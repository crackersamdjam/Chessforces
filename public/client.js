const $ = (id) => document.getElementById(id);

function genRoomId() {
  // Simple client-side id generator; good enough for a casual game.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

let roomId = (() => {
  const match = location.pathname.match(/^\/room\/([^/]+)/);
  if (match) return match[1];
  const id = genRoomId();
  // Update URL without a network reload; server also serves this path.
  history.replaceState(null, "", `/room/${id}`);
  return id;
})();

$("roomId").textContent = roomId;

const wsUrl = (() => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/room/${roomId}`;
})();

/** @type {{playerId:string|null, seats:string[], state:any|null}} */
const app = {
  playerId: null,
  seats: ["N", "E", "S", "W"],
  state: null
};

let selectedPieceId = null;

// Cached DOM views so we don't rebuild the whole screen every update.
/** @type {Map<string, {card:HTMLElement, nameEl:HTMLElement, statusEl:HTMLElement, btn:HTMLButtonElement}>} */
const seatViews = new Map();
/** @type {Map<string, {cell:HTMLElement, tokenHost:HTMLElement}>} */
const boardViews = new Map();

function send(obj) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(obj));
}

function seatLabel(seat) {
  // N/E/S/W are concise but we can show Chinese directions too.
  const map = { N: "北", E: "东", S: "南", W: "西" };
  return `${seat}(${map[seat] ?? seat})`;
}

function formatTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setHint(text) {
  $("hint").textContent = text || "";
}

function ensureSeatViews() {
  const grid = $("seatsGrid");
  if (!grid || seatViews.size === app.seats.length) return;
  grid.innerHTML = "";

  for (const seat of app.seats) {
    const card = document.createElement("div");
    card.className = "seatCard";

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
        send({ type: "take_seat", seat });
      } else if (isMe) {
        send({ type: "leave_seat" });
      }
    });

    seatViews.set(seat, { card, nameEl: nameLine, statusEl: pill, btn });
  }
}

function ensureBoardViews(state) {
  const boardEl = $("board");
  if (!boardEl || boardViews.size || !state?.board) return;
  const { rows, cols, cells } = state.board;
  boardEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  boardEl.innerHTML = "";

  for (const cellDef of cells) {
    const { r, c, type } = cellDef;
    const cell = document.createElement("div");
    const key = `${r},${c}`;

    if (type === "inactive") {
      cell.className = "cell cell--inactive";
      boardEl.appendChild(cell);
      // Inactive cells are invisible grid placeholders — not added to boardViews.
      continue;
    }

    cell.className = "cell";
    cell.classList.add(
      type === "camp" ? "cell--camp" : type === "hq" ? "cell--hq" : "cell--post"
    );
    cell.dataset.r = String(r);
    cell.dataset.c = String(c);

    const coord = document.createElement("div");
    coord.className = "cellCoord";
    coord.textContent = `${r},${c}`;
    cell.appendChild(coord);

    const tokenHost = document.createElement("div");
    tokenHost.className = "cellTokenHost";
    cell.appendChild(tokenHost);

    cell.addEventListener("click", () => onCellClick({ r, c }));

    boardEl.appendChild(cell);
    boardViews.set(key, { cell, tokenHost });
  }
}

function render() {
  const state = app.state;
  if (!state) {
    // Do not touch existing text before we have an initial room state;
    // this avoids flicker between transient connection messages.
    return;
  }

  $("phaseLine").textContent = `Phase: ${state.phase}`;
  if (state.phase === "done") {
    $("turnLine").textContent = state.winnerSeat
      ? `Game over. Winner: ${seatLabel(state.winnerSeat)}`
      : "Game over.";
  } else if (state.phase === "play") {
    $("turnLine").textContent = `Turn: ${state.turnSeat ? seatLabel(state.turnSeat) : "-"}`;
  } else {
    $("turnLine").textContent = "";
  }

  ensureSeatViews();
  ensureBoardViews(state);

  renderSeats(state);
  renderBoard(state);
  renderPieces(state);

  const me = state.players.find((p) => p.id === app.playerId) || null;
  $("readyBtn").disabled = !me || !me.seat || me.ready;
  $("unreadyBtn").disabled = !me || !me.seat || !me.ready;
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

    view.nameEl.textContent = occupied ? (isMe ? "You" : p.name) : "Empty";
    view.statusEl.textContent = occupied ? (p.ready ? "Ready" : "Not ready") : "—";
    view.statusEl.classList.toggle("ready", !!p?.ready);

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

  for (const [key, view] of boardViews) {
    const piece = pieceByCell.get(key) || null;
    const host = view.tokenHost;
    host.innerHTML = "";
    if (!piece) continue;
    const token = document.createElement("div");
    token.className = "token";
    if (piece.id === selectedPieceId) token.classList.add("selected");
    const coord = formatSideCoord(piece);
    token.innerHTML = `
      <div class="label">${escapeHtml(piece.label)}</div>
      <div class="owner">${piece.ownerSeat ?? "?"}${
        coord ? ` · ${escapeHtml(coord)}` : ""
      }</div>
    `;
    host.appendChild(token);
  }
}

function formatSideCoord(piece) {
  if (!piece.pos || !piece.ownerSeat) return "";
  const sideMap = { N: "A", E: "B", S: "C", W: "D" };
  const side = sideMap[piece.ownerSeat];
  if (!side) return "";
  // Center of the 17×17 cross board.
  const centerR = 8;
  const centerC = 8;
  const dx = piece.pos.c - centerC;
  const dy = piece.pos.r - centerR; // down is positive

  let x = 0;
  let y = 0;
  if (side === "A") {
    // N at top: y increases away from center toward N's back
    x = dx;
    y = -dy;
  } else if (side === "C") {
    // S at bottom
    x = -dx;
    y = dy;
  } else if (side === "B") {
    // E on right
    x = dy;
    y = dx;
  } else if (side === "D") {
    // W on left
    x = -dy;
    y = -dx;
  }

  return `${side}(${x},${y})`;
}

function renderPieces(state) {
  const list = $("piecesList");
  list.innerHTML = "";
  const myPieces = state.pieces.filter((p) => p.ownerSeat && isMineSeat(state, p.ownerSeat));

  // If you haven't taken a seat yet, you won't have an ownerSeat; instead infer from hidden state:
  // We show "your pieces" by matching the pieces labeled (server already hides others).
  const mine = state.pieces.filter((p) => p.label !== "?" && isProbablyMine(state, p));
  const pieces = mine.sort((a, b) => a.label.localeCompare(b.label, "zh"));

  if (!pieces.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Take a seat to get your pieces.";
    list.appendChild(empty);
    return;
  }

  for (const p of pieces) {
    const btn = document.createElement("button");
    btn.className = "pieceBtn";
    if (p.id === selectedPieceId) btn.classList.add("selected");
    const posText = p.pos ? `@ ${p.pos.r},${p.pos.c}` : "(unplaced)";
    btn.innerHTML = `
      <div style="font-weight:650;">${escapeHtml(p.label)}</div>
      <div class="pieceMeta"><div>${posText}</div></div>
    `;
    btn.addEventListener("click", () => {
      selectedPieceId = selectedPieceId === p.id ? null : p.id;
      setHint(selectedPieceId ? "Now click a cell to place/move." : "");
      render();
    });
    list.appendChild(btn);
  }
}

function isMineSeat(state, ownerSeat) {
  const me = state.players.find((p) => p.id === app.playerId);
  return Boolean(me && me.seat === ownerSeat);
}

function isProbablyMine(state, piece) {
  const me = state.players.find((p) => p.id === app.playerId);
  if (!me?.seat) return false;
  return piece.ownerSeat === me.seat;
}

function onCellClick(pos) {
  const state = app.state;
  if (!state || !selectedPieceId) return;

  if (state.phase === "lobby" || state.phase === "placement") {
    send({ type: "place_piece", pieceId: selectedPieceId, pos });
    setHint("");
    return;
  }

  if (state.phase === "play") {
    send({ type: "move", pieceId: selectedPieceId, to: pos });
    setHint("");
    return;
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
  N: { minR: 0,  maxR: 5,  minC: 6,  maxC: 10, orientation: "row", frontRow: 5,  mineRows: [0, 1],   hqRow: 0,  hqCols: [7, 9] },
  S: { minR: 11, maxR: 16, minC: 6,  maxC: 10, orientation: "row", frontRow: 11, mineRows: [15, 16], hqRow: 16, hqCols: [7, 9] },
  W: { minR: 6,  maxR: 10, minC: 0,  maxC: 5,  orientation: "col", frontCol: 5,  mineCols: [0, 1],   hqCol: 0,  hqRows: [7, 9] },
  E: { minR: 6,  maxR: 10, minC: 11, maxC: 16, orientation: "col", frontCol: 11, mineCols: [15, 16], hqCol: 16, hqRows: [7, 9] }
};

function randomizePlacement() {
  const state = app.state;
  if (!state) return;
  if (state.phase !== "lobby" && state.phase !== "placement") {
    setHint("You can only randomize at the start.");
    setTimeout(() => setHint(""), 1400);
    return;
  }
  const me = state.players.find((p) => p.id === app.playerId);
  if (!me?.seat) {
    setHint("Take a seat first.");
    setTimeout(() => setHint(""), 1400);
    return;
  }

  const pieces = state.pieces.filter((p) => p.label !== "?" && isProbablyMine(state, p));
  if (!pieces.length) return;

  const zone = HOME_ZONES[me.seat];
  if (!zone) return;

  const { cells } = state.board;

  function posKey(p) { return `${p.r},${p.c}`; }

  const occupied = new Set(
    state.pieces.filter((p) => p.pos).map((p) => posKey(p.pos))
  );

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
  const hqCells   = allHomeCells.filter((cell) => cell.type === "hq");

  let flagCells, mineCells, bombCells, normalCells;
  if (zone.orientation === "row") {
    // Flag: must go on the designated HQ cells.
    flagCells   = hqCells.filter((cell) => cell.r === zone.hqRow && zone.hqCols.includes(cell.c));
    // Mines: must stay in the back 2 rows (post cells only — no HQ/camp).
    mineCells   = postCells.filter((cell) => zone.mineRows.includes(cell.r));
    // Bombs: any post or HQ cell except the front row.
    bombCells   = [...postCells, ...hqCells].filter((cell) => cell.r !== zone.frontRow);
    // Normal officers/engineers: any post or HQ cell (including the front row).
    normalCells = [...postCells, ...hqCells];
  } else {
    flagCells   = hqCells.filter((cell) => cell.c === zone.hqCol && zone.hqRows.includes(cell.r));
    mineCells   = postCells.filter((cell) => zone.mineCols.includes(cell.c));
    bombCells   = [...postCells, ...hqCells].filter((cell) => cell.c !== zone.frontCol);
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
    if (!available.length) continue;
    const pos = randomChoice(available);
    occupied.add(posKey(pos));
    send({ type: "place_piece", pieceId: piece.id, pos });
  }

  setHint("Board randomized.");
  setTimeout(() => setHint(""), 1400);
}

// Track which seat we've already auto-placed for, so we only do it once.
let autoPlacedSeat = null;

const socket = new WebSocket(wsUrl);

socket.addEventListener("open", () => {
  setHint("Pick a seat and click Ready — pieces will be placed automatically.");
  render();
});

socket.addEventListener("close", () => {
  render();
});

socket.addEventListener("message", (ev) => {
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
    render();
    return;
  }
  if (msg.type === "state") {
    app.state = msg.state;
    // If selected piece got removed (bomb), clear selection.
    if (selectedPieceId && app.state && !app.state.pieces.some((p) => p.id === selectedPieceId)) {
      selectedPieceId = null;
    }
    // Auto-randomize placement once when the placement phase begins for this player.
    if (msg.state.phase === "placement") {
      const me = msg.state.players.find((p) => p.id === app.playerId);
      if (me?.seat && me.seat !== autoPlacedSeat) {
        autoPlacedSeat = me.seat;
        setTimeout(() => randomizePlacement(), 150);
      }
    }
    render();
    return;
  }
  if (msg.type === "chat") {
    addChatLine(msg);
    return;
  }
  if (msg.type === "phase") {
    if (msg.phase === "play") setHint("Game started. Select one of your pieces and move.");
    render();
    return;
  }
});

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
  const name = $("nameInput").value.trim();
  if (!name) return;
  send({ type: "set_name", name });
  setHint("Name saved.");
  setTimeout(() => setHint(""), 1200);
});

$("readyBtn").addEventListener("click", () => send({ type: "set_ready", ready: true }));
$("unreadyBtn").addEventListener("click", () => send({ type: "set_ready", ready: false }));

function sendChat() {
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  send({ type: "chat", text });
}

$("sendChatBtn").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

$("randomizeBtn").addEventListener("click", randomizePlacement);

