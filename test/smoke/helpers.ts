import { accessSync, constants } from "node:fs";
import { chromium } from "playwright";
import { createBoard } from "../../lib/game/board.js";
import { findLegalPlayMoves } from "../../lib/game/play-moves.js";

export const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:5173";

const PLAY_BOARD = createBoard();

const DEFAULT_BROWSER_PATHS = [
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
	"/usr/bin/google-chrome-stable"
];

function canAccess(path: string) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveBrowserPath() {
	const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
	if (envPath && canAccess(envPath)) {
		return envPath;
	}
	for (const path of DEFAULT_BROWSER_PATHS) {
		if (canAccess(path)) {
			return path;
		}
	}
	return null;
}

export async function launchSmokeBrowser() {
	try {
		return await chromium.launch();
	} catch (error: any) {
		const message = String(error?.message ?? error ?? "");
		if (!message.includes("Executable doesn't exist")) {
			throw error;
		}
		const executablePath = resolveBrowserPath();
		if (!executablePath) {
			throw new Error(
				"Playwright browser binary is missing. Run `npx playwright install` or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an installed Chrome/Chromium executable.",
				{ cause: error }
			);
		}
		return chromium.launch({ executablePath });
	}
}

export function assert(cond: unknown, msg: string) {
	if (!cond) throw new Error(msg);
}

export async function expectText(page: any, selector: string, re: RegExp, timeout = 10_000) {
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

export async function clickSeat(page: any, seat: string) {
	const btn = page.locator(`button[data-seat="${seat}"]`);
	await btn.waitFor({ timeout: 10_000 });
	await btn.click();
}

export async function setName(page: any, name: string) {
	await page.locator("#nameInput").fill(name);
	await page.locator("#saveNameBtn").click();
}

export async function waitForReadyEnabled(page: any, timeout = 30_000) {
	await page.waitForFunction(
		() => {
			const btn = document.querySelector<HTMLButtonElement>("#readyBtn");
			return btn !== null && !btn.disabled;
		},
		{ timeout }
	);
}

/** Wait for take_seat + randomize to finish; retry Random setup if needed. */
export async function waitForPlacementComplete(page: any, seat: string, timeout = 60_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const ready = await page.evaluate(() => {
			const btn = document.querySelector<HTMLButtonElement>("#readyBtn");
			return Boolean(btn && !btn.disabled);
		});
		if (ready) return;
		await page.locator("#randomizeBtn").click();
		await page.waitForTimeout(800);
	}
	throw new Error(`Placement did not complete for seat ${seat}`);
}

export async function setReady(page: any) {
	await waitForReadyEnabled(page);
	await page.locator("#readyBtn").click();
}

export async function sendChat(page: any, text: string) {
	await page.locator("#chatInput").fill(text);
	await page.locator("#sendChatBtn").click();
}

export async function offerDraw(page: any) {
	await page.locator("#offerDrawBtn").click();
}

export async function forfeitGame(page: any) {
	page.once("dialog", (dialog) => dialog.accept());
	await page.locator("#forfeitBtn").click();
}

export const HOME_ZONES = {
	N: { minR: 0, maxR: 5, minC: 6, maxC: 10 },
	S: { minR: 11, maxR: 16, minC: 6, maxC: 10 },
	W: { minR: 6, maxR: 10, minC: 0, maxC: 5 },
	E: { minR: 6, maxR: 10, minC: 11, maxC: 16 }
};

export async function clickCell(page: any, r: number, c: number) {
	const cell = page.locator(`.cell[data-r="${r}"][data-c="${c}"]`);
	await cell.waitFor({ timeout: 10_000 });
	await cell.click();
}

