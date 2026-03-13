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
 * Create a simplified Luzhanqi-style board:
 * - 12 rows x 5 cols
 * - Mark a few cells as 行营 (camp) and 大本营 (HQ)
 * - All other traversable cells are 兵站 (post)
 */
function createBoard() {
  const rows = 12;
  const cols = 5;
  /** @type {{rows:number, cols:number, cells:{r:number,c:number,type:"post"|"camp"|"hq"}[]} */
  // @ts-ignore
  const board = { rows, cols, cells: [] };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      board.cells.push({ r, c, type: "post" });
    }
  }

  // Helper to set cell type safely.
  function mark(r, c, type) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    board.cells[r * cols + c].type = type;
  }

  // Camps (行营) – approximate a couple of central circular spaces for each side.
  // Top side camps.
  mark(1, 1, "camp");
  mark(1, 3, "camp");
  mark(3, 1, "camp");
  mark(3, 3, "camp");
  // Bottom side camps (mirrored).
  mark(8, 1, "camp");
  mark(8, 3, "camp");
  mark(10, 1, "camp");
  mark(10, 3, "camp");

  // Headquarters (大本营) – use the rows already implied by homeInfoForSeat.
  const halfRows = rows / 2; // 6
  // Top HQ row (row 5) at cols 1 and 3.
  mark(halfRows - 1, 1, "hq");
  mark(halfRows - 1, 3, "hq");
  // Bottom HQ row (row 6) at cols 1 and 3.
  mark(halfRows, 1, "hq");
  mark(halfRows, 3, "hq");

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
      // 12 rows x 5 cols with typed cells (兵站 / 行营 / 大本营).
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
  return (
    Number.isInteger(pos.r) &&
    Number.isInteger(pos.c) &&
    pos.r >= 0 &&
    pos.r < board.rows &&
    pos.c >= 0 &&
    pos.c < board.cols
  );
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

function homeInfoForSeat(board, seat) {
  // We split board into a top half (rows 0‑5) and bottom half (rows 6‑11).
  // Seats N/W use the top, S/E use the bottom.
  const top = seat === "N" || seat === "W";
  const halfRows = board.rows / 2; // 6
  if (top) {
    return {
      // rows 0..5
      frontRow: 0,
      lastTwoRows: [halfRows - 2, halfRows - 1], // 4,5
      hqRow: halfRows - 1, // 5
      hqCols: [1, 3]
    };
  }
  // bottom side
  return {
    // rows 6..11
    frontRow: board.rows - 1,
    lastTwoRows: [board.rows - 2, board.rows - 1], // 10,11
    hqRow: halfRows, // 6
    hqCols: [1, 3]
  };
}

function isHQCell(board, seat, pos) {
  const info = homeInfoForSeat(board, seat);
  if (pos.r !== info.hqRow || !info.hqCols.includes(pos.c)) return false;
  const cell = boardCellAt(board, pos);
  return !!cell && cell.type === "hq";
}

function validatePlacement(room, piece, player) {
  if (!player.seat) return false;
  const pos = piece.pos;
  if (!pos) return true;
  const info = homeInfoForSeat(room.board, player.seat);

  // Only allow setup inside own half of the board.
  if (player.seat === "N" || player.seat === "W") {
    if (pos.r < 0 || pos.r >= room.board.rows / 2) return false;
  } else {
    if (pos.r < room.board.rows / 2 || pos.r >= room.board.rows) return false;
  }

  const cell = boardCellAt(room.board, pos);
  if (!cell) return false;

  // Do not allow initial placement on 行营.
  if (cell.type === "camp") return false;

  if (piece.type === "bomb") {
    // Bombs cannot be in the front row.
    if (pos.r === info.frontRow) return false;
  }
  if (piece.type === "mine") {
    // Mines must be in the last two rows.
    if (!info.lastTwoRows.includes(pos.r)) return false;
  }
  if (piece.type === "flag") {
    // Flag must be in one of the HQ cells.
    if (!isHQCell(room.board, player.seat, pos)) return false;
  } else {
    // Non-flag pieces cannot start in HQ.
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

