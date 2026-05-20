/**
 * Create a 4-player cross-shaped board.
 */
export function createBoard() {
	const rows = 17;
	const cols = 17;
	/** @type {{rows:number, cols:number, cells:{r:number,c:number,type:"post"|"camp"|"hq"|"inactive"|"railonly"|"mountain"}[], railEdges:[{r:number,c:number},{r:number,c:number}][]}} */
	// @ts-ignore
	const board = { rows, cols, cells: [] };

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const active = (c >= 6 && c <= 10) || (r >= 6 && r <= 10);
			board.cells.push({ r, c, type: active ? "post" : "inactive" });
		}
	}

	function mark(r, c, type) {
		if (r < 0 || r >= rows || c < 0 || c >= cols) return;
		const cell = board.cells[r * cols + c];
		if (cell.type === "inactive") return;
		cell.type = type;
	}

	mark(0, 7, "hq");  mark(0, 9, "hq");
	mark(2, 7, "camp"); mark(2, 9, "camp");
	mark(3, 8, "camp");
	mark(4, 7, "camp"); mark(4, 9, "camp");

	mark(16, 7, "hq"); mark(16, 9, "hq");
	mark(12, 7, "camp"); mark(12, 9, "camp");
	mark(13, 8, "camp");
	mark(14, 7, "camp"); mark(14, 9, "camp");

	mark(7, 0, "hq");  mark(9, 0, "hq");
	mark(7, 2, "camp"); mark(9, 2, "camp");
	mark(8, 3, "camp");
	mark(7, 4, "camp"); mark(9, 4, "camp");

	mark(7, 16, "hq"); mark(9, 16, "hq");
	mark(7, 12, "camp"); mark(9, 12, "camp");
	mark(8, 13, "camp");
	mark(7, 14, "camp"); mark(9, 14, "camp");

	for (const [r, c] of [[6,7],[7,6],[6,9],[7,8],[7,10],[9,6],[9,8],[9,10],[10,7],[10,9],[8,7],[8,9]]) {
		mark(r, c, "railonly");
	}
	for (const [r, c] of [[7,7],[7,9],[9,7],[9,9]]) {
		mark(r, c, "mountain");
	}

	const railEdges = [];
	function re(r1, c1, r2, c2) { railEdges.push([{ r: r1, c: c1 }, { r: r2, c: c2 }]); }

	for (let c = 6; c < 10; c++) re(1, c, 1, c + 1);
	for (let c = 6; c < 10; c++) re(5, c, 5, c + 1);
	for (let r = 1; r < 6; r++)  re(r, 6, r + 1, 6);
	for (let r = 1; r < 6; r++)  re(r, 10, r + 1, 10);

	for (let c = 6; c < 10; c++) re(11, c, 11, c + 1);
	for (let c = 6; c < 10; c++) re(15, c, 15, c + 1);
	for (let r = 10; r < 15; r++) re(r, 6, r + 1, 6);
	for (let r = 10; r < 15; r++) re(r, 10, r + 1, 10);

	for (let r = 6; r < 10; r++) re(r, 1, r + 1, 1);
	for (let r = 6; r < 10; r++) re(r, 5, r + 1, 5);
	for (let c = 1; c < 6; c++)  re(6, c, 6, c + 1);
	for (let c = 1; c < 6; c++)  re(10, c, 10, c + 1);

	for (let r = 6; r < 10; r++) re(r, 11, r + 1, 11);
	for (let r = 6; r < 10; r++) re(r, 15, r + 1, 15);
	for (let c = 10; c < 15; c++) re(6, c, 6, c + 1);
	for (let c = 10; c < 15; c++) re(10, c, 10, c + 1);

	for (let c = 6; c < 10; c++) re(6, c, 6, c + 1);
	for (let r = 6; r < 10; r++) re(r, 10, r + 1, 10);
	for (let c = 6; c < 10; c++) re(10, c, 10, c + 1);
	for (let r = 6; r < 10; r++) re(r, 6, r + 1, 6);

	for (let r = 5; r < 11; r++) re(r, 8, r + 1, 8);
	for (let c = 5; c < 11; c++) re(8, c, 8, c + 1);

	re(5, 6,  6,  5);
	re(5, 10, 6,  11);
	re(11, 6, 10, 5);
	re(11, 10, 10, 11);

	board.railEdges = railEdges;
	return board;
}

export function boardCellAt(board, pos) {
	if (!pos) return null;
	const { rows, cols, cells } = board;
	if (
		pos.r < 0 ||
		pos.r >= rows ||
		pos.c < 0 ||
		pos.c >= cols ||
		!Array.isArray(cells) ||
		cells.length !== rows * cols
	) {
		return null;
	}
	return cells[pos.r * cols + pos.c] ?? null;
}

export function isInBounds(board, pos) {
	if (!pos) return false;
	if (
		!Number.isInteger(pos.r) ||
		!Number.isInteger(pos.c) ||
		pos.r < 0 ||
		pos.r >= board.rows ||
		pos.c < 0 ||
		pos.c >= board.cols
	) return false;
	const cell = boardCellAt(board, pos);
	return !!cell && cell.type !== "inactive";
}

/** Build (lazily cached) adjacency map from railEdges for BFS. */
export function getRailAdj(room) {
	if (room._railAdj) return room._railAdj;
	const adj = new Map();
	for (const [a, b] of room.board.railEdges) {
		const ak = `${a.r},${a.c}`, bk = `${b.r},${b.c}`;
		if (!adj.has(ak)) adj.set(ak, []);
		if (!adj.has(bk)) adj.set(bk, []);
		adj.get(ak).push(b);
		adj.get(bk).push(a);
	}
	room._railAdj = adj;
	return adj;
}
