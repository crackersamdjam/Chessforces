import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boardCellAt, createBoard } from "../../lib/game/index.js";

describe("board", () => {
	it("creates a 17x17 grid", () => {
		const board = createBoard();
		assert.equal(board.rows, 17);
		assert.equal(board.cols, 17);
		assert.equal(board.cells.length, 17 * 17);
	});

	it("has cross-shaped active cells", () => {
		const board = createBoard();
		const active = board.cells.filter((c) => c.type !== "inactive");
		assert.ok(active.length > 0);
		assert.equal(boardCellAt(board, { r: 0, c: 0 })?.type, "inactive");
		assert.equal(boardCellAt(board, { r: 8, c: 8 })?.type, "post");
	});

	it("marks HQ cells for each arm", () => {
		const board = createBoard();
		for (const pos of [
			{ r: 0, c: 7 }, { r: 0, c: 9 },
			{ r: 16, c: 7 }, { r: 16, c: 9 },
			{ r: 7, c: 0 }, { r: 9, c: 0 },
			{ r: 7, c: 16 }, { r: 9, c: 16 }
		]) {
			assert.equal(boardCellAt(board, pos)?.type, "hq", `HQ at ${pos.r},${pos.c}`);
		}
	});

	it("marks 5 camp cells per arm", () => {
		const board = createBoard();
		const camps = board.cells.filter((c) => c.type === "camp");
		assert.equal(camps.length, 20);
	});

	it("marks 4 mountain cells", () => {
		const board = createBoard();
		const mountains = board.cells.filter((c) => c.type === "mountain");
		assert.equal(mountains.length, 4);
		for (const pos of [{ r: 7, c: 7 }, { r: 7, c: 9 }, { r: 9, c: 7 }, { r: 9, c: 9 }]) {
			assert.equal(boardCellAt(board, pos)?.type, "mountain");
		}
	});

	it("has connected railway edges", () => {
		const board = createBoard();
		assert.ok(board.railEdges.length > 0);
		const keys = new Set();
		for (const [a, b] of board.railEdges) {
			keys.add(`${a.r},${a.c}`);
			keys.add(`${b.r},${b.c}`);
		}
		assert.ok(keys.has("1,8"), "N back railway");
		assert.ok(keys.has("5,8"), "N front railway");
		assert.ok(keys.has("8,5"), "center cross");
	});

	it("marks railonly pass-through cells in center", () => {
		const board = createBoard();
		assert.equal(boardCellAt(board, { r: 7, c: 8 })?.type, "railonly");
	});
});
