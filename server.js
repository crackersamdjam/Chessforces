import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import {
	SEATS,
	PHASES,
	DEFAULT_TURN_DURATION_MS,
	MIN_TURN_DURATION_SEC,
	MAX_TURN_DURATION_SEC,
	applyMove,
	applyForfeit,
	applyOfferDraw,
	applyPlacement,
	allPiecesPlaced,
	createRoom,
	eliminatePlayer,
	ensurePieceSet,
	maybeAdvancePhase,
	nextOccupiedSeat,
	checkForWin,
	resetTurnTimer,
	roomSnapshotFor,
	applySetupToRoom,
	exportSetup,
	exportGame
} from "./lib/game/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const HOST = process.env.HOST ?? "0.0.0.0";

const app = express();
app.disable("x-powered-by");

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, {
	// Keep the client shell fresh after deploys.
	// This app is small, so favor correctness over asset caching.
	//
	// Future optimization: fingerprint static assets (for example,
	// client.jc8934f9j834.js), then serve those with long-lived immutable
	// cache headers while keeping HTML revalidated on each visit.
	// This "fresh HTML + heavily cached hashed assets" pattern is what most
	// production websites use to get fast loads without stale deploys.
	setHeaders(res) {
		res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
		res.setHeader("Pragma", "no-cache");
		res.setHeader("Expires", "0");
	}
}));

function sendIndex(res) {
	res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
	res.setHeader("Pragma", "no-cache");
	res.setHeader("Expires", "0");
	res.sendFile(path.join(publicDir, "index.html"));
}

