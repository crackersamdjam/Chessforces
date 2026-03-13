import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const HOST = process.env.HOST ?? "0.0.0.0";

const app = express();
app.disable("x-powered-by");

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Always serve the SPA shell; the client JS will assign/generate a room id
// and update the URL without causing a full reload.
app.get(["/", "/room/:roomId"], (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Room state lives in-memory (good for a simple demo).
 * If you want persistence/hosting scale, we can add Redis later.
 */
const rooms = new Map();

const SEATS = /** @type {const} */ (["N", "E", "S", "W"]);
const PHASES = /** @type {const} */ ({
  LOBBY: "lobby",
  PLACEMENT: "placement",
  PLAY: "play",
  DONE: "done"
});

// Full Junqi-style piece set (2‑side version, reused per seat).
// We keep the standard ranks and special pieces but still allow up to 4 seats on one board.
const PIECE_DEFS = [
  { type: "marshal", label: "司令(9)", rank: 9, count: 1 },
  { type: "general", label: "军长(8)", rank: 8, count: 1 },
  { type: "major_general", label: "师长(7)", rank: 7, count: 2 },
  { type: "brigadier", label: "旅长(6)", rank: 6, count: 2 },
  { type: "colonel", label: "团长(5)", rank: 5, count: 2 },
  { type: "major", label: "营长(4)", rank: 4, count: 2 },
  { type: "captain", label: "连长(3)", rank: 3, count: 3 },
  { type: "lieutenant", label: "排长(2)", rank: 2, count: 3 },
  { type: "engineer", label: "工兵(1)", rank: 1, count: 3 },
  { type: "bomb", label: "炸弹(0)", rank: null, count: 2 },
  { type: "mine", label: "地雷(10)", rank: null, count: 3 },
  { type: "flag", label: "军旗(11)", rank: null, count: 1 }
];

/**
 * Create a 4-player cross-shaped (+ shape) Luzhanqi-style board:
 * - 15 rows × 15 cols (square)
 * - Active cells: vertical bar (cols 5-9, all rows) UNION horizontal bar (rows 5-9, all cols)
 * - Inactive corner cells (5×5 each) keep the cross shape
 * - Each player has a fully exclusive 5×5 home zone (no overlap with the center):
 *     N: rows 0-4,   cols 5-9   (front = row 4,  back = row 0)
 *     S: rows 10-14, cols 5-9   (front = row 10, back = row 14)
 *     W: rows 5-9,   cols 0-4   (front = col 4,  back = col 0)
 *     E: rows 5-9,   cols 10-14 (front = col 10, back = col 14)
 * - Center (rows 5-9, cols 5-9) is shared battle territory — not part of any home zone
 */
function createBoard() {
  const rows = 15;
  const cols = 15;
  /** @type {{rows:number, cols:number, cells:{r:number,c:number,type:"post"|"camp"|"hq"|"inactive"}[]}} */
  // @ts-ignore
  const board = { rows, cols, cells: [] };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Cross (+ shape): vertical bar (cols 5-9) union horizontal bar (rows 5-9).
      const active = (c >= 5 && c <= 9) || (r >= 5 && r <= 9);
      board.cells.push({ r, c, type: active ? "post" : "inactive" });
    }
  }

  // Helper to set cell type safely (will not overwrite inactive cells).
  function mark(r, c, type) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    const cell = board.cells[r * cols + c];
    if (cell.type === "inactive") return;
    cell.type = type;
  }

  // N home (rows 0-4, cols 5-9): HQ at back (row 0), camps at rows 1 and 3.
  mark(0, 6, "hq");  mark(0, 8, "hq");
  mark(1, 6, "camp"); mark(1, 8, "camp");
  mark(3, 6, "camp"); mark(3, 8, "camp");

  // S home (rows 10-14, cols 5-9): HQ at back (row 14), camps at rows 11 and 13.
  mark(14, 6, "hq"); mark(14, 8, "hq");
  mark(13, 6, "camp"); mark(13, 8, "camp");
  mark(11, 6, "camp"); mark(11, 8, "camp");

  // W home (rows 5-9, cols 0-4): HQ at back (col 0), camps at cols 1 and 3.
  mark(6, 0, "hq");  mark(8, 0, "hq");
  mark(6, 1, "camp"); mark(8, 1, "camp");
  mark(6, 3, "camp"); mark(8, 3, "camp");

  // E home (rows 5-9, cols 10-14): HQ at back (col 14), camps at cols 13 and 11.
  mark(6, 14, "hq"); mark(8, 14, "hq");
  mark(6, 13, "camp"); mark(8, 13, "camp");
  mark(6, 11, "camp"); mark(8, 11, "camp");

  return board;
}

