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
  const btn = page.locator(`button[data-action="take"][data-seat="${seat}"]`);
  await btn.waitFor({ timeout: 10_000 });
  await btn.click();
}

async function setName(page, name) {
  await page.locator("#nameInput").fill(name);
  await page.locator("#saveNameBtn").click();
}

async function waitForReadyEnabled(page, timeout = 30_000) {
  // Auto-placement fires after taking a seat; wait until all 25 pieces are placed
  // so the Ready button becomes enabled.
  await page.waitForFunction(
    () => {
      const btn = document.querySelector("#readyBtn");
      return btn !== null && !btn.disabled;
    },
    { timeout }
  );
}

async function setReady(page) {
  await waitForReadyEnabled(page);
  await page.locator("#readyBtn").click();
}

async function sendChat(page, text) {
  await page.locator("#chatInput").fill(text);
  await page.locator("#sendChatBtn").click();
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

  // Take seats
  for (let i = 0; i < players.length; i++) {
    await setName(players[i].page, `Auto${i + 1}`);
    await clickSeat(players[i].page, seats[i]);
  }

  // Auto-placement fires when each player takes their seat.
  // Wait until all pieces are placed (Ready button enabled), then ready up.
  for (const p of players) await setReady(p.page);

  // Phase should advance to play once everyone is ready (goes LOBBY → PLAY directly).
  await Promise.all(players.map((p) => expectText(p.page, "#phaseLine", /Phase:\s*play/, 20_000)));
  await Promise.all(players.map((p) => expectText(p.page, "#turnLine", /Turn:\s*/)));

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

