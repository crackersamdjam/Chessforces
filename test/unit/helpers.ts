import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import {
	applyMove,
	applyPlacement,
	createRoom,
	ensurePieceSet,
	findLegalPlayMoves,
	isHQCell,
	maybeAdvancePhase,
	PHASES,
	SEATS,
	startGame
} from "../../lib/game/index.js";
import { homeInfoForSeat } from "../../lib/game/placement.js";

let nextId = 0;

function testIdFn<Type extends string = string>(_size?: number): Type {
	nextId += 1;
	return `piece-${nextId}` as Type;
}

export function resetIdCounter() {
	nextId = 0;
}

export function createTestRoom(overrides: Record<string, any> = {}) {
	resetIdCounter();
	return createRoom("test-room", overrides);
}

export function addPlayer(
	room: any,
	{ playerId = `player-${room.players.size + 1}`, seat = null, name = "Test", ready = false }: { playerId?: string; seat?: string | null; name?: string; ready?: boolean } = {}
) {
	const player = {
		id: playerId,
		name,
		seat: seat ?? null,
		ready,
		joinedAt: Date.now()
	};
	room.players.set(playerId, player);
	if (seat) {
		room.seatToPlayerId.set(seat, playerId);
		ensurePieceSet(room, playerId, testIdFn);
	}
	return { playerId, seat, player };
}

export function findPiece(room: any, playerId: string, type: string) {
	for (const piece of room.pieces.values()) {
		if (piece.ownerId === playerId && piece.type === type && piece.alive !== false) {
			return piece;
		}
	}
	return null;
}

export function setPieceAt(room: any, playerId: string, type: string, pos: { r: number; c: number }) {
	const piece = findPiece(room, playerId, type);
	if (!piece) throw new Error(`No ${type} found for player ${playerId}`);
	piece.pos = pos;
	return piece;
}

export function setupMinimalGame(room: any, seats = ["N", "E"]) {
	const players: Record<string, string> = {};
	for (const seat of seats) {
		const { playerId } = addPlayer(room, { seat });
		players[seat] = playerId;
		const flag = findPiece(room, playerId, "flag");
		const hqPos = room.board.cells.find(
			(c) => c.type === "hq" && isHQCell(room.board, seat, c)
		);
		if (!hqPos) throw new Error(`No HQ for seat ${seat}`);
		flag.pos = { r: hqPos.r, c: hqPos.c };
	}
	startGame(room);
	room.turnSeat = SEATS.find((s) => room.seatToPlayerId.has(s)) ?? null;
	room.phase = PHASES.PLAY;
	return players;
}

export function assertPos(piece: any, r: number, c: number) {
	assert.equal(piece.pos?.r, r, `expected row ${r}, got ${piece.pos?.r}`);
	assert.equal(piece.pos?.c, c, `expected col ${c}, got ${piece.pos?.c}`);
}

export function makePiece(id: string, type: string, rank: number | null = null, overrides: Record<string, any> = {}) {
	return {
		id,
		ownerId: "owner",
		type,
		label: type,
		rank,
		pos: null,
		alive: true,
		flagRevealed: false,
		...overrides
	};
}

function sortCells(cells: Array<{ r: number; c: number }>) {
	return [...cells].sort((a, b) => a.r - b.r || a.c - b.c);
}

