import { chromium } from "playwright";
import {
	BASE_URL,
	assert,
	clickSeat,
	createTrackedPage,
	expectText,
	setName,
	setReady,
	waitForMyTurn,
	waitForPlacementComplete
} from "./helpers.mjs";

async function run() {
	const browser = await chromium.launch();
	const errors = [];

	const p1 = await createTrackedPage(browser, "P1", errors);
	await p1.page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
	await p1.page.locator("#createRoomBtn").click();
	await p1.page.waitForURL(/\/room\/[A-Za-z0-9_-]+$/);
	const roomUrl = p1.page.url();

	const p2 = await createTrackedPage(browser, "P2", errors);
	await p2.page.goto(roomUrl, { waitUntil: "domcontentloaded" });
	// eslint-disable-next-line no-console
	console.info(`smoke-turn-timer-skip: open in browser while running → ${roomUrl}`);

	await setName(p1.page, "TimerP1");
	await setName(p2.page, "TimerP2");
	await clickSeat(p1.page, "N");
	await clickSeat(p2.page, "E");
	await waitForPlacementComplete(p1.page, "N");
	await waitForPlacementComplete(p2.page, "E");
	await p1.page.locator("#turnDurationInput").fill("3");
	await p1.page.locator("#saveTurnDurationBtn").click();
	await expectText(p1.page, "#hint", /Turn timer set to 3s\./, 10_000);
	await setReady(p1.page);
	await setReady(p2.page);

	await expectText(p1.page, "#phaseLine", /Phase:\s*play/, 20_000);
	await expectText(p2.page, "#phaseLine", /Phase:\s*play/, 20_000);
	await waitForMyTurn(p1.page, 20_000);
	await expectText(p1.page, "#turnLine", /^Your Turn\b.*\d+s left!?$/, 20_000);

	// Do not move as P1; wait for server-side turn timeout skip to advance to E.
	await waitForMyTurn(p2.page, 12_000);
	await expectText(p1.page, "#turnLine", /Turn:\s*E/, 10_000);
	await expectText(p2.page, "#turnLine", /^Your Turn\b.*\d+s left!?$/, 10_000);

	const remaining = await p2.page.evaluate(() => {
		const text = (document.querySelector("#turnLine")?.textContent ?? "").trim();
		const match = text.match(/(\d+)s left/);
		return match ? Number(match[1]) : null;
	});
	assert(Number.isInteger(remaining), "Expected turn countdown seconds for P2.");
	assert(remaining <= 3 && remaining >= 1, `Expected countdown reset near 3s, got ${remaining}.`);

	await p1.context.close();
	await p2.context.close();
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
