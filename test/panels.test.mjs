// End-to-end test of "My plugins" against a real `layr serve` in headless Chromium, with a temporary home, a
// temporary store and the fake gh (core/layr_core/tests/fake_gh): nothing reaches GitHub or the user's layr.
//
//   cargo build -p layr_cli          (in core/)
//   node plugins/devtools/test/panels.test.mjs [--out plugins/devtools/screenshots] [--claude]
//
// LAYR_EXE: another layr binary (default core/target/debug/layr).
//
// --claude also lets a real Claude thread (haiku) combine a conflicting update in the merge folder, and checks that
// its turn was saved by itself and that Update then uses it.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const OUT = path.resolve(arg("out", path.join(repoRoot, "plugins", "devtools", "screenshots")));
const WITH_CLAUDE = process.argv.includes("--claude");
mkdirSync(OUT, { recursive: true });

function loadPlaywright() {
  for (const base of [path.join(repoRoot, "plugins", "dev", "package.json"), path.join(os.homedir(), "pwtools", "package.json")]) {
    try {
      return createRequire(base)("playwright");
    } catch {}
  }
  throw new Error("playwright not found (plugins/dev: npm install)");
}
const { chromium } = loadPlaywright();

const exeName = process.platform === "win32" ? "layr.exe" : "layr";
const exe = process.env.LAYR_EXE || path.join(repoRoot, "core", "target", "debug", exeName);
if (!existsSync(exe)) throw new Error(`build the CLI first: cargo build -p layr_cli (no ${exe})`);

// ---------- a temporary world ----------

const tmp = mkdtempSync(path.join(os.tmpdir(), "layr-devtools-"));
const home = path.join(tmp, "home");
const storeSrc = path.join(tmp, "store-src");
const store = path.join(tmp, "store");
const fakeGh = path.join(tmp, "github");
mkdirSync(path.join(fakeGh, "releases"), { recursive: true });
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const who = (name, email) => ["-c", `user.name=${name}`, "-c", `user.email=${email}`];

// Publisher keys of their own (never the user's): the store's, and a friend's who forks a plugin.
const storeKey = path.join(tmp, "key-store");
const friendKey = path.join(tmp, "key-friend");
execFileSync(exe, ["key", "new", "--home", storeKey]);
execFileSync(exe, ["key", "new", "--home", friendKey]);

// Another store plugin with a GitHub repository, whose fork is signed by someone else.
const sky = path.join(storeSrc, "sky");
const skyManifest = (version) => JSON.stringify({ id: "sky", name: "Sky", version, layr: "^0.1",
  description: "The sky.", permissions: ["data"], repository: "https://github.com/tester/sky",
  panels: [{ id: "main", title: "Sky", page: "panels/main.html" }] }, null, 2) + "\n";
mkdirSync(path.join(sky, "panels"), { recursive: true });
writeFileSync(path.join(sky, "layr.json"), skyManifest("0.1.0"));
writeFileSync(path.join(sky, "panels", "main.html"), "<p>Blue</p>\n");

function storeVersion(version, lines, extra = {}) {
  const dir = path.join(storeSrc, "weather");
  mkdirSync(path.join(dir, "panels"), { recursive: true });
  writeFileSync(path.join(dir, "layr.json"), JSON.stringify({ id: "weather", name: "Weather", version, layr: "^0.1",
    description: "Today's weather.", permissions: ["data"], icon: "cloud",
    panels: [{ id: "main", title: "Weather", page: "panels/main.html" }], ...extra }, null, 2) + "\n");
  writeFileSync(path.join(dir, "panels", "main.html"), lines.join("\n") + "\n");
  execFileSync(exe, ["registry", "build", storeSrc, store, "--home", storeKey]);
}
storeVersion("0.1.0", ["<h1>Weather</h1>", "<p>Sunny</p>", "<p>Wind: calm</p>", "<p>Rain: none</p>", "<footer>v1</footer>"]);

