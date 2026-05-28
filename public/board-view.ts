// @ts-nocheck

export function createBoard() {
	const rows = 17;
	const cols = 17;
	const cells = [];
	const railEdges = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const active = (c >= 6 && c <= 10) || (r >= 6 && r <= 10);
			cells.push({ r, c, type: active ? "post" : "inactive" });
		}
	}
	function mark(r, c, type) {
		if (r < 0 || r >= rows || c < 0 || c >= cols) return;
		const idx = r * cols + c;
		if (cells[idx].type !== "inactive") cells[idx].type = type;
	}
	for (const [r, c] of [[0, 7], [0, 9], [16, 7], [16, 9], [7, 0], [9, 0], [7, 16], [9, 16]]) mark(r, c, "hq");
	for (const [r, c] of [[2, 7], [2, 9], [3, 8], [4, 7], [4, 9], [12, 7], [12, 9], [13, 8], [14, 7], [14, 9], [7, 2], [9, 2], [8, 3], [7, 4], [9, 4], [7, 12], [9, 12], [8, 13], [7, 14], [9, 14]]) mark(r, c, "camp");
	for (const [r, c] of [[6, 7], [7, 6], [6, 9], [7, 8], [7, 10], [9, 6], [9, 8], [9, 10], [10, 7], [10, 9], [8, 7], [8, 9]]) mark(r, c, "railonly");
	for (const [r, c] of [[7, 7], [7, 9], [9, 7], [9, 9]]) mark(r, c, "mountain");

	function re(r1, c1, r2, c2) {
		railEdges.push([{ r: r1, c: c1 }, { r: r2, c: c2 }]);
	}

	for (let c = 6; c < 10; c++) re(1, c, 1, c + 1);
	for (let c = 6; c < 10; c++) re(5, c, 5, c + 1);
	for (let r = 1; r < 6; r++) re(r, 6, r + 1, 6);
	for (let r = 1; r < 6; r++) re(r, 10, r + 1, 10);

	for (let c = 6; c < 10; c++) re(11, c, 11, c + 1);
	for (let c = 6; c < 10; c++) re(15, c, 15, c + 1);
	for (let r = 10; r < 15; r++) re(r, 6, r + 1, 6);
	for (let r = 10; r < 15; r++) re(r, 10, r + 1, 10);

	for (let r = 6; r < 10; r++) re(r, 1, r + 1, 1);
	for (let r = 6; r < 10; r++) re(r, 5, r + 1, 5);
	for (let c = 1; c < 6; c++) re(6, c, 6, c + 1);
	for (let c = 1; c < 6; c++) re(10, c, 10, c + 1);

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

	re(5, 6, 6, 5);
	re(5, 10, 6, 11);
	re(11, 6, 10, 5);
	re(11, 10, 10, 11);

	return { rows, cols, cells, railEdges };
}

