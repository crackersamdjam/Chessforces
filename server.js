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
  { type: "marshal", label: "司令(40)", rank: 9, count: 1 },
  { type: "general", label: "军长(39)", rank: 8, count: 1 },
  { type: "major_general", label: "师长(38)", rank: 7, count: 2 },
  { type: "brigadier", label: "旅长(37)", rank: 6, count: 2 },
  { type: "colonel", label: "团长(36)", rank: 5, count: 2 },
  { type: "major", label: "营长(35)", rank: 4, count: 2 },
  { type: "captain", label: "连长(34)", rank: 3, count: 3 },
  { type: "lieutenant", label: "排长(33)", rank: 2, count: 3 },
  { type: "engineer", label: "工兵(32)", rank: 1, count: 3 },
  { type: "bomb", label: "炸弹(B)", rank: null, count: 2 },
  { type: "mine", label: "地雷(M)", rank: null, count: 3 },
  { type: "flag", label: "军旗(F)", rank: null, count: 1 }
];

/**
 * Create a 4-player cross-shaped (+ shape) Luzhanqi-style board:
 * - 17 rows × 17 cols (square)
 * - Active cells: vertical bar (cols 6-10, all rows) UNION horizontal bar (rows 6-10, all cols)
 * - Inactive corner cells (6×6 each) keep the cross shape
 * - Each player has a fully exclusive 6×5 (or 5×6) home zone — 30 cells, 24 post + 4 camp + 2 HQ:
 *     N: rows 0-5,   cols 6-10  (front = row 5,  back = row 0)
 *     S: rows 11-16, cols 6-10  (front = row 11, back = row 16)
 *     W: rows 6-10,  cols 0-5   (front = col 5,  back = col 0)
 *     E: rows 6-10,  cols 11-16 (front = col 11, back = col 16)
 * - Center (rows 6-10, cols 6-10) is shared battle territory — not part of any home zone
 * - 30 cells per arm gives exactly 24 post cells for 24 non-flag pieces + 2 HQ (1 for flag)
 */
function createBoard() {
  const rows = 17;
  const cols = 17;
  /** @type {{rows:number, cols:number, cells:{r:number,c:number,type:"post"|"camp"|"hq"|"inactive"}[]}} */
  // @ts-ignore
  const board = { rows, cols, cells: [] };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Cross (+ shape): vertical bar (cols 6-10) union horizontal bar (rows 6-10).
      const active = (c >= 6 && c <= 10) || (r >= 6 && r <= 10);
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

  // N home (rows 0-5, cols 6-10): HQ at back (row 0); 5 camps in plum-blossom pattern at rows 2-4.
  // Layout (row 0=back, row 5=front):  row2: C·C  row3: ·C·  row4: C·C
  mark(0, 7, "hq");  mark(0, 9, "hq");
  mark(2, 7, "camp"); mark(2, 9, "camp");
  mark(3, 8, "camp"); // centre camp
  mark(4, 7, "camp"); mark(4, 9, "camp");

  // S home (rows 11-16, cols 6-10): HQ at back (row 16); camps at rows 12-14 (mirrored).
  mark(16, 7, "hq"); mark(16, 9, "hq");
  mark(12, 7, "camp"); mark(12, 9, "camp");
  mark(13, 8, "camp"); // centre camp
  mark(14, 7, "camp"); mark(14, 9, "camp");

  // W home (rows 6-10, cols 0-5): HQ at back (col 0); 5 camps at cols 2-4 (rotated pattern).
  // Layout (col 0=back, col 5=front):  col2: C·C  col3: ·C·  col4: C·C
  mark(7, 0, "hq");  mark(9, 0, "hq");
  mark(7, 2, "camp"); mark(9, 2, "camp");
  mark(8, 3, "camp"); // centre camp
  mark(7, 4, "camp"); mark(9, 4, "camp");

  // E home (rows 6-10, cols 11-16): HQ at back (col 16); camps at cols 12-14 (mirrored).
  mark(7, 16, "hq"); mark(9, 16, "hq");
  mark(7, 12, "camp"); mark(9, 12, "camp");
  mark(8, 13, "camp"); // centre camp
  mark(7, 14, "camp"); mark(9, 14, "camp");

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
  // Pieces: label is only visible to the owner — never revealed to opponents.
  for (const piece of room.pieces.values()) {
    const isOwner = piece.ownerId === viewerId;
    pieces.push({
      id: piece.id,
      ownerSeat: room.players.get(piece.ownerId)?.seat ?? null,
      pos: piece.pos,
      label: isOwner ? piece.label : "?",
      type: isOwner ? piece.type : null
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
      // 17 rows × 17 cols cross-shaped board with typed cells (兵站 / 行营 / 大本营).
      board: createBoard(),
      pieces: new Map(), // pieceId -> {id, ownerId, type, label, rank, pos:{r,c}|null, alive:boolean}
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

function broadcastState(room) {
  for (const [pid, p] of room.players) {
    safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
  }
}

function allPiecesPlaced(room, playerId) {
  const mine = Array.from(room.pieces.values()).filter((pc) => pc.ownerId === playerId);
  return mine.length > 0 && mine.every((pc) => pc.pos !== null);
}

function maybeAdvancePhase(room) {
  // Placement now happens in the lobby phase before declaring ready.
  // The game starts (LOBBY → PLAY) once every seated player is ready
  // AND has placed all their pieces.
  if (room.phase !== PHASES.LOBBY) return;

  const seatedPlayers = Array.from(room.players.values()).filter((p) => p.seat);
  if (seatedPlayers.length < 2) return;

  const allReady = seatedPlayers.every((p) => p.ready);
  if (!allReady) return;

  const allPlaced = seatedPlayers.every((p) => allPiecesPlaced(room, p.id));
  if (!allPlaced) return;

  room.phase = PHASES.PLAY;
  room.turnSeat = SEATS.find((s) => room.seatToPlayerId.has(s)) ?? null;
  room.updatedAt = nowMs();
  room.winnerSeat = null;
  room.gameOverReason = null;
  broadcastState(room);
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
        alive: true
      });
    }
  }
}