// A plugin "you made", with a history: the first commit, two of Claude's turns, one of yours, and unsaved work.
const made = path.join(tmp, "my-plugins", "counter");
mkdirSync(path.join(made, "panels"), { recursive: true });
git(path.dirname(made), "init", "-q", "--initial-branch=main", made);
git(made, ...who("layr", "layr@layr.invalid"), "commit", "-q", "--allow-empty", "-m", "New plugin counter");
writeFileSync(path.join(made, "layr.json"), JSON.stringify({ id: "counter", name: "Counter", version: "0.1.0", layr: "^0.1",
  description: "A button that counts.", permissions: ["data"], icon: "plus_one",
  panels: [{ id: "main", title: "Counter", page: "panels/main.html" }] }, null, 2) + "\n");
writeFileSync(path.join(made, "panels", "main.html"), "<button>+1</button>\n<p>Count: 0</p>\n");
git(made, "add", "-A");
git(made, ...who("layr (Claude)", "claude@layr.invalid"), "commit", "-q", "-m", "Please make a counter with a big button",
  "-m", "I made a Counter plugin: a big +1 button and the count under it.");
writeFileSync(path.join(made, "panels", "main.html"), "<button class=big>+1</button>\n<p>Count: 0</p>\n<button>Reset</button>\n");
git(made, "add", "-A");
git(made, ...who("layr (Claude)", "claude@layr.invalid"), "commit", "-q", "-m", "Add a reset button", "-m", "Added Reset under the count.");
writeFileSync(path.join(made, "styles.css"), "button.big { font-size: 32px; }\n");
git(made, "add", "-A");
git(made, ...who("Tester", "tester@example.com"), "commit", "-q", "-m", "Bigger button");
writeFileSync(path.join(made, "panels", "main.html"), "<button class=big>+1</button>\n<p>Count: 0</p>\n<button>Reset</button>\n<p>Made with layr</p>\n");

// ---------- fake GitHub downloads ----------

const files = http.createServer((req, res) => {
  const f = path.join(fakeGh, "releases", ...decodeURIComponent(req.url).split("/").filter(Boolean));
  if (existsSync(f)) res.end(readFileSync(f));
  else res.writeHead(404).end();
});
await new Promise((r) => files.listen(0, "127.0.0.1", r));
const downloadBase = `http://127.0.0.1:${files.address().port}`;

// ---------- layr serve ----------

const PORT = 4300 + Math.floor(Math.random() * 500) + 100;
const links = ["--link", path.join(repoRoot, "plugins", "devtools"), "--link", made];
if (WITH_CLAUDE) links.push("--link", path.join(repoRoot, "plugins", "claude"));
const env = {
  ...process.env,
  LAYR_GH: path.join(repoRoot, "core", "layr_core", "tests", "fake_gh", "gh.mjs"),
  FAKE_GH_DIR: fakeGh,
  FAKE_GH_DOWNLOAD_BASE: downloadBase,
  FAKE_GH_USER: "tester",
  RUST_LOG: "warn",
};
const serve = spawn(exe, ["serve", "--port", String(PORT), "--token", "dev", "--home", home, "--registry", path.join(store, "index.json"), ...links],
  { env, stdio: ["ignore", "pipe", "pipe"] });
let serveLog = "";
serve.stdout.on("data", (d) => (serveLog += d));
serve.stderr.on("data", (d) => (serveLog += d));
console.log(`layr serve pid ${serve.pid} on ${PORT}, temp ${tmp}`);
for (let i = 0; i < 100 && !serveLog.includes("shell:"); i++) await new Promise((r) => setTimeout(r, 200));
if (!serveLog.includes("shell:")) throw new Error(`layr serve didn't start:\n${serveLog}`);

// ---------- the shell side ----------

