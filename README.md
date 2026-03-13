# Online 军棋 (Simple 4-player)

This is a minimal “share a link and play in the browser” multiplayer demo inspired by 军棋.

It intentionally implements **simple** rules (not full Junqi).

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