/** Legal placement (mirrors client randomize cell rules). */
export function placePlayerPieces(room: any, playerId: string, seat: string) {
	const pick = (arr: any[]) => arr[randomInt(arr.length)];
	const info: any = homeInfoForSeat(room.board, seat);
	if (!info) throw new Error(`No home zone for seat ${seat}`);

	const allHomeCells = room.board.cells.filter(
		(cell) =>
			cell.r >= info.minR &&
			cell.r <= info.maxR &&
			cell.c >= info.minC &&
			cell.c <= info.maxC &&
			cell.type !== "inactive"
	);
	const postCells = allHomeCells.filter((cell) => cell.type === "post");
	const hqCells = allHomeCells.filter((cell) => cell.type === "hq");

	let flagCells: Array<{ r: number; c: number }>;
	let mineCells: Array<{ r: number; c: number }>;
	let bombCells: Array<{ r: number; c: number }>;
	let normalCells: Array<{ r: number; c: number }>;
	if (info.orientation === "row") {
		flagCells = hqCells.filter((cell) => cell.r === info.hqRow && info.hqCols.includes(cell.c));
		mineCells = postCells.filter((cell) => info.mineRows.includes(cell.r));
		bombCells = [...postCells, ...hqCells].filter((cell) => cell.r !== info.frontRow);
		normalCells = [...postCells, ...hqCells];
	} else {
		flagCells = hqCells.filter((cell) => cell.c === info.hqCol && info.hqRows.includes(cell.r));
		mineCells = postCells.filter((cell) => info.mineCols.includes(cell.c));
		bombCells = [...postCells, ...hqCells].filter((cell) => cell.c !== info.frontCol);
		normalCells = [...postCells, ...hqCells];
	}

	flagCells = sortCells(flagCells);
	mineCells = sortCells(mineCells);
	bombCells = sortCells(bombCells);
	normalCells = sortCells(normalCells);

	const pieces = (Array.from(room.pieces.values()) as any[]).filter((p) => p.ownerId === playerId);
	const ordered = [
		...pieces.filter((p) => p.type === "flag"),
		...pieces.filter((p) => p.type === "mine"),
		...pieces.filter((p) => p.type === "bomb"),
		...pieces.filter((p) => p.type !== "flag" && p.type !== "mine" && p.type !== "bomb")
	];

	for (const piece of ordered) {
		let candidates: Array<{ r: number; c: number }>;
		if (piece.type === "flag") candidates = flagCells;
		else if (piece.type === "mine") candidates = mineCells;
		else if (piece.type === "bomb") candidates = bombCells;
		else candidates = normalCells;

		const available = candidates.filter((pos) => !pieceAt(room, pos));
		assert.ok(available.length > 0, `No placement cell for ${piece.type} (${seat})`);
		const pos = pick(available);
		const result = applyPlacement(room, playerId, piece.id, pos);
		assert.equal(result.ok, true, `place ${piece.type} at ${pos.r},${pos.c}: ${result.reason}`);
	}
}

/** Four seated players, full placement, lobby → play (2v2). */
export function setup2v2ForPlaythrough(room: any) {
	const players: Record<string, string> = {};
	for (const seat of ["N", "E", "S", "W"]) {
		const { playerId, player } = addPlayer(room, { seat });
		players[seat] = playerId;
		placePlayerPieces(room, playerId, seat);
		player.ready = true;
	}
	assert.equal(maybeAdvancePhase(room), true);
	assert.equal(room.gameMode, "2v2");
	assert.equal(room.phase, PHASES.PLAY);
	return players;
}

function pieceAt(room: any, pos: { r: number; c: number }) {
	for (const p of room.pieces.values()) {
		if (p.alive !== false && p.pos && p.pos.r === pos.r && p.pos.c === pos.c) return p;
	}
	return null;
}

/** Try biased legal moves first, then any legal move; returns applyMove result. */
export function playBotMove(room: any, seat: string) {
	const playerId = room.seatToPlayerId.get(seat);
	const candidates = [
		...findLegalPlayMoves(room, seat, { biasToEnemyHq: true }),
		...findLegalPlayMoves(room, seat, { limit: 32 })
	];
	const seen = new Set<string>();
	let lastReason: string | null = null;
	for (const { pieceId, to } of candidates) {
		const key = `${pieceId}:${to.r},${to.c}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const result = applyMove(room, playerId, pieceId, to);
		if (result.ok) return result;
		lastReason = result.reason ?? null;
	}
	throw new Error(`No legal move for seat ${seat}${lastReason ? `: ${lastReason}` : ""}`);
}