let nextId = 1;
const pending = new Map();
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_layr/ws?token=dev`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
};
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
const tool = async (name, args = {}, plugin = "layr") => {
  const r = await call("tools.call", { plugin, tool: name, args });
  return r.structuredContent;
};
await call("settings.set", { key: "theme", value: { mode: "dark" } });
await call("packages.install", { id: "weather", version: "0.1.0" });
await call("packages.install", { id: "sky", version: "0.1.0" });

// ---------- tiny runner ----------

let failures = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e.stack || e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m || "assertion failed");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 });
const errors = [];
const created = await call("panels.create", { plugin: "devtools", panel: "main" });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(created.url);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const item = (id) => page.locator(`[data-select="${id}"]`);
const idle = () => page.waitForFunction(() => !document.body.classList.contains("busy"));
async function clickAndConfirm(selector) {
  await page.click(selector);
  await page.waitForSelector("#modal:not([hidden])");
  await page.click("#modalBox [data-answer=ok]");
  await idle();
}

await test("lists plugins you made and installed ones", async () => {
  await page.waitForSelector('[data-select="counter"]');
  const titles = await page.locator(".group-title").allTextContents();
  assert(titles.includes("Made by you") && titles.includes("From the store"), JSON.stringify(titles));
  await item("counter").click();
  await page.waitForSelector(".timeline .commit");
  await idle();
  const subjects = await page.locator(".commit-subject").allTextContents();
  assert(subjects[0] === "Bigger button" && subjects.includes("Add a reset button"), JSON.stringify(subjects));
  const metas = await page.locator(".commit-meta").allTextContents();
  assert(metas[0].startsWith("You") && metas[1].startsWith("Claude"), JSON.stringify(metas));
  assert(await page.locator(".notice.warn", { hasText: "not saved yet" }).count() === 1, "unsaved changes are shown");
  assert(await page.locator('.plugin-item[data-select="counter"] .dot').count() === 1, "dot for unsaved changes");
  await shot("01-history");
});

await test("a saved version's changes, as a diff", async () => {
  await page.locator(".commit-head", { hasText: "Add a reset button" }).click();
  await page.waitForSelector(".diff .add");
  const added = await page.locator(".diff .add").allTextContents();
  assert(added.some((l) => l.includes("Reset")), JSON.stringify(added));
  await shot("02-diff");
});

await test("Save version keeps the unsaved work", async () => {
  await page.click('.actions [data-action="save"]');
  await page.fill("#saveMsg", "Made with layr line");
  await page.click("#modalBox [data-answer=ok]");
  await idle();
  await page.waitForFunction(() => document.querySelector(".commit-subject")?.textContent === "Made with layr line");
  assert(git(made, "status", "--porcelain") === "", "nothing left unsaved");
});

await test("Undo takes one version back", async () => {
  // "Bigger button" added styles.css: undoing it removes just that file, later versions stay.
  await page.locator(".commit-head", { hasText: "Bigger button" }).click();
  await page.waitForSelector('.commit-actions [data-action="undo"]');
  await shot("03-commit-actions");
  await clickAndConfirm('.commit-actions [data-action="undo"]');
  await page.waitForFunction(() => document.querySelector(".commit-subject")?.textContent?.startsWith("Revert"));
  assert(!existsSync(path.join(made, "styles.css")), "styles.css is gone");
  assert(readFileSync(path.join(made, "panels", "main.html"), "utf8").includes("Made with layr"), "later changes stay");
  await shot("04-after-undo");
});

await test("An undo that clashes with later changes changes nothing", async () => {
  const head = git(made, "rev-parse", "HEAD");
  await page.locator(".commit-head", { hasText: "Add a reset button" }).click();
  await clickAndConfirm('.commit-actions [data-action="undo"]');
  assert(git(made, "rev-parse", "HEAD") === head && git(made, "status", "--porcelain") === "", "nothing changed");
});

await test("Restore to here", async () => {
  await page.locator(".commit-head", { hasText: "Please make a counter" }).click();
  await clickAndConfirm('.commit-actions [data-action="restore"]');
  await page.waitForFunction(() => document.querySelector(".commit-subject")?.textContent?.startsWith("Restore to"));
  assert(readFileSync(path.join(made, "panels", "main.html"), "utf8").replace(/\r\n/g, "\n") === "<button>+1</button>\n<p>Count: 0</p>\n");
  assert(!existsSync(path.join(made, "styles.css")), "files added later are gone");
});

let mine;
await test("Change this plugin: a store plugin gets your changes", async () => {
  await item("weather").click();
  await page.waitForSelector('[data-action="edit"]');
  await idle();
  await shot("05-store-plugin");
  await page.click('[data-action="edit"]');
  await idle();
  await page.waitForFunction(() => document.querySelector(".layr-badge")?.textContent === "Your changes");
  const repos = await tool("plugin_repos");
  mine = repos.plugins.find((p) => p.id === "weather").path;
  assert(mine.replace(/\\/g, "/").endsWith("packages/weather/mine"), mine);
  writeFileSync(path.join(mine, "panels", "main.html"), "<h1>Weather</h1>\n<p>Sunny</p>\n<p>Wind: calm</p>\n<p>Rain: none</p>\n<footer>my footer</footer>\n");
  await page.click("#refresh");
  await idle();
  await page.click('.actions [data-action="save"]');
  await page.fill("#saveMsg", "My own footer");
  await page.click("#modalBox [data-answer=ok]");
  await idle();
  await page.waitForFunction(() => document.querySelector(".commit-subject")?.textContent === "My own footer");
  await shot("06-your-changes");
});

await test("Update with your changes: merges cleanly", async () => {
  storeVersion("0.2.0", ["<h1>Weather today</h1>", "<p>Sunny</p>", "<p>Wind: calm</p>", "<p>Rain: none</p>", "<footer>v1</footer>"]);
  await page.click("#refresh");
  await idle();
  await page.click('.tab[data-tab="versions"]');
  await page.waitForSelector('[data-action="update"]');
  await shot("07-update-available");
  await page.click('[data-action="update"]');
  await idle();
  await page.waitForFunction(() => document.querySelector(".layr-muted")?.textContent === "0.2.0");
  const html = readFileSync(path.join(mine, "panels", "main.html"), "utf8");
  assert(html.includes("Weather today") && html.includes("my footer"), html);
});

await test("A conflicting update leaves the old version running", async () => {
  storeVersion("0.3.0", ["<h1>Weather today</h1>", "<p>Sunny</p>", "<p>Wind: calm</p>", "<p>Rain: none</p>", "<footer>v3</footer>"]);
  await page.click("#refresh");
  await idle();
  await page.click('.tab[data-tab="versions"]');
  await page.waitForSelector(".notice.warn");
  const text = await page.locator(".notice.warn").textContent();
  assert(text.includes("changes the same places") && text.includes("panels/main.html"), text);
  const info = (await call("packages.list")).find((p) => p.id === "weather");
  assert(info.version.startsWith("0.2.0"), info.version);
  await shot("08-update-conflict");
});

if (WITH_CLAUDE) {
  await test("Claude combines the conflicting update; its turn is saved; Update uses it", async () => {
    const help = await tool("plugin_merge_help", { plugin: "weather", version: "0.3.0" });
    const { project } = await tool("project_add", { path: help.path }, "claude");
    const { thread } = await tool("thread_start", { project: project.id, prompt: help.prompt, model: "haiku",
      permissionMode: "bypassPermissions", title: "Combine weather 0.3.0" }, "claude");
    const done = await tool("thread_wait", { thread: thread.id, timeoutSec: 300 }, "claude");
    assert(!done.timedOut, "Claude finished");
    for (let i = 0; i < 30 && git(help.path, "status", "--porcelain") !== ""; i++) await sleep(500);
    const last = git(help.path, "log", "-1", "--format=%an|%P");
    assert(last.split("|")[1].split(" ").length === 2, `the merge is committed: ${last}`);
    assert(last.startsWith("layr (Claude)|"), `saved by itself after Claude's turn: ${last}`);
    const up = await tool("plugin_update", { plugin: "weather", version: "0.3.0" });
    assert(up.applied && up.resolved, JSON.stringify(up));
    const html = readFileSync(path.join(mine, "panels", "main.html"), "utf8");
    assert(!html.includes("<<<<<<<"), html);
    console.log(`     Claude kept: ${html.match(/<footer>.*<\/footer>/)?.[0]} (last commit by ${last.split("|")[0]})`);
    await page.click("#refresh");
    await idle();
    await shot("09-combined-by-claude");
  });
}

