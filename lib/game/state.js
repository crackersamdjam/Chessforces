import { nanoid } from "nanoid";
import { createBoard } from "./board.js";
import { PIECE_DEFS, PHASES, SEATS } from "./constants.js";

export function createRoom(id, overrides = {}) {
	return {
		id,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		phase: PHASES.LOBBY,
		players: new Map(),
		seatToPlayerId: new Map(),
		board: createBoard(),
		pieces: new Map(),
		turnSeat: null,
		lastMove: null,
		moveHistory: [],
		initialSetupByPieceId: null,
		gameMode: "ffa",
		winnerTeam: null,
		eliminatedSeats: new Set(),
		gameOverReason: null,
		...overrides
	};
}

export function pieceAt(room, pos) {
	for (const p of room.pieces.values()) {
		if (p.alive !== false && p.pos && p.pos.r === pos.r && p.pos.c === pos.c) return p;
	}
	return null;
}

export function ensurePieceSet(room, playerId, idFn = nanoid) {
	const existing = Array.from(room.pieces.values()).some((p) => p.ownerId === playerId);
	if (existing) return;

	for (const def of PIECE_DEFS) {
		for (let i = 0; i < def.count; i++) {
			const id = idFn(8);
			room.pieces.set(id, {
				id,
				ownerId: playerId,
				type: def.type,
				slot: i,
				label: def.label,
				rank: def.rank,
				pos: null,
				alive: true,
				flagRevealed: false
			});
		}
	}
}

export function roomSnapshotFor(room, viewerId) {
	const players = [];
	for (const [pid, p] of room.players) {
		players.push({
			id: pid,
			name: p.name,
			seat: p.seat,
			ready: p.ready,
			connected: Boolean(p.ws)
		});
	}

	const pieces = [];
	for (const piece of room.pieces.values()) {
		const isOwner = piece.ownerId === viewerId;
		const isRevealed = !!piece.flagRevealed;
		pieces.push({
			id: piece.id,
			ownerSeat: room.players.get(piece.ownerId)?.seat ?? null,
			pos: piece.pos,
			label: isOwner || isRevealed ? piece.label : "?",
			type: isOwner || isRevealed ? piece.type : null,
			flagRevealed: isRevealed
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
		gameMode: room.gameMode ?? "ffa",
		winnerTeam: room.winnerTeam ?? null,
		eliminatedSeats: Array.from(room.eliminatedSeats ?? []),
		gameOverReason: room.gameOverReason ?? null
	};
}

export function allPiecesPlaced(room, playerId) {
	const mine = Array.from(room.pieces.values()).filter((pc) => pc.ownerId === playerId);
	return mine.length > 0 && mine.every((pc) => pc.pos !== null);
}

export function resolveGameMode(seatedCount) {
	return seatedCount === 4 ? "2v2" : "ffa";
}

/** Returns true if the room transitioned from lobby to play. */
export function maybeAdvancePhase(room) {
	if (room.phase !== PHASES.LOBBY) return false;

	const seatedPlayers = Array.from(room.players.values()).filter((p) => p.seat);
	if (seatedPlayers.length < 2) return false;

	const allReady = seatedPlayers.every((p) => p.ready);
	if (!allReady) return false;

	room.gameMode = resolveGameMode(room.seatToPlayerId.size);
	room.phase = PHASES.PLAY;
	room.turnSeat = SEATS.find((s) => room.seatToPlayerId.has(s)) ?? null;
	room.initialSetupByPieceId = snapshotInitialSetupByPieceId(room);
	room.moveHistory = [];
	room.lastMove = null;
	room.updatedAt = Date.now();
	room.winnerTeam = null;
	room.eliminatedSeats = new Set();
	room.gameOverReason = null;
	return true;
}

export function startGame(room) {
	room.phase = PHASES.PLAY;
	room.turnSeat = SEATS.find((s) => room.seatToPlayerId.has(s)) ?? null;
	room.initialSetupByPieceId = snapshotInitialSetupByPieceId(room);
	room.moveHistory = [];
	room.lastMove = null;
	room.updatedAt = Date.now();
	room.winnerTeam = null;
	room.eliminatedSeats = new Set();
	room.gameOverReason = null;
}

export function nextOccupiedSeat(room, fromSeat) {
	const startIdx = SEATS.indexOf(fromSeat);
	for (let i = 1; i <= SEATS.length; i++) {
		const seat = SEATS[(startIdx + i) % SEATS.length];
		if (room.seatToPlayerId.has(seat) && !room.eliminatedSeats.has(seat)) return seat;
	}
	return fromSeat;
}

export function teamOf(room, seat) {
	if (!seat) return null;
	if (room.gameMode === "2v2") return { N: "NS", S: "NS", E: "EW", W: "EW" }[seat] ?? seat;
	return seat;
}

export function eliminatePlayer(room, seat) {
	if (room.eliminatedSeats.has(seat)) return;
	room.eliminatedSeats.add(seat);
	const playerId = room.seatToPlayerId.get(seat);
	if (!playerId) return;
	for (const piece of room.pieces.values()) {
		if (piece.ownerId === playerId && piece.alive !== false) {
			piece.alive = false;
			piece.pos = null;
		}
	}
}

export function isFriendly(room, seatA, seatB) {
	return seatA != null && seatB != null && teamOf(room, seatA) === teamOf(room, seatB);
}

export function checkForWin(room) {
	if (room.phase === PHASES.DONE) return;

	const activeTeams = new Set();
	for (const [seat] of room.seatToPlayerId) {
		if (!room.eliminatedSeats.has(seat)) activeTeams.add(teamOf(room, seat));
	}

	if (activeTeams.size <= 1) {
		room.phase = PHASES.DONE;
		room.winnerTeam = activeTeams.size === 1 ? [...activeTeams][0] : null;
		room.gameOverReason = room.winnerTeam ? "winner" : "draw";
	}
}

function snapshotInitialSetupByPieceId(room) {
	const setup = {};
	for (const piece of room.pieces.values()) {
		setup[piece.id] = piece.pos ? { r: piece.pos.r, c: piece.pos.c } : null;
	}
	return setup;
}
