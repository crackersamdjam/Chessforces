import { chromium } from "playwright";
import {
	expectText,
	sendChat,
	setup2v2Lobby,
	start2v2Play,
	shufflePlacement,
	waitForMyTurn,
	playOneMove,
	waitForTurnToEnd
} from "./smoke-helpers.mjs";

async function run() {
	const browser = await chromium.launch();
	const errors = [];

	const { roomUrl, players, seats } = await setup2v2Lobby(browser, errors);

	// Manually shuffle a few pieces in each home zone before readying up.
	for (let i = 0; i < players.length; i++) {
		await shufflePlacement(players[i].page, seats[i], 3);
	}

	await start2v2Play(players);
	await Promise.all(players.map((p) => expectText(p.page, "#turnLine", /Turn:|Your Turn!/)));

	// One full round of moves (N → E → S → W).
	for (let i = 0; i < players.length; i++) {
		await waitForMyTurn(players[i].page);
		await playOneMove(players[i].page, seats[i]);
		await waitForTurnToEnd(players[i].page);
	}

	// Chat send/receive
	const chatText = `hello-${Date.now()}`;
	await sendChat(players[0].page, chatText);
	for (const p of players) {
		await p.page.waitForFunction(
			(t) => {
				const log = document.querySelector("#chatLog");
				return Boolean(log && (log.textContent ?? "").includes(t));
			},
			chatText,
			{ timeout: 10_000 }
		);
	}

	await browser.close();
	return { roomUrl, errors };
}

run()
	.then((r) => {
		// eslint-disable-next-line no-console
		console.log(JSON.stringify({ ok: true, ...r }, null, 2));
		process.exitCode = r.errors?.length ? 2 : 0;
	})
	.catch((e) => {
		// eslint-disable-next-line no-console
		console.error(JSON.stringify({ ok: false, error: String(e?.stack ?? e) }, null, 2));
		process.exitCode = 1;
	});
