# Online 4-player 军棋

This is a minimal “share a link and play in the browser” 军棋 game.

## Run locally

```bash
npm install
npm run dev
```

Then open:

- `http://localhost:5173/` (auto-creates a new room link)
- or `http://localhost:5173/room/<id>`

Share the room URL with friends. Up to 4 players can join.

## How to play (simple)

- Pick a seat (N/E/S/W)
- Click **Ready**
- Placement phase: select a piece on the right, then click a board cell to place it
  - (In this demo you only need to place at least 1 piece to start)
- Play phase:
  - Select one of your pieces
  - Click an adjacent cell to move

## Notes

- Rooms are stored **in memory** (server restart resets everything)
- Good enough for LAN / small friend games. For internet hosting + persistence, we can add:
  - HTTPS + reverse proxy
  - Redis room storage
  - Full 军棋 board + movement rules + ranks + win conditions

## Rules

### Overview

军棋 (Jūnqí, "Army Chess" / Luzhanqi) is a Chinese strategy board game for 2–4 players. This implementation uses the 4-player variant. Each player commands an army and must capture every opponent's 军旗 (Flag) to win. Your own pieces are hidden from opponents — you only learn what a piece is when it fights.

---

### Board

The board is a 17×17 grid in a cross (+) shape:

- **Vertical bar**: all rows, columns 6–10
- **Horizontal bar**: all columns, rows 6–10
- The four inactive corner quadrants (6×6 each) are off-limits

Each player occupies one arm of the cross:

| Seat | Rows   | Cols  | Back (HQ) | Front (toward center) |
|------|--------|-------|-----------|------------------------|
| N    | 0–5    | 6–10  | row 0     | row 5                  |
| S    | 11–16  | 6–10  | row 16    | row 11                 |
| W    | 6–10   | 0–5   | col 0     | col 5                  |
| E    | 6–10   | 11–16 | col 16    | col 11                 |

The **center** (rows 6–10, cols 6–10) is shared battle territory belonging to no player.

#### Cell types

- **兵站 Post** — ordinary cell; normal movement and combat apply
- **行营 Camp** — 5 special cells per arm in a plum-blossom pattern; pieces here are **immune to capture** and may not be attacked
- **大本营 HQ** — 2 cells at the very back of each arm; the Flag must be placed on one of them
- **山界 Mountain** — 4 cells at the inner corners of the center zone (positions (7,7), (7,9), (9,7), (9,9)); **only Engineers may enter** (see movement)

---

### Pieces

Each player has **25 pieces**:

| Piece        | Chinese | Notation | Rank | Count | Notes                                  |
|--------------|---------|----------|------|-------|----------------------------------------|
| Marshal      | 司令    | 40       | 9    | 1     | Highest-ranked officer                 |
| General      | 军长    | 39       | 8    | 1     |                                        |
| Major General| 师长    | 38       | 7    | 2     |                                        |
| Brigadier    | 旅长    | 37       | 6    | 2     |                                        |
| Colonel      | 团长    | 36       | 5    | 2     |                                        |
| Major        | 营长    | 35       | 4    | 2     |                                        |
| Captain      | 连长    | 34       | 3    | 3     |                                        |
| Lieutenant   | 排长    | 33       | 2    | 3     |                                        |
| Engineer     | 工兵    | 1        | 1    | 3     | Lowest rank; special railway movement and mine-clearing |
| Bomb         | 炸弹    | 0        | —    | 2     | Destroys any piece it attacks or is attacked by |
| Mine         | 地雷    | X        | —    | 3     | Immovable; destroys attackers (except Engineers) |
| Flag         | 军旗    | $        | —    | 1     | Immovable; capturing it eliminates that player |

---

### Placement Phase

Before the game starts, each player arranges their 25 pieces anywhere within their own home zone, subject to these constraints:

1. **No piece may be placed on a Camp cell** during setup (pieces enter camps only by moving later)
2. **Bombs** may not be placed on the front row/column (the row/col immediately adjacent to the center)
3. **Mines** must be placed in the back two rows/columns (the two rows/cols farthest from the center, including the HQ row/col)
4. **The Flag** must be placed on one of the two HQ cells
5. **All other pieces** (including officers and Engineers) may occupy any remaining post or HQ cell in the home zone

