import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const code = await readFile(new URL("../src/bridge.js", import.meta.url), "utf8");

function setup(address, extension = "chrome-extension://test/") {
  const events = {};
  const posted = [];
  const requests = [];
  const window = {
    addEventListener: (name, fn) => { events[name] = fn; },
    postMessage: (message, origin) => { posted.push({ message, origin }); },
  };
  window.top = window;
  class Element {
    constructor(href) { this.href = href; }
    closest() { return this; }
  }
  runInNewContext(code, {
    window, Element, URL, location: new URL(address),
    document: { addEventListener: (name, fn) => { events[name] = fn; } },
    chrome: { runtime: {
      getURL: (path) => new URL(path, extension).href,
      sendMessage: async (message) => {
        requests.push(message);
        return { ok: true, jobId: "job" };
      },
    } },
  });
  return { window, events, posted, requests, Element };
}

test("discovery is automatic only on port 9528 and can be requested again", () => {
  const ignored = setup("https://example.com/");
  assert.equal(ignored.posted.length, 0);
  assert.equal(Object.keys(ignored.events).length, 0);
  const ctx = setup("http://127.0.0.1:9528/");
  assert.equal(ctx.posted[0].message.type, "MOON_EXTENSION_READY");
  ctx.events.message({
    source: ctx.window, origin: "http://127.0.0.1:9528",
    data: { type: "MOON_EXTENSION_DISCOVER" },
  });
  assert.equal(ctx.posted.length, 2);
  assert.equal(ctx.posted[1].message.waitUrl, "chrome-extension://test/wait.html");
  ctx.events.message({
    source: {}, origin: "http://127.0.0.1:9528",
    data: { type: "MOON_LOGIN_REQUEST", request: {} },
  });
  assert.equal(ctx.requests.length, 0);
});

test("Chrome and Firefox links are intercepted only for this extension", async () => {
  for (const scheme of ["chrome-extension", "moz-extension"]) {
    const ctx = setup("http://127.0.0.1:9528/", `${scheme}://test/`);
    let prevented = false;
    ctx.events.click({
      target: new ctx.Element(`${scheme}://other/wait.html?domain=a.com`),
      preventDefault: () => { prevented = true; },
    });
    assert.equal(prevented, false);
    ctx.events.click({
      target: new ctx.Element(
        `${scheme}://test/wait.html?domain=a.com&scope=cookie&requestId=one`,
      ),
      preventDefault: () => { prevented = true; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prevented, true);
    assert.equal(ctx.requests[0].request.domain, "a.com");
    assert.equal(ctx.requests[0].type, "MOON_OPEN_LOGIN");
    assert.equal(ctx.posted.at(-1).message.requestId, "one");
    assert.equal(ctx.posted.at(-1).message.ok, true);
  }
});