function boardCellAt(board, pos) {
  if (!pos) return null;
  const { rows, cols, cells } = board;
  if (
    pos.r < 0 ||
    pos.r >= rows ||
    pos.c < 0 ||
    pos.c >= cols ||
    !Array.isArray(cells) ||
    cells.length !== rows * cols
  ) {
    return null;
  }
  return cells[pos.r * cols + pos.c] ?? null;
}

function nowMs() {
  return Date.now();
}

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const p of room.players.values()) safeSend(p.ws, obj);
}

function roomSnapshotFor(room, viewerId) {
  const players = [];
  for (const [pid, p] of room.players) {
    players.push({
      id: pid,
      name: p.name,
      seat: p.seat,
      ready: p.ready
    });
  }

  const pieces = [];
  // Pieces: each piece is hidden to non-owner unless revealed.
  for (const piece of room.pieces.values()) {
    const isOwner = piece.ownerId === viewerId;
    pieces.push({
      id: piece.id,
      ownerSeat: room.players.get(piece.ownerId)?.seat ?? null,
      pos: piece.pos,
      revealed: piece.revealed,
      label: isOwner || piece.revealed ? piece.label : "?"
    });
  }

  return {
    roomId: room.id,
    phase: room.phase,
    players,
    board: room.board,
    pieces,
    turnSeat: room.turnSeat,
    lastMove: room.lastMove,
    winnerSeat: room.winnerSeat ?? null,
    gameOverReason: room.gameOverReason ?? null
  };
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      phase: PHASES.LOBBY,
      players: new Map(), // playerId -> {ws, name, seat, ready, joinedAt}
      seatToPlayerId: new Map(), // seat -> playerId
      // 15 rows × 15 cols cross-shaped board with typed cells (兵站 / 行营 / 大本营).
      board: createBoard(),
      pieces: new Map(), // pieceId -> {id, ownerId, type, label, rank, pos:{r,c}|null, revealed:boolean, alive:boolean}
      turnSeat: null,
      lastMove: null,
      winnerSeat: null,
      gameOverReason: null
    };
    rooms.set(roomId, room);
  }
  return room;
}

function chooseSeat(room) {
  for (const s of SEATS) {
    if (!room.seatToPlayerId.has(s)) return s;
  }
  return null;
}

function maybeAdvancePhase(room) {
  const occupiedSeats = Array.from(room.seatToPlayerId.keys()).length;
  const allReady =
    occupiedSeats > 1 &&
    Array.from(room.players.values()).every((p) => p.seat && p.ready);

  if (room.phase === PHASES.LOBBY && allReady) {
    room.phase = PHASES.PLACEMENT;
    room.updatedAt = nowMs();
    room.winnerSeat = null;
    room.gameOverReason = null;
    broadcast(room, { type: "phase", phase: room.phase });
  }

  if (room.phase === PHASES.PLACEMENT) {
    // In this simple version: placement is "done" when each seated player has at least 1 placed piece.
    const seatedPlayers = Array.from(room.players.values()).filter((p) => p.seat);
    const allPlaced = seatedPlayers.every((p) => {
      for (const piece of room.pieces.values()) {
        if (piece.ownerId === p.id && piece.pos) return true;
      }
      return false;
    });
    if (allPlaced) {
      room.phase = PHASES.PLAY;
      // Start turn at N then clockwise among occupied seats.
      room.turnSeat = SEATS.find((s) => room.seatToPlayerId.has(s)) ?? null;
      room.updatedAt = nowMs();
      broadcast(room, { type: "phase", phase: room.phase, turnSeat: room.turnSeat });
    }
  }
}

function nextOccupiedSeat(room, fromSeat) {
  const startIdx = SEATS.indexOf(fromSeat);
  for (let i = 1; i <= SEATS.length; i++) {
    const seat = SEATS[(startIdx + i) % SEATS.length];
    if (room.seatToPlayerId.has(seat)) return seat;
  }
  return fromSeat;
}

