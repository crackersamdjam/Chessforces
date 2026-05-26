import { chromium } from "playwright";
import {
	BASE_URL,
	assert,
	clickSeat,
	createTrackedPage,
	expectText,
	forfeitGame,
	offerDraw,
	playOneMove,
	setName,
	setReady,
	waitForMyTurn,
	waitForPlacementComplete,
	waitForTurnToEnd
} from "./helpers.mjs";

async function setupTwoPlayerGame(browser, errors, label) {
	const p1 = await createTrackedPage(browser, `${label}-P1`, errors);
	await p1.page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
	await p1.page.locator("#createRoomBtn").click();
	await p1.page.waitForURL(/\/room\/[A-Za-z0-9_-]+$/);
	const roomUrl = p1.page.url();

	const p2 = await createTrackedPage(browser, `${label}-P2`, errors);
	await p2.page.goto(roomUrl, { waitUntil: "domcontentloaded" });

	await setName(p1.page, `${label}A`);
	await setName(p2.page, `${label}B`);
	await clickSeat(p1.page, "N");
	await clickSeat(p2.page, "E");
	await waitForPlacementComplete(p1.page, "N");
	await waitForPlacementComplete(p2.page, "E");
	await setReady(p1.page);
	await setReady(p2.page);
	await expectText(p1.page, "#phaseLine", /Phase:\s*play/, 20_000);
	await expectText(p2.page, "#phaseLine", /Phase:\s*play/, 20_000);

	return { roomUrl, p1, p2 };
}

async function runDrawOfferScenario(browser, errors) {
	const { roomUrl, p1, p2 } = await setupTwoPlayerGame(browser, errors, "Draw");
	 
	console.info(`smoke-forfeit-and-draw: draw scenario room → ${roomUrl}`);

	await offerDraw(p1.page);
	await expectText(p1.page, "#offerDrawBtn", /Draw offered \(1\/2\)/, 10_000);
	await expectText(p2.page, "#offerDrawBtn", /Offer draw \(1\/2\)/, 10_000);

	// A regular move should clear any pending draw offers.
	await waitForMyTurn(p1.page, 20_000);
	await playOneMove(p1.page, "N");
	await waitForTurnToEnd(p1.page, 10_000);
	await waitForMyTurn(p2.page, 20_000);
	await playOneMove(p2.page, "E");
	await waitForTurnToEnd(p2.page, 10_000);
	await expectText(p1.page, "#offerDrawBtn", /Offer draw \(0\/2\)/, 10_000);
	await expectText(p2.page, "#offerDrawBtn", /Offer draw \(0\/2\)/, 10_000);

	await offerDraw(p2.page);
	await expectText(p1.page, "#offerDrawBtn", /Offer draw \(1\/2\)/, 10_000);
	await expectText(p2.page, "#offerDrawBtn", /Draw offered \(1\/2\)/, 10_000);
	await offerDraw(p1.page);
	await expectText(p1.page, "#phaseLine", /Phase:\s*done/, 10_000);
	await expectText(p2.page, "#phaseLine", /Phase:\s*done/, 10_000);
	await expectText(p1.page, "#turnLine", /Game over\.\s*Draw\./, 10_000);
	await expectText(p2.page, "#turnLine", /Game over\.\s*Draw\./, 10_000);

	await p1.context.close();
	await p2.context.close();
}

async function runForfeitScenario(browser, errors) {
	const { roomUrl, p1, p2 } = await setupTwoPlayerGame(browser, errors, "Forfeit");
	 
	console.info(`smoke-forfeit-and-draw: forfeit scenario room → ${roomUrl}`);

	await forfeitGame(p2.page);
	await expectText(p1.page, "#phaseLine", /Phase:\s*done/, 10_000);
	await expectText(p2.page, "#phaseLine", /Phase:\s*done/, 10_000);
	await expectText(p1.page, "#turnLine", /wins!/, 10_000);
	await expectText(p2.page, ".seatCard--E .pill", /Eliminated/, 10_000);

	const p1TurnText = await p1.page.locator("#turnLine").innerText();
	assert(/wins!/.test(p1TurnText), "Expected winner announcement after forfeit.");

	await p1.context.close();
	await p2.context.close();
}

async function run() {
	const browser = await chromium.launch();
	const errors = [];
	try {
		await runDrawOfferScenario(browser, errors);
		await runForfeitScenario(browser, errors);
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
