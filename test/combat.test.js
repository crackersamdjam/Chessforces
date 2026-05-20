import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCapture } from "../lib/game/index.js";
import { makePiece } from "./helpers.js";

describe("combat", () => {
	const cases = [
		{
			name: "higher rank wins",
			attacker: { type: "captain", rank: 3 },
			defender: { type: "lieutenant", rank: 2 },
			result: "attacker",
			attackerAlive: true,
			defenderAlive: false
		},
		{
			name: "lower rank loses",
			attacker: { type: "lieutenant", rank: 2 },
			defender: { type: "captain", rank: 3 },
			result: "defender",
			attackerAlive: false,
			defenderAlive: true
		},
		{
			name: "equal rank removes both",
			attacker: { type: "captain", rank: 3 },
			defender: { type: "captain", rank: 3 },
			result: "both",
			attackerAlive: false,
			defenderAlive: false
		},
		{
			name: "bomb destroys both",
			attacker: { type: "bomb", rank: null },
			defender: { type: "marshal", rank: 9 },
			result: "both",
			attackerAlive: false,
			defenderAlive: false
		},
		{
			name: "engineer clears mine",
			attacker: { type: "engineer", rank: 1 },
			defender: { type: "mine", rank: null },
			result: "attacker",
			attackerAlive: true,
			defenderAlive: false
		},
		{
			name: "non-engineer dies on mine (mine survives per current code)",
			attacker: { type: "captain", rank: 3 },
			defender: { type: "mine", rank: null },
			result: "defender",
			attackerAlive: false,
			defenderAlive: true
		},
		{
			name: "flag capture",
			attacker: { type: "captain", rank: 3 },
			defender: { type: "flag", rank: null },
			result: "flag",
			attackerAlive: true,
			defenderAlive: false
		}
	];

	for (const c of cases) {
		it(c.name, () => {
			const attacker = makePiece("a1", c.attacker.type, c.attacker.rank, { pos: { r: 0, c: 0 } });
			const defender = makePiece("d1", c.defender.type, c.defender.rank, { pos: { r: 0, c: 1 } });
			const outcome = resolveCapture(attacker, defender);
			assert.equal(outcome.result, c.result);
			assert.equal(attacker.alive !== false, c.attackerAlive);
			assert.equal(defender.alive !== false, c.defenderAlive);
		});
	}

	it("throws on invalid combat", () => {
		const attacker = makePiece("a1", "unknown", null);
		const defender = makePiece("d1", "unknown", null);
		assert.throws(() => resolveCapture(attacker, defender), /Invalid combat resolution/);
	});
});
