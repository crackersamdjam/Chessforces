import { nanoid } from "nanoid";
import { createBoard } from "./board.js";
import { PIECE_DEFS, PHASES, SEATS } from "./constants.js";

export const MIN_TURN_DURATION_SEC = 1;
export const MAX_TURN_DURATION_SEC = 60;
export const MIN_TURN_DURATION_MS = MIN_TURN_DURATION_SEC * 1000;
export const MAX_TURN_DURATION_MS = MAX_TURN_DURATION_SEC * 1000;
export const DEFAULT_TURN_DURATION_MS = 30_000;

function snapTurnDurationMs(ms: number) {
	const raw =
		Number.isFinite(Number(ms)) && Number(ms) > 0
			? Math.floor(Number(ms))
			: DEFAULT_TURN_DURATION_MS;
	return Math.min(MAX_TURN_DURATION_MS, Math.max(MIN_TURN_DURATION_MS, raw));
}

export function createRoom(id: string, overrides: Record<string, any> = {}) {
	return {
		id,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		phase: PHASES.LOBBY,
		players: new Map<string, any>(),
		seatToPlayerId: new Map<string, string>(),
		board: createBoard(),
		pieces: new Map<string, any>(),
		turnSeat: null as string | null,
		turnStartedAt: null as number | null,
		turnDeadlineAt: null as number | null,
		turnDurationMs: DEFAULT_TURN_DURATION_MS,
		lastMove: null,
		moveHistory: [],
		initialSetupByPieceId: null,
		gameMode: "ffa",
		winnerTeam: null,
		eliminatedSeats: new Set<string>(),
		gameOverReason: null,
		drawOfferSeats: new Set<string>(),
		...overrides
	};
}

export function pieceAt(room: any, pos: any) {
	for (const p of room.pieces.values()) {
		if (p.alive !== false && p.pos && p.pos.r === pos.r && p.pos.c === pos.c) return p;
	}
	return null;
}

