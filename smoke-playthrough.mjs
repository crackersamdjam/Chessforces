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
	findLegalPlayMovesOnPage,
	setup2v2Lobby,
	start2v2Play,
	waitForTurnToEnd
} from "./smoke-helpers.mjs";

const MAX_MOVES = 5000;
const GAME_TIMEOUT_MS = 120_000; // two minutes
// Last OK run: 350 moves, ~72s (1m 12s). Not deterministic — lobby randomize uses Math.random().

async function playAggressiveMove(page, seat) {
	const moves = await findLegalPlayMovesOnPage(page, seat, { limit: 64, biasToEnemyHq: true });
	assert(moves.length > 0, `No play moves found for seat ${seat}`);
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
	// eslint-disable-next-line no-console
	console.info(`smoke-playthrough: open in browser while running → ${roomUrl}`);
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
