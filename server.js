import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";
import {
	SEATS,
	PHASES,
	applyMove,
	applyPlacement,
	allPiecesPlaced,
	createRoom,
	eliminatePlayer,
	ensurePieceSet,
	maybeAdvancePhase,
	nextOccupiedSeat,
	checkForWin,
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
	// Prevent browsers and proxies from serving stale JS/CSS after a deploy.
	setHeaders(res, filePath) {
		if (filePath.endsWith(".js") || filePath.endsWith(".css")) {
			res.setHeader("Cache-Control", "no-cache");
		}
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

function broadcastState(room) {
	for (const [pid, p] of room.players) {
		safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
	}
}

function getOrCreateRoom(roomId) {
	let room = rooms.get(roomId);
	if (!room) {
		room = createRoom(roomId);
		rooms.set(roomId, room);
	}
	return room;
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
	const playerId = nanoid(10);

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
			room.seatToPlayerId.set(seat, playerId);
			ensurePieceSet(room, playerId);
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
			if (wantsReady && !allPiecesPlaced(room, playerId)) return;
			player.ready = wantsReady;
			for (const [pid, p] of room.players) {
				safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
			}
			if (maybeAdvancePhase(room)) {
				broadcastState(room);
			}
			return;
		}

		if (msg.type === "place_piece") {
			const result = applyPlacement(room, playerId, String(msg.pieceId ?? ""), msg.pos ?? null);
			if (!result.ok) return;
			for (const [pid] of room.players) {
				safeSend(room.players.get(pid).ws, { type: "state", state: roomSnapshotFor(room, pid) });
			}
			if (maybeAdvancePhase(room)) {
				broadcastState(room);
			}
			return;
		}

		if (msg.type === "move") {
			const result = applyMove(room, playerId, String(msg.pieceId ?? ""), msg.to ?? null);
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

		if (msg.type === "export_setup") {
			if (room.phase !== PHASES.LOBBY) {
				safeSend(ws, { type: "setup_file", ok: false, reason: "Setup export is only available in the lobby." });
				return;
			}
			if (!player.seat) {
				safeSend(ws, { type: "setup_file", ok: false, reason: "Take a seat before exporting your setup." });
				return;
			}
			if (!allPiecesPlaced(room, playerId)) {
				safeSend(ws, { type: "setup_file", ok: false, reason: "Place all your pieces before exporting your setup." });
				return;
			}
			safeSend(ws, { type: "setup_file", ok: true, setup: exportSetup(room, playerId) });
			return;
		}

		if (msg.type === "import_setup") {
			const result = applySetupToRoom(room, playerId, msg.setup ?? null);
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
		room.players.delete(playerId);
		room.updatedAt = nowMs();

		if (room.players.size === 0) {
			rooms.delete(room.id);
			return;
		}

		if (room.phase === PHASES.PLAY && player.seat) {
			eliminatePlayer(room, player.seat);
			if (room.turnSeat === player.seat) {
				room.turnSeat = nextOccupiedSeat(room, player.seat);
			}
			checkForWin(room);
		} else {
			if (player.seat) room.seatToPlayerId.delete(player.seat);
			for (const [pid, piece] of room.pieces) {
				if (piece.ownerId === playerId) room.pieces.delete(pid);
			}
		}

		broadcast(room, { type: "presence" });
		for (const [pid] of room.players) {
			safeSend(room.players.get(pid).ws, { type: "state", state: roomSnapshotFor(room, pid) });
		}
	});
});

server.listen(PORT, HOST, () => {
	// eslint-disable-next-line no-console
	console.log(`Chessforces server on http://${HOST}:${PORT}`);
});