app.get(["/", "/room/:roomId", "/playback"], (_req, res) => {
	sendIndex(res);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
const disconnectTimers = new Map();
const RECONNECT_GRACE_MS = process.env.RECONNECT_GRACE_MS
	? Number(process.env.RECONNECT_GRACE_MS)
	: 45000;
const TURN_TIMEOUT_MS = process.env.TURN_TIMEOUT_MS
	? Number(process.env.TURN_TIMEOUT_MS)
	: DEFAULT_TURN_DURATION_MS;
const turnTimers = new Map();

function nowMs() {
	return Date.now();
}

function safeSend(ws, obj) {
	if (!ws || ws.readyState !== ws.OPEN) return;
	ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
	for (const p of room.players.values()) safeSend(p.ws, obj);
}

function broadcastState(room) {
	for (const [pid, p] of room.players) {
		safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
	}
}

function getOrCreateRoom(roomId) {
	let room = rooms.get(roomId);
	if (!room) {
		room = createRoom(roomId, { turnDurationMs: TURN_TIMEOUT_MS });
		rooms.set(roomId, room);
	}
	return room;
}

function disconnectTimerKey(roomId, playerId) {
	return `${roomId}:${playerId}`;
}

function clearDisconnectTimer(roomId, playerId) {
	const key = disconnectTimerKey(roomId, playerId);
	const timer = disconnectTimers.get(key);
	if (timer) {
		clearTimeout(timer);
		disconnectTimers.delete(key);
	}
}

function clearTurnTimer(roomId) {
	const timer = turnTimers.get(roomId);
	if (timer) {
		clearTimeout(timer);
		turnTimers.delete(roomId);
	}
}

function scheduleTurnTimer(room) {
	clearTurnTimer(room.id);
	if (room.phase !== PHASES.PLAY || !room.turnSeat || !room.turnDeadlineAt) return;
	const delayMs = Math.max(0, room.turnDeadlineAt - nowMs());
	const timer = setTimeout(() => {
		turnTimers.delete(room.id);
		const liveRoom = rooms.get(room.id);
		if (!liveRoom) return;
		if (liveRoom.phase !== PHASES.PLAY || !liveRoom.turnSeat || !liveRoom.turnDeadlineAt) return;
		if (liveRoom.turnDeadlineAt > nowMs()) {
			scheduleTurnTimer(liveRoom);
			return;
		}

		const skippedSeat = liveRoom.turnSeat;
		liveRoom.turnSeat = nextOccupiedSeat(liveRoom, liveRoom.turnSeat);
		checkForWin(liveRoom);
		resetTurnTimer(liveRoom);
		liveRoom.updatedAt = nowMs();

		broadcast(liveRoom, {
			type: "turn_skipped",
			seat: skippedSeat,
			nextSeat: liveRoom.turnSeat
		});
		broadcastState(liveRoom);
		scheduleTurnTimer(liveRoom);
	}, delayMs);
	turnTimers.set(room.id, timer);
}

function finalizeDisconnectedPlayer(room, playerId) {
	const player = room.players.get(playerId);
	if (!player) return;
	clearDisconnectTimer(room.id, playerId);
	room.players.delete(playerId);
	room.updatedAt = nowMs();

	if (room.players.size === 0) {
		clearTurnTimer(room.id);
		rooms.delete(room.id);
		return;
	}

	if (room.phase === PHASES.PLAY && player.seat) {
		eliminatePlayer(room, player.seat);
		room.drawOfferSeats = new Set();
		if (room.turnSeat === player.seat) {
			room.turnSeat = nextOccupiedSeat(room, player.seat);
			resetTurnTimer(room);
		}
		checkForWin(room);
	} else {
		if (player.seat) room.seatToPlayerId.delete(player.seat);
		for (const [pid, piece] of room.pieces) {
			if (piece.ownerId === playerId) room.pieces.delete(pid);
		}
	}

	broadcast(room, { type: "presence" });
	broadcastState(room);
	scheduleTurnTimer(room);
}

function scheduleDisconnectFinalization(room, playerId) {
	const player = room.players.get(playerId);
	if (!player) return;
	player.disconnectedAt = nowMs();
	clearDisconnectTimer(room.id, playerId);
	const key = disconnectTimerKey(room.id, playerId);
	const timer = setTimeout(() => {
		disconnectTimers.delete(key);
		const liveRoom = rooms.get(room.id);
		if (!liveRoom) return;
		const livePlayer = liveRoom.players.get(playerId);
		if (!livePlayer || !livePlayer.disconnectedAt) return;
		finalizeDisconnectedPlayer(liveRoom, playerId);
	}, RECONNECT_GRACE_MS);
	disconnectTimers.set(key, timer);
}

wss.on("connection", (ws, req) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const parts = url.pathname.split("/").filter(Boolean);
	const roomId = parts[0] === "ws" && parts[1] === "room" ? parts[2] : null;
	if (!roomId) {
		ws.close(1008, "Missing roomId");
		return;
	}

	const room = getOrCreateRoom(roomId);
	scheduleTurnTimer(room);
	const reconnectToken = String(url.searchParams.get("session") ?? "").trim();
	let player = null;
	if (reconnectToken) {
		for (const candidate of room.players.values()) {
			if (candidate.reconnectToken === reconnectToken) {
				player = candidate;
				break;
			}
		}
	}

	if (player) {
		if (player.ws && player.ws !== ws && player.ws.readyState === player.ws.OPEN) {
			player.ws.close(4001, "Reconnected elsewhere");
		}
		player.ws = ws;
		player.disconnectedAt = null;
		clearDisconnectTimer(room.id, player.id);
	} else {
		const playerId = nanoid(10);
		player = {
			id: playerId,
			ws,
			name: `Player-${playerId.slice(0, 4)}`,
			seat: null,
			ready: false,
			joinedAt: nowMs(),
			disconnectedAt: null,
			reconnectToken: reconnectToken || nanoid(18)
		};
		room.players.set(playerId, player);
	}
	room.updatedAt = nowMs();

	safeSend(ws, {
		type: "hello",
		playerId: player.id,
		seats: SEATS,
		reconnectToken: player.reconnectToken,
		reconnectGraceMs: RECONNECT_GRACE_MS
	});
	safeSend(ws, { type: "state", state: roomSnapshotFor(room, player.id) });
	broadcast(room, { type: "presence" });
	broadcastState(room);

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
			broadcastState(room);
			return;
		}

		if (msg.type === "take_seat") {
			if (room.phase === PHASES.PLAY || room.phase === PHASES.DONE) return;
			const seat = String(msg.seat ?? "");
			if (!SEATS.includes(seat)) return;
			if (room.seatToPlayerId.has(seat)) return;
			if (player.seat) {
				room.seatToPlayerId.delete(player.seat);
				player.ready = false;
			}
			player.seat = seat;
			room.seatToPlayerId.set(seat, player.id);
			ensurePieceSet(room, player.id);
			broadcast(room, { type: "presence" });
			for (const [pid, p] of room.players) {
				safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
			}
			return;
		}

		if (msg.type === "leave_seat") {
			if (room.phase === PHASES.PLAY || room.phase === PHASES.DONE) return;
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
			if (wantsReady && !allPiecesPlaced(room, player.id)) return;
			player.ready = wantsReady;
			for (const [pid, p] of room.players) {
				safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
			}
			if (maybeAdvancePhase(room)) {
				broadcastState(room);
				scheduleTurnTimer(room);
			}
			return;
		}

		if (msg.type === "set_turn_duration") {
			if (room.phase !== PHASES.LOBBY) {
				safeSend(ws, { type: "turn_duration_result", ok: false, reason: "Turn timer can only be changed in the lobby." });
				return;
			}
			const seconds = Number(msg.seconds);
			if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
				safeSend(ws, { type: "turn_duration_result", ok: false, reason: "Turn timer must be an integer number of seconds." });
				return;
			}
			if (seconds < MIN_TURN_DURATION_SEC || seconds > MAX_TURN_DURATION_SEC) {
				safeSend(ws, {
					type: "turn_duration_result",
					ok: false,
					reason: `Turn timer must be between ${MIN_TURN_DURATION_SEC} and ${MAX_TURN_DURATION_SEC} seconds.`
				});
				return;
			}
			room.turnDurationMs = seconds * 1000;
			room.updatedAt = nowMs();
			broadcastState(room);
			safeSend(ws, { type: "turn_duration_result", ok: true, seconds });
			return;
		}

		if (msg.type === "place_piece") {
			const result = applyPlacement(room, player.id, String(msg.pieceId ?? ""), msg.pos ?? null);
			if (!result.ok) return;
			for (const [pid] of room.players) {
				safeSend(room.players.get(pid).ws, { type: "state", state: roomSnapshotFor(room, pid) });
			}
			if (maybeAdvancePhase(room)) {
				broadcastState(room);
				scheduleTurnTimer(room);
			}
			return;
		}

		if (msg.type === "move") {
			const result = applyMove(room, player.id, String(msg.pieceId ?? ""), msg.to ?? null);
			if (!result.ok) {
				safeSend(ws, { type: "move_result", ok: false, reason: result.reason });
				return;
			}
			for (const [pid] of room.players) {
				safeSend(room.players.get(pid).ws, {
					type: "state",
					state: roomSnapshotFor(room, pid)
				});
			}
			scheduleTurnTimer(room);
			return;
		}

		if (msg.type === "forfeit") {
			const result = applyForfeit(room, player.id);
			if (!result.ok) {
				safeSend(ws, { type: "forfeit_result", ok: false, reason: result.reason });
				return;
			}
			broadcast(room, {
				type: "forfeit_result",
				ok: true,
				seat: result.seat,
				by: { id: player.id, name: player.name, seat: player.seat }
			});
			broadcastState(room);
			scheduleTurnTimer(room);
			return;
		}

		if (msg.type === "offer_draw") {
			const result = applyOfferDraw(room, player.id);
			if (!result.ok) {
				safeSend(ws, { type: "draw_offer_result", ok: false, reason: result.reason });
				return;
			}
			broadcast(room, {
				type: "draw_offer_result",
				ok: true,
				seat: result.seat,
				offeredSeats: result.offeredSeats,
				accepted: result.accepted
			});
			broadcastState(room);
			scheduleTurnTimer(room);
			return;
		}

		if (msg.type === "chat") {
			const text = String(msg.text ?? "").slice(0, 300).trim();
			if (!text) return;
			broadcast(room, {
				type: "chat",
				from: { id: player.id, name: player.name, seat: player.seat },
				text,
				at: nowMs()
			});
			return;
		}

		if (msg.type === "export_setup") {
			if (room.phase !== PHASES.LOBBY) {
				safeSend(ws, { type: "setup_file", ok: false, reason: "Setup export is only available in the lobby." });
				return;
			}
			if (!player.seat) {
				safeSend(ws, { type: "setup_file", ok: false, reason: "Take a seat before exporting your setup." });
				return;
			}
			if (!allPiecesPlaced(room, player.id)) {
				safeSend(ws, { type: "setup_file", ok: false, reason: "Place all your pieces before exporting your setup." });
				return;
			}
			safeSend(ws, { type: "setup_file", ok: true, setup: exportSetup(room, player.id) });
			return;
		}

		if (msg.type === "import_setup") {
			const result = applySetupToRoom(room, player.id, msg.setup ?? null);
			if (!result.ok) {
				safeSend(ws, { type: "import_setup_result", ok: false, reason: result.reason });
				return;
			}
			broadcastState(room);
			safeSend(ws, { type: "import_setup_result", ok: true });
			return;
		}

		if (msg.type === "export_game") {
			if (room.phase !== PHASES.DONE) {
				safeSend(ws, { type: "game_file", ok: false, reason: "Game export is only available after the game ends." });
				return;
			}
			safeSend(ws, { type: "game_file", ok: true, game: exportGame(room) });
			return;
		}
	});

	ws.on("close", () => {
		// Ignore stale close events from a socket that was replaced by a reconnect.
		if (player.ws !== ws) return;
		player.ws = null;
		room.updatedAt = nowMs();
		scheduleDisconnectFinalization(room, player.id);
		broadcast(room, { type: "presence" });
		broadcastState(room);
	});
});

server.listen(PORT, HOST, () => {
	// eslint-disable-next-line no-console
	console.log(`Chessforces server on http://${HOST}:${PORT}`);
});
