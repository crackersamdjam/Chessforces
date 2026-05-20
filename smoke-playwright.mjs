import { chromium } from "playwright";

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

async function expectText(page, selector, re, timeout = 10_000) {
	const loc = page.locator(selector);
	await loc.waitFor({ timeout });
	await page.waitForFunction(
		({ selector, source, flags }) => {
			const el = document.querySelector(selector);
			if (!el) return false;
			const text = el.textContent ?? "";
			return new RegExp(source, flags).test(text);
		},
		{ selector, source: re.source, flags: re.flags },
		{ timeout }
	);
}

async function clickSeat(page, seat) {
	const btn = page.locator(`button[data-seat="${seat}"]`);
	await btn.waitFor({ timeout: 10_000 });
	await btn.click();
}

async function setName(page, name) {
	await page.locator("#nameInput").fill(name);
	await page.locator("#saveNameBtn").click();
}

async function waitForReadyEnabled(page, timeout = 30_000) {
	await page.waitForFunction(
		() => {
			const btn = document.querySelector("#readyBtn");
			return btn !== null && !btn.disabled;
		},
		{ timeout }
	);
}

/** Wait for take_seat + randomize to finish; retry Random setup if needed. */
async function waitForPlacementComplete(page, seat, timeout = 60_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const ready = await page.evaluate(() => {
			const btn = document.querySelector("#readyBtn");
			return Boolean(btn && !btn.disabled);
		});
		if (ready) return;
		await page.locator("#randomizeBtn").click();
		await page.waitForTimeout(800);
	}
	throw new Error(`Placement did not complete for seat ${seat}`);
}

async function setReady(page) {
	await waitForReadyEnabled(page);
	await page.locator("#readyBtn").click();
}

async function sendChat(page, text) {
	await page.locator("#chatInput").fill(text);
	await page.locator("#sendChatBtn").click();
}

const HOME_ZONES = {
	N: { minR: 0, maxR: 5, minC: 6, maxC: 10 },
	S: { minR: 11, maxR: 16, minC: 6, maxC: 10 },
	W: { minR: 6, maxR: 10, minC: 0, maxC: 5 },
	E: { minR: 6, maxR: 10, minC: 11, maxC: 16 }
};

async function clickCell(page, r, c) {
	const cell = page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
	await cell.waitFor({ timeout: 10_000 });
	await cell.click();
}

/** Find pairs of own pieces to swap in the home zone (board is full after randomize). */
async function findPlacementSwaps(page, seat, limit = 12) {
	const zone = HOME_ZONES[seat];
	return page.evaluate(
		({ seat, zone, limit }) => {
			const immobile = (label) => label.startsWith("军旗") || label.startsWith("地雷");
			const owned = [];
			for (const cell of document.querySelectorAll(".cell[data-r][data-c]")) {
				const r = Number(cell.dataset.r);
				const c = Number(cell.dataset.c);
				if (r < zone.minR || r > zone.maxR || c < zone.minC || c > zone.maxC) continue;
				const token = cell.querySelector(".token");
				if (!token) continue;
				const owner = token.querySelector(".owner")?.textContent ?? "";
				if (!owner.startsWith(seat)) continue;
				const label = token.querySelector(".label")?.textContent ?? "";
				if (immobile(label)) continue;
				owned.push({ r, c });
			}
			const swaps = [];
			for (let i = 0; i < owned.length; i++) {
				for (let j = i + 1; j < owned.length; j++) {
					swaps.push({
						fromR: owned[i].r,
						fromC: owned[i].c,
						toR: owned[j].r,
						toC: owned[j].c
					});
					if (swaps.length >= limit) return swaps;
				}
			}
			return swaps;
		},
		{ seat, zone, limit }
	);
}

/** Find orthogonal empty-cell moves for lobby placement (home zone only). */
async function findPlacementMoves(page, seat, limit = 12) {
	const zone = HOME_ZONES[seat];
	return page.evaluate(
		({ zone, limit }) => {
			const blocked = (label) =>
				label.startsWith("军旗") || label.startsWith("地雷") || label.startsWith("炸弹");
			const moves = [];
			const dirs = [
				[0, 1],
				[0, -1],
				[1, 0],
				[-1, 0]
			];
			for (const cell of document.querySelectorAll(".cell[data-r][data-c]")) {
				const r = Number(cell.dataset.r);
				const c = Number(cell.dataset.c);
				if (r < zone.minR || r > zone.maxR || c < zone.minC || c > zone.maxC) continue;
				const token = cell.querySelector(".token");
				if (!token) continue;
				const label = token.querySelector(".label")?.textContent ?? "";
				if (blocked(label)) continue;
				for (const [dr, dc] of dirs) {
					const nr = r + dr;
					const nc = c + dc;
					if (nr < zone.minR || nr > zone.maxR || nc < zone.minC || nc > zone.maxC) continue;
					const dest = document.querySelector(`.cell[data-r="${nr}"][data-c="${nc}"]`);
					if (!dest || dest.querySelector(".token")) continue;
					if (dest.classList.contains("cell--inactive") || dest.classList.contains("cell--camp")) {
						continue;
					}
					moves.push({ fromR: r, fromC: c, toR: nr, toC: nc });
					if (moves.length >= limit) return moves;
				}
			}
			return moves;
		},
		{ zone, limit }
	);
}