/**
 * Returns placement-constraint info for each seat's home zone.
 * N/S are "row-oriented" (the arm extends vertically, 6 rows × 5 cols = 30 cells).
 * W/E are "col-oriented" (the arm extends horizontally, 5 rows × 6 cols = 30 cells).
 *
 * Home zones (exclusive — no overlap with center or other arms):
 *   N: rows 0-5,   cols 6-10  (center starts at row 6)
 *   S: rows 11-16, cols 6-10  (center ends  at row 10)
 *   W: rows 6-10,  cols 0-5   (center starts at col 6)
 *   E: rows 6-10,  cols 11-16 (center ends  at col 10)
 */
function homeInfoForSeat(board, seat) {
  switch (seat) {
    case "N":
      return {
        minR: 0,  maxR: 5,  minC: 6,  maxC: 10,
        orientation: "row",
        frontRow: 5,          // row closest to center (bombs not allowed here)
        mineRows: [0, 1],     // back 2 rows (mines must be here)
        hqRow: 0, hqCols: [7, 9]
      };
    case "S":
      return {
        minR: 11, maxR: 16, minC: 6,  maxC: 10,
        orientation: "row",
        frontRow: 11,
        mineRows: [15, 16],
        hqRow: 16, hqCols: [7, 9]
      };
    case "W":
      return {
        minR: 6,  maxR: 10, minC: 0,  maxC: 5,
        orientation: "col",
        frontCol: 5,          // col closest to center
        mineCols: [0, 1],     // back 2 cols
        hqCol: 0, hqRows: [7, 9]
      };
    case "E":
      return {
        minR: 6,  maxR: 10, minC: 11, maxC: 16,
        orientation: "col",
        frontCol: 11,
        mineCols: [15, 16],
        hqCol: 16, hqRows: [7, 9]
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
    // Flag must be placed on an HQ cell.
    if (!isHQCell(room.board, player.seat, pos)) return false;
  }
  // Non-flag pieces may occupy any non-camp, in-bounds cell including the second HQ.
  return true;
}

function resolveCapture(attacker, defender) {
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
      const wantsReady = Boolean(msg.ready);
      // Prevent readying up until every piece has been placed.
      if (wantsReady && !allPiecesPlaced(room, playerId)) return;
      player.ready = wantsReady;
      for (const [pid, p] of room.players) {
        safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      maybeAdvancePhase(room);
      return;
    }

    if (msg.type === "place_piece") {
      if (room.phase !== PHASES.LOBBY) return;
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

