import assert from "node:assert/strict";
import {
	createRoom,
	ensurePieceSet,
	isHQCell,
	PHASES,
	SEATS,
	startGame
} from "../lib/game/index.js";

let nextId = 0;

function testIdFn() {
	nextId += 1;
	return `piece-${nextId}`;
}

export function resetIdCounter() {
	nextId = 0;
}

export function createTestRoom(overrides = {}) {
	resetIdCounter();
	return createRoom("test-room", overrides);
}

export function addPlayer(room, { playerId = `player-${room.players.size + 1}`, seat, name = "Test", ready = false } = {}) {
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

export function findPiece(room, playerId, type) {
	for (const piece of room.pieces.values()) {
		if (piece.ownerId === playerId && piece.type === type && piece.alive !== false) {
			return piece;
		}
	}
	return null;
}

export function setPieceAt(room, playerId, type, pos) {
	const piece = findPiece(room, playerId, type);
	if (!piece) throw new Error(`No ${type} found for player ${playerId}`);
	piece.pos = pos;
	return piece;
}

export function setupMinimalGame(room, seats = ["N", "E"]) {
	const players = {};
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

export function assertPos(piece, r, c) {
	assert.equal(piece.pos?.r, r, `expected row ${r}, got ${piece.pos?.r}`);
	assert.equal(piece.pos?.c, c, `expected col ${c}, got ${piece.pos?.c}`);
}

export function makePiece(id, type, rank = null, overrides = {}) {
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