function isInBounds(board, pos) {
  if (!pos) return false;
  if (
    !Number.isInteger(pos.r) ||
    !Number.isInteger(pos.c) ||
    pos.r < 0 ||
    pos.r >= board.rows ||
    pos.c < 0 ||
    pos.c >= board.cols
  ) return false;
  const cell = boardCellAt(board, pos);
  return !!cell && cell.type !== "inactive";
}

function pieceAt(room, pos) {
  for (const p of room.pieces.values()) {
    if (p.alive !== false && p.pos && p.pos.r === pos.r && p.pos.c === pos.c) return p;
  }
  return null;
}

function ensurePieceSet(room, playerId) {
  const existing = Array.from(room.pieces.values()).some((p) => p.ownerId === playerId);
  if (existing) return;

  for (const def of PIECE_DEFS) {
    for (let i = 0; i < def.count; i++) {
      const id = nanoid(8);
      room.pieces.set(id, {
        id,
        ownerId: playerId,
        type: def.type,
        label: def.label,
        rank: def.rank,
        pos: null,
        revealed: false,
        alive: true
      });
    }
  }
}

/**
 * Returns placement-constraint info for each seat's 5×5 home zone.
 * N/S are "row-oriented" (the arm extends vertically).
 * W/E are "col-oriented" (the arm extends horizontally).
 *
 * Home zones (exclusive — no overlap with center or other arms):
 *   N: rows 0-4,   cols 5-9   (center starts at row 5)
 *   S: rows 10-14, cols 5-9   (center ends  at row 9)
 *   W: rows 5-9,   cols 0-4   (center starts at col 5)
 *   E: rows 5-9,   cols 10-14 (center ends  at col 9)
 */
function homeInfoForSeat(board, seat) {
  switch (seat) {
    case "N":
      return {
        minR: 0,  maxR: 4,  minC: 5,  maxC: 9,
        orientation: "row",
        frontRow: 4,          // row closest to center (bombs not allowed here)
        mineRows: [0, 1],     // back 2 rows (mines must be here)
        hqRow: 0, hqCols: [6, 8]
      };
    case "S":
      return {
        minR: 10, maxR: 14, minC: 5,  maxC: 9,
        orientation: "row",
        frontRow: 10,
        mineRows: [13, 14],
        hqRow: 14, hqCols: [6, 8]
      };
    case "W":
      return {
        minR: 5,  maxR: 9,  minC: 0,  maxC: 4,
        orientation: "col",
        frontCol: 4,          // col closest to center
        mineCols: [0, 1],     // back 2 cols
        hqCol: 0, hqRows: [6, 8]
      };
    case "E":
      return {
        minR: 5,  maxR: 9,  minC: 10, maxC: 14,
        orientation: "col",
        frontCol: 10,
        mineCols: [13, 14],
        hqCol: 14, hqRows: [6, 8]
      };
    default:
      return null;
  }
}

function isHQCell(board, seat, pos) {
  const info = homeInfoForSeat(board, seat);
  if (!info) return false;
  const cell = boardCellAt(board, pos);
  if (!cell || cell.type !== "hq") return false;
  if (info.orientation === "row") {
    return pos.r === info.hqRow && info.hqCols.includes(pos.c);
  }
  return pos.c === info.hqCol && info.hqRows.includes(pos.r);
}

function validatePlacement(room, piece, player) {
  if (!player.seat) return false;
  const pos = piece.pos;
  if (!pos) return true;
  const info = homeInfoForSeat(room.board, player.seat);
  if (!info) return false;

  // Must be within own home zone bounding box.
  if (pos.r < info.minR || pos.r > info.maxR || pos.c < info.minC || pos.c > info.maxC) return false;

  const cell = boardCellAt(room.board, pos);
  if (!cell || cell.type === "inactive") return false;

  // No initial placement on 行营 (camp).
  if (cell.type === "camp") return false;

  if (info.orientation === "row") {
    if (piece.type === "bomb" && pos.r === info.frontRow) return false;
    if (piece.type === "mine" && !info.mineRows.includes(pos.r)) return false;
  } else {
    if (piece.type === "bomb" && pos.c === info.frontCol) return false;
    if (piece.type === "mine" && !info.mineCols.includes(pos.c)) return false;
  }

  if (piece.type === "flag") {
    if (!isHQCell(room.board, player.seat, pos)) return false;
  } else {
    if (cell.type === "hq") return false;
  }
  return true;
}

