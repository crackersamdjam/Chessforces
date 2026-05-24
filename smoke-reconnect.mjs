import { chromium } from "playwright";
import {
	BASE_URL,
	clickSeat,
	createTrackedPage,
	expectText,
	setName,
	waitForPlacementComplete
} from "./smoke-helpers.mjs";

async function expectSeatIsMine(page, seat, timeout = 15_000) {
	await page.waitForFunction(
		(targetSeat) => {
			const card = document.querySelector(`.seatCard--${targetSeat}`);
			if (!card) return false;
			const name = card.querySelector(".muted")?.textContent?.trim() ?? "";
			const btn = card.querySelector(`button[data-seat="${targetSeat}"]`)?.textContent?.trim() ?? "";
			return name === "You" && btn === "Leave";
		},
		seat,
		{ timeout }
	);
}

async function run() {
	const browser = await chromium.launch();
	const errors = [];

	try {
		const player = await createTrackedPage(browser, "P1", errors);
		await player.page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
		await player.page.locator("#createRoomBtn").click();
		await player.page.waitForURL(/\/room\/[A-Za-z0-9_-]+$/);
		const roomUrl = player.page.url();
		const seat = "N";

		await expectText(player.page, "#phaseLine", /Connected\.|Phase:/);
		await setName(player.page, "ReconnectSmoke");
		await clickSeat(player.page, seat);
		await waitForPlacementComplete(player.page, seat);
		await expectSeatIsMine(player.page, seat);

		// Reload while keeping the same browser context/localStorage.
		// The reconnect token should restore this exact player session.
		await player.page.reload({ waitUntil: "domcontentloaded" });
		await expectText(player.page, "#phaseLine", /Connected\.|Phase:/);
		await expectSeatIsMine(player.page, seat);

		await browser.close();
		return { roomUrl, errors };
	} catch (error) {
		await browser.close();
		throw error;
	}
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
