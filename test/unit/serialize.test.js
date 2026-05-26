import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applySetupToRoom,
	exportGame,
	exportSetup,
	parseGameDocument,
	parseSetupDocument,
	PHASES
} from "../../lib/game/index.js";
import {
	addPlayer,
	createTestRoom,
	placePlayerPieces,
	playBotMove,
	setup2v2ForPlaythrough
} from "./helpers.js";

describe("serialize", () => {
	it("round-trips personal setup across different seats", () => {
		const room = createTestRoom();
		const { playerId: sourcePlayerId } = addPlayer(room, { seat: "N" });
		placePlayerPieces(room, sourcePlayerId, "N");
		const setupDoc = parseSetupDocument(exportSetup(room, sourcePlayerId));

		const target = createTestRoom();
		const { playerId: targetPlayerId } = addPlayer(target, { seat: "E" });
		const imported = applySetupToRoom(target, targetPlayerId, setupDoc);
		assert.equal(imported.ok, true);

		assert.deepEqual(
			snapshotLocalPieces(room, sourcePlayerId, "N"),
			snapshotLocalPieces(target, targetPlayerId, "E")
		);
	});

	it("replays exported game to the same final state", () => {
		const room = createTestRoom();
		setup2v2ForPlaythrough(room);

		let safety = 120;
		while (room.phase === PHASES.PLAY && safety > 0) {
			const seat = room.turnSeat;
			playBotMove(room, seat);
			safety -= 1;
		}
		assert.ok(room.moveHistory.length > 0);

		const gameDoc = parseGameDocument(exportGame(room));
		const replayFinal = replayGameDoc(gameDoc);
		assert.deepEqual(replayFinal, snapshotPieces(room));
	});

	it("rejects unsupported schema versions", () => {
		assert.throws(
			() =>
				parseSetupDocument({
					format: "chessforces-setup",
					version: 999,
					pieces: []
				}),
			/Unsupported setup version/
		);
		assert.throws(
			() =>
				parseGameDocument({
					format: "chessforces-game",
					version: 999,
					boardSpecVersion: 1,
					gameMode: "2v2",
					initialSetup: { N: [], E: [], S: [], W: [] },
					moves: [],
					result: { phase: "done", winnerTeam: "NS", reason: "winner" }
				}),
			/Unsupported game version/
		);
	});
});

function snapshotPieces(room) {
	const rows = [];
	for (const piece of room.pieces.values()) {
		const seat = room.players.get(piece.ownerId)?.seat ?? null;
		rows.push({
			seat,
			type: piece.type,
			slot: piece.slot ?? 0,
			pos: piece.pos ? { r: piece.pos.r, c: piece.pos.c } : null
		});
	}
	rows.sort((a, b) => {
		if (a.seat !== b.seat) return String(a.seat).localeCompare(String(b.seat));
		if (a.type !== b.type) return a.type.localeCompare(b.type);
		return a.slot - b.slot;
	});
	return rows;
}

function snapshotLocalPieces(room, playerId, seat) {
	const rows = [];
	for (const piece of room.pieces.values()) {
		if (piece.ownerId !== playerId) continue;
		rows.push({
			type: piece.type,
			slot: piece.slot ?? 0,
			pos: toLocalPos(seat, piece.pos)
		});
	}
	rows.sort((a, b) => {
		if (a.type !== b.type) return a.type.localeCompare(b.type);
		return a.slot - b.slot;
	});
	return rows;
}

function replayGameDoc(doc) {
	const byKey = new Map();
	for (const seat of ["N", "E", "S", "W"]) {
		for (const entry of doc.initialSetup[seat]) {
			byKey.set(pieceKey(seat, entry.type, entry.slot), {
				seat,
				type: entry.type,
				slot: entry.slot,
				pos: entry.pos ? { r: entry.pos.r, c: entry.pos.c } : null
			});
		}
	}
	for (const move of doc.moves) {
		const moving = byKey.get(pieceRefKey(move.piece));
		assert.ok(moving, `missing piece ref at ply ${move.ply}`);
		moving.pos = { r: move.to.r, c: move.to.c };
		if (move.capture) {
			const attacker = byKey.get(pieceRefKey(move.capture.attacker));
			const defender = byKey.get(pieceRefKey(move.capture.defender));
			if (move.capture.result === "attacker" || move.capture.result === "flag") {
				if (defender) defender.pos = null;
			} else if (move.capture.result === "defender") {
				if (attacker) attacker.pos = null;
			} else if (move.capture.result === "both") {
				if (attacker) attacker.pos = null;
				if (defender) defender.pos = null;
			}
		}
		for (const seat of move.eliminatedSeats ?? []) {
			for (const piece of byKey.values()) {
				if (piece.seat === seat) piece.pos = null;
			}
		}
	}
	const out = [...byKey.values()];
	out.sort((a, b) => {
		if (a.seat !== b.seat) return a.seat.localeCompare(b.seat);
		if (a.type !== b.type) return a.type.localeCompare(b.type);
		return a.slot - b.slot;
	});
	return out;
}

function pieceRefKey(ref) {
	return pieceKey(ref.seat, ref.type, ref.slot);
}

function pieceKey(seat, type, slot) {
	return `${seat}:${type}:${slot}`;
}

function toLocalPos(seat, pos) {
	if (!pos) return null;
	switch (seat) {
		case "N":
			return { depth: pos.r, lane: pos.c - 6 };
		case "S":
			return { depth: 16 - pos.r, lane: 10 - pos.c };
		case "W":
			return { depth: pos.c, lane: 10 - pos.r };
		case "E":
			return { depth: 16 - pos.c, lane: pos.r - 6 };
		default:
			return null;
	}
}
