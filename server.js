import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const HOST = process.env.HOST ?? "0.0.0.0";

const app = express();
app.disable("x-powered-by");

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Always serve the SPA shell; the client JS will assign/generate a room id
// and update the URL without causing a full reload.
app.get(["/", "/room/:roomId"], (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Room state lives in-memory (good for a simple demo).
 * If you want persistence/hosting scale, we can add Redis later.
 */
const rooms = new Map();

const SEATS = /** @type {const} */ (["N", "E", "S", "W"]);
const PHASES = /** @type {const} */ ({
  LOBBY: "lobby",
  PLACEMENT: "placement",
  PLAY: "play",
  DONE: "done"
});

// Full Junqi-style piece set (2‑side version, reused per seat).
// We keep the standard ranks and special pieces but still allow up to 4 seats on one board.
const PIECE_DEFS = [
  { type: "marshal", label: "司令(40)", rank: 9, count: 1 },
  { type: "general", label: "军长(39)", rank: 8, count: 1 },
  { type: "major_general", label: "师长(38)", rank: 7, count: 2 },
  { type: "brigadier", label: "旅长(37)", rank: 6, count: 2 },
  { type: "colonel", label: "团长(36)", rank: 5, count: 2 },
  { type: "major", label: "营长(35)", rank: 4, count: 2 },
  { type: "captain", label: "连长(34)", rank: 3, count: 3 },
  { type: "lieutenant", label: "排长(33)", rank: 2, count: 3 },
  { type: "engineer", label: "工兵(1)", rank: 1, count: 3 },
  { type: "bomb", label: "炸弹(0)", rank: null, count: 2 },
  { type: "mine", label: "地雷(X)", rank: null, count: 3 },
  { type: "flag", label: "军旗($)", rank: null, count: 1 }
];

/**
 * Create a 4-player cross-shaped (+ shape) Luzhanqi-style board:
 * - 17 rows × 17 cols (square)
 * - Active cells: vertical bar (cols 6-10, all rows) UNION horizontal bar (rows 6-10, all cols)
 * - Inactive corner cells (6×6 each) keep the cross shape
 * - Each player has a fully exclusive 6×5 (or 5×6) home zone — 30 cells, 24 post + 4 camp + 2 HQ:
 *     N: rows 0-5,   cols 6-10  (front = row 5,  back = row 0)
 *     S: rows 11-16, cols 6-10  (front = row 11, back = row 16)
 *     W: rows 6-10,  cols 0-5   (front = col 5,  back = col 0)
 *     E: rows 6-10,  cols 11-16 (front = col 11, back = col 16)
 * - Center (rows 6-10, cols 6-10) is shared battle territory — not part of any home zone
 * - 30 cells per arm gives exactly 24 post cells for 24 non-flag pieces + 2 HQ (1 for flag)
 */
function createBoard() {
  const rows = 17;
  const cols = 17;
  /** @type {{rows:number, cols:number, cells:{r:number,c:number,type:"post"|"camp"|"hq"|"inactive"|"railonly"|"mountain"}[], railEdges:[{r:number,c:number},{r:number,c:number}][]}} */
  // @ts-ignore
  const board = { rows, cols, cells: [] };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Cross (+ shape): vertical bar (cols 6-10) union horizontal bar (rows 6-10).
      const active = (c >= 6 && c <= 10) || (r >= 6 && r <= 10);
      board.cells.push({ r, c, type: active ? "post" : "inactive" });
    }
  }

  // Helper to set cell type safely (will not overwrite inactive cells).
  function mark(r, c, type) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    const cell = board.cells[r * cols + c];
    if (cell.type === "inactive") return;
    cell.type = type;
  }

  // N home (rows 0-5, cols 6-10): HQ at back (row 0); 5 camps in plum-blossom pattern at rows 2-4.
  // Layout (row 0=back, row 5=front):  row2: C·C  row3: ·C·  row4: C·C
  mark(0, 7, "hq");  mark(0, 9, "hq");
  mark(2, 7, "camp"); mark(2, 9, "camp");
  mark(3, 8, "camp"); // centre camp
  mark(4, 7, "camp"); mark(4, 9, "camp");

  // S home (rows 11-16, cols 6-10): HQ at back (row 16); camps at rows 12-14 (mirrored).
  mark(16, 7, "hq"); mark(16, 9, "hq");
  mark(12, 7, "camp"); mark(12, 9, "camp");
  mark(13, 8, "camp"); // centre camp
  mark(14, 7, "camp"); mark(14, 9, "camp");

  // W home (rows 6-10, cols 0-5): HQ at back (col 0); 5 camps at cols 2-4 (rotated pattern).
  // Layout (col 0=back, col 5=front):  col2: C·C  col3: ·C·  col4: C·C
  mark(7, 0, "hq");  mark(9, 0, "hq");
  mark(7, 2, "camp"); mark(9, 2, "camp");
  mark(8, 3, "camp"); // centre camp
  mark(7, 4, "camp"); mark(9, 4, "camp");

  // E home (rows 6-10, cols 11-16): HQ at back (col 16); camps at cols 12-14 (mirrored).
  mark(7, 16, "hq"); mark(9, 16, "hq");
  mark(7, 12, "camp"); mark(9, 12, "camp");
  mark(8, 13, "camp"); // centre camp
  mark(7, 14, "camp"); mark(9, 14, "camp");

  // Center railway-only pass-through nodes — pieces cannot stop here.
  for (const [r, c] of [[6,7],[7,6],[6,9],[7,8],[7,10],[9,6],[9,8],[9,10],[10,7],[10,9],[8,7],[8,9]]) {
    mark(r, c, "railonly");
  }
  // Mountain zones (山界) — only engineers (工兵) may enter.
  for (const [r, c] of [[7,7],[7,9],[9,7],[9,9]]) {
    mark(r, c, "mountain");
  }

  // ── Railway edge topology ──────────────────────────────────────────────────
  // Layout (same structure for each arm, described for N; others are symmetric):
  //   • Back row/col: row 1 for N, row 15 for S, col 1 for W, col 15 for E
  //   • Front row/col: row 5 for N, row 11 for S, col 5 for W, col 11 for E
  //   • HQ rows/cols (0, 16, 0, 16) are OFF the railway
  //   • The col/row sides of each arm connect back↔front and reach into the center loop
  //   • Center inner loop (border of 5×5 center square) links all four arms
  //   • No diagonal spine; straight-line-only movement enforced in isValidRailwayMove
  const railEdges = [];
  function re(r1, c1, r2, c2) { railEdges.push([{ r: r1, c: c1 }, { r: r2, c: c2 }]); }

  // N arm  (rows 0-5, cols 6-10 — HQ row 0 excluded)
  for (let c = 6; c < 10; c++) re(1, c, 1, c + 1);    // back row 1
  for (let c = 6; c < 10; c++) re(5, c, 5, c + 1);    // front row 5
  for (let r = 1; r < 6; r++)  re(r, 6, r + 1, 6);    // left col 6  (rows 1→6, joins center)
  for (let r = 1; r < 6; r++)  re(r, 10, r + 1, 10);  // right col 10 (rows 1→6, joins center)

  // S arm  (rows 11-16, cols 6-10 — HQ row 16 excluded)
  for (let c = 6; c < 10; c++) re(11, c, 11, c + 1);  // front row 11
  for (let c = 6; c < 10; c++) re(15, c, 15, c + 1);  // back row 15
  for (let r = 10; r < 15; r++) re(r, 6, r + 1, 6);   // left col 6  (rows 10→15)
  for (let r = 10; r < 15; r++) re(r, 10, r + 1, 10); // right col 10 (rows 10→15)

  // W arm  (rows 6-10, cols 0-5 — HQ col 0 excluded)
  for (let r = 6; r < 10; r++) re(r, 1, r + 1, 1);    // back col 1
  for (let r = 6; r < 10; r++) re(r, 5, r + 1, 5);    // front col 5
  for (let c = 1; c < 6; c++)  re(6, c, 6, c + 1);    // top row 6   (cols 1→6, joins center)
  for (let c = 1; c < 6; c++)  re(10, c, 10, c + 1);  // bottom row 10 (cols 1→6)

  // E arm  (rows 6-10, cols 11-16 — HQ col 16 excluded)
  for (let r = 6; r < 10; r++) re(r, 11, r + 1, 11);  // front col 11
  for (let r = 6; r < 10; r++) re(r, 15, r + 1, 15);  // back col 15
  for (let c = 10; c < 15; c++) re(6, c, 6, c + 1);   // top row 6   (cols 10→15)
  for (let c = 10; c < 15; c++) re(10, c, 10, c + 1); // bottom row 10 (cols 10→15)

  // Center inner loop (border of 5×5 center square, rows/cols 6-10)
  for (let c = 6; c < 10; c++) re(6, c, 6, c + 1);    // top    row 6
  for (let r = 6; r < 10; r++) re(r, 10, r + 1, 10);  // right  col 10
  for (let c = 6; c < 10; c++) re(10, c, 10, c + 1);  // bottom row 10
  for (let r = 6; r < 10; r++) re(r, 6, r + 1, 6);    // left   col 6

  // Center cross: col 8 (rows 5→11) and row 8 (cols 5→11)
  // Connects N front row ↔ S front row and W front col ↔ E front col through center.
  for (let r = 5; r < 11; r++) re(r, 8, r + 1, 8);    // vertical   col 8
  for (let c = 5; c < 11; c++) re(8, c, 8, c + 1);    // horizontal row 8

  // Diagonal corner connectors — join adjacent arm railways at the four junctions.
  // Engineers can turn here; other pieces cannot use these edges (straight-line rule).
  re(5, 6,  6,  5);   // N-arm left   ↔ W-arm top
  re(5, 10, 6,  11);  // N-arm right  ↔ E-arm top
  re(11, 6, 10, 5);   // S-arm left   ↔ W-arm bottom
  re(11, 10, 10, 11); // S-arm right  ↔ E-arm bottom

  board.railEdges = railEdges;
  return board;
}

