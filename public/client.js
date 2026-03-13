const $ = (id) => document.getElementById(id);

const roomId = (() => {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] === "room" && parts[1]) return parts[1];
  return null;
})();

if (!roomId) {
  location.href = "/";
}

$("roomId").textContent = roomId;
$("phaseLine").textContent = "Connecting…";

const wsUrl = (() => {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/room/${roomId}`;
})();

/** @type {{playerId:string|null, seats:string[], state:any|null}} */
const app = {
  playerId: null,
  seats: [],
  state: null
};

let selectedPieceId = null;

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

function render() {
  const state = app.state;
  if (!state) return;

  $("phaseLine").textContent = `Phase: ${state.phase}`;
  $("turnLine").textContent =
    state.phase === "play" ? `Turn: ${state.turnSeat ? seatLabel(state.turnSeat) : "-"}` : "";

  renderSeats(state);
  renderBoard(state);
  renderPieces(state);

  const me = state.players.find((p) => p.id === app.playerId) || null;
  $("readyBtn").disabled = !me || !me.seat || me.ready;
  $("unreadyBtn").disabled = !me || !me.seat || !me.ready;
}

function renderSeats(state) {
  const grid = $("seatsGrid");
  grid.innerHTML = "";

  const playersBySeat = new Map();
  for (const p of state.players) {
    if (p.seat) playersBySeat.set(p.seat, p);
  }

  for (const seat of app.seats) {
    const card = document.createElement("div");
    card.className = "seatCard";
    const p = playersBySeat.get(seat) || null;
    const isMe = p && p.id === app.playerId;
    const occupied = Boolean(p);
    const readyClass = p?.ready ? "pill ready" : "pill";
    card.innerHTML = `
      <div class="seatTop">
        <div>
          <div class="seatName">${seatLabel(seat)}</div>
          <div class="muted" style="font-size:12px;margin-top:2px;">
            ${occupied ? (isMe ? "You" : escapeHtml(p.name)) : "Empty"}
          </div>
        </div>
        <div class="${readyClass}">${occupied ? (p.ready ? "Ready" : "Not ready") : "—"}</div>
      </div>
      <div class="seatActions">
        ${
          occupied
            ? isMe
              ? `<button class="btn" data-action="leave" data-seat="${seat}">Leave</button>`
              : `<button class="btn" disabled>Occupied</button>`
            : `<button class="btn primary" data-action="take" data-seat="${seat}">Sit</button>`
        }
      </div>
    `;
    grid.appendChild(card);
  }

  grid.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-action");
      const seat = btn.getAttribute("data-seat");
      if (!seat) return;
      if (action === "take") send({ type: "take_seat", seat });
      if (action === "leave") send({ type: "leave_seat" });
    });
  });
}

function renderBoard(state) {
  const boardEl = $("board");
  const { rows, cols } = state.board;
  boardEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  boardEl.innerHTML = "";

  const pieceByCell = new Map();
  for (const piece of state.pieces) {
    if (!piece.pos) continue;
    pieceByCell.set(`${piece.pos.r},${piece.pos.c}`, piece);
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.setAttribute("data-r", String(r));
      cell.setAttribute("data-c", String(c));
      const key = `${r},${c}`;
      const piece = pieceByCell.get(key) || null;

      const coord = document.createElement("div");
      coord.className = "cellCoord";
      coord.textContent = `${r},${c}`;
      cell.appendChild(coord);

      if (piece) {
        const token = document.createElement("div");
        token.className = "token";
        if (piece.id === selectedPieceId) token.classList.add("selected");
        token.innerHTML = `
          <div class="label">${escapeHtml(piece.label)}</div>
          <div class="owner">${piece.ownerSeat ?? "?"}</div>
        `;
        cell.appendChild(token);
      }

      cell.addEventListener("click", () => onCellClick({ r, c }));
      boardEl.appendChild(cell);
    }
  }
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
      <div class="pieceMeta">
        <div>${posText}</div>
        <div>${p.revealed ? "revealed" : "hidden"}</div>
      </div>
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
  // If label is visible to us, it's either ours or revealed enemy.
  // Treat as ours if not revealed OR ownerSeat matches our seat when present.
  const me = state.players.find((p) => p.id === app.playerId);
  if (!me?.seat) return false;
  if (piece.ownerSeat && piece.ownerSeat === me.seat) return true;
  return piece.ownerSeat === null && piece.revealed === false; // during seating transitions, ownerSeat may be null
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

const socket = new WebSocket(wsUrl);

socket.addEventListener("open", () => {
  $("phaseLine").textContent = "Connected.";
  setHint("Pick a seat, set ready, then place at least 1 piece to start.");
});

socket.addEventListener("close", () => {
  $("phaseLine").textContent = "Disconnected. Refresh to reconnect.";
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

