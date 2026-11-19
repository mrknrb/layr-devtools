// The old panel's page (0.2.0: My plugins is part of layr): it opens the Plugins list at once and on its button, and
// says so when that fails, in a bare context with a fake `layr` and document (no browser). Replaces the end-to-end
// test of the old panel (0.1). Run: node --test plugins/devtools/test/page.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, "..", "panels", "main.js"), "utf8");
const html = readFileSync(path.join(here, "..", "panels", "main.html"), "utf8");

function page(open) {
  const opened = [];
  const els = { open: { listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; } }, error: { hidden: true } };
  const context = {
    window: { layr: { links: { open: async (url) => (opened.push(url), open?.(url)) } } },
    document: { getElementById: (id) => els[id] },
  };
  vm.runInNewContext(code, context);
  return { opened, els };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("the old My plugins panel", () => {
  it("says My plugins is part of layr, with a button", () => {
    assert.match(html, /My plugins is part of layr now/);
    assert.match(html, /id="open"/);
  });

  it("opens the Plugins list at once, and again on its button", async () => {
    const { opened, els } = page();
    await tick();
    assert.deepEqual(opened, ["layr://layr/plugins"]);
    els.open.listeners.click();
    await tick();
    assert.equal(opened.length, 2);
    assert.equal(els.error.hidden, true);
  });

  it("says so when the list can't be opened", async () => {
    const { els } = page(() => {
      throw new Error("no shell");
    });
    await tick();
    assert.equal(els.error.hidden, false);
    assert.match(els.error.textContent, /no shell/);
  });
});
