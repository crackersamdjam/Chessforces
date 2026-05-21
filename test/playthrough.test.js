import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyMove, enemyHqTargetsForSeat, eliminatePlayer, PHASES } from "../lib/game/index.js";
import { createTestRoom, playBotMove, setup2v2ForPlaythrough } from "./helpers.js";

const MAX_MOVES = 500;

const logPlaythrough = process.env.LOG_PLAYTHROUGH === "1";

describe("2v2 playthrough", () => {
	it("biases toward the first uncaptured enemy HQ only", () => {
		const room = createTestRoom();
		setup2v2ForPlaythrough(room);

		assert.deepEqual(enemyHqTargetsForSeat(room, "N")[0], { r: 7, c: 0 });
		eliminatePlayer(room, "W");
		assert.deepEqual(enemyHqTargetsForSeat(room, "N")[0], { r: 7, c: 16 });
		eliminatePlayer(room, "E");
		assert.deepEqual(enemyHqTargetsForSeat(room, "N"), []);
	});

	it("plays a full game to completion via lib/game only", () => {
		const room = createTestRoom();
		setup2v2ForPlaythrough(room);

		let moves = 0;
		while (room.phase === PHASES.PLAY) {
			assert.ok(moves < MAX_MOVES, `exceeded ${MAX_MOVES} moves without finishing`);
			const seat = room.turnSeat;
			assert.ok(seat, "expected turnSeat during play");
			const result = playBotMove(room, seat);
			assert.equal(result.ok, true);
			moves++;
			const { from, to, by } = result.lastMove;
			if (logPlaythrough) {
				// eslint-disable-next-line no-console
				console.log(`#${moves} ${by}: (${from.r},${from.c}) → (${to.r},${to.c})`);
			}
		}

		assert.equal(room.phase, PHASES.DONE);
		assert.ok(moves > 0, "expected at least one move");
		assert.ok(room.winnerTeam === "NS" || room.winnerTeam === "EW", "expected a team winner");
		if (logPlaythrough) {
			// eslint-disable-next-line no-console
			console.log(`Game over: team ${room.winnerTeam} (${moves} moves)`);
		}
	});
});
