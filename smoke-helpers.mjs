import { createBoard } from "./lib/game/board.js";
import { findLegalPlayMoves } from "./lib/game/play-moves.js";

export const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:5173";

const PLAY_BOARD = createBoard();

export function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

export async function expectText(page, selector, re, timeout = 10_000) {
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

export async function clickSeat(page, seat) {
	const btn = page.locator(`button[data-seat="${seat}"]`);
	await btn.waitFor({ timeout: 10_000 });
	await btn.click();
}

export async function setName(page, name) {
	await page.locator("#nameInput").fill(name);
	await page.locator("#saveNameBtn").click();
}

export async function waitForReadyEnabled(page, timeout = 30_000) {
	await page.waitForFunction(
		() => {
			const btn = document.querySelector("#readyBtn");
			return btn !== null && !btn.disabled;
		},
		{ timeout }
	);
}

/** Wait for take_seat + randomize to finish; retry Random setup if needed. */
export async function waitForPlacementComplete(page, seat, timeout = 60_000) {
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

export async function setReady(page) {
	await waitForReadyEnabled(page);
	await page.locator("#readyBtn").click();
}

export async function sendChat(page, text) {
	await page.locator("#chatInput").fill(text);
	await page.locator("#sendChatBtn").click();
}

export const HOME_ZONES = {
	N: { minR: 0, maxR: 5, minC: 6, maxC: 10 },
	S: { minR: 11, maxR: 16, minC: 6, maxC: 10 },
	W: { minR: 6, maxR: 10, minC: 0, maxC: 5 },
	E: { minR: 6, maxR: 10, minC: 11, maxC: 16 }
};

export async function clickCell(page, r, c) {
	const cell = page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
	await cell.waitFor({ timeout: 10_000 });
	await cell.click();
}

/** Find pairs of own pieces to swap in the home zone (board is full after randomize). */
export async function findPlacementSwaps(page, seat, limit = 12) {
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
				if (!token.classList.contains(`token--seat-${seat}`)) continue;
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
export async function findPlacementMoves(page, seat, limit = 12) {
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

/** Scrape piece positions and meta from the live board DOM. */
export async function scrapePlayState(page) {
	return page.evaluate(() => {
		const SEATS = ["N", "E", "S", "W"];
		const typeFromLabel = (label) => {
			if (label.startsWith("军旗")) return "flag";
			if (label.startsWith("地雷")) return "mine";
			if (label.startsWith("炸弹")) return "bomb";
			if (label.startsWith("工兵")) return "engineer";
			return "captain";
		};
		const pieces = [];
		for (const cell of document.querySelectorAll(".cell[data-r][data-c]")) {
			const token = cell.querySelector(".token");
			if (!token) continue;
			const ownerSeat = SEATS.find((s) => token.classList.contains(`token--seat-${s}`));
			if (!ownerSeat) continue;
			const label = token.querySelector(".label")?.textContent ?? "";
			const r = Number(cell.dataset.r);
			const c = Number(cell.dataset.c);
			pieces.push({
				id: `${ownerSeat}@${r},${c}`,
				seat: ownerSeat,
				type: typeFromLabel(label),
				r,
				c
			});
		}
		const eliminatedSeats = SEATS.filter((s) =>
			document.querySelector(`.seatCard--${s} .pill`)?.classList.contains("eliminated")
		);
		const modeLine = document.querySelector("#modeLine")?.textContent ?? "";
		const gameMode = modeLine.includes("2v2") ? "2v2" : "ffa";
		return { pieces, eliminatedSeats, gameMode };
	});
}

/** Build a minimal room object for lib/game move generation. */
export function buildPlayRoom(scrape) {
	const room = {
		gameMode: scrape.gameMode,
		eliminatedSeats: new Set(scrape.eliminatedSeats),
		seatToPlayerId: new Map(),
		players: new Map(),
		pieces: new Map(),
		board: PLAY_BOARD
	};
	for (const seat of ["N", "E", "S", "W"]) {
		const playerId = `player-${seat}`;
		room.seatToPlayerId.set(seat, playerId);
		room.players.set(playerId, { id: playerId, seat });
	}
	for (const p of scrape.pieces) {
		const ownerId = `player-${p.seat}`;
		room.pieces.set(p.id, {
			id: p.id,
			ownerId,
			type: p.type,
			pos: { r: p.r, c: p.c },
			alive: true
		});
	}
	return room;
}

/**
 * All legal play moves for a seat (road steps, camp diagonals, railway slides).
 * Uses lib/game rules on a DOM scrape of the current board.
 */
export async function findLegalPlayMovesOnPage(page, seat, { limit = 64, biasToEnemyHq = false } = {}) {
	const scrape = await scrapePlayState(page);
	const room = buildPlayRoom(scrape);
	const legal = findLegalPlayMoves(room, seat, { limit, biasToEnemyHq });
	const moves = [];
	for (const { pieceId, to } of legal) {
		const piece = room.pieces.get(pieceId);
		if (!piece?.pos) continue;
		moves.push({
			fromR: piece.pos.r,
			fromC: piece.pos.c,
			toR: to.r,
			toC: to.c
		});
	}
	return moves;
}

/** Find legal play moves for the current player during play. */
export async function findPlayMoves(page, seat, limit = 24) {
	return findLegalPlayMovesOnPage(page, seat, { limit });
}

export async function applyMove(page, move) {
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

export async function shufflePlacement(page, seat, count = 3) {
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

export async function waitForMyTurn(page, timeout = 30_000) {
	await page.waitForFunction(
		() => (document.querySelector("#turnLine")?.textContent ?? "").includes("Your Turn!"),
		{ timeout }
	);
}

export async function playOneMove(page, seat) {
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

export async function waitForTurnToEnd(page, timeout = 15_000) {
	await page.waitForFunction(
		() => !(document.querySelector("#turnLine")?.textContent ?? "").includes("Your Turn!"),
		{ timeout }
	);
}

export async function createTrackedPage(browser, label, errors) {
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
}

/** Seat four players in a 2v2 lobby (connected, placed, not yet ready). */
export async function setup2v2Lobby(browser, errors) {
	const p1 = await createTrackedPage(browser, "P1", errors);
	await p1.page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
	await p1.page.locator("#createRoomBtn").click();
	await p1.page.waitForURL(/\/room\/[A-Za-z0-9_-]+$/);
	const roomUrl = p1.page.url();

	const players = [p1];
	for (let i = 2; i <= 4; i++) {
		const p = await createTrackedPage(browser, `P${i}`, errors);
		await p.page.goto(roomUrl, { waitUntil: "domcontentloaded" });
		players.push(p);
	}

	const seats = ["N", "E", "S", "W"];
	await Promise.all(players.map((p) => expectText(p.page, "#phaseLine", /Connected\.|Phase:/)));

	for (let i = 0; i < players.length; i++) {
		await setName(players[i].page, `Auto${i + 1}`);
		await clickSeat(players[i].page, seats[i]);
		await waitForPlacementComplete(players[i].page, seats[i]);
	}

	await Promise.all(players.map((p) => expectText(p.page, "#modeLine", /2v2/)));

	return { roomUrl, players, seats };
}

/** Ready all lobby players and wait for the play phase. */
export async function start2v2Play(players) {
	for (const p of players) await setReady(p.page);
	await Promise.all(players.map((p) => expectText(p.page, "#phaseLine", /Phase:\s*play/, 20_000)));
}