await test("Rollback: a version as it came", async () => {
  await page.click('.tab[data-tab="versions"]');
  await page.locator('.version-row:has(.v:text-is("0.1.0")) [data-action="switch"]').click();
  await idle();
  await page.waitForFunction(() => document.querySelector(".layr-muted")?.textContent === "0.1.0");
  const info = (await call("packages.list")).find((p) => p.id === "weather");
  assert(info.version === "0.1.0" && !info.linked, JSON.stringify(info));
  await page.click('.tab[data-tab="versions"]');
  await shot("10-versions");
  await page.locator('.version-row:has(.v:text-is("0.1.0")) [data-action="switch-mine"]').click();
  await idle();
  assert(readFileSync(path.join(mine, "panels", "main.html"), "utf8").includes("my footer"), "my changes on 0.1.0 are back");
});

await test("GitHub: signed in through gh (the fake one)", async () => {
  await page.click("#githubNav");
  await page.waitForSelector(".notice.good");
  const text = await page.locator(".notice.good").textContent();
  assert(text.includes("Signed in as tester"), text);
  await shot("11-github");
});

await test("Publish a plugin you made (fake GitHub)", async () => {
  await item("counter").click();
  await idle();
  await page.click('.tab[data-tab="share"]');
  await page.waitForSelector('[data-action="publish"]:not([disabled])');
  await page.check('input[name="vis"][value="public"]');
  await page.fill("#pubVersion", "0.2.0");
  await page.fill("#pubNotes", "Counts, resets.");
  await shot("12-publish-form");
  await clickAndConfirm('[data-action="publish"]');
  await page.waitForSelector(".notice.good.result");
  const state = JSON.parse(readFileSync(path.join(fakeGh, "state.json"), "utf8"));
  assert(state.visibility["tester/counter"] === "public", JSON.stringify(state.visibility));
  assert(state.releases["tester/counter"][0].tag === "v0.2.0", JSON.stringify(state.releases));
  assert(git(made, "tag", "--list") === "v0.2.0");
  await shot("13-published");
});

