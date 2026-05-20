import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyMove,
	applyPlacement,
	checkForWin,
	PHASES,
	resolveGameMode,
	maybeAdvancePhase
} from "../lib/game/index.js";
import {
	addPlayer,
	assertPos,
	createTestRoom,
	findPiece,
	setPieceAt,
	setupMinimalGame
} from "./helpers.js";

describe("game mode", () => {
	it("resolveGameMode: 2–3 ffa, 4 is 2v2", () => {
		assert.equal(resolveGameMode(2), "ffa");
		assert.equal(resolveGameMode(3), "ffa");
		assert.equal(resolveGameMode(4), "2v2");
	});

	it("maybeAdvancePhase sets 2v2 when four players start", () => {
		const room = createTestRoom();
		for (const seat of ["N", "E", "S", "W"]) {
			addPlayer(room, { seat, ready: true });
		}
		assert.equal(maybeAdvancePhase(room), true);
		assert.equal(room.gameMode, "2v2");
		assert.equal(room.phase, PHASES.PLAY);
	});

	it("maybeAdvancePhase sets ffa when three players start", () => {
		const room = createTestRoom();
		for (const seat of ["N", "E", "S"]) {
			addPlayer(room, { seat, ready: true });
		}
		assert.equal(maybeAdvancePhase(room), true);
		assert.equal(room.gameMode, "ffa");
	});

	it("gameMode stays fixed after play begins", () => {
		const room = createTestRoom({ gameMode: "2v2" });
		setupMinimalGame(room, ["N", "E", "S", "W"]);
		room.seatToPlayerId.delete("W");
		assert.equal(room.gameMode, "2v2");
	});
});

describe("actions", () => {
	it("applyPlacement rejects out-of-bounds", () => {
		const room = createTestRoom();
		const { playerId } = addPlayer(room, { seat: "N" });
		const piece = findPiece(room, playerId, "captain");
		const result = applyPlacement(room, playerId, piece.id, { r: 99, c: 99 });
		assert.equal(result.ok, false);
	});

	it("applyPlacement enforces junqi constraints", () => {
		const room = createTestRoom();
		const { playerId } = addPlayer(room, { seat: "N" });
		const bomb = findPiece(room, playerId, "bomb");
		const result = applyPlacement(room, playerId, bomb.id, { r: 5, c: 8 });
		assert.equal(result.ok, false);
	});

	it("rejects move when not your turn", () => {
		const room = createTestRoom();
		setupMinimalGame(room, ["N", "E"]);
		const nId = room.seatToPlayerId.get("N");
		const captain = setPieceAt(room, nId, "captain", { r: 5, c: 8 });
		room.turnSeat = "E";
		const result = applyMove(room, nId, captain.id, { r: 5, c: 9 });
		assert.equal(result.ok, false);
		assert.match(result.reason, /not your turn/i);
	});

	it("captain beats lieutenant on adjacent capture", () => {
		const room = createTestRoom();
		const players = setupMinimalGame(room, ["N", "E"]);
		setPieceAt(room, players.N, "captain", { r: 5, c: 8 });
		const lieutenant = setPieceAt(room, players.E, "lieutenant", { r: 6, c: 8 });
		room.turnSeat = "N";
		const captain = findPiece(room, players.N, "captain");
		const result = applyMove(room, players.N, captain.id, { r: 6, c: 8 });
		assert.equal(result.ok, true);
		assert.equal(result.capture?.result, "attacker");
		assertPos(captain, 6, 8);
		assert.equal(lieutenant.alive, false);
	});

	it("rejects capture of piece on camp", () => {
		const room = createTestRoom();
		const players = setupMinimalGame(room, ["N", "E"]);
		setPieceAt(room, players.N, "captain", { r: 4, c: 7 });
		setPieceAt(room, players.E, "lieutenant", { r: 3, c: 8 });
		room.turnSeat = "N";
		const captain = findPiece(room, players.N, "captain");
		const result = applyMove(room, players.N, captain.id, { r: 3, c: 8 });
		assert.equal(result.ok, false);
		assert.match(result.reason, /camp/i);
	});

	it("flag capture eliminates victim", () => {
		const room = createTestRoom();
		const players = setupMinimalGame(room, ["N", "E"]);
		setPieceAt(room, players.N, "captain", { r: 7, c: 15 });
		room.turnSeat = "N";
		const captain = findPiece(room, players.N, "captain");
		const result = applyMove(room, players.N, captain.id, { r: 7, c: 16 });
		assert.equal(result.ok, true);
		assert.equal(result.capture?.result, "flag");
		assert.ok(room.eliminatedSeats.has("E"));
	});

	it("turn skips eliminated seats", () => {
		const room = createTestRoom();
		const players = setupMinimalGame(room, ["N", "E", "S"]);
		setPieceAt(room, players.N, "captain", { r: 5, c: 8 });
		setPieceAt(room, players.E, "lieutenant", { r: 6, c: 8 });
		setPieceAt(room, players.S, "captain", { r: 12, c: 8 });
		room.turnSeat = "N";
		const captain = findPiece(room, players.N, "captain");
		const result = applyMove(room, players.N, captain.id, { r: 6, c: 8 });
		assert.equal(result.ok, true);
		assert.equal(room.turnSeat, "S");
	});

	it("blocks friendly capture in 2v2", () => {
		const room = createTestRoom({ gameMode: "2v2" });
		const players = setupMinimalGame(room, ["N", "E", "S", "W"]);
		setPieceAt(room, players.N, "captain", { r: 5, c: 8 });
		setPieceAt(room, players.S, "lieutenant", { r: 5, c: 9 });
		room.turnSeat = "N";
		const captain = findPiece(room, players.N, "captain");
		const result = applyMove(room, players.N, captain.id, { r: 5, c: 9 });
		assert.equal(result.ok, false);
		assert.match(result.reason, /friendly/i);
	});

	it("ends game when one team remains in 2v2", () => {
		const room = createTestRoom({ gameMode: "2v2" });
		setupMinimalGame(room, ["N", "E", "S", "W"]);
		room.eliminatedSeats.add("E");
		room.eliminatedSeats.add("W");
		checkForWin(room);
		assert.equal(room.phase, PHASES.DONE);
		assert.equal(room.winnerTeam, "NS");
	});
});
