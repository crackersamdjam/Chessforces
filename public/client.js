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
  const { rows, cols, cells, railEdges } = state.board;
  boardEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  boardEl.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  boardEl.innerHTML = "";

  // ── SVG overlay (z-index 0, below cells) ────────────────────────────────
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${cols} ${rows}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("boardSvg");
  boardEl.appendChild(svg);

  function svgLine(x1, y1, x2, y2, cls) {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
    l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
    l.setAttribute("class", cls);
    svg.appendChild(l);
  }

  // Quarter-circle arc for diagonal connector edges.
  // The arc curves toward the OUTER corner of the arm junction (away from
  // the board centre), making it visually obvious that the connector only
  // flows "with the grain" from deep inside an arm.
  function svgArc(x1, y1, x2, y2, cls) {
    // Recover grid coords from SVG cell-centre coords (x = c+0.5, y = r+0.5).
    const r1 = y1 - 0.5, c1 = x1 - 0.5;
    const r2 = y2 - 0.5, c2 = x2 - 0.5;
    // The arc is centred at the OUTER corner (the candidate cell that lies
    // OUTSIDE the central 5×5 zone), so the curve bows away from the board
    // centre — like a real railway track curving around the outside of a bend.
    // Candidate corners are (r2,c1) and (r1,c2); the inner one sits in [6,10]².
    let icr, icc;
    if (r2 >= 6 && r2 <= 10 && c1 >= 6 && c1 <= 10) { icr = r1; icc = c2; } // outer
    else                                               { icr = r2; icc = c1; } // outer
    const cx = icc + 0.5, cy = icr + 0.5;
    // Cross product (P1−C)×(P2−C) determines sweep direction so the arc
    // always curves through the outer corner of the junction.
    const cross = (x1 - cx) * (y2 - cy) - (y1 - cy) * (x2 - cx);
    const sweep = cross > 0 ? 1 : 0;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", `M ${x1} ${y1} A 1 1 0 0 ${sweep} ${x2} ${y2}`);
    p.setAttribute("class", cls);
    svg.appendChild(p);
  }

  // Pre-build sets for fast lookup.
  // roadKeys: cells that participate in the visible road network.
  // Railonly cells are railway pass-throughs (no pieces, no road lines).
  // Mountain cells are shown but have no visible roads leading to them.
  const roadKeys = new Set(
    cells
      .filter(c => c.type !== "inactive" && c.type !== "railonly" && c.type !== "mountain")
      .map(c => `${c.r},${c.c}`)
  );
  const railSet = new Set();
  for (const [a, b] of (railEdges ?? [])) {
    const k = a.r < b.r || (a.r === b.r && a.c <= b.c)
      ? `${a.r},${a.c},${b.r},${b.c}` : `${b.r},${b.c},${a.r},${a.c}`;
    railSet.add(k);
  }
  function edgeKey(r1, c1, r2, c2) {
    return r1 < r2 || (r1 === r2 && c1 <= c2)
      ? `${r1},${c1},${r2},${c2}` : `${r2},${c2},${r1},${c1}`;
  }

  // Draw orthogonal road lines (non-railway adjacencies between road-network cells).
  for (const { r, c } of cells) {
    if (!roadKeys.has(`${r},${c}`)) continue;
    // right neighbour
    if (roadKeys.has(`${r},${c + 1}`)) {
      const k = edgeKey(r, c, r, c + 1);
      if (!railSet.has(k)) svgLine(c + 0.5, r + 0.5, c + 1.5, r + 0.5, "boardRoad");
    }
    // bottom neighbour
    if (roadKeys.has(`${r + 1},${c}`)) {
      const k = edgeKey(r, c, r + 1, c);
      if (!railSet.has(k)) svgLine(c + 0.5, r + 0.5, c + 0.5, r + 1.5, "boardRoad");
    }
  }
  // Draw diagonal roads for camp cells (行营 have 4 diagonal connections).
  // Deduplicated so each edge is drawn once.
  const campDiagSet = new Set();
  for (const { r, c, type } of cells) {
    if (type !== "camp") continue;
    for (const [dr, dc] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
      const nr = r + dr, nc = c + dc;
      if (!roadKeys.has(`${nr},${nc}`)) continue;
      const ek = r < nr || (r === nr && c < nc)
        ? `${r},${c},${nr},${nc}` : `${nr},${nc},${r},${c}`;
      if (campDiagSet.has(ek)) continue;
      campDiagSet.add(ek);
      svgLine(c + 0.5, r + 0.5, nc + 0.5, nr + 0.5, "boardRoad");
    }
  }
  // Draw railway lines (two-layer: golden base + black dashes).
  // Diagonal connector edges are drawn as quarter-circle arcs so the curve
  // makes it clear which direction the branch naturally flows.
  for (const [a, b] of (railEdges ?? [])) {
    const x1 = a.c + 0.5, y1 = a.r + 0.5, x2 = b.c + 0.5, y2 = b.r + 0.5;
    const isDiag = Math.abs(a.r - b.r) === 1 && Math.abs(a.c - b.c) === 1;
    const draw = isDiag ? svgArc : svgLine;
    draw(x1, y1, x2, y2, "boardRailBase");
    draw(x1, y1, x2, y2, "boardRailDash");
  }
  // ────────────────────────────────────────────────────────────────────────

  for (const cellDef of cells) {
    const { r, c, type } = cellDef;
    const cell = document.createElement("div");
    const key = `${r},${c}`;

    // Inactive and rail-only cells are transparent grid placeholders (no pieces, no clicks).
    if (type === "inactive" || type === "railonly") {
      cell.className = "cell cell--inactive";
      boardEl.appendChild(cell);
      continue;
    }

    // Mountain cells (山界): labelled, clickable, but no visible road lines.
    if (type === "mountain") {
      cell.className = "cell cell--mountain";
      const lbl = document.createElement("div");
      lbl.className = "mountainLabel";
      lbl.textContent = "山界";
      cell.appendChild(lbl);
      const tokenHost = document.createElement("div");
      tokenHost.className = "cellTokenHost";
      cell.appendChild(tokenHost);
      cell.addEventListener("click", () => onCellClick({ r, c }));
      boardEl.appendChild(cell);
      boardViews.set(key, { cell, tokenHost });
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
  const myPieces = state.pieces.filter((p) => isMyPiece(state, p));
  const allMyPiecesPlaced =
    myPieces.length > 0 && myPieces.every((p) => p.pos !== null);
  $("readyBtn").disabled = !me || !me.seat || me.ready || !allMyPiecesPlaced;
  $("unreadyBtn").disabled = !me || !me.seat || !me.ready;
  // Hide lobby controls (ready, randomize) once the game is under way.
  const inPlay = state.phase === "play" || state.phase === "done";
  const lobbyEl = $("lobbyControls");
  if (lobbyEl) lobbyEl.style.display = inPlay ? "none" : "";
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
  if (!list) return;
  list.innerHTML = "";
  const myPieces = state.pieces.filter((p) => p.ownerSeat && isMineSeat(state, p.ownerSeat));

  // If you haven't taken a seat yet, you won't have an ownerSeat; instead infer from hidden state:
  // We show "your pieces" by matching the pieces labeled (server already hides others).
  const mine = state.pieces.filter((p) => p.label !== "?" && isMyPiece(state, p));
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
      if (selectedPieceId) {
        const ph = state.phase;
        setHint(ph === "play"
          ? "Click a destination cell to move."
          : "Click a cell to place, or another piece to swap.");
      } else {
        setHint("");
      }
      render();
    });
    list.appendChild(btn);
  }
}