**Auto-randomize**: when you take a seat, your pieces are placed randomly in a legal configuration automatically. You can rearrange them freely before clicking Ready, including clicking one of your placed pieces and then clicking another to **swap** their positions.

Once all pieces are placed, click **Ready**. The game begins when every seated player is ready.

---

### Movement

Players take turns in clockwise order: N → E → S → W → N … (empty seats are skipped).

On your turn, move exactly one piece. There are two movement modes:

#### Road move (兵站 step)
Move one step to an **orthogonally adjacent** active cell.

#### Railway move (铁路 slide)
The railway is a network of tracks that runs:
- Along the back row/col of each arm (row 1 / row 15 / col 1 / col 15)
- Along the front row/col of each arm (row 5 / row 11 / col 5 / col 11)
- Along the left and right edges of each arm (cols 6 & 10 for N/S; rows 6 & 10 for W/E)
- Around the border of the 5×5 center square
- Through the center cross: col 8 (rows 5–11) and row 8 (cols 5–11)
- Four **diagonal connectors** linking adjacent arm railways at each corner junction

A piece **on a railway cell** may slide any number of cells along connected tracks in a single turn, with the following rules:

- **Engineers** (工兵): unrestricted railway movement — may turn freely at any junction, travel any distance; blocked only by pieces occupying intermediate cells. Engineers may also step off the railway onto an adjacent **山界 Mountain** cell in the same move, and can later exit a Mountain by stepping back onto any adjacent unblocked railway cell.
- **All other pieces**: must travel in a straight line (same row or column). They may use **at most one diagonal connector** per move to transition between arms, but only when arriving from **deep inside an arm** (the cell before the connector must be outside the center band). This prevents taking a shortcut by starting near the junction and immediately diagonaling. After the diagonal the piece continues straight on the new arm. Blocked by any piece on an intermediate cell. Non-engineers **cannot enter Mountain cells** under any circumstances.

Pieces **may not move** through occupied cells (they stop at the blocker or cannot reach the destination unless they can capture it).

**Flags and Mines cannot move at all.** All other pieces — including Bombs — can move normally (road or railway).

---

### Combat

When a moving piece enters a cell occupied by an **enemy** piece, combat is resolved immediately:

| Situation                          | Result                                              |
|------------------------------------|-----------------------------------------------------|
| Attacker rank > Defender rank      | Defender removed; attacker occupies the cell        |
| Attacker rank < Defender rank      | Attacker removed; defender stays                    |
| Equal ranks                        | Both pieces removed                                 |
| Any piece attacks a **Mine**       | Attacker removed; Mine also removed                 |
| **Engineer** attacks a Mine        | Mine cleared (removed); Engineer survives and moves there |
| Either piece is a **Bomb**         | Both pieces removed                                 |
| Any piece captures the **Flag**    | Flag owner is eliminated; attacker survives         |

**You may never attack your own pieces.**

**Pieces on Camp cells cannot be attacked** — a move into an occupied camp is illegal.

---

### Winning

The last player whose Flag is still alive wins. A player is **eliminated** as soon as their Flag is captured. If all remaining Flags are captured simultaneously, the game ends with no winner.

---

### Special rules summary

| Rule              | Detail                                                                                     |
|-------------------|--------------------------------------------------------------------------------------------|
| Hidden information | You only see your own piece labels; opponents' pieces show "?" until revealed in combat    |
| Camp immunity      | A piece resting on a Camp cell cannot be captured; it can move out voluntarily             |
| Mine placement     | Mines must stay in the back two rows/cols; they cannot move under any circumstances         |
| Bomb movement      | Bombs cannot be placed on the front row/col during setup, but **can move** freely (road or railway) once the game begins |
| Engineer on railway| Engineers navigate the full railway network with free turns and are the only pieces that can enter 山界 Mountain cells |
| Mountain (山界)    | 4 cells at the inner corners of the center zone; Engineers may step onto them from an adjacent railway cell, and step back off onto any adjacent unblocked railway cell |
| Turn skip          | Empty seats (players who haven't joined or have disconnected) are skipped automatically    |