/** Find pairs of own pieces to swap in the home zone (board is full after randomize). */
export async function findPlacementSwaps(page: any, seat: string, limit = 12) {
	const zone = HOME_ZONES[seat as keyof typeof HOME_ZONES];
	return page.evaluate(
		({ seat, zone, limit }) => {
			const immobile = (label) => label.startsWith("军旗") || label.startsWith("地雷");
			const owned: Array<{ r: number; c: number }> = [];
			for (const cell of document.querySelectorAll<HTMLElement>(".cell[data-r][data-c]")) {
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
			const swaps: Array<{ fromR: number; fromC: number; toR: number; toC: number }> = [];
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
export async function findPlacementMoves(page: any, seat: string, limit = 12) {
	const zone = HOME_ZONES[seat as keyof typeof HOME_ZONES];
	return page.evaluate(
		({ zone, limit }) => {
			const blocked = (label) =>
				label.startsWith("军旗") || label.startsWith("地雷") || label.startsWith("炸弹");
			const moves: Array<{ fromR: number; fromC: number; toR: number; toC: number }> = [];
			const dirs = [
				[0, 1],
				[0, -1],
				[1, 0],
				[-1, 0]
			];
			for (const cell of document.querySelectorAll<HTMLElement>(".cell[data-r][data-c]")) {
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
export async function scrapePlayState(page: any) {
	return page.evaluate(() => {
		const SEATS = ["N", "E", "S", "W"];
		const typeFromLabel = (label) => {
			if (label.startsWith("军旗")) return "flag";
			if (label.startsWith("地雷")) return "mine";
			if (label.startsWith("炸弹")) return "bomb";
			if (label.startsWith("工兵")) return "engineer";
			return "captain";
		};
		const pieces: Array<{ id: string; seat: string; type: string; r: number; c: number }> = [];
		for (const cell of document.querySelectorAll<HTMLElement>(".cell[data-r][data-c]")) {
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
export function buildPlayRoom(scrape: any) {
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
export async function findLegalPlayMovesOnPage(page: any, seat: string, { limit = 64, biasToEnemyHq = false } = {}) {
	const scrape = await scrapePlayState(page);
	const room = buildPlayRoom(scrape);
	const legal = findLegalPlayMoves(room, seat, { limit, biasToEnemyHq });
	const moves: Array<{ fromR: number; fromC: number; toR: number; toC: number }> = [];
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
export async function findPlayMoves(page: any, seat: string, limit = 24) {
	return findLegalPlayMovesOnPage(page, seat, { limit });
}

export async function applyMove(page: any, move: { fromR: number; fromC: number; toR: number; toC: number }) {
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

export async function shufflePlacement(page: any, seat: string, count = 3) {
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

export async function waitForMyTurn(page: any, timeout = 30_000) {
	await page.waitForFunction(
		() => /^Your Turn\b/.test((document.querySelector("#turnLine")?.textContent ?? "").trim()),
		{ timeout }
	);
}

export async function playOneMove(page: any, seat: string) {
	const moves = await findPlayMoves(page, seat);
	assert(moves.length > 0, `No play moves found for seat ${seat}`);
	let lastErr: any = null;
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

export async function waitForTurnToEnd(page: any, timeout = 15_000) {
	await page.waitForFunction(
		() => !/^Your Turn\b/.test((document.querySelector("#turnLine")?.textContent ?? "").trim()),
		{ timeout }
	);
}

export async function createTrackedPage(browser: any, label: string, errors: any[]) {
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
export async function setup2v2Lobby(browser: any, errors: any[]) {
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
export async function start2v2Play(players: Array<{ page: any }>) {
	for (const p of players) await setReady(p.page);
	await Promise.all(players.map((p) => expectText(p.page, "#phaseLine", /Phase:\s*play/, 20_000)));
}

/**
 * Generic N-seat game setup: connect every player, name them, sit them in the
 * requested seats, randomize placement, set a generous turn timer, ready up and
 * wait for the play phase. Seat count drives the game mode (4 seats → 2v2).
 */
export async function setupSeatedGame(
	browser: any,
	errors: any[],
	seats: string[],
	label: string,
	turnSeconds = 60
) {
	const p1 = await createTrackedPage(browser, `${label}-1`, errors);
	await p1.page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
	await p1.page.locator("#createRoomBtn").click();
	await p1.page.waitForURL(/\/room\/[A-Za-z0-9_-]+$/);
	const roomUrl = p1.page.url();

	const players = [p1];
	for (let i = 1; i < seats.length; i++) {
		const p = await createTrackedPage(browser, `${label}-${i + 1}`, errors);
		await p.page.goto(roomUrl, { waitUntil: "domcontentloaded" });
		players.push(p);
	}

	for (let i = 0; i < seats.length; i++) {
		await setName(players[i].page, `${label}${i + 1}`);
		await clickSeat(players[i].page, seats[i]);
		await waitForPlacementComplete(players[i].page, seats[i]);
	}

	// Generous turn timer so multi-step end sequences (e.g. several forfeits or
	// every player offering a draw) are not disrupted by turn-timeout skips.
	await players[0].page.locator("#turnDurationInput").fill(String(turnSeconds));
	await players[0].page.locator("#saveTurnDurationBtn").click();
	await expectText(players[0].page, "#hint", new RegExp(`Turn timer set to ${turnSeconds}s\\.`), 10_000);

	for (const p of players) await setReady(p.page);
	for (const p of players) await expectText(p.page, "#phaseLine", /Phase:\s*play/, 20_000);

	return { roomUrl, players, seats };
}

/**
 * Assert the finished game is downloadable: the Download game button must be
 * visible and enabled, and clicking it must trigger a `.chessforces-game.json`
 * download. Returns the suggested filename.
 */
export async function expectGameDownloadable(page: any, timeout = 10_000) {
	await page.waitForFunction(
		() => {
			const btn = document.querySelector<HTMLButtonElement>("#downloadGameBtn");
			return Boolean(btn && btn.offsetParent !== null && !btn.disabled);
		},
		{ timeout }
	);
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout }),
		page.locator("#downloadGameBtn").click()
	]);
	const filename = download.suggestedFilename();
	assert(
		/\.chessforces-game\.json$/.test(filename),
		`Expected a chessforces game download, got "${filename}".`
	);
	return filename;
}