function resolveCapture(attacker, defender) {
  attacker.revealed = true;
  defender.revealed = true;

  // Flag captured: attacker wins, defender removed.
  if (defender.type === "flag") {
    defender.alive = false;
    defender.pos = null;
    return { result: "flag", attackerId: attacker.id, defenderId: defender.id };
  }

  // Landmine interaction.
  if (defender.type === "mine") {
    if (attacker.type === "engineer") {
      // Engineer safely clears the mine.
      defender.alive = false;
      defender.pos = null;
      return { result: "mine_cleared", attackerId: attacker.id, defenderId: defender.id };
    }
    // Non‑engineers die on the mine; optional rule: mine also removed.
    attacker.alive = false;
    attacker.pos = null;
    // Common fast‑play rule: mine removed too.
    defender.alive = false;
    defender.pos = null;
    return { result: "mine_both", attackerId: attacker.id, defenderId: defender.id };
  }

  // Bomb interaction.
  if (attacker.type === "bomb" || defender.type === "bomb") {
    attacker.alive = false;
    defender.alive = false;
    attacker.pos = null;
    defender.pos = null;
    return { result: "bomb_both", attackerId: attacker.id, defenderId: defender.id };
  }

  // Normal rank comparison for officers/engineers.
  if (typeof attacker.rank === "number" && typeof defender.rank === "number") {
    if (attacker.rank > defender.rank) {
      defender.alive = false;
      defender.pos = null;
      return { result: "attacker", attackerId: attacker.id, defenderId: defender.id };
    }
    if (attacker.rank < defender.rank) {
      attacker.alive = false;
      attacker.pos = null;
      return { result: "defender", attackerId: attacker.id, defenderId: defender.id };
    }
    // Equal rank: both removed.
    attacker.alive = false;
    defender.alive = false;
    attacker.pos = null;
    defender.pos = null;
    return { result: "both", attackerId: attacker.id, defenderId: defender.id };
  }

  // Fallback: treat as both removed.
  attacker.alive = false;
  defender.alive = false;
  attacker.pos = null;
  defender.pos = null;
  return { result: "both", attackerId: attacker.id, defenderId: defender.id };
}

