import { buildReplayFromGameDoc } from "./game-replay.js";
import { buildBoardViews, createBoard } from "./board-view.js";

export function initPlaybackPage() {
	const board = createBoard();
	const boardEl = document.getElementById("replayBoard") as HTMLElement;
	const boardViews = buildBoardViews(boardEl, board);
	let replay: { moves: any[]; snapshots: any[]; result: any } | null = null;
	let moveIndex = 0;

	const fileInput = document.getElementById("playbackFileInput") as HTMLInputElement;
	const seatFilter = document.getElementById("replaySeatFilter") as HTMLSelectElement;
	const statusLine = document.getElementById("replayStatusLine") as HTMLElement;
	const moveLabel = document.getElementById("replayMoveLabel") as HTMLElement;
	const hint = document.getElementById("replayHint") as HTMLElement;

	const setHint = (text: string) => {
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
			replay = buildReplayFromGameDoc(doc);
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
	document.getElementById("replayFirstBtn")!.addEventListener("click", () => {
		if (!replay) return;
		moveIndex = 0;
		render();
	});
	document.getElementById("replayPrevBtn")!.addEventListener("click", () => {
		if (!replay) return;
		moveIndex = Math.max(0, moveIndex - 1);
		render();
	});
	document.getElementById("replayNextBtn")!.addEventListener("click", () => {
		if (!replay) return;
		moveIndex = Math.min(replay.moves.length, moveIndex + 1);
		render();
	});
	document.getElementById("replayLastBtn")!.addEventListener("click", () => {
		if (!replay) return;
		moveIndex = replay.moves.length;
		render();
	});

	render();
}

function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}