function isMineSeat(state, ownerSeat) {
  const me = state.players.find((p) => p.id === app.playerId);
  return Boolean(me && me.seat === ownerSeat);
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
  const state = app.state;
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
      const fromPos = selPiece.pos;  // may be null if selPiece is unplaced
      const toPos   = clickedPiece.pos;
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
  N: { minR: 0,  maxR: 5,  minC: 6,  maxC: 10, orientation: "row", frontRow: 5,  mineRows: [0, 1],   hqRow: 0,  hqCols: [7, 9] },
  S: { minR: 11, maxR: 16, minC: 6,  maxC: 10, orientation: "row", frontRow: 11, mineRows: [15, 16], hqRow: 16, hqCols: [7, 9] },
  W: { minR: 6,  maxR: 10, minC: 0,  maxC: 5,  orientation: "col", frontCol: 5,  mineCols: [0, 1],   hqCol: 0,  hqRows: [7, 9] },
  E: { minR: 6,  maxR: 10, minC: 11, maxC: 16, orientation: "col", frontCol: 11, mineCols: [15, 16], hqCol: 16, hqRows: [7, 9] }
};

function randomizePlacement() {
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
  if (!pieces.length) return;

  const zone = HOME_ZONES[me.seat];
  if (!zone) return;

  // Unplace all of my currently placed pieces so the server accepts re-placement.
  for (const p of pieces) {
    if (p.pos) send({ type: "place_piece", pieceId: p.id, pos: null });
  }

  const { cells } = state.board;

  function posKey(p) { return `${p.r},${p.c}`; }

  // Only treat OTHER players' pieces as occupied — my own will be cleared by the messages above.
  const occupied = new Set(
    state.pieces.filter((p) => p.pos && !isMyPiece(state, p)).map((p) => posKey(p.pos))
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
  setHint("Pick a seat — pieces will be placed automatically. Click Ready when done.");
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
    const prevPhase = app.state?.phase;
    app.state = msg.state;
    // If selected piece got removed (bomb), clear selection.
    if (selectedPieceId && !app.state.pieces.some((p) => p.id === selectedPieceId)) {
      selectedPieceId = null;
    }
    // Auto-randomize as soon as the player takes a seat in the lobby.
    if (msg.state.phase === "lobby") {
      const me = msg.state.players.find((p) => p.id === app.playerId);
      if (me?.seat && me.seat !== autoPlacedSeat) {
        autoPlacedSeat = me.seat;
        setTimeout(() => randomizePlacement(), 150);
      }
    }
    // Show hint on phase transitions.
    if (prevPhase !== msg.state.phase) {
      if (msg.state.phase === "play") setHint("Game started. Select one of your pieces and move.");
    }
    render();
    return;
  }
  if (msg.type === "chat") {
    addChatLine(msg);
    return;
  }
  if (msg.type === "phase") {
    // Legacy handler kept for forward-compatibility; server now sends state instead.
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

