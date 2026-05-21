/**
 * Browser E2E: four clients, lobby randomize, full 2v2 until game over.
 * For rules, moves, combat, and win conditions use test/playthrough.test.js
 * (lib/game, no Playwright) — do not add more smoke tests for game logic.
 */
import { chromium } from "playwright";
import {
	assert,
	applyMove,
	expectText,
	findPlayMoves,
	setup2v2Lobby,
	start2v2Play,
	waitForTurnToEnd
} from "./smoke-helpers.mjs";

const MAX_MOVES = 5000;
const GAME_TIMEOUT_MS = 120_000; // two minutes
// this test ran in 1m10 = 70s

const ENEMY_HQ = {
	N: [
		{ r: 7, c: 0 },
		{ r: 9, c: 0 },
		{ r: 7, c: 16 },
		{ r: 9, c: 16 }
	],
	S: [
		{ r: 7, c: 0 },
		{ r: 9, c: 0 },
		{ r: 7, c: 16 },
		{ r: 9, c: 16 }
	],
	E: [
		{ r: 0, c: 7 },
		{ r: 0, c: 9 },
		{ r: 16, c: 7 },
		{ r: 16, c: 9 }
	],
	W: [
		{ r: 0, c: 7 },
		{ r: 0, c: 9 },
		{ r: 16, c: 7 },
		{ r: 16, c: 9 }
	]
};

/** Road-step and capture moves, biased toward enemy HQ in 2v2. */
async function findAggressivePlayMoves(page, seat, limit = 64) {
	return page.evaluate(
		({ seat, limit, enemyHq }) => {
			const SEATS = ["N", "E", "S", "W"];
			const teamOf = (s) => ({ N: "NS", S: "NS", E: "EW", W: "EW" }[s] ?? s);
			const modeLine = document.querySelector("#modeLine")?.textContent ?? "";
			const gameMode = modeLine.includes("2v2") ? "2v2" : "ffa";

			const isEnemySeat = (other) => {
				if (!other || other === seat) return false;
				if (gameMode === "2v2") return teamOf(seat) !== teamOf(other);
				return other !== seat;
			};

			const tokenSeat = (token) => SEATS.find((s) => token.classList.contains(`token--seat-${s}`)) ?? null;

			const blocked = (label) => label.startsWith("军旗") || label.startsWith("地雷");
			const dirs = [
				[0, 1],
				[0, -1],
				[1, 0],
				[-1, 0]
			];
			const targets = enemyHq[seat] ?? [];
			const distToEnemy = (r, c) => {
				if (!targets.length) return 0;
				return Math.min(...targets.map((t) => Math.abs(t.r - r) + Math.abs(t.c - c)));
			};

			const moves = [];
			for (const cell of document.querySelectorAll(".cell[data-r][data-c]")) {
				const token = cell.querySelector(".token");
				if (!token) continue;
				if (!token.classList.contains(`token--seat-${seat}`)) continue;
				const label = token.querySelector(".label")?.textContent ?? "";
				if (blocked(label)) continue;
				const r = Number(cell.dataset.r);
				const c = Number(cell.dataset.c);
				const fromCell = cell;

				const tryDest = (nr, nc, capture) => {
					const dest = document.querySelector(`.cell[data-r="${nr}"][data-c="${nc}"]`);
					if (!dest || dest.classList.contains("cell--inactive")) return;
					if (dest.classList.contains("cell--mountain") && !label.includes("工兵")) return;

					const destToken = dest.querySelector(".token");
					if (destToken) {
						if (!capture) return;
						const otherSeat = tokenSeat(destToken);
						if (!isEnemySeat(otherSeat)) return;
						if (dest.classList.contains("cell--camp")) return;
					} else if (capture) {
						return;
					}

					const score = (capture ? 1000 : 0) - distToEnemy(nr, nc);
					moves.push({ fromR: r, fromC: c, toR: nr, toC: nc, score, capture });
				};

				for (const [dr, dc] of dirs) {
					const nr = r + dr;
					const nc = c + dc;
					const dest = document.querySelector(`.cell[data-r="${nr}"][data-c="${nc}"]`);
					const destToken = dest?.querySelector(".token");
					tryDest(nr, nc, Boolean(destToken));
				}

				// Diagonal step through camp (road rules during play).
				for (const [dr, dc] of [
					[1, 1],
					[1, -1],
					[-1, 1],
					[-1, -1]
				]) {
					const nr = r + dr;
					const nc = c + dc;
					const dest = document.querySelector(`.cell[data-r="${nr}"][data-c="${nc}"]`);
					if (!dest) continue;
					const fromCamp = fromCell.classList.contains("cell--camp");
					const toCamp = dest.classList.contains("cell--camp");
					if (!fromCamp && !toCamp) continue;
					const destToken = dest.querySelector(".token");
					tryDest(nr, nc, Boolean(destToken));
				}
			}

			moves.sort((a, b) => b.score - a.score);
			return moves.slice(0, limit).map(({ fromR, fromC, toR, toC }) => ({ fromR, fromC, toR, toC }));
		},
		{ seat, limit, enemyHq: ENEMY_HQ }
	);
}

