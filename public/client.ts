import { initPlaybackPage } from "./playback.js";
import { buildReplayFromGameDoc } from "./game-replay.js";
import { buildBoardViews } from "./board-view.js";

function $<T extends HTMLElement = HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

function genRoomId() {
	// Simple client-side id generator; good enough for a casual game.
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < 10; i++) {
		s += chars[Math.floor(Math.random() * chars.length)];
	}
	return s;
}

function roomIdFromPath() {
	const match = location.pathname.match(/^\/room\/([^/]+)/);
	return match ? decodeURIComponent(match[1]) : null;
}

function isPlaybackPath() {
	return location.pathname === "/playback";
}

function wsUrlFor(roomId, sessionToken = "") {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	const base = `${proto}//${location.host}/ws/room/${roomId}`;
	if (!sessionToken) return base;
	return `${base}?session=${encodeURIComponent(sessionToken)}`;
}

function sessionStorageKey(roomId) {
	return `chessforces:session:${roomId}`;
}

function readSessionToken(roomId) {
	try {
		return localStorage.getItem(sessionStorageKey(roomId)) || "";
	} catch {
		return "";
	}
}

function writeSessionToken(roomId, token) {
	if (!token) return;
	try {
		localStorage.setItem(sessionStorageKey(roomId), token);
	} catch {
		// Ignore storage failures (private mode / storage disabled).
	}
}

let socket: WebSocket | null = null;

interface AppState {
	playerId: string | null;
	seats: string[];
	state: any;
	liveState: any;
	historySnapshots: any[];
	historyCursor: number;
	historySource: "live" | "replay";
}

const app: AppState = {
	playerId: null,
	seats: ["N", "E", "S", "W"],
	state: null,
	liveState: null,
	historySnapshots: [],
	historyCursor: 0,
	historySource: "live"
};

let selectedPieceId: string | null = null;
let turnCountdownInterval: any = null;
let pendingGameDownloadRequest = false;
let pendingReplayHistoryRequest = false;
let replayHistoryLoaded = false;

function isPlayablePhase(phase) {
	return phase === "play" || phase === "done";
}

function cloneState(state) {
	return JSON.parse(JSON.stringify(state));
}

function moveKey(state) {
	if (!state) return "";
	const move = state.lastMove;
	if (!move) return `${state.phase}:nomove`;
	const from = move.from ? `${move.from.r},${move.from.c}` : "?,?";
	const to = move.to ? `${move.to.r},${move.to.c}` : "?,?";
	return `${state.phase}:${move.by ?? "?"}:${move.pieceId ?? "?"}:${from}->${to}`;
}

function isViewingHistory() {
	return app.historySnapshots.length > 0 && app.historyCursor < app.historySnapshots.length - 1;
}

function syncHistoryWithLiveState(nextState) {
	if (app.historySource === "replay" && nextState.phase === "done") {
		if (app.historySnapshots.length > 0) {
			app.state = app.historySnapshots[app.historyCursor];
			return;
		}
		app.historySource = "live";
	}

	if (!isPlayablePhase(nextState.phase)) {
		app.historySource = "live";
		app.historySnapshots = [];
		app.historyCursor = 0;
		app.state = nextState;
		return;
	}

	const nextSnapshot = cloneState(nextState);
	if (app.historySnapshots.length === 0) {
		app.historySource = "live";
		app.historySnapshots = [nextSnapshot];
		app.historyCursor = 0;
		app.state = nextSnapshot;
		return;
	}

	const wasAtLatest = app.historyCursor === app.historySnapshots.length - 1;
	const lastSnapshot = app.historySnapshots[app.historySnapshots.length - 1];
	if (moveKey(lastSnapshot) === moveKey(nextState)) {
		app.historySnapshots[app.historySnapshots.length - 1] = nextSnapshot;
	} else {
		app.historySnapshots.push(nextSnapshot);
		const maxSnapshots = 512;
		if (app.historySnapshots.length > maxSnapshots) {
			const overflow = app.historySnapshots.length - maxSnapshots;
			app.historySnapshots.splice(0, overflow);
			app.historyCursor = Math.max(0, app.historyCursor - overflow);
		}
	}

	if (wasAtLatest) {
		app.historyCursor = app.historySnapshots.length - 1;
	}
	app.state = app.historySnapshots[app.historyCursor];
}

function importGameReplayHistory(gameDoc) {
	const liveState = app.liveState;
	if (!liveState || liveState.phase !== "done") return false;
	try {
		const replay = buildReplayFromGameDoc(gameDoc);
		const replaySnapshots = replay.snapshots.map((snapshot) => {
			const pieces: any[] = [];
			for (const [cellKey, piece] of snapshot.pieceByCell.entries()) {
				const [r, c] = cellKey.split(",").map((v) => Number(v));
				pieces.push({
					id: `${piece.ownerSeat}:${piece.label}:${r},${c}`,
					ownerSeat: piece.ownerSeat,
					pos: { r, c },
					label: piece.label,
					type: null,
					slot: null,
					flagRevealed: true
				});
			}
			return {
				...cloneState(liveState),
				pieces,
				lastMove: snapshot.lastMove ?? null
			};
		});
		if (!replaySnapshots.length) return false;
		app.historySource = "replay";
		app.historySnapshots = replaySnapshots;
		app.historyCursor = replaySnapshots.length - 1;
		app.state = app.historySnapshots[app.historyCursor];
		return true;
	} catch (err) {
		setHint(err instanceof Error ? `⚠ ${err.message}` : "⚠ Invalid game history.");
		setTimeout(() => setHint(""), 2500);
		return false;
	}
}

