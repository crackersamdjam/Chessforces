import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applySetupToRoom,
	exportGame,
	exportSetup,
	parseGameDocument,
	parseSetupDocument,
	PHASES
} from "../lib/game/index.js";
import {
	addPlayer,
	createTestRoom,
	placePlayerPieces,
	playBotMove,
	setup2v2ForPlaythrough
} from "./helpers.js";

describe("serialize", () => {
	it("round-trips full-room setup export/import", () => {
		const room = createTestRoom();
		for (const seat of ["N", "E", "S", "W"]) {
			const { playerId } = addPlayer(room, { seat });
			placePlayerPieces(room, playerId, seat);
		}
		const setupDoc = parseSetupDocument(exportSetup(room));

		const target = createTestRoom();
		for (const seat of ["N", "E", "S", "W"]) {
			addPlayer(target, { seat });
		}
		const imported = applySetupToRoom(target, setupDoc);
		assert.equal(imported.ok, true);

		assert.deepEqual(snapshotPieces(target), snapshotPieces(room));
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
					gameMode: "2v2",
					seats: { N: [], E: [], S: [], W: [] }
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