export function ensurePieceSet(room: any, playerId: string, idFn = nanoid) {
	const existing = (Array.from(room.pieces.values()) as any[]).some((p) => p.ownerId === playerId);
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

export function roomSnapshotFor(room: any, viewerId: string) {
	const turnDurationMs = snapTurnDurationMs(room.turnDurationMs);

	const players: any[] = [];
	for (const [pid, p] of room.players) {
		players.push({
			id: pid,
			name: p.name,
			seat: p.seat,
			ready: p.ready,
			connected: Boolean(p.ws)
		});
	}

	const pieces: any[] = [];
	for (const piece of room.pieces.values()) {
		const isOwner = piece.ownerId === viewerId;
		const isRevealed = !!piece.flagRevealed;
		pieces.push({
			id: piece.id,
			ownerSeat: room.players.get(piece.ownerId)?.seat ?? null,
			pos: piece.pos,
			label: isOwner || isRevealed ? piece.label : "?",
			type: isOwner || isRevealed ? piece.type : null,
			slot: isOwner && Number.isInteger(piece.slot) ? piece.slot : null,
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
		turnStartedAt: room.turnStartedAt ?? null,
		turnDeadlineAt: room.turnDeadlineAt ?? null,
		turnDurationMs,
		lastMove: room.lastMove,
		gameMode: room.gameMode ?? "ffa",
		winnerTeam: room.winnerTeam ?? null,
		eliminatedSeats: Array.from(room.eliminatedSeats ?? []),
		gameOverReason: room.gameOverReason ?? null,
		drawOfferSeats: Array.from(room.drawOfferSeats ?? [])
	};
}

export function allPiecesPlaced(room: any, playerId: string) {
	const mine = (Array.from(room.pieces.values()) as any[]).filter((pc) => pc.ownerId === playerId);
	return mine.length > 0 && mine.every((pc) => pc.pos !== null);
}

export function resolveGameMode(seatedCount: number) {
	return seatedCount === 4 ? "2v2" : "ffa";
}

/** Returns true if the room transitioned from lobby to play. */
export function maybeAdvancePhase(room: any) {
	if (room.phase !== PHASES.LOBBY) return false;

	const seatedPlayers = (Array.from(room.players.values()) as any[]).filter((p) => p.seat);
	if (seatedPlayers.length < 2) return false;

	const allReady = seatedPlayers.every((p) => p.ready);
	if (!allReady) return false;

	room.gameMode = resolveGameMode(room.seatToPlayerId.size);
	room.phase = PHASES.PLAY;
	room.turnSeat = SEATS.find((s) => room.seatToPlayerId.has(s)) ?? null;
	resetTurnTimer(room);
	room.initialSetupByPieceId = snapshotInitialSetupByPieceId(room);
	room.moveHistory = [];
	room.lastMove = null;
	room.updatedAt = Date.now();
	room.winnerTeam = null;
	room.eliminatedSeats = new Set<string>();
	room.gameOverReason = null;
	room.drawOfferSeats = new Set<string>();
	return true;
}

export function startGame(room: any) {
	room.phase = PHASES.PLAY;
	room.turnSeat = SEATS.find((s) => room.seatToPlayerId.has(s)) ?? null;
	resetTurnTimer(room);
	room.initialSetupByPieceId = snapshotInitialSetupByPieceId(room);
	room.moveHistory = [];
	room.lastMove = null;
	room.updatedAt = Date.now();
	room.winnerTeam = null;
	room.eliminatedSeats = new Set<string>();
	room.gameOverReason = null;
	room.drawOfferSeats = new Set<string>();
}

export function nextOccupiedSeat(room: any, fromSeat: (typeof SEATS)[number]) {
	const startIdx = SEATS.indexOf(fromSeat);
	for (let i = 1; i <= SEATS.length; i++) {
		const seat = SEATS[(startIdx + i) % SEATS.length];
		if (room.seatToPlayerId.has(seat) && !room.eliminatedSeats.has(seat)) return seat;
	}
	return fromSeat;
}

export function teamOf(room: any, seat: string | null) {
	if (!seat) return null;
	if (room.gameMode === "2v2") return { N: "NS", S: "NS", E: "EW", W: "EW" }[seat] ?? seat;
	return seat;
}

export function eliminatePlayer(room: any, seat: string) {
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

export function isFriendly(room: any, seatA: string | null, seatB: string | null) {
	return seatA != null && seatB != null && teamOf(room, seatA) === teamOf(room, seatB);
}

export function checkForWin(room: any) {
	if (room.phase === PHASES.DONE) return;

	const activeTeams = new Set<string | null>();
	for (const [seat] of room.seatToPlayerId) {
		if (!room.eliminatedSeats.has(seat)) activeTeams.add(teamOf(room, seat));
	}

	if (activeTeams.size <= 1) {
		room.phase = PHASES.DONE;
		room.winnerTeam = activeTeams.size === 1 ? [...activeTeams][0] : null;
		room.gameOverReason = room.winnerTeam ? "winner" : "draw";
		room.turnStartedAt = null;
		room.turnDeadlineAt = null;
	}
}

export function resetTurnTimer(room: any, now = Date.now()) {
	const turnDurationMs = snapTurnDurationMs(room.turnDurationMs);
	room.turnDurationMs = turnDurationMs;
	if (room.phase !== PHASES.PLAY || !room.turnSeat) {
		room.turnStartedAt = null;
		room.turnDeadlineAt = null;
		return;
	}
	room.turnStartedAt = now;
	room.turnDeadlineAt = now + turnDurationMs;
}

function snapshotInitialSetupByPieceId(room: any) {
	const setup: Record<string, any> = {};
	for (const piece of room.pieces.values()) {
		setup[piece.id] = piece.pos ? { r: piece.pos.r, c: piece.pos.c } : null;
	}
	return setup;
}