function boardCellAt(board, pos) {
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

function nowMs() {
  return Date.now();
}

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const p of room.players.values()) safeSend(p.ws, obj);
}

function roomSnapshotFor(room, viewerId) {
  const players = [];
  for (const [pid, p] of room.players) {
    players.push({
      id: pid,
      name: p.name,
      seat: p.seat,
      ready: p.ready
    });
  }

  const pieces = [];
  // Pieces: label is only visible to the owner — never revealed to opponents.
  for (const piece of room.pieces.values()) {
    const isOwner = piece.ownerId === viewerId;
    pieces.push({
      id: piece.id,
      ownerSeat: room.players.get(piece.ownerId)?.seat ?? null,
      pos: piece.pos,
      label: isOwner ? piece.label : "?",
      type: isOwner ? piece.type : null
    });
  }

  return {
    roomId: room.id,
    phase: room.phase,
    players,
    board: room.board,
    pieces,
    turnSeat: room.turnSeat,
    lastMove: room.lastMove,
    winnerSeat: room.winnerSeat ?? null,
    gameOverReason: room.gameOverReason ?? null
  };
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      phase: PHASES.LOBBY,
      players: new Map(), // playerId -> {ws, name, seat, ready, joinedAt}
      seatToPlayerId: new Map(), // seat -> playerId
      // 17 rows × 17 cols cross-shaped board with typed cells (兵站 / 行营 / 大本营).
      board: createBoard(),
      pieces: new Map(), // pieceId -> {id, ownerId, type, label, rank, pos:{r,c}|null, alive:boolean}
      turnSeat: null,
      lastMove: null,
      winnerSeat: null,
      gameOverReason: null
    };
    rooms.set(roomId, room);
  }
  return room;
}

