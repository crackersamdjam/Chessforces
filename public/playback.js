const PIECE_LABELS = {
	marshal: "司令(40)",
	general: "军长(39)",
	major_general: "师长(38)",
	brigadier: "旅长(37)",
	colonel: "团长(36)",
	major: "营长(35)",
	captain: "连长(34)",
	lieutenant: "排长(33)",
	engineer: "工兵(1)",
	bomb: "炸弹(0)",
	mine: "地雷(X)",
	flag: "军旗($)"
};

export function initPlaybackPage() {
	const board = createBoard();
	const boardViews = buildBoardViews("replayBoard", board);
	/** @type {{moves:any[], snapshots:any[], result:any}|null} */
	let replay = null;
	let moveIndex = 0;

	const fileInput = document.getElementById("playbackFileInput");
	const seatFilter = document.getElementById("replaySeatFilter");
	const statusLine = document.getElementById("replayStatusLine");
	const moveLabel = document.getElementById("replayMoveLabel");
	const hint = document.getElementById("replayHint");

	const setHint = (text) => {
		hint.textContent = text || "";
	};

	function render() {
		const snapshot = replay ? replay.snapshots[moveIndex] : null;
		const filter = seatFilter.value;
		moveLabel.textContent = replay
			? `Move ${moveIndex}/${Math.max(0, replay.moves.length)}`
			: "Move 0/0";
		statusLine.textContent = replay
			? moveIndex === replay.moves.length
				? `Replay complete (${replay.result?.winnerTeam ?? "no winner"})`
				: `Viewing move ${moveIndex + 1} of ${replay.moves.length}`
			: "No game loaded.";

		for (const [key, view] of boardViews.entries()) {
			view.cell.classList.remove("cell--lastFrom", "cell--lastTo");
			view.tokenHost.innerHTML = "";
			if (!snapshot) continue;
			const piece = snapshot.pieceByCell.get(key);
			if (!piece) continue;
			if (snapshot.lastMove?.from && key === `${snapshot.lastMove.from.r},${snapshot.lastMove.from.c}`) {
				view.cell.classList.add("cell--lastFrom");
			}
			if (snapshot.lastMove?.to && key === `${snapshot.lastMove.to.r},${snapshot.lastMove.to.c}`) {
				view.cell.classList.add("cell--lastTo");
			}
			const token = document.createElement("div");
			token.className = `token token--seat-${piece.ownerSeat}`;
			const label = filter === "all" || filter === piece.ownerSeat ? piece.label : "?";
			token.innerHTML = `<div class="label">${escapeHtml(label)}</div>`;
			view.tokenHost.appendChild(token);
		}
	}

	fileInput.addEventListener("change", async () => {
		const file = fileInput.files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			const doc = JSON.parse(text);
			replay = buildReplay(doc);
			moveIndex = 0;
			setHint("");
		} catch (err) {
			replay = null;
			moveIndex = 0;
			setHint(err instanceof Error ? err.message : "Invalid replay file.");
		}
		render();
	});

	seatFilter.addEventListener("change", render);
	document.getElementById("replayFirstBtn").addEventListener("click", () => {
		if (!replay) return;
		moveIndex = 0;
		render();
	});
	document.getElementById("replayPrevBtn").addEventListener("click", () => {
		if (!replay) return;
		moveIndex = Math.max(0, moveIndex - 1);
		render();
	});
	document.getElementById("replayNextBtn").addEventListener("click", () => {
		if (!replay) return;
		moveIndex = Math.min(replay.moves.length, moveIndex + 1);
		render();
	});
	document.getElementById("replayLastBtn").addEventListener("click", () => {
		if (!replay) return;
		moveIndex = replay.moves.length;
		render();
	});

	render();
}

function buildReplay(doc) {
	validateGameDoc(doc);
	const piecesByKey = new Map();
	for (const seat of ["N", "E", "S", "W"]) {
		for (const entry of doc.initialSetup[seat]) {
			const key = pieceKey(entry);
			piecesByKey.set(key, {
				ownerSeat: seat,
				type: entry.type,
				slot: entry.slot,
				label: PIECE_LABELS[entry.type] ?? entry.type,
				pos: entry.pos ? { r: entry.pos.r, c: entry.pos.c } : null
			});
		}
	}

	const snapshots = [makeSnapshot(piecesByKey, null)];
	for (const move of doc.moves) {
		const piece = piecesByKey.get(pieceKey(move.piece));
		if (!piece || !piece.pos) throw new Error(`Replay move ${move.ply} references missing piece.`);
		piece.pos = { r: move.to.r, c: move.to.c };
		if (move.capture) {
			const attacker = piecesByKey.get(pieceKey(move.capture.attacker));
			const defender = piecesByKey.get(pieceKey(move.capture.defender));
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
			for (const otherPiece of piecesByKey.values()) {
				if (otherPiece.ownerSeat === seat) otherPiece.pos = null;
			}
		}
		snapshots.push(makeSnapshot(piecesByKey, move));
	}

	return {
		moves: doc.moves,
		snapshots,
		result: doc.result
	};
}

function makeSnapshot(piecesByKey, lastMove) {
	const pieceByCell = new Map();
	for (const piece of piecesByKey.values()) {
		if (!piece.pos) continue;
		pieceByCell.set(`${piece.pos.r},${piece.pos.c}`, {
			ownerSeat: piece.ownerSeat,
			label: piece.label
		});
	}
	return { pieceByCell, lastMove };
}

function pieceKey(piece) {
	return `${piece.seat}:${piece.type}:${piece.slot}`;
}

function validateGameDoc(doc) {
	if (!doc || typeof doc !== "object") throw new Error("Replay file must be a JSON object.");
	if (doc.format !== "chessforces-game") throw new Error("Unsupported replay format.");
	if (doc.version !== 1) throw new Error("Unsupported replay version.");
	if (doc.boardSpecVersion !== 1) throw new Error("Unsupported board spec version.");
	for (const seat of ["N", "E", "S", "W"]) {
		if (!Array.isArray(doc.initialSetup?.[seat])) throw new Error(`Missing initial setup for seat ${seat}.`);
	}
	if (!Array.isArray(doc.moves)) throw new Error("Replay moves must be an array.");
}

function buildBoardViews(boardId, board) {
	const boardEl = document.getElementById(boardId);
	boardEl.style.gridTemplateColumns = `repeat(${board.cols}, 1fr)`;
	boardEl.style.gridTemplateRows = `repeat(${board.rows}, 1fr)`;
	boardEl.innerHTML = "";
	const views = new Map();
	for (const cellDef of board.cells) {
		const { r, c, type } = cellDef;
		const cell = document.createElement("div");
		const key = `${r},${c}`;
		if (type === "inactive" || type === "railonly") {
			cell.className = "cell cell--inactive";
			boardEl.appendChild(cell);
			continue;
		}
		cell.className = "cell";
		if (type === "camp") cell.classList.add("cell--camp");
		if (type === "hq") cell.classList.add("cell--hq");
		if (type === "mountain") cell.classList.add("cell--mountain");
		const host = document.createElement("div");
		host.className = "cellTokenHost";
		cell.appendChild(host);
		boardEl.appendChild(cell);
		views.set(key, { cell, tokenHost: host });
	}
	return views;
}

function createBoard() {
	const rows = 17;
	const cols = 17;
	const cells = [];
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
	return { rows, cols, cells };
}

function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}