function requestReplayHistoryIfNeeded() {
	const liveState = app.liveState ?? app.state;
	if (!liveState || liveState.phase !== "done") return;
	if (pendingReplayHistoryRequest || replayHistoryLoaded) return;
	pendingReplayHistoryRequest = true;
	send({ type: "export_game" });
}

function stepHistory(delta) {
	if (!app.historySnapshots.length) return;
	selectedPieceId = null;
	setHint("");
	const next = app.historyCursor + delta;
	app.historyCursor = Math.max(0, Math.min(app.historySnapshots.length - 1, next));
	app.state = app.historySnapshots[app.historyCursor];
	render();
}

// Cached DOM views so we don't rebuild the whole screen every update.
/** @type {Map<string, {card:HTMLElement, nameEl:HTMLElement, statusEl:HTMLElement, btn:HTMLButtonElement}>} */
const seatViews = new Map();
/** @type {Map<string, {cell:HTMLElement, tokenHost:HTMLElement}>} */
const boardViews = new Map();

function send(obj) {
	if (!socket || socket.readyState !== WebSocket.OPEN) return;
	socket.send(JSON.stringify(obj));
}

function seatLabel(seat) {
	// N/E/S/W are concise but we can show Chinese directions too.
	const map = { N: "北", E: "东", S: "南", W: "西" };
	return `${seat}(${map[seat] ?? seat})`;
}

function formatGameMode(state) {
	const seatedCount = state.players.filter((p) => p.seat).length;
	if (seatedCount < 2) return "Mode: —";
	const mode =
		state.phase === "lobby"
			? seatedCount === 4
				? "2v2"
				: "ffa"
			: state.gameMode ?? "ffa";
	if (mode === "2v2") return "Mode: 2v2 (N+S vs E+W)";
	return "Mode: Free-for-all";
}