function checkForWin(room) {
  // If any flag is dead, the opposing seat team wins.
  const aliveFlagsBySeat = new Map();
  for (const piece of room.pieces.values()) {
    if (!piece.alive || piece.type !== "flag" || !piece.ownerId) continue;
    const ownerSeat = room.players.get(piece.ownerId)?.seat;
    if (!ownerSeat) continue;
    aliveFlagsBySeat.set(ownerSeat, true);
  }
  if (aliveFlagsBySeat.size >= 2) return;

  if (aliveFlagsBySeat.size === 0) {
    room.phase = PHASES.DONE;
    room.winnerSeat = null;
    room.gameOverReason = "both_flags_lost";
    return;
  }

  // Only one seat still has a flag.
  const [survivorSeat] = aliveFlagsBySeat.keys();
  room.phase = PHASES.DONE;
  room.winnerSeat = survivorSeat;
  room.gameOverReason = "flag_captured";
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  // Expect ws path: /ws/room/<roomId>
  const roomId = parts[0] === "ws" && parts[1] === "room" ? parts[2] : null;
  if (!roomId) {
    ws.close(1008, "Missing roomId");
    return;
  }

  const room = getOrCreateRoom(roomId);
  const playerId = nanoid(10);

  /** @type {{id:string, ws:any, name:string, seat:string|null, ready:boolean, joinedAt:number}} */
  const player = {
    id: playerId,
    ws,
    name: `Player-${playerId.slice(0, 4)}`,
    seat: null,
    ready: false,
    joinedAt: nowMs()
  };
  room.players.set(playerId, player);
  room.updatedAt = nowMs();

  safeSend(ws, { type: "hello", playerId, seats: SEATS });
  safeSend(ws, { type: "state", state: roomSnapshotFor(room, playerId) });
  broadcast(room, { type: "presence" });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;
    room.updatedAt = nowMs();

    if (msg.type === "set_name") {
      player.name = String(msg.name ?? "").slice(0, 24) || player.name;
      broadcast(room, { type: "state", state: roomSnapshotFor(room, playerId) });
      return;
    }

    if (msg.type === "take_seat") {
      const seat = String(msg.seat ?? "");
      if (!SEATS.includes(seat)) return;
      if (room.seatToPlayerId.has(seat)) return;
      if (player.seat) room.seatToPlayerId.delete(player.seat);
      player.seat = seat;
      room.seatToPlayerId.set(seat, playerId);
      ensurePieceSet(room, playerId);
      broadcast(room, { type: "presence" });
      for (const [pid, p] of room.players) {
        safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      return;
    }

    if (msg.type === "leave_seat") {
      if (player.seat) room.seatToPlayerId.delete(player.seat);
      player.seat = null;
      player.ready = false;
      broadcast(room, { type: "presence" });
      for (const [pid, p] of room.players) {
        safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      return;
    }

    if (msg.type === "set_ready") {
      player.ready = Boolean(msg.ready);
      broadcast(room, { type: "presence" });
      for (const [pid, p] of room.players) {
        safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      maybeAdvancePhase(room);
      return;
    }

    if (msg.type === "place_piece") {
      if (room.phase !== PHASES.PLACEMENT && room.phase !== PHASES.LOBBY) return;
      if (!player.seat) return;
      const pieceId = String(msg.pieceId ?? "");
      const pos = msg.pos ?? null;
      const piece = room.pieces.get(pieceId);
      if (!piece || piece.ownerId !== playerId) return;
      if (pos !== null && !isInBounds(room.board, pos)) return;
      if (pos !== null && pieceAt(room, pos)) return;
      piece.pos = pos;
      if (!validatePlacement(room, piece, player)) {
        // Revert if placement breaks Junqi constraints.
        piece.pos = null;
        return;
      }
      room.updatedAt = nowMs();
      for (const [pid] of room.players) {
        safeSend(room.players.get(pid).ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      maybeAdvancePhase(room);
      return;
    }

    if (msg.type === "move") {
      if (room.phase !== PHASES.PLAY) return;
      if (!player.seat) return;
      if (room.turnSeat !== player.seat) return;
      const pieceId = String(msg.pieceId ?? "");
      const to = msg.to ?? null;
      if (!isInBounds(room.board, to)) return;
      const piece = room.pieces.get(pieceId);
      if (!piece || piece.ownerId !== playerId || !piece.pos || piece.alive === false) return;
      if (piece.type === "flag" || piece.type === "mine") return; // cannot move
      const from = piece.pos;
      if (from.r === to.r && from.c === to.c) return;
      const target = pieceAt(room, to);

      // Move 1-step orthogonally (we do not model full railroad topology here).
      const manhattan = Math.abs(from.r - to.r) + Math.abs(from.c - to.c);
      if (manhattan !== 1) return;

      let capture = null;
      if (target && target.ownerId === playerId) return;
      if (target) {
        capture = resolveCapture(piece, target);
        if (piece.alive !== false) piece.pos = to;
      } else {
        piece.pos = to;
      }

      room.lastMove = { by: player.seat, pieceId: piece.id, from, to, capture };
      if (room.phase !== PHASES.DONE) {
        room.turnSeat = nextOccupiedSeat(room, room.turnSeat);
      }

      // Check for win after each capture/move.
      checkForWin(room);

      for (const [pid] of room.players) {
        safeSend(room.players.get(pid).ws, {
          type: "state",
          state: roomSnapshotFor(room, pid)
        });
      }
      return;
    }

    if (msg.type === "chat") {
      const text = String(msg.text ?? "").slice(0, 300).trim();
      if (!text) return;
      broadcast(room, {
        type: "chat",
        from: { id: playerId, name: player.name, seat: player.seat },
        text,
        at: nowMs()
      });
      return;
    }
  });

  ws.on("close", () => {
    room.players.delete(playerId);
    if (player.seat) room.seatToPlayerId.delete(player.seat);
    // Remove pieces owned by player
    for (const [pid, piece] of room.pieces) {
      if (piece.ownerId === playerId) room.pieces.delete(pid);
    }
    room.updatedAt = nowMs();
    if (room.players.size === 0) {
      rooms.delete(room.id);
      return;
    }
    broadcast(room, { type: "presence" });
    for (const [pid] of room.players) {
      safeSend(room.players.get(pid).ws, { type: "state", state: roomSnapshotFor(room, pid) });
    }
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Junqi server on http://${HOST}:${PORT}`);
});

