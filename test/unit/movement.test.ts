import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isValidRailwayMove,
	isValidRoadStep
} from "../../lib/game/index.js";
import { addPlayer, createTestRoom, setPieceAt } from "./helpers.js";

describe("movement", () => {
	it("allows orthogonal road step", () => {
		const room = createTestRoom();
		assert.ok(isValidRoadStep(room, { r: 5, c: 8 }, { r: 5, c: 9 }));
	});

	it("rejects non-adjacent road step", () => {
		const room = createTestRoom();
		assert.ok(!isValidRoadStep(room, { r: 5, c: 8 }, { r: 5, c: 10 }));
	});

	it("allows camp diagonal when either cell is camp", () => {
		const room = createTestRoom();
		assert.ok(isValidRoadStep(room, { r: 2, c: 7 }, { r: 3, c: 8 }));
	});

	it("blocks railway exit from HQ", () => {
		const room = createTestRoom();
		const { playerId } = addPlayer(room, { seat: "N" });
		const captain = setPieceAt(room, playerId, "captain", { r: 0, c: 8 });
		assert.ok(!isValidRailwayMove(room, captain, { r: 0, c: 8 }, { r: 1, c: 8 }));
	});

	it("allows engineer railway slide along track", () => {
		const room = createTestRoom();
		const { playerId } = addPlayer(room, { seat: "N" });
		const engineer = setPieceAt(room, playerId, "engineer", { r: 1, c: 8 });
		assert.ok(isValidRailwayMove(room, engineer, { r: 1, c: 8 }, { r: 5, c: 8 }));
	});

	it("blocks non-engineer from entering mountain", () => {
		const room = createTestRoom();
		const { playerId } = addPlayer(room, { seat: "N" });
		const captain = setPieceAt(room, playerId, "captain", { r: 7, c: 8 });
		assert.ok(!isValidRailwayMove(room, captain, { r: 7, c: 8 }, { r: 7, c: 7 }));
	});

	it("allows engineer to step onto mountain from railway", () => {
		const room = createTestRoom();
		const { playerId } = addPlayer(room, { seat: "N" });
		const engineer = setPieceAt(room, playerId, "engineer", { r: 7, c: 8 });
		assert.ok(isValidRailwayMove(room, engineer, { r: 7, c: 8 }, { r: 7, c: 7 }));
	});

	it("allows center-edge diagonal connector (current behaviour)", () => {
		const room = createTestRoom();
		const { playerId } = addPlayer(room, { seat: "N" });
		const captain = setPieceAt(room, playerId, "captain", { r: 5, c: 10 });
		assert.ok(isValidRailwayMove(room, captain, { r: 5, c: 10 }, { r: 6, c: 11 }));
	});

	it("allows non-engineer diagonal from deep arm rail", () => {
		const room = createTestRoom();
		const { playerId } = addPlayer(room, { seat: "N" });
		const captain = setPieceAt(room, playerId, "captain", { r: 1, c: 6 });
		assert.ok(isValidRailwayMove(room, captain, { r: 1, c: 6 }, { r: 6, c: 5 }));
	});

	it("blocks railway path through occupied cell", () => {
		const room = createTestRoom();
		const { playerId: nId } = addPlayer(room, { seat: "N" });
		const { playerId: eId } = addPlayer(room, { seat: "E" });
		const captain = setPieceAt(room, nId, "captain", { r: 1, c: 6 });
		setPieceAt(room, eId, "lieutenant", { r: 3, c: 6 });
		assert.ok(!isValidRailwayMove(room, captain, { r: 1, c: 6 }, { r: 5, c: 6 }));
	});
});