/** Find empty-cell road-step moves for the current player during play. */
async function findPlayMoves(page, seat, limit = 24) {
	return page.evaluate(
		({ seat, limit }) => {
			const blocked = (label) => label.startsWith("军旗") || label.startsWith("地雷");
			const moves = [];
			const dirs = [
				[0, 1],
				[0, -1],
				[1, 0],
				[-1, 0]
			];
			for (const cell of document.querySelectorAll(".cell[data-r][data-c]")) {
				const token = cell.querySelector(".token");
				if (!token) continue;
				const owner = token.querySelector(".owner")?.textContent ?? "";
				if (!owner.startsWith(seat)) continue;
				const label = token.querySelector(".label")?.textContent ?? "";
				if (blocked(label)) continue;
				const r = Number(cell.dataset.r);
				const c = Number(cell.dataset.c);
				for (const [dr, dc] of dirs) {
					const nr = r + dr;
					const nc = c + dc;
					const dest = document.querySelector(`.cell[data-r="${nr}"][data-c="${nc}"]`);
					if (!dest || dest.querySelector(".token")) continue;
					if (dest.classList.contains("cell--inactive")) continue;
					if (dest.classList.contains("cell--mountain") && !label.includes("工兵")) continue;
					moves.push({ fromR: r, fromC: c, toR: nr, toC: nc });
					if (moves.length >= limit) return moves;
				}
			}
			return moves;
		},
		{ seat, limit }
	);
}

async function applyMove(page, move) {
	await clickCell(page, move.fromR, move.fromC);
	await page.waitForSelector(".token.selected", { timeout: 5_000 });
	await clickCell(page, move.toR, move.toC);
	await page.waitForFunction(
		() => {
			const hint = document.querySelector("#hint")?.textContent ?? "";
			return !hint.startsWith("⚠");
		},
		{ timeout: 5_000 }
	);
}

async function shufflePlacement(page, seat, count = 3) {
	const swaps = await findPlacementSwaps(page, seat);
	const moves = await findPlacementMoves(page, seat);
	const attempts = [...swaps, ...moves];
	assert(attempts.length > 0, `No placement shuffles found for seat ${seat}`);
	let done = 0;
	for (const attempt of attempts) {
		if (done >= count) break;
		try {
			await applyMove(page, attempt);
			done++;
		} catch {
			// swap/move may be rejected by placement rules; try another pair
		}
	}
	assert(done > 0, `No placement shuffles succeeded for seat ${seat}`);
}

async function waitForMyTurn(page, timeout = 30_000) {
	await page.waitForFunction(
		() => (document.querySelector("#turnLine")?.textContent ?? "").includes("Your Turn!"),
		{ timeout }
	);
}

async function playOneMove(page, seat) {
	const moves = await findPlayMoves(page, seat);
	assert(moves.length > 0, `No play moves found for seat ${seat}`);
	let lastErr = null;
	for (const move of moves) {
		try {
			await applyMove(page, move);
			return;
		} catch (e) {
			lastErr = e;
		}
	}
	throw lastErr ?? new Error(`All play moves failed for seat ${seat}`);
}

async function waitForTurnToEnd(page, timeout = 15_000) {
	await page.waitForFunction(
		() => !(document.querySelector("#turnLine")?.textContent ?? "").includes("Your Turn!"),
		{ timeout }
	);
}

async function run() {
	const browser = await chromium.launch();
	const errors = [];

	const mkCtx = async (label) => {
		const context = await browser.newContext();
		const page = await context.newPage();

		page.on("pageerror", (err) => {
			errors.push({ where: label, type: "pageerror", message: String(err?.message ?? err) });
		});
		page.on("console", (msg) => {
			const type = msg.type();
			if (type === "error" || type === "warning") {
				errors.push({ where: label, type: `console.${type}`, message: msg.text() });
			}
		});

		return { context, page };
	};

	// First player goes to / and should be redirected to /room/<id>
	const p1 = await mkCtx("P1");
	await p1.page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
	await p1.page.waitForLoadState("networkidle");
	const roomUrl = p1.page.url();
	assert(/\/room\/[A-Za-z0-9_-]+$/.test(roomUrl), `Expected redirect to /room/<id>, got: ${roomUrl}`);

	// Spin up additional players in isolated contexts (simulates extra tabs/windows).
	const p2 = await mkCtx("P2");
	await p2.page.goto(roomUrl, { waitUntil: "domcontentloaded" });

	const p3 = await mkCtx("P3");
	await p3.page.goto(roomUrl, { waitUntil: "domcontentloaded" });

	const p4 = await mkCtx("P4");
	await p4.page.goto(roomUrl, { waitUntil: "domcontentloaded" });

	const players = [p1, p2, p3, p4];
	const seats = ["N", "E", "S", "W"];

	// Wait for websocket connect (phase line no longer says Connecting…)
	await Promise.all(players.map((p) => expectText(p.page, "#phaseLine", /Connected\.|Phase:/)));

	// Take seats; wait for piece list then auto/manual randomize to finish.
	for (let i = 0; i < players.length; i++) {
		await setName(players[i].page, `Auto${i + 1}`);
		await clickSeat(players[i].page, seats[i]);
		await waitForPlacementComplete(players[i].page, seats[i]);
	}

	// Manually shuffle a few pieces in each home zone before readying up.
	for (let i = 0; i < players.length; i++) {
		await shufflePlacement(players[i].page, seats[i], 3);
	}

	for (const p of players) await setReady(p.page);

	// Phase should advance to play once everyone is ready (goes LOBBY → PLAY directly).
	await Promise.all(players.map((p) => expectText(p.page, "#phaseLine", /Phase:\s*play/, 20_000)));
	await Promise.all(players.map((p) => expectText(p.page, "#turnLine", /Turn:|Your Turn!/)));

	// One full round of moves (N → E → S → W).
	for (let i = 0; i < players.length; i++) {
		await waitForMyTurn(players[i].page);
		await playOneMove(players[i].page, seats[i]);
		await waitForTurnToEnd(players[i].page);
	}

	// Chat send/receive
	const chatText = `hello-${Date.now()}`;
	await sendChat(p1.page, chatText);
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