async function playAggressiveMove(page, seat) {
	const moves = await findAggressivePlayMoves(page, seat);
	if (moves.length === 0) {
		const fallback = await findPlayMoves(page, seat);
		assert(fallback.length > 0, `No play moves found for seat ${seat}`);
		moves.push(...fallback);
	}
	let lastErr = null;
	for (const move of moves) {
		try {
			await applyMove(page, move);
			return move;
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr ?? new Error(`All play moves failed for seat ${seat}`);
}

async function isMyTurn(page) {
	return page.evaluate(
		() => (document.querySelector("#turnLine")?.textContent ?? "").includes("Your Turn!")
	);
}

async function isGameDone(page) {
	return page.evaluate(
		() => (document.querySelector("#phaseLine")?.textContent ?? "").includes("done")
	);
}

async function run() {
	// eslint-disable-next-line no-console
	console.info(
		"smoke-playthrough: UI only. Game logic playthroughs belong in test/playthrough.test.js (npm test)."
	);
	const browser = await chromium.launch();
	const errors = [];

	const { roomUrl, players, seats } = await setup2v2Lobby(browser, errors);
	await start2v2Play(players);

	let moves = 0;
	const deadline = Date.now() + GAME_TIMEOUT_MS;
	while (!(await isGameDone(players[0].page))) {
		if (Date.now() > deadline) {
			throw new Error(`Playthrough timed out after ${GAME_TIMEOUT_MS}ms (${moves} moves)`);
		}
		if (moves >= MAX_MOVES) {
			throw new Error(`Playthrough exceeded ${MAX_MOVES} moves without finishing`);
		}

		let acted = false;
		for (let i = 0; i < players.length; i++) {
			if (!(await isMyTurn(players[i].page))) continue;
			const move = await playAggressiveMove(players[i].page, seats[i]);
			await waitForTurnToEnd(players[i].page);
			moves++;
			// eslint-disable-next-line no-console
			console.log(
				`#${moves} ${seats[i]}: (${move.fromR},${move.fromC}) → (${move.toR},${move.toC})`
			);
			acted = true;
			break;
		}

		if (!acted) {
			await players[0].page.waitForTimeout(150);
		}
	}

	await Promise.all(
		players.map((p) => expectText(p.page, "#phaseLine", /Phase:\s*done/, 10_000))
	);
	await Promise.all(
		players.map((p) => expectText(p.page, "#turnLine", /Game over\./, 10_000))
	);

	const outcome = await players[0].page.evaluate(() => ({
		terminationReason: (document.querySelector("#turnLine")?.textContent ?? "").trim(),
		modeLine: document.querySelector("#modeLine")?.textContent ?? ""
	}));

	await browser.close();
	return { roomUrl, moves, outcome, errors };
}

run()
	.then((r) => {
		const reason = r.outcome?.terminationReason ?? "";
		// eslint-disable-next-line no-console
		console.log(
			`smoke-playthrough: done after ${r.moves} moves — ${reason || "(no termination reason)"}`
		);
		// eslint-disable-next-line no-console
		console.log(JSON.stringify({ ok: true, ...r }, null, 2));
		process.exitCode = r.errors?.length ? 2 : 0;
	})
	.catch((e) => {
		// eslint-disable-next-line no-console
		console.error(JSON.stringify({ ok: false, error: String(e?.stack ?? e) }, null, 2));
		process.exitCode = 1;
	});
