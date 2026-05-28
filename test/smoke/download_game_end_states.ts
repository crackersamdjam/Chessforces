import {
	assert,
	expectDoneHistoryRevealed,
	expectGameDownloadable,
	expectText,
	forfeitGame,
	launchSmokeBrowser,
	offerDraw,
	setupSeatedGame
} from "./helpers.js";

/**
 * Every player offers a draw until the game ends by agreement, then the
 * finished game must be downloadable from the Download game button.
 */
async function runDrawDownload(browser: any, errors: any[], seats: string[], label: string) {
	const { roomUrl, players } = await setupSeatedGame(browser, errors, seats, label);
	 
	console.info(`${label}: draw-agreement download scenario → ${roomUrl}`);

	for (const p of players) {
		await offerDraw(p.page);
	}

	for (const p of players) {
		await expectText(p.page, "#phaseLine", /Phase:\s*done/, 15_000);
		await expectText(p.page, "#turnLine", /Game over\.\s*Draw\./, 10_000);
	}
	await expectDoneHistoryRevealed(players[0].page, seats[0]);

	const filename = await expectGameDownloadable(players[0].page);
	 
	console.info(`${label}: downloaded ${filename} after draw.`);

	for (const p of players) await p.context.close();
}

/**
 * Players forfeit in the given order until only one team remains and the game
 * ends, then the finished game must be downloadable.
 */
async function runForfeitDownload(
	browser: any,
	errors: any[],
	seats: string[],
	forfeitIdxs: number[],
	label: string
) {
	const { roomUrl, players } = await setupSeatedGame(browser, errors, seats, label);
	 
	console.info(`${label}: forfeit download scenario → ${roomUrl}`);

	for (const idx of forfeitIdxs) {
		await forfeitGame(players[idx].page);
		await expectText(players[idx].page, `.seatCard--${seats[idx]} .pill`, /Eliminated/, 10_000);
	}

	for (const p of players) {
		await expectText(p.page, "#phaseLine", /Phase:\s*done/, 15_000);
	}
	// A forfeit-to-completion leaves a single surviving team — a win, not a draw.
	const turnText = await players[0].page.locator("#turnLine").innerText();
	assert(/wins!/.test(turnText), `Expected a winner announcement, got "${turnText}".`);

	const filename = await expectGameDownloadable(players[0].page);
	 
	console.info(`${label}: downloaded ${filename} after forfeit.`);

	for (const p of players) await p.context.close();
}

async function run() {
	const browser = await launchSmokeBrowser();
	const errors: any[] = [];
	try {
		// 2-player free-for-all.
		await runDrawDownload(browser, errors, ["N", "E"], "Dl2pDraw");
		await runForfeitDownload(browser, errors, ["N", "E"], [1], "Dl2pForfeit");

		// 3-player free-for-all (two forfeits leave a single survivor).
		await runDrawDownload(browser, errors, ["N", "E", "S"], "Dl3pDraw");
		await runForfeitDownload(browser, errors, ["N", "E", "S"], [1, 2], "Dl3pForfeit");

		// 4-player 2v2 (NS vs EW; both NS members forfeit so EW wins).
		await runDrawDownload(browser, errors, ["N", "E", "S", "W"], "Dl4pDraw");
		await runForfeitDownload(browser, errors, ["N", "E", "S", "W"], [0, 2], "Dl4pForfeit");

		await browser.close();
		return { errors };
	} catch (error) {
		await browser.close();
		throw error;
	}
}

run()
	.then((r) => {
		 
		console.log(JSON.stringify({ ok: true, ...r }, null, 2));
		process.exitCode = r.errors?.length ? 2 : 0;
	})
	.catch((e) => {
		 
		console.error(JSON.stringify({ ok: false, error: String(e?.stack ?? e) }, null, 2));
		process.exitCode = 1;
	});