function chooseSeat(room) {
  for (const s of SEATS) {
    if (!room.seatToPlayerId.has(s)) return s;
  }
  return null;
}

/** Build (lazily cached) adjacency map from railEdges for BFS. */
function getRailAdj(room) {
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

/**
 * Railway move validator.
 *
 * Engineers (工兵): full BFS — may turn freely at any junction, still blocked
 *   by pieces on intermediate cells.
 *
 * All other pieces: directional BFS — must travel in a straight line (same row
 *   or column), but may pass through EXACTLY ONE diagonal connector per move.
 *   The diagonal connector resets the travel direction, allowing the piece to
 *   then continue straight in any direction on the new arm.
 *   Example: (1,6) → down col 6 → (5,6) → diagonal → (6,5) → left row 6 → (6,2).
 *
 * Capture / camp validity is checked by the caller after this returns true.
 */
function isValidRailwayMove(room, piece, from, to) {
  const adj = getRailAdj(room);
  const startKey = `${from.r},${from.c}`;
  const toKey   = `${to.r},${to.c}`;
  const ORTHO = [[0,1],[0,-1],[1,0],[-1,0]];

  if (piece.type === "engineer") {
    // Engineers use full BFS on the railway and may additionally:
    //   • Enter a mountain cell (山界) by stepping off the rail in one final
    //     orthogonal step from any railway node adjacent to the mountain.
    //   • Exit a mountain cell by first stepping onto any adjacent railway node
    //     that is not blocked, then continuing normally on the rail.
    const fromCell = boardCellAt(room.board, from);
    const visited = new Set();
    const queue = [];

    if (fromCell?.type === "mountain") {
      // Piece is starting on a mountain: seed the BFS with all adjacent
      // unblocked railway cells (the "exit step" off the mountain).
      visited.add(startKey);
      for (const [dr, dc] of ORTHO) {
        const nr = from.r + dr, nc = from.c + dc;
        const nk = `${nr},${nc}`;
        if (!adj.has(nk)) continue;           // not on railway
        if (pieceAt(room, {r: nr, c: nc})) continue; // blocked
        if (visited.has(nk)) continue;
        visited.add(nk);
        if (nk === toKey) return true;
        queue.push({r: nr, c: nc});
      }
    } else {
      if (!adj.has(startKey)) return false;   // source not on railway
      visited.add(startKey);
      queue.push(from);
    }

    while (queue.length > 0) {
      const cur = queue.shift();
      // Standard railway BFS expansion.
      for (const next of (adj.get(`${cur.r},${cur.c}`) ?? [])) {
        const nk = `${next.r},${next.c}`;
        if (visited.has(nk)) continue;
        visited.add(nk);
        if (nk === toKey) return true;
        if (pieceAt(room, next)) continue; // blocked
        queue.push(next);
      }
      // One-step exit from railway onto an adjacent mountain cell.
      for (const [dr, dc] of ORTHO) {
        const mr = cur.r + dr, mc = cur.c + dc;
        if (`${mr},${mc}` !== toKey) continue;
        const destCell = boardCellAt(room.board, {r: mr, c: mc});
        if (destCell?.type === "mountain") return true;
      }
    }
    return false;
  }

  // Non-engineers cannot start on or reach mountain cells, so the early guard
  // is still valid for them.
  if (!adj.has(startKey)) return false;

  // ── Non-engineer: DFS with direction tracking ─────────────────────────────
  // Two distinct rules depending on edge type:
  //
  // Regular (orthogonal) edges — no turns allowed:
  //   dot product of new direction with current direction must be > 0.
  //   (any direction is allowed on the very first step, dr=dc=0)
  //
  // Diagonal connector edges — usable only from "deep within a side":
  //   the cell we arrived FROM, (r−dr, c−dc), must satisfy
  //   prevR < 5 || prevC < 5 || prevR > 11 || prevC > 11
  //   i.e. it must be outside the 6×6 center band, meaning the piece is
  //   genuinely travelling along an arm rail toward the corner junction.
  //   This prevents shortcuts like (5,9)→(5,10)→diagonal(6,11).
  //   On the first step dr=dc=0 the "prev" resolves to the piece's own cell,
  //   which is never deep, so diagonal-as-first-step is correctly blocked.

  const visited = new Set();

  function dfs(r, c, dr, dc) {
    const isFirstStep = dr === 0 && dc === 0;
    for (const next of (adj.get(`${r},${c}`) ?? [])) {
      const ndr = Math.sign(next.r - r);
      const ndc = Math.sign(next.c - c);
      const isDiag = (ndr !== 0 && ndc !== 0);

      if (isDiag) {
        // Must be travelling from deep inside an arm.
        const prevR = r - dr, prevC = c - dc;
        if (!isFirstStep && !(prevR < 5 || prevC < 5 || prevR > 11 || prevC > 11)) continue;
      } else {
        // Straight-line only — no turning at regular junctions.
        if ((dr !== 0 || dc !== 0) && (dr * ndr + dc * ndc) <= 0) continue;
      }

      const sk = `${next.r},${next.c},${ndr},${ndc}`;
      if (visited.has(sk)) continue;
      visited.add(sk);

      if (next.r === to.r && next.c === to.c) return true;
      if (pieceAt(room, next)) continue; // blocked intermediate cell

      if (dfs(next.r, next.c, ndr, ndc)) return true;
    }
    return false;
  }

  return dfs(from.r, from.c, 0, 0);
}

function broadcastState(room) {
  for (const [pid, p] of room.players) {
    safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
  }
}

function allPiecesPlaced(room, playerId) {
  const mine = Array.from(room.pieces.values()).filter((pc) => pc.ownerId === playerId);
  return mine.length > 0 && mine.every((pc) => pc.pos !== null);
}

function maybeAdvancePhase(room) {
  // Placement now happens in the lobby phase before declaring ready.
  // The game starts (LOBBY → PLAY) once every seated player is ready.
  if (room.phase !== PHASES.LOBBY) return;

  const seatedPlayers = Array.from(room.players.values()).filter((p) => p.seat);
  if (seatedPlayers.length < 2) return;

  const allReady = seatedPlayers.every((p) => p.ready);
  if (!allReady) return;

  room.phase = PHASES.PLAY;
  room.turnSeat = SEATS.find((s) => room.seatToPlayerId.has(s)) ?? null;
  room.updatedAt = nowMs();
  room.winnerSeat = null;
  room.gameOverReason = null;
  broadcastState(room);
}

function nextOccupiedSeat(room, fromSeat) {
  const startIdx = SEATS.indexOf(fromSeat);
  for (let i = 1; i <= SEATS.length; i++) {
    const seat = SEATS[(startIdx + i) % SEATS.length];
    if (room.seatToPlayerId.has(seat)) return seat;
  }
  return fromSeat;
}

function isInBounds(board, pos) {
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

function pieceAt(room, pos) {
  for (const p of room.pieces.values()) {
    if (p.alive !== false && p.pos && p.pos.r === pos.r && p.pos.c === pos.c) return p;
  }
  return null;
}

function ensurePieceSet(room, playerId) {
  const existing = Array.from(room.pieces.values()).some((p) => p.ownerId === playerId);
  if (existing) return;

  for (const def of PIECE_DEFS) {
    for (let i = 0; i < def.count; i++) {
      const id = nanoid(8);
      room.pieces.set(id, {
        id,
        ownerId: playerId,
        type: def.type,
        label: def.label,
        rank: def.rank,
        pos: null,
        alive: true
      });
    }
  }
}

/**
 * Returns placement-constraint info for each seat's home zone.
 * N/S are "row-oriented" (the arm extends vertically, 6 rows × 5 cols = 30 cells).
 * W/E are "col-oriented" (the arm extends horizontally, 5 rows × 6 cols = 30 cells).
 *
 * Home zones (exclusive — no overlap with center or other arms):
 *   N: rows 0-5,   cols 6-10  (center starts at row 6)
 *   S: rows 11-16, cols 6-10  (center ends  at row 10)
 *   W: rows 6-10,  cols 0-5   (center starts at col 6)
 *   E: rows 6-10,  cols 11-16 (center ends  at col 10)
 */
function homeInfoForSeat(board, seat) {
  switch (seat) {
    case "N":
      return {
        minR: 0,  maxR: 5,  minC: 6,  maxC: 10,
        orientation: "row",
        frontRow: 5,          // row closest to center (bombs not allowed here)
        mineRows: [0, 1],     // back 2 rows (mines must be here)
        hqRow: 0, hqCols: [7, 9]
      };
    case "S":
      return {
        minR: 11, maxR: 16, minC: 6,  maxC: 10,
        orientation: "row",
        frontRow: 11,
        mineRows: [15, 16],
        hqRow: 16, hqCols: [7, 9]
      };
    case "W":
      return {
        minR: 6,  maxR: 10, minC: 0,  maxC: 5,
        orientation: "col",
        frontCol: 5,          // col closest to center
        mineCols: [0, 1],     // back 2 cols
        hqCol: 0, hqRows: [7, 9]
      };
    case "E":
      return {
        minR: 6,  maxR: 10, minC: 11, maxC: 16,
        orientation: "col",
        frontCol: 11,
        mineCols: [15, 16],
        hqCol: 16, hqRows: [7, 9]
      };
    default:
      return null;
  }
}

function isHQCell(board, seat, pos) {
  const info = homeInfoForSeat(board, seat);
  if (!info) return false;
  const cell = boardCellAt(board, pos);
  if (!cell || cell.type !== "hq") return false;
  if (info.orientation === "row") {
    return pos.r === info.hqRow && info.hqCols.includes(pos.c);
  }
  return pos.c === info.hqCol && info.hqRows.includes(pos.r);
}

function validatePlacement(room, piece, player) {
  if (!player.seat) return false;
  const pos = piece.pos;
  if (!pos) return true;
  const info = homeInfoForSeat(room.board, player.seat);
  if (!info) return false;

  // Must be within own home zone bounding box.
  if (pos.r < info.minR || pos.r > info.maxR || pos.c < info.minC || pos.c > info.maxC) return false;

  const cell = boardCellAt(room.board, pos);
  if (!cell || cell.type === "inactive") return false;

  // No initial placement on 行营 (camp).
  if (cell.type === "camp") return false;

  if (info.orientation === "row") {
    if (piece.type === "bomb" && pos.r === info.frontRow) return false;
    if (piece.type === "mine" && !info.mineRows.includes(pos.r)) return false;
  } else {
    if (piece.type === "bomb" && pos.c === info.frontCol) return false;
    if (piece.type === "mine" && !info.mineCols.includes(pos.c)) return false;
  }

  if (piece.type === "flag") {
    // Flag must be placed on an HQ cell.
    if (!isHQCell(room.board, player.seat, pos)) return false;
  }
  // Non-flag pieces may occupy any non-camp, in-bounds cell including the second HQ.
  return true;
}

function resolveCapture(attacker, defender) {
  // Flag captured: attacker wins, defender removed.
  if (defender.type === "flag") {
    defender.alive = false;
    defender.pos = null;
    return { result: "flag", attackerId: attacker.id, defenderId: defender.id };
    // TODO: may need additional eliminatePlayer logic
  }
  
  // Bomb interaction.
  if (attacker.type === "bomb" || defender.type === "bomb") {
    attacker.alive = false;
    defender.alive = false;
    attacker.pos = null;
    defender.pos = null;
    return { result: "both", attackerId: attacker.id, defenderId: defender.id };
  }

  // Landmine interaction.
  if (defender.type === "mine") {
    if (attacker.type === "engineer") {
      // Engineer safely clears the mine.
      defender.alive = false;
      defender.pos = null;
      return { result: "attacker", attackerId: attacker.id, defenderId: defender.id };
    }
    // Non‑engineers die on the mine; mines are not removed.
    attacker.alive = false;
    attacker.pos = null;
    return { result: "defender", attackerId: attacker.id, defenderId: defender.id };
  }

  // Normal rank comparison for officers/engineers.
  if (typeof attacker.rank === "number" && typeof defender.rank === "number") {
    if (attacker.rank > defender.rank) {
      defender.alive = false;
      defender.pos = null;
      return { result: "attacker", attackerId: attacker.id, defenderId: defender.id };
    }
    if (attacker.rank < defender.rank) {
      attacker.alive = false;
      attacker.pos = null;
      return { result: "defender", attackerId: attacker.id, defenderId: defender.id };
    }
    // Equal rank: both removed.
    attacker.alive = false;
    defender.alive = false;
    attacker.pos = null;
    defender.pos = null;
    return { result: "both", attackerId: attacker.id, defenderId: defender.id };
  }

  assert(false, "Invalid combat resolution");
}

function checkForWin(room) {
  // If any flag is dead, the opposing seat team wins.
  const aliveFlagsBySeat = new Map();
  for (const piece of room.pieces.values()) {
    if (!piece.alive || piece.type !== "flag" || !piece.ownerId) continue;
    const ownerSeat = room.players.get(piece.ownerId)?.seat;
    if (!ownerSeat) continue;
    aliveFlagsBySeat.set(ownerSeat, true);
  }
  if (aliveFlagsBySeat.size >= 2) return;

  if (aliveFlagsBySeat.size === 0) {
    room.phase = PHASES.DONE;
    room.winnerSeat = null;
    room.gameOverReason = "both_flags_lost";
    return;
  }

  // Only one seat still has a flag.
  const [survivorSeat] = aliveFlagsBySeat.keys();
  room.phase = PHASES.DONE;
  room.winnerSeat = survivorSeat;
  room.gameOverReason = "flag_captured";
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  // Expect ws path: /ws/room/<roomId>
  const roomId = parts[0] === "ws" && parts[1] === "room" ? parts[2] : null;
  if (!roomId) {
    ws.close(1008, "Missing roomId");
    return;
  }

  const room = getOrCreateRoom(roomId);
  const playerId = nanoid(10);

  /** @type {{id:string, ws:any, name:string, seat:string|null, ready:boolean, joinedAt:number}} */
  const player = {
    id: playerId,
    ws,
    name: `Player-${playerId.slice(0, 4)}`,
    seat: null,
    ready: false,
    joinedAt: nowMs()
  };
  room.players.set(playerId, player);
  room.updatedAt = nowMs();

  safeSend(ws, { type: "hello", playerId, seats: SEATS });
  safeSend(ws, { type: "state", state: roomSnapshotFor(room, playerId) });
  broadcast(room, { type: "presence" });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== "string") return;
    room.updatedAt = nowMs();

    if (msg.type === "set_name") {
      player.name = String(msg.name ?? "").slice(0, 24) || player.name;
      broadcast(room, { type: "state", state: roomSnapshotFor(room, playerId) });
      return;
    }

    if (msg.type === "take_seat") {
      if (room.phase === PHASES.PLAY || room.phase === PHASES.DONE) return;
      const seat = String(msg.seat ?? "");
      if (!SEATS.includes(seat)) return;
      if (room.seatToPlayerId.has(seat)) return;
      if (player.seat) room.seatToPlayerId.delete(player.seat);
      player.seat = seat;
      room.seatToPlayerId.set(seat, playerId);
      ensurePieceSet(room, playerId);
      broadcast(room, { type: "presence" });
      for (const [pid, p] of room.players) {
        safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      return;
    }

    if (msg.type === "leave_seat") {
      if (room.phase === PHASES.PLAY || room.phase === PHASES.DONE) return;
      if (player.seat) room.seatToPlayerId.delete(player.seat);
      player.seat = null;
      player.ready = false;
      broadcast(room, { type: "presence" });
      for (const [pid, p] of room.players) {
        safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      return;
    }

    if (msg.type === "set_ready") {
      const wantsReady = Boolean(msg.ready);
      // Prevent readying up until every piece has been placed.
      if (wantsReady && !allPiecesPlaced(room, playerId)) return;
      player.ready = wantsReady;
      for (const [pid, p] of room.players) {
        safeSend(p.ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      maybeAdvancePhase(room);
      return;
    }

    if (msg.type === "place_piece") {
      if (room.phase !== PHASES.LOBBY) return;
      if (!player.seat) return;
      const pieceId = String(msg.pieceId ?? "");
      const pos = msg.pos ?? null;
      const piece = room.pieces.get(pieceId);
      if (!piece || piece.ownerId !== playerId) return;
      if (pos !== null && !isInBounds(room.board, pos)) return;
      if (pos !== null && pieceAt(room, pos)) return;
      piece.pos = pos;
      if (!validatePlacement(room, piece, player)) {
        // Revert if placement breaks Junqi constraints.
        piece.pos = null;
        return;
      }
      room.updatedAt = nowMs();
      for (const [pid] of room.players) {
        safeSend(room.players.get(pid).ws, { type: "state", state: roomSnapshotFor(room, pid) });
      }
      maybeAdvancePhase(room);
      return;
    }

    if (msg.type === "move") {
      if (room.phase !== PHASES.PLAY) return;
      if (!player.seat) return;
      if (room.turnSeat !== player.seat) return;
      const pieceId = String(msg.pieceId ?? "");
      const to = msg.to ?? null;
      if (!isInBounds(room.board, to)) return;
      const piece = room.pieces.get(pieceId);
      if (!piece || piece.ownerId !== playerId || !piece.pos || piece.alive === false) return;
      if (piece.type === "flag" || piece.type === "mine") return; // cannot move
      const from = piece.pos;
      if (from.r === to.r && from.c === to.c) return;

      // Validate move: 1-step road OR multi-step railway slide.
      const dr = Math.abs(to.r - from.r), dc = Math.abs(to.c - from.c);
      const isRoadMove = dr + dc === 1;
      if (!isRoadMove && !isValidRailwayMove(room, piece, from, to)) return;

      // Destination cell restrictions.
      const toCell = boardCellAt(room.board, to);
      if (toCell?.type === "railonly") return; // rail pass-through only, no landing
      if (toCell?.type === "mountain" && piece.type !== "engineer") return; // 山界: engineers only

      const target = pieceAt(room, to);
      if (target && target.ownerId === playerId) return; // can't capture own piece
      // Pieces on camp cells are immune to capture.
      if (target && boardCellAt(room.board, to)?.type === "camp") return;

      let capture = null;
      if (target) {
        capture = resolveCapture(piece, target);
        if (piece.alive !== false) piece.pos = to;
      } else {
        piece.pos = to;
      }

      room.lastMove = { by: player.seat, pieceId: piece.id, from, to, capture };
      if (room.phase !== PHASES.DONE) {
        room.turnSeat = nextOccupiedSeat(room, room.turnSeat);
      }

      // Check for win after each capture/move.
      checkForWin(room);

      for (const [pid] of room.players) {
        safeSend(room.players.get(pid).ws, {
          type: "state",
          state: roomSnapshotFor(room, pid)
        });
      }
      return;
    }

    if (msg.type === "chat") {
      const text = String(msg.text ?? "").slice(0, 300).trim();
      if (!text) return;
      broadcast(room, {
        type: "chat",
        from: { id: playerId, name: player.name, seat: player.seat },
        text,
        at: nowMs()
      });
      return;
    }
  });

  ws.on("close", () => {
    room.players.delete(playerId);
    if (player.seat) room.seatToPlayerId.delete(player.seat);
    // Remove pieces owned by player
    for (const [pid, piece] of room.pieces) {
      if (piece.ownerId === playerId) room.pieces.delete(pid);
    }
    room.updatedAt = nowMs();
    if (room.players.size === 0) {
      rooms.delete(room.id);
      return;
    }
    broadcast(room, { type: "presence" });
    for (const [pid] of room.players) {
      safeSend(room.players.get(pid).ws, { type: "state", state: roomSnapshotFor(room, pid) });
    }
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Junqi server on http://${HOST}:${PORT}`);
});