function formatTime(ms) {
	const d = new Date(ms);
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function turnDurationSecondsFromState(state) {
	const ms = Number(state?.turnDurationMs);
	if (!Number.isFinite(ms) || ms <= 0) return 30;
	return Math.max(1, Math.floor(ms / 1000));
}

function setHint(text) {
	const hint = $("hint");
	if (!hint) return;
	hint.textContent = text || "";
}

function remainingTurnSeconds(state) {
	if (!state?.turnDeadlineAt) return null;
	return Math.max(0, Math.ceil((state.turnDeadlineAt - Date.now()) / 1000));
}

function renderTurnLine(state, me) {
	const turnLine = $("turnLine");
	if (!turnLine) return;
	turnLine.classList.remove("turnLine--mine", "turnLine--other", "turnLine--critical");

	if (state.phase === "done") {
		if (state.winnerTeam) {
			const teamLabels = { NS: "North & South", EW: "East & West" };
			const label = teamLabels[state.winnerTeam] ?? seatLabel(state.winnerTeam);
			turnLine.textContent = `Game over. ${label} wins!`;
		} else {
			turnLine.textContent = "Game over. Draw.";
		}
		return;
	}

	if (state.phase !== "play") {
		turnLine.textContent = "";
		return;
	}

	const isMyTurn = me?.seat && state.turnSeat === me.seat;
	const secondsLeft = remainingTurnSeconds(state);
	const timeSuffix = Number.isInteger(secondsLeft) ? ` - ${secondsLeft}s left` : "";
	turnLine.textContent = isMyTurn
		? `Your Turn${timeSuffix}!`
		: `Turn: ${state.turnSeat ? seatLabel(state.turnSeat) : "-"}${timeSuffix}`;
	turnLine.classList.add(isMyTurn ? "turnLine--mine" : "turnLine--other");
	if (isMyTurn) {
		turnLine.classList.add("turnLine--critical");
	}
}

function syncTurnCountdown(state) {
	const shouldTick = state?.phase === "play" && Number.isFinite(state?.turnDeadlineAt);
	if (!shouldTick) {
		if (turnCountdownInterval) {
			clearInterval(turnCountdownInterval);
			turnCountdownInterval = null;
		}
		return;
	}
	if (turnCountdownInterval) return;
	turnCountdownInterval = setInterval(() => {
		if (!app.state) return;
		const me = app.state.players.find((p) => p.id === app.playerId) || null;
		renderTurnLine(app.state, me);
	}, 250);
}

function ensureSeatViews() {
	const grid = $("seatsGrid");
	if (!grid || seatViews.size === app.seats.length) return;
	grid.innerHTML = "";

	for (const seat of app.seats) {
		const card = document.createElement("div");
		card.className = `seatCard seatCard--${seat}`;

		const seatTop = document.createElement("div");
		seatTop.className = "seatTop";

		const left = document.createElement("div");
		const seatName = document.createElement("div");
		seatName.className = "seatName";
		seatName.textContent = seatLabel(seat);
		const nameLine = document.createElement("div");
		nameLine.className = "muted";
		nameLine.style.fontSize = "12px";
		nameLine.style.marginTop = "2px";
		left.appendChild(seatName);
		left.appendChild(nameLine);

		const pill = document.createElement("div");
		pill.className = "pill";
		pill.textContent = "—";

		seatTop.appendChild(left);
		seatTop.appendChild(pill);

		const actions = document.createElement("div");
		actions.className = "seatActions";
		const btn = document.createElement("button");
		btn.className = "btn";
		btn.textContent = "Sit";
		btn.dataset.seat = seat;
		actions.appendChild(btn);

		card.appendChild(seatTop);
		card.appendChild(actions);
		grid.appendChild(card);

		btn.addEventListener("click", () => {
			const state = app.state;
			const current = state?.players.find((p) => p.id === app.playerId) || null;
			const playersBySeat = new Map();
			if (state) {
				for (const p of state.players) {
					if (p.seat) playersBySeat.set(p.seat, p);
				}
			}
			const p = playersBySeat.get(seat) || null;
			const isMe = p && current && p.id === current.id;
			const occupied = Boolean(p);
			if (!occupied) {
				// Snapshot current layout before the seat change so we can
				// reapply the same relative positions in the new home zone.
				if (current?.seat && state) {
					const myPieces = state.pieces.filter(
						(p) => isMyPiece(state, p) && p.label !== "?" && p.pos
					);
					pendingTransferSetup = myPieces.length
						? myPieces.map((piece) => ({
							type: piece.type,
							slot: piece.slot,
							pos: boardPosToLocalPos(current.seat, piece.pos)
						}))
						: null;
				} else {
					pendingTransferSetup = null;
				}
				send({ type: "take_seat", seat });
			} else if (isMe) {
				pendingTransferSetup = null;
				send({ type: "leave_seat" });
			}
		});

		seatViews.set(seat, { card, nameEl: nameLine, statusEl: pill, btn });
	}
}

function ensureBoardViews(state) {
	const boardEl = $("board");
	if (!boardEl || boardViews.size || !state?.board) return;
	const builtViews = buildBoardViews(boardEl, state.board, {
		onCellClick,
		includeCoords: true
	});
	for (const [key, view] of builtViews) {
		boardViews.set(key, view);
	}
}

function renderHistoryControls(state, liveState) {
	const controls = $("historyControls");
	if (!controls) return;
	if (!state || !liveState || !isPlayablePhase(liveState.phase)) {
		controls.classList.add("hidden");
		return;
	}
	controls.classList.remove("hidden");

	const totalMoves = Math.max(0, app.historySnapshots.length - 1);
	const currentMove = Math.min(totalMoves, app.historyCursor);
	const viewingHistory = isViewingHistory();

	const firstBtn = $<HTMLButtonElement>("historyFirstBtn");
	const backBtn = $<HTMLButtonElement>("historyBackBtn");
	const forwardBtn = $<HTMLButtonElement>("historyForwardBtn");
	const liveBtn = $<HTMLButtonElement>("historyLiveBtn");
	const historyLine = $("historyLine");

	if (firstBtn) firstBtn.disabled = app.historyCursor <= 0;
	if (backBtn) backBtn.disabled = app.historyCursor <= 0;
	if (forwardBtn) forwardBtn.disabled = app.historyCursor >= app.historySnapshots.length - 1;
	if (liveBtn) {
		const atLatest = !viewingHistory;
		liveBtn.disabled = atLatest;
		liveBtn.classList.toggle("active", atLatest);
	}
	if (historyLine) {
		historyLine.textContent = viewingHistory
			? `History: move ${currentMove}/${totalMoves}`
			: `Live: move ${currentMove}/${totalMoves}`;
	}
}

function render() {
	const state = app.state;
	if (!state) {
		// Do not touch existing text before we have an initial room state;
		// this avoids flicker between transient connection messages.
		return;
	}
	const liveState = app.liveState ?? state;

	const me = state.players.find((p) => p.id === app.playerId) || null;

	$("phaseLine").textContent = `Phase: ${state.phase}`;
	const modeLine = $("modeLine");
	if (modeLine) modeLine.textContent = formatGameMode(state);
	renderTurnLine(state, me);
	syncTurnCountdown(state);

	ensureSeatViews();
	ensureBoardViews(state);
	applyPerspective(state);
	renderHistoryControls(state, liveState);

	const turnDurationInput = $<HTMLInputElement>("turnDurationInput");
	const saveTurnDurationBtn = $<HTMLButtonElement>("saveTurnDurationBtn");
	const turnSeconds = turnDurationSecondsFromState(state);
	if (turnDurationInput && document.activeElement !== turnDurationInput) {
		turnDurationInput.value = String(turnSeconds);
	}
	if (turnDurationInput) {
		turnDurationInput.disabled = state.phase !== "lobby";
	}
	if (saveTurnDurationBtn) {
		saveTurnDurationBtn.disabled = state.phase !== "lobby";
	}

	renderSeats(state);
	renderBoard(state);
	const myPieces = state.pieces.filter((p) => isMyPiece(state, p));
	const allMyPiecesPlaced =
		myPieces.length > 0 && myPieces.every((p) => p.pos !== null);
	$<HTMLButtonElement>("readyBtn").disabled = !me || !me.seat || me.ready || !allMyPiecesPlaced;
	$<HTMLButtonElement>("unreadyBtn").disabled = !me || !me.seat || !me.ready;
	const canUseSetupControls = state.phase === "lobby";
	const canUseMySetupControls = canUseSetupControls && Boolean(me?.seat);
	const mySetupControls = $("mySetupControls");
	if (mySetupControls) mySetupControls.style.display = canUseMySetupControls ? "" : "none";
	const downloadSetupBtn = $<HTMLButtonElement>("downloadSetupBtn");
	const uploadSetupBtn = $<HTMLButtonElement>("uploadSetupBtn");
	if (downloadSetupBtn) downloadSetupBtn.disabled = !canUseMySetupControls;
	if (uploadSetupBtn) uploadSetupBtn.disabled = !canUseMySetupControls;
	const downloadGameBtn = $<HTMLButtonElement>("downloadGameBtn");
	const gameDone = liveState.phase === "done";
	if (downloadGameBtn) {
		downloadGameBtn.disabled = !gameDone;
		downloadGameBtn.style.display = gameDone ? "" : "none";
	}
	// Hide lobby controls (ready, randomize) once the game is under way.
	const inPlay = liveState.phase === "play" || liveState.phase === "done";
	const lobbyEl = $("lobbyControls");
	if (lobbyEl) lobbyEl.style.display = inPlay ? "none" : "";

	const eliminatedSeats = liveState.eliminatedSeats ?? [];
	const activeSeatCount = liveState.players.filter((p) => p.seat && !eliminatedSeats.includes(p.seat)).length;
	const offeredSeats = liveState.drawOfferSeats ?? [];
	const hasOfferedDraw = Boolean(me?.seat) && offeredSeats.includes(me.seat);
	const canUseInGameActions =
		liveState.phase === "play" &&
		Boolean(me?.seat) &&
		!eliminatedSeats.includes(me.seat) &&
		!isViewingHistory();
	const offerDrawBtn = $<HTMLButtonElement>("offerDrawBtn");
	if (offerDrawBtn) {
		offerDrawBtn.style.display = liveState.phase === "play" ? "" : "none";
		offerDrawBtn.disabled = !canUseInGameActions || hasOfferedDraw;
		offerDrawBtn.classList.toggle("active", hasOfferedDraw);
		offerDrawBtn.textContent =
			activeSeatCount > 0
				? `${hasOfferedDraw ? "Draw offered" : "Offer draw"} (${offeredSeats.length}/${activeSeatCount})`
				: "Offer draw";
	}
	const forfeitBtn = $<HTMLButtonElement>("forfeitBtn");
	if (forfeitBtn) {
		forfeitBtn.style.display = liveState.phase === "play" ? "" : "none";
		forfeitBtn.disabled = !canUseInGameActions;
	}
}

function renderSeats(state) {
	const playersBySeat = new Map();
	for (const p of state.players) {
		if (p.seat) playersBySeat.set(p.seat, p);
	}

	for (const seat of app.seats) {
		const view = seatViews.get(seat);
		if (!view) continue;
		const p = playersBySeat.get(seat) || null;
		const isMe = p && p.id === app.playerId;
		const occupied = Boolean(p);

		const isEliminated = (state.eliminatedSeats ?? []).includes(seat);
		view.nameEl.textContent = occupied ? (isMe ? "You" : p.name) : "Empty";
		if (isEliminated) {
			view.statusEl.textContent = "Eliminated";
			view.statusEl.classList.remove("ready");
			view.statusEl.classList.add("eliminated");
		} else {
			view.statusEl.classList.remove("eliminated");
			const connected = p?.connected !== false;
			view.statusEl.textContent = occupied
				? connected
					? (p.ready ? "Ready" : "Not ready")
					: "Reconnecting..."
				: "—";
			view.statusEl.classList.toggle("ready", !!p?.ready && connected);
		}

		const gameActive = state.phase === "play" || state.phase === "done";
		view.btn.style.display = gameActive ? "none" : "";
		if (!occupied) {
			view.btn.disabled = false;
			view.btn.classList.add("primary");
			view.btn.textContent = "Sit";
		} else if (isMe) {
			view.btn.disabled = false;
			view.btn.classList.remove("primary");
			view.btn.textContent = "Leave";
		} else {
			view.btn.disabled = true;
			view.btn.classList.remove("primary");
			view.btn.textContent = "Occupied";
		}
	}
}

function renderBoard(state) {
	const pieceByCell = new Map();
	for (const piece of state.pieces) {
		if (!piece.pos) continue;
		pieceByCell.set(`${piece.pos.r},${piece.pos.c}`, piece);
	}

	const lastMove = state.lastMove;
	const lastFromKey = lastMove?.from ? `${lastMove.from.r},${lastMove.from.c}` : null;
	const lastToKey = lastMove?.to ? `${lastMove.to.r},${lastMove.to.c}` : null;

	for (const [key, view] of boardViews) {
		view.cell.classList.remove("cell--lastFrom", "cell--lastTo");
		if (key === lastFromKey) view.cell.classList.add("cell--lastFrom");
		if (key === lastToKey) view.cell.classList.add("cell--lastTo");

		const piece = pieceByCell.get(key) || null;
		const host = view.tokenHost;
		host.innerHTML = "";
		if (!piece) continue;
		const token = document.createElement("div");
		token.className = "token";
		if (piece.ownerSeat) token.classList.add(`token--seat-${piece.ownerSeat}`);
		if (isMyPiece(state, piece)) token.classList.add("token--mine");
		if (piece.id === selectedPieceId) token.classList.add("selected");
		token.innerHTML = `<div class="label">${escapeHtml(piece.label)}</div>`;
		host.appendChild(token);
	}
}

function applyPerspective(state) {
	const boardEl = $("board");
	if (!boardEl) return;
	boardEl.classList.remove("board--rotN", "board--rotE", "board--rotW");
	const me = state?.players.find(p => p.id === app.playerId);
	const seat = me?.seat;
	if (seat === "N") boardEl.classList.add("board--rotN");
	else if (seat === "E") boardEl.classList.add("board--rotE");
	else if (seat === "W") boardEl.classList.add("board--rotW");
}

function isMyPiece(state, piece) {
	const me = state.players.find((p) => p.id === app.playerId);
	if (!me?.seat) return false;
	return piece.ownerSeat === me.seat;
}

// Client-side placement validation mirroring server validatePlacement.
function canPlaceAt(state, piece, pos) {
	if (!pos) return true; // unplace always ok
	const zone = HOME_ZONES[piece.ownerSeat];
	if (!zone) return false;
	if (pos.r < zone.minR || pos.r > zone.maxR || pos.c < zone.minC || pos.c > zone.maxC) return false;
	const cell = state.board.cells.find((c) => c.r === pos.r && c.c === pos.c);
	if (!cell || cell.type === "inactive" || cell.type === "camp") return false;
	if (piece.type === "flag") {
		if (cell.type !== "hq") return false;
		return zone.orientation === "row"
			? pos.r === zone.hqRow && zone.hqCols.includes(pos.c)
			: pos.c === zone.hqCol && zone.hqRows.includes(pos.r);
	}
	if (piece.type === "mine") {
		if (cell.type !== "post") return false;
		return zone.orientation === "row"
			? zone.mineRows.includes(pos.r)
			: zone.mineCols.includes(pos.c);
	}
	if (piece.type === "bomb") {
		return zone.orientation === "row"
			? pos.r !== zone.frontRow
			: pos.c !== zone.frontCol;
	}
	return true;
}

function onCellClick(pos) {
	if (isViewingHistory()) {
		setHint("Viewing history. Click Live to return before making a move.");
		setTimeout(() => setHint(""), 1800);
		return;
	}

	const state = app.liveState ?? app.state;
	if (!state) return;

	const clickedPiece = state.pieces.find(
		(p) => p.pos && p.pos.r === pos.r && p.pos.c === pos.c && p.alive !== false
	) ?? null;
	const clickedIsMine = clickedPiece !== null && isMyPiece(state, clickedPiece);

	// ── LOBBY / PLACEMENT ──────────────────────────────────────────────
	if (state.phase === "lobby" || state.phase === "placement") {
		if (!selectedPieceId) {
			// Click a placed own piece to select it.
			if (clickedIsMine) {
				selectedPieceId = clickedPiece.id;
				setHint("Click a cell to move, or another piece to swap.");
				render();
			}
			return;
		}

		// A piece is already selected.
		const selPiece = state.pieces.find((p) => p.id === selectedPieceId) ?? null;

		// Clicking the same piece → deselect.
		if (clickedPiece?.id === selectedPieceId) {
			selectedPieceId = null;
			setHint("");
			render();
			return;
		}

		// Clicking another own placed piece → attempt swap.
		if (clickedIsMine && clickedPiece.pos && selPiece) {
			const fromPos = selPiece.pos;	 // may be null if selPiece is unplaced
			const toPos		= clickedPiece.pos;
			if (fromPos && !canPlaceAt(state, selPiece, toPos)) {
				setHint("⚠ Invalid swap: that position isn't legal for this piece.");
				setTimeout(() => setHint(""), 1800);
				selectedPieceId = null;
				render();
				return;
			}
			if (fromPos && !canPlaceAt(state, clickedPiece, fromPos)) {
				setHint("⚠ Invalid swap: that position isn't legal for the other piece.");
				setTimeout(() => setHint(""), 1800);
				selectedPieceId = null;
				render();
				return;
			}
			// 3-step swap so the server never sees two pieces on the same cell.
			send({ type: "place_piece", pieceId: selectedPieceId, pos: null });
			if (fromPos) send({ type: "place_piece", pieceId: clickedPiece.id, pos: fromPos });
			send({ type: "place_piece", pieceId: selectedPieceId, pos: toPos });
			selectedPieceId = null;
			setHint("");
			render();
			return;
		}

		// Clicking an empty cell (or an unplaced piece slot) → place selected piece there.
		send({ type: "place_piece", pieceId: selectedPieceId, pos });
		selectedPieceId = null;
		setHint("");
		return;
	}

	// ── PLAY ───────────────────────────────────────────────────────────
	if (state.phase === "play") {
		if (!selectedPieceId) {
			// Click own piece on board to select it.
			if (clickedIsMine) {
				selectedPieceId = clickedPiece.id;
				setHint("Click a destination cell to move.");
				render();
			}
			return;
		}

		// Click the already-selected piece → deselect.
		if (clickedPiece?.id === selectedPieceId) {
			selectedPieceId = null;
			setHint("");
			render();
			return;
		}

		// Click a different own piece → re-select it.
		if (clickedIsMine) {
			selectedPieceId = clickedPiece.id;
			setHint("Click a destination cell to move.");
			render();
			return;
		}

		// Click any other cell → attempt move.
		send({ type: "move", pieceId: selectedPieceId, to: pos });
		selectedPieceId = null;
		setHint("");
		render(); // deselect immediately; server will re-render on valid move
	}
}

function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function addChatLine({ from, text, at }) {
	const log = $("chatLog");
	const div = document.createElement("div");
	div.className = "chatMsg";
	const who = from?.seat ? `${from.name} (${from.seat})` : from?.name ?? "Unknown";
	div.innerHTML = `<span class="who">${escapeHtml(who)}</span><span class="meta">${formatTime(
		at ?? Date.now()
	)}</span>: ${escapeHtml(text)}`;
	log.appendChild(div);
	log.scrollTop = log.scrollHeight;
}

// Home zone info mirrored from server homeInfoForSeat (must stay in sync).
const HOME_ZONES = {
	N: { minR: 0,	 maxR: 5,	 minC: 6,	 maxC: 10, orientation: "row", frontRow: 5,	 mineRows: [0, 1],	 hqRow: 0,	hqCols: [7, 9] },
	S: { minR: 11, maxR: 16, minC: 6,	 maxC: 10, orientation: "row", frontRow: 11, mineRows: [15, 16], hqRow: 16, hqCols: [7, 9] },
	W: { minR: 6,	 maxR: 10, minC: 0,	 maxC: 5,	 orientation: "col", frontCol: 5,	 mineCols: [0, 1],	 hqCol: 0,	hqRows: [7, 9] },
	E: { minR: 6,	 maxR: 10, minC: 11, maxC: 16, orientation: "col", frontCol: 11, mineCols: [15, 16], hqCol: 16, hqRows: [7, 9] }
};

function boardPosToLocalPos(seat, pos) {
	switch (seat) {
		case "N":
			return { depth: pos.r, lane: pos.c - 6 };
		case "S":
			return { depth: 16 - pos.r, lane: 10 - pos.c };
		case "W":
			return { depth: pos.c, lane: 10 - pos.r };
		case "E":
			return { depth: 16 - pos.c, lane: pos.r - 6 };
		default:
			return null;
	}
}

function randomizePlacement() {
	if (randomizeInFlight) return;
	const state = app.state;
	if (!state) return;
	if (state.phase !== "lobby") {
		setHint("Pieces can only be moved before the game starts.");
		setTimeout(() => setHint(""), 1400);
		return;
	}
	const me = state.players.find((p) => p.id === app.playerId);
	if (!me?.seat) {
		setHint("Take a seat first.");
		setTimeout(() => setHint(""), 1400);
		return;
	}

	const pieces = state.pieces.filter((p) => p.label !== "?" && isMyPiece(state, p));
	if (!pieces.length) {
		scheduleAutoRandomize();
		return;
	}

	const zone = HOME_ZONES[me.seat];
	if (!zone) return;

	randomizeInFlight = true;
	try {
		const { cells } = state.board;

		function posKey(p) { return `${p.r},${p.c}`; }

		function randomChoice(arr) {
			if (!arr.length) return null;
			return arr[Math.floor(Math.random() * arr.length)];
		}

		// Filter to home zone active cells only.
		const allHomeCells = cells.filter(
			(cell) =>
				cell.r >= zone.minR && cell.r <= zone.maxR &&
				cell.c >= zone.minC && cell.c <= zone.maxC &&
				cell.type !== "inactive"
		);
		const postCells = allHomeCells.filter((cell) => cell.type === "post");
		const hqCells		= allHomeCells.filter((cell) => cell.type === "hq");

		let flagCells, mineCells, bombCells, normalCells;
		if (zone.orientation === "row") {
			// Flag: must go on the designated HQ cells.
			flagCells		= hqCells.filter((cell) => cell.r === zone.hqRow && zone.hqCols.includes(cell.c));
			// Mines: must stay in the back 2 rows (post cells only — no HQ/camp).
			mineCells		= postCells.filter((cell) => zone.mineRows.includes(cell.r));
			// Bombs: any post or HQ cell except the front row.
			bombCells		= [...postCells, ...hqCells].filter((cell) => cell.r !== zone.frontRow);
			// Normal officers/engineers: any post or HQ cell (including the front row).
			normalCells = [...postCells, ...hqCells];
		} else {
			flagCells		= hqCells.filter((cell) => cell.c === zone.hqCol && zone.hqRows.includes(cell.r));
			mineCells		= postCells.filter((cell) => zone.mineCols.includes(cell.c));
			bombCells		= [...postCells, ...hqCells].filter((cell) => cell.c !== zone.frontCol);
			normalCells = [...postCells, ...hqCells];
		}

		// Place flag first, then mines, then bombs, then officers/engineers.
		const ordered = [
			...pieces.filter((p) => p.label.startsWith("军旗")),
			...pieces.filter((p) => p.label.startsWith("地雷")),
			...pieces.filter((p) => p.label.startsWith("炸弹")),
			...pieces.filter(
				(p) => !p.label.startsWith("军旗") && !p.label.startsWith("地雷") && !p.label.startsWith("炸弹")
			)
		];

		const occupied = new Set();
		const placementById = new Map();
		for (const piece of ordered) {
			let candidates;
			if (piece.label.startsWith("军旗")) {
				candidates = flagCells;
			} else if (piece.label.startsWith("地雷")) {
				candidates = mineCells;
			} else if (piece.label.startsWith("炸弹")) {
				candidates = bombCells;
			} else {
				candidates = normalCells;
			}

			const available = candidates.filter((p) => !occupied.has(posKey(p)));
			if (!available.length) {
				setHint("Could not find a full valid random setup.");
				setTimeout(() => setHint(""), 1400);
				return;
			}
			const pos = randomChoice(available);
			occupied.add(posKey(pos));
			placementById.set(piece.id, pos);
		}

		const setupPieces = pieces.map((piece) => {
			const pos = placementById.get(piece.id);
			return {
				type: piece.type,
				slot: piece.slot,
				pos: boardPosToLocalPos(me.seat, pos)
			};
		});

		send({
			type: "import_setup",
			setup: {
				format: "chessforces-setup",
				version: 1,
				pieces: setupPieces
			}
		});

		setHint("Board randomized.");
		setTimeout(() => setHint(""), 1400);
	} finally {
		randomizeInFlight = false;
	}
}

// Track which seat we've already auto-placed for, so we only do it once.
let autoPlacedSeat: string | null = null;
let autoRandomizeTimer: any = null;
let randomizeInFlight = false;
// Local-coordinate snapshot captured before a seat switch; sent as import_setup
// once the server confirms the new seat, preserving the player's layout.
let pendingTransferSetup = null;

function scheduleAutoRandomize() {
	clearTimeout(autoRandomizeTimer);
	autoRandomizeTimer = setTimeout(() => {
		autoRandomizeTimer = null;
		randomizePlacement();
	}, 250);
}

function sendTransferSetup() {
	const setup = pendingTransferSetup;
	pendingTransferSetup = null;
	if (!setup) return;
	send({
		type: "import_setup",
		setup: { format: "chessforces-setup", version: 1, pieces: setup }
	});
}

function initLanding() {
	$("landing").classList.remove("hidden");
	$("gameView").classList.add("hidden");
	$("playbackView").classList.add("hidden");

	$("createRoomBtn").addEventListener("click", () => {
		location.href = `/room/${genRoomId()}`;
	});

	function joinRoom() {
		const id = $<HTMLInputElement>("joinRoomInput").value.trim();
		if (!id) return;
		location.href = `/room/${encodeURIComponent(id)}`;
	}

	$("joinRoomBtn").addEventListener("click", joinRoom);
	$("joinRoomInput").addEventListener("keydown", (e) => {
		if (e.key === "Enter") joinRoom();
	});
	$("playbackModeBtn").addEventListener("click", () => {
		location.href = "/playback";
	});
}

function initRoom(roomId) {
	$("landing").classList.add("hidden");
	$("gameView").classList.remove("hidden");
	$("playbackView").classList.add("hidden");
	$("roomId").textContent = roomId;

	let reconnectTimer: any = null;
	let reconnectAttempts = 0;

	function clearReconnectTimer() {
		if (!reconnectTimer) return;
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}

	function connectSocket() {
		const sessionToken = readSessionToken(roomId);
		const wasReconnecting = reconnectAttempts > 0;
		socket = new WebSocket(wsUrlFor(roomId, sessionToken));
		const currentSocket = socket;

		currentSocket.addEventListener("open", () => {
			if (socket !== currentSocket) return;
			clearReconnectTimer();
			reconnectAttempts = 0;
			if (wasReconnecting) {
				setHint("Connection restored.");
				setTimeout(() => setHint(""), 1500);
			} else if (!app.liveState) {
				setHint(
					"Pick a seat — pieces will be placed automatically. Click Ready when done. (Game will start automatically when all present players are ready)"
				);
			}
			render();
		});

		currentSocket.addEventListener("close", () => {
			if (socket !== currentSocket) return;
			render();
			if (reconnectTimer) return;
			const delayMs = Math.min(10000, 1000 * (2 ** Math.min(reconnectAttempts, 4)));
			reconnectAttempts += 1;
			setHint(`Connection lost. Reconnecting in ${Math.ceil(delayMs / 1000)}s...`);
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				connectSocket();
			}, delayMs);
		});

		currentSocket.addEventListener("message", (ev) => {
			let msg;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			if (!msg || typeof msg.type !== "string") return;

			if (msg.type === "hello") {
				app.playerId = msg.playerId;
				app.seats = msg.seats || ["N", "E", "S", "W"];
				if (typeof msg.reconnectToken === "string") {
					writeSessionToken(roomId, msg.reconnectToken);
				}
				render();
				return;
			}
			if (msg.type === "state") {
				const prevPhase = app.liveState?.phase;
				app.liveState = msg.state;
				if (msg.state.phase !== "done") {
					pendingReplayHistoryRequest = false;
					replayHistoryLoaded = false;
				}
				syncHistoryWithLiveState(msg.state);
				// If selected piece got removed (bomb), clear selection.
				if (selectedPieceId && !app.liveState.pieces.some((p) => p.id === selectedPieceId)) {
					selectedPieceId = null;
				}
				// Auto-place as soon as the player takes a seat in the lobby.
				if (msg.state.phase === "lobby") {
					const me = msg.state.players.find((p) => p.id === app.playerId);
					if (!me?.seat) {
						// Seatless again (e.g. after leaving): forget the placed seat so
						// re-taking the same seat re-triggers auto-placement.
						autoPlacedSeat = null;
					} else if (me.seat !== autoPlacedSeat) {
						autoPlacedSeat = me.seat;
						if (pendingTransferSetup) {
							sendTransferSetup();
						} else {
							scheduleAutoRandomize();
						}
					}
				}
				// Show hint on phase transitions.
				if (prevPhase !== msg.state.phase) {
					if (msg.state.phase === "play") setHint("Game started. On your turn, select one of your pieces and move.");
				}
				requestReplayHistoryIfNeeded();
				render();
				return;
			}
			if (msg.type === "move_result") {
				if (!msg.ok) {
					setHint(`⚠ ${msg.reason}`);
					setTimeout(() => setHint(""), 2500);
				}
				return;
			}
			if (msg.type === "forfeit_result") {
				if (!msg.ok) {
					setHint(`⚠ ${msg.reason}`);
					setTimeout(() => setHint(""), 2500);
					return;
				}
				const seat = msg.seat ? seatLabel(msg.seat) : "A player";
				setHint(`${seat} forfeited.`);
				setTimeout(() => setHint(""), 1800);
				return;
			}
			if (msg.type === "draw_offer_result") {
				if (!msg.ok) {
					setHint(`⚠ ${msg.reason}`);
					setTimeout(() => setHint(""), 2500);
					return;
				}
				if (msg.accepted) {
					setHint("Draw accepted.");
					setTimeout(() => setHint(""), 1800);
					return;
				}
				const offered = Array.isArray(msg.offeredSeats) ? msg.offeredSeats.length : 0;
				setHint(`Draw offer recorded (${offered} total).`);
				setTimeout(() => setHint(""), 1800);
				return;
			}
			if (msg.type === "chat") {
				addChatLine(msg);
				return;
			}
			if (msg.type === "setup_file") {
				if (!msg.ok) {
					setHint(`⚠ ${msg.reason}`);
					setTimeout(() => setHint(""), 2500);
					return;
				}
				downloadJsonFile(msg.setup, `my-setup-${roomId}.chessforces-setup.json`);
				setHint("My setup file downloaded.");
				setTimeout(() => setHint(""), 1500);
				return;
			}
			if (msg.type === "game_file") {
				const shouldDownload = pendingGameDownloadRequest;
				pendingGameDownloadRequest = false;
				const shouldImportReplay =
					pendingReplayHistoryRequest ||
					((app.liveState?.phase ?? app.state?.phase) === "done" && !replayHistoryLoaded);
				pendingReplayHistoryRequest = false;
				if (!msg.ok) {
					setHint(`⚠ ${msg.reason}`);
					setTimeout(() => setHint(""), 2500);
					return;
				}
				if (shouldImportReplay) {
					replayHistoryLoaded = importGameReplayHistory(msg.game);
				}
				if (shouldDownload) {
					downloadJsonFile(msg.game, `game-${roomId}.chessforces-game.json`);
					setHint("Game file downloaded.");
					setTimeout(() => setHint(""), 1500);
				} else if (replayHistoryLoaded) {
					render();
				}
				return;
			}
			if (msg.type === "import_setup_result") {
				if (!msg.ok) {
					setHint(`⚠ ${msg.reason}`);
				} else {
					setHint("My setup imported.");
				}
				setTimeout(() => setHint(""), 2500);
				return;
			}
			if (msg.type === "turn_duration_result") {
				if (!msg.ok) {
					setHint(`⚠ ${msg.reason}`);
					setTimeout(() => setHint(""), 2500);
					return;
				}
				const seconds = Number(msg.seconds);
				const safeSeconds = Number.isFinite(seconds) && seconds > 0
					? Math.floor(seconds)
					: turnDurationSecondsFromState(app.state);
				setHint(`Turn timer set to ${safeSeconds}s.`);
				setTimeout(() => setHint(""), 1500);
				return;
			}
			if (msg.type === "phase") {
				// Legacy handler kept for forward-compatibility; server now sends state instead.
				if (msg.phase === "play") setHint("Game started. Select one of your pieces and move.");
				render();
				return;
			}
		});
	}

	window.addEventListener("online", () => {
		if (socket?.readyState === WebSocket.OPEN) return;
		if (reconnectTimer) return;
		connectSocket();
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		if (socket?.readyState === WebSocket.OPEN) return;
		clearReconnectTimer();
		connectSocket();
	});
	connectSocket();

	$("copyLinkBtn").addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(location.href);
			setHint("Link copied.");
			setTimeout(() => setHint(""), 1200);
		} catch {
			setHint("Copy failed. Copy from address bar.");
		}
	});

	$("saveNameBtn").addEventListener("click", () => {
		const name = $<HTMLInputElement>("nameInput").value.trim();
		if (!name) return;
		send({ type: "set_name", name });
		setHint("Name saved.");
		setTimeout(() => setHint(""), 1200);
	});

	$("readyBtn").addEventListener("click", () => send({ type: "set_ready", ready: true }));
	$("unreadyBtn").addEventListener("click", () => send({ type: "set_ready", ready: false }));

	function sendTurnDuration() {
		const input = $<HTMLInputElement>("turnDurationInput");
		if (!input) return;
		const seconds = Number(input.value);
		if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
			setHint("⚠ Turn timer must be a whole number between 1 and 60 seconds.");
			setTimeout(() => setHint(""), 2500);
			return;
		}
		send({ type: "set_turn_duration", seconds });
	}

	$("saveTurnDurationBtn").addEventListener("click", sendTurnDuration);
	$("turnDurationInput").addEventListener("keydown", (e) => {
		if (e.key === "Enter") sendTurnDuration();
	});

	function sendChat() {
		const text = $<HTMLInputElement>("chatInput").value.trim();
		if (!text) return;
		$<HTMLInputElement>("chatInput").value = "";
		send({ type: "chat", text });
	}

	$("sendChatBtn").addEventListener("click", sendChat);
	$("chatInput").addEventListener("keydown", (e) => {
		if (e.key === "Enter") sendChat();
	});

	$("randomizeBtn").addEventListener("click", () => {
		clearTimeout(autoRandomizeTimer);
		autoRandomizeTimer = null;
		randomizePlacement();
	});

	$("downloadSetupBtn").addEventListener("click", () => {
		send({ type: "export_setup" });
	});
	$("uploadSetupBtn").addEventListener("click", () => {
		$("uploadSetupInput").click();
	});
	$("uploadSetupInput").addEventListener("change", async () => {
		const file = $<HTMLInputElement>("uploadSetupInput").files?.[0];
		if (!file) return;
		try {
			const text = await file.text();
			const setup = JSON.parse(text);
			send({ type: "import_setup", setup });
		} catch {
			setHint("⚠ Invalid setup file.");
			setTimeout(() => setHint(""), 2000);
		} finally {
			$<HTMLInputElement>("uploadSetupInput").value = "";
		}
	});
	$("downloadGameBtn").addEventListener("click", () => {
		pendingGameDownloadRequest = true;
		send({ type: "export_game" });
	});
	$("offerDrawBtn").addEventListener("click", () => {
		send({ type: "offer_draw" });
	});
	$("forfeitBtn").addEventListener("click", () => {
		if (!confirm("Forfeit this game? This cannot be undone.")) return;
		send({ type: "forfeit" });
	});
	$("historyFirstBtn").addEventListener("click", () => {
		if (!app.historySnapshots.length) return;
		selectedPieceId = null;
		setHint("");
		app.historyCursor = 0;
		app.state = app.historySnapshots[0];
		render();
	});
	$("historyBackBtn").addEventListener("click", () => {
		stepHistory(-1);
	});
	$("historyForwardBtn").addEventListener("click", () => {
		stepHistory(1);
	});
	$("historyLiveBtn").addEventListener("click", () => {
		if (!app.historySnapshots.length) return;
		selectedPieceId = null;
		setHint("");
		app.historyCursor = app.historySnapshots.length - 1;
		app.state = app.historySnapshots[app.historyCursor];
		render();
	});

	$("debugBtn").addEventListener("click", () => {
		document.body.classList.toggle("debug");
		$("debugBtn").textContent = document.body.classList.contains("debug") ? "Debug: ON" : "Debug: OFF";
	});
}

function downloadJsonFile(data, filename) {
	const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
	const href = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = href;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(href);
}

function initPlayback() {
	$("landing").classList.add("hidden");
	$("gameView").classList.add("hidden");
	$("playbackView").classList.remove("hidden");
	$("playbackBackBtn").addEventListener("click", () => {
		location.href = "/";
	});
	initPlaybackPage();
}

const activeRoomId = roomIdFromPath();
if (isPlaybackPath()) {
	initPlayback();
} else if (activeRoomId) {
	initRoom(activeRoomId);
} else {
	initLanding();
}