export function buildBoardViews(boardEl, board, options = {}) {
	const { onCellClick = null, includeCoords = false } = options;
	const { rows, cols, cells, railEdges } = board;
	boardEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
	boardEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
	boardEl.innerHTML = "";

	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("viewBox", `0 0 ${cols} ${rows}`);
	svg.setAttribute("preserveAspectRatio", "none");
	svg.classList.add("boardSvg");
	boardEl.appendChild(svg);

	function svgLine(x1, y1, x2, y2, cls) {
		const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
		l.setAttribute("x1", String(x1));
		l.setAttribute("y1", String(y1));
		l.setAttribute("x2", String(x2));
		l.setAttribute("y2", String(y2));
		l.setAttribute("class", cls);
		svg.appendChild(l);
	}

	function svgArc(x1, y1, x2, y2, cls) {
		const r1 = y1 - 0.5;
		const c1 = x1 - 0.5;
		const r2 = y2 - 0.5;
		const c2 = x2 - 0.5;
		let icr;
		let icc;
		if (r2 >= 6 && r2 <= 10 && c1 >= 6 && c1 <= 10) {
			icr = r1;
			icc = c2;
		} else {
			icr = r2;
			icc = c1;
		}
		const cx = icc + 0.5;
		const cy = icr + 0.5;
		const cross = (x1 - cx) * (y2 - cy) - (y1 - cy) * (x2 - cx);
		const sweep = cross > 0 ? 1 : 0;
		const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
		p.setAttribute("d", `M ${x1} ${y1} A 1 1 0 0 ${sweep} ${x2} ${y2}`);
		p.setAttribute("class", cls);
		svg.appendChild(p);
	}

	const roadKeys = new Set(
		cells
			.filter((c) => c.type !== "inactive" && c.type !== "railonly" && c.type !== "mountain")
			.map((c) => `${c.r},${c.c}`)
	);
	const railSet = new Set();
	for (const [a, b] of railEdges ?? []) {
		const k = a.r < b.r || (a.r === b.r && a.c <= b.c)
			? `${a.r},${a.c},${b.r},${b.c}`
			: `${b.r},${b.c},${a.r},${a.c}`;
		railSet.add(k);
	}
	function edgeKey(r1, c1, r2, c2) {
		return r1 < r2 || (r1 === r2 && c1 <= c2)
			? `${r1},${c1},${r2},${c2}`
			: `${r2},${c2},${r1},${c1}`;
	}

	for (const { r, c } of cells) {
		if (!roadKeys.has(`${r},${c}`)) continue;
		if (roadKeys.has(`${r},${c + 1}`)) {
			const k = edgeKey(r, c, r, c + 1);
			if (!railSet.has(k)) svgLine(c + 0.5, r + 0.5, c + 1.5, r + 0.5, "boardRoad");
		}
		if (roadKeys.has(`${r + 1},${c}`)) {
			const k = edgeKey(r, c, r + 1, c);
			if (!railSet.has(k)) svgLine(c + 0.5, r + 0.5, c + 0.5, r + 1.5, "boardRoad");
		}
	}

	const campDiagSet = new Set();
	for (const { r, c, type } of cells) {
		if (type !== "camp") continue;
		for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
			const nr = r + dr;
			const nc = c + dc;
			if (!roadKeys.has(`${nr},${nc}`)) continue;
			const ek = r < nr || (r === nr && c < nc)
				? `${r},${c},${nr},${nc}`
				: `${nr},${nc},${r},${c}`;
			if (campDiagSet.has(ek)) continue;
			campDiagSet.add(ek);
			svgLine(c + 0.5, r + 0.5, nc + 0.5, nr + 0.5, "boardRoad");
		}
	}

	for (const [a, b] of railEdges ?? []) {
		const x1 = a.c + 0.5;
		const y1 = a.r + 0.5;
		const x2 = b.c + 0.5;
		const y2 = b.r + 0.5;
		const isDiag = Math.abs(a.r - b.r) === 1 && Math.abs(a.c - b.c) === 1;
		const draw = isDiag ? svgArc : svgLine;
		draw(x1, y1, x2, y2, "boardRailBase");
		draw(x1, y1, x2, y2, "boardRailDash");
	}

	const views = new Map();
	for (const cellDef of cells) {
		const { r, c, type } = cellDef;
		const cell = document.createElement("div");
		const key = `${r},${c}`;

		if (type === "inactive" || type === "railonly") {
			cell.className = "cell cell--inactive";
			boardEl.appendChild(cell);
			continue;
		}

		if (type === "mountain") {
			cell.className = "cell cell--mountain";
			const lbl = document.createElement("div");
			lbl.className = "mountainLabel";
			lbl.textContent = "山界";
			cell.appendChild(lbl);
		} else {
			cell.className = "cell";
			cell.classList.add(
				type === "camp" ? "cell--camp" : type === "hq" ? "cell--hq" : "cell--post"
			);
			if (type === "camp" || type === "hq") {
				const lbl = document.createElement("div");
				lbl.className = type === "camp" ? "campLabel" : "hqLabel";
				lbl.textContent = type === "camp" ? "行营" : "大本营";
				cell.appendChild(lbl);
			}
		}

		cell.dataset.r = String(r);
		cell.dataset.c = String(c);
		if (includeCoords) {
			const coord = document.createElement("div");
			coord.className = "cellCoord";
			coord.textContent = `${r},${c}`;
			cell.appendChild(coord);
		}

		const tokenHost = document.createElement("div");
		tokenHost.className = "cellTokenHost";
		cell.appendChild(tokenHost);

		if (onCellClick) {
			cell.addEventListener("click", () => onCellClick({ r, c }));
		}

		boardEl.appendChild(cell);
		views.set(key, { cell, tokenHost });
	}
	return views;
}
