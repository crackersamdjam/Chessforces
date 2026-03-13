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

app.get("/", (req, res) => {
  res.redirect(`/room/${nanoid(10)}`);
});

app.get("/room/:roomId", (req, res) => {
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
    lastMove: room.lastMove
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
      // Simple rectangular board for "simple Junqi":
      // 12 rows x 5 cols. We keep it generic and do minimal validation.
      board: { rows: 12, cols: 5 },
      pieces: new Map(), // pieceId -> {id, ownerId, label, pos:{r,c}|null, revealed:boolean, alive:boolean}
      turnSeat: null,
      lastMove: null
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
  // A small subset for "simple" play: 10 pieces labeled in Chinese.
  // You can expand later.
  const existing = Array.from(room.pieces.values()).some((p) => p.ownerId === playerId);
  if (existing) return;

  const labels = ["司令", "军长", "师长", "旅长", "团长", "营长", "连长", "排长", "工兵", "炸弹"];
  for (const label of labels) {
    const id = nanoid(8);
    room.pieces.set(id, {
      id,
      ownerId: playerId,
      label,
      pos: null,
      revealed: false,
      alive: true
    });
  }
}

function resolveCapture(attacker, defender) {
  // Intentionally simple:
  // - If defender is "炸弹": both removed (revealed).
  // - Else attacker wins, defender removed (revealed).
  // This is NOT full Junqi rank logic.
  defender.revealed = true;
  attacker.revealed = true;
  if (defender.label === "炸弹") {
    defender.alive = false;
    attacker.alive = false;
    attacker.pos = null;
    defender.pos = null;
    return { result: "both", attackerId: attacker.id, defenderId: defender.id };
  }
  defender.alive = false;
  defender.pos = null;
  return { result: "attacker", attackerId: attacker.id, defenderId: defender.id };
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
      const from = piece.pos;
      if (from.r === to.r && from.c === to.c) return;
      const target = pieceAt(room, to);

      // Simple move rule: allow 1-step orthogonal when not capturing; capturing can be any (still simple).
      const manhattan = Math.abs(from.r - to.r) + Math.abs(from.c - to.c);
      if (!target && manhattan !== 1) return;

      let capture = null;
      if (target && target.ownerId === playerId) return;
      if (target) {
        capture = resolveCapture(piece, target);
        if (piece.alive !== false) piece.pos = to;
      } else {
        piece.pos = to;
      }

      room.lastMove = { by: player.seat, pieceId: piece.id, from, to, capture };
      room.turnSeat = nextOccupiedSeat(room, room.turnSeat);

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