await test("A fork signed by someone else installs only as a replacement", async () => {
  // friend/sky on the fake GitHub: a release of sky 0.2.0 with its .sig, signed by the friend's key.
  const forkSrc = path.join(tmp, "fork-src", "sky");
  cpSync(sky, forkSrc, { recursive: true });
  writeFileSync(path.join(forkSrc, "layr.json"), skyManifest("0.2.0"));
  writeFileSync(path.join(forkSrc, "panels", "main.html"), "<p>Blue, with clouds</p>\n");
  const rel = path.join(fakeGh, "releases", "friend", "sky", "v0.2.0");
  mkdirSync(rel, { recursive: true });
  execFileSync(exe, ["pack", forkSrc, "--out", rel]);
  execFileSync(exe, ["key", "sign", path.join(rel, "sky-0.2.0.zip"), "--out", rel, "--home", friendKey]);
  const statePath = path.join(fakeGh, "state.json");
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { releases: {}, forks: {}, parents: {}, prs: [], visibility: {} };
  state.releases["friend/sky"] = [{ tag: "v0.2.0", assets: ["sky-0.2.0.zip", "sky-0.2.0.zip.sig"] }];
  state.forks["tester/sky"] = ["friend/sky"];
  writeFileSync(statePath, JSON.stringify(state, null, 2));

  await item("sky").click();
  await idle();
  await page.click('.tab[data-tab="versions"]');
  await page.click('[data-action="forks"]');
  await page.waitForSelector(".version-row .other-signer");
  const row = await page.locator(".version-row:has(.other-signer)").textContent();
  assert(row.includes("friend") && row.includes("signed by") && row.includes("another publisher"), row);
  await shot("14-fork-signed-by-someone-else");
  await page.click('[data-action="install-release"][data-repo="https://github.com/friend/sky"]');
  await page.waitForSelector("#modal:not([hidden]) .signer-warning");
  const box = await page.locator("#modalBox").textContent();
  assert(box.includes("signed by someone else") && box.includes("start over"), box);
  const ok = await page.locator("#modalBox [data-answer=ok]").textContent();
  assert(ok.trim() === "Install as replacement", ok);
  await shot("15-install-as-replacement");
  await page.click("#modalBox [data-answer=ok]");
  await idle();
  let info;
  for (let i = 0; i < 50 && info?.version !== "0.2.0"; i++, await sleep(100)) {
    info = (await call("packages.list")).find((p) => p.id === "sky");
  }
  assert(info?.version === "0.2.0", JSON.stringify(info));
});

await test("No page errors", async () => {
  assert(!errors.length, errors.join("\n"));
});

await browser.close();
ws.close();
files.close();
serve.kill();
await sleep(500);
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {}
console.log(failures ? `\n${failures} failure(s)` : `\nall passed; screenshots in ${OUT}`);
process.exit(failures ? 1 : 0);
