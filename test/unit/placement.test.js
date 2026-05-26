import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePlacement } from "../../lib/game/index.js";
import { addPlayer, createTestRoom, findPiece } from "./helpers.js";

describe("placement", () => {
	const cases = [
		{
			name: "rejects placement on camp",
			seat: "N",
			type: "captain",
			pos: { r: 3, c: 8 },
			valid: false
		},
		{
			name: "rejects bomb on front row (N)",
			seat: "N",
			type: "bomb",
			pos: { r: 5, c: 8 },
			valid: false
		},
		{
			name: "allows bomb behind front row (N)",
			seat: "N",
			type: "bomb",
			pos: { r: 4, c: 8 },
			valid: true
		},
		{
			name: "rejects mine outside back rows (N)",
			seat: "N",
			type: "mine",
			pos: { r: 3, c: 8 },
			valid: false
		},
		{
			name: "allows mine on back row (N)",
			seat: "N",
			type: "mine",
			pos: { r: 0, c: 8 },
			valid: true
		},
		{
			name: "rejects flag off HQ (N)",
			seat: "N",
			type: "flag",
			pos: { r: 1, c: 8 },
			valid: false
		},
		{
			name: "allows flag on HQ (N)",
			seat: "N",
			type: "flag",
			pos: { r: 0, c: 7 },
			valid: true
		},
		{
			name: "rejects bomb on front col (W)",
			seat: "W",
			type: "bomb",
			pos: { r: 8, c: 5 },
			valid: false
		},
		{
			name: "allows mine on back col (W)",
			seat: "W",
			type: "mine",
			pos: { r: 8, c: 0 },
			valid: true
		},
		{
			name: "rejects piece outside home zone",
			seat: "N",
			type: "captain",
			pos: { r: 8, c: 8 },
			valid: false
		}
	];

	for (const c of cases) {
		it(c.name, () => {
			const room = createTestRoom();
			const { playerId, player } = addPlayer(room, { seat: c.seat });
			const piece = findPiece(room, playerId, c.type);
			piece.pos = c.pos;
			assert.equal(validatePlacement(room, piece, player), c.valid);
		});
	}
});
