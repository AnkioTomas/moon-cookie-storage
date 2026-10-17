import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, hkdfSync } from "node:crypto";

test("authorized login flow with actual page checker and encrypted callback", async (t) => {
  const session = {};
  const tabs = new Map([[1, { id: 1, url: "http://127.0.0.1:9528/", incognito: false }]]);
  let nextId = 2;
  let listener;
  let checkStatus = 401;
  let ackMode = "accept";
  let pageChecks = 0;
  let cookieReads = 0;
  let callbacks = 0;
  let envelope;
  const ticket = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const api = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (fn) => { listener = fn; } },
    },
    storage: { session: {
      set: async (value) => Object.assign(session, structuredClone(value)),
      get: async (key) => structuredClone(key === null ? session : { [key]: session[key] }),
      remove: async (key) => { delete session[key]; },
    } },
    tabs: {
      create: async ({ url }) => {
        const tab = { id: nextId++, url };
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("页面已关闭");
        return tabs.get(id);
      },
      query: async () => [...tabs.values()],
      remove: async (id) => { tabs.delete(id); },
      onRemoved: { addListener() {} },
    },
    scripting: { executeScript: async ({ func, args }) => {
      globalThis.location = new URL("https://example.com/login");
      const storage = { length: 1, key: () => "token", getItem: () => "storage-secret" };
      globalThis.localStorage = storage;
      globalThis.sessionStorage = storage;
      return [{ result: await func(...args) }];
    } },
    cookies: {
      getAllCookieStores: async () => [{ id: "container-1", tabIds: [...tabs.keys()] }],
      getAll: async ({ storeId, url }) => {
        cookieReads++;
        assert.equal(storeId, "container-1");
        assert.equal(url, "https://example.com/userinfo");
        return [{ name: "sessionid", value: "cookie-secret", httpOnly: true }];
      },
    },
  };
  globalThis.chrome = api;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === "example.com") {
      pageChecks++;
      assert.equal(options.credentials, "include");
      assert.equal(options.redirect, "manual");
      return {
        ok: checkStatus >= 200 && checkStatus < 300,
        status: checkStatus, type: checkStatus === 302 ? "opaqueredirect" : "basic",
        redirected: false,
      };
    }
    callbacks++;
    assert.equal(new URL(url).origin, "http://127.0.0.1:9528");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    envelope = JSON.parse(new URL(url).searchParams.get("data"));
    assert.equal(JSON.stringify(envelope).includes("cookie-secret"), false);
    // Independently decode as a remote server, without using the extension's crypto helper.
    const key = hkdfSync(
      "sha256", Buffer.from(ticket), Buffer.from(envelope.salt, "base64url"),
      Buffer.from("moon-cookie-storage/v1"), 32,
    );
    const ciphertext = Buffer.from(envelope.data, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from(ticket));
    decipher.setAuthTag(ciphertext.subarray(-16));
    const payload = JSON.parse(Buffer.concat([
      decipher.update(ciphertext.subarray(0, -16)), decipher.final(),
    ]).toString());
    assert.equal(payload.ticket, ticket);
    assert.equal(payload.domain, "example.com");
    assert.equal(payload.cookies[0].httpOnly, true);
    assert.equal(payload.cookies[0].value, "cookie-secret");
    assert.deepEqual(payload.local, { token: "storage-secret" });
    assert.deepEqual(payload.session, { token: "storage-secret" });
    return {
      ok: true,
      json: async () => ({ ok: true, close: ackMode === "accept", ticketId: envelope.ticketId }),
    };
  };
  await import("../src/background.js");
  const send = (message, sender) => new Promise((resolve) => listener(message, sender, resolve));
  const source = { tab: tabs.get(1), frameId: 0, url: tabs.get(1).url };
  let jobId;
  let waiter;

  await t.test("reject requests outside management port", async () => {
    const result = await send({
      type: "MOON_OPEN_LOGIN", request: {},
    }, { ...source, url: "https://example.com/" });
    assert.equal(result.ok, false);
    assert.equal(tabs.size, 1);
  });

  await t.test("opening a job does not read credentials before explicit approval", async () => {
    const result = await send({
      type: "MOON_OPEN_LOGIN",
      request: {
        domain: "example.com", scope: "cookie,local,session",
        check: "https://example.com/userinfo", login: "https://example.com/login", ticket,
      },
    }, source);
    assert.equal(result.ok, true);
    jobId = result.jobId;
    const tab = tabs.get(result.tabId);
    waiter = { tab, url: tab.url, frameId: 0 };
    const blocked = await send({ type: "MOON_POLL", id: jobId }, waiter);
    assert.equal(blocked.ok, false);
    assert.equal(pageChecks, 0);
    assert.equal(cookieReads, 0);
    // Extension pages can have no sender.tab / sender.frameId in Chromium.
    const description = await send({
      type: "MOON_DESCRIBE", id: jobId, tabId: tab.id,
    }, { url: tab.url });
    assert.equal(description.origin, "http://127.0.0.1:9528");
    assert.equal(description.ticket, undefined);
    const forged = await send({ type: "MOON_START", id: jobId }, source);
    assert.equal(forged.ok, false);
    assert.equal((await send({ type: "MOON_START", id: jobId }, waiter)).ok, true);
  });

  await t.test("401, redirects, and server errors never trigger callback", async () => {
    for (const status of [401, 302, 301, 500]) {
      checkStatus = status;
      const result = await send({ type: "MOON_POLL", id: jobId }, waiter);
      assert.equal(result.state, "waiting");
    }
    assert.equal(cookieReads, 0);
    assert.equal(callbacks, 0);
  });

  await t.test("remote rejection preserves tabs and permits retry", async () => {
    checkStatus = 200;
    ackMode = "reject";
    const result = await send({ type: "MOON_POLL", id: jobId }, waiter);
    assert.equal(result.ok, false);
    assert.match(result.error, /未确认/);
    assert.equal(tabs.size, 3);
    assert.ok(session[`login:${jobId}`]);
  });

  await t.test("a management tab that navigated away cannot receive credentials", async () => {
    tabs.get(1).url = "http://other.example:9528/";
    const count = callbacks;
    const result = await send({ type: "MOON_POLL", id: jobId }, waiter);
    assert.equal(result.ok, false);
    assert.equal(callbacks, count);
    tabs.get(1).url = source.url;
  });

  await t.test("verified acknowledgement closes only owned tabs and consumes the job", async () => {
    ackMode = "accept";
    const result = await send({ type: "MOON_POLL", id: jobId }, waiter);
    assert.equal(result.state, "done");
    assert.equal(tabs.size, 1);
    assert.ok(tabs.has(1));
    assert.equal(session[`login:${jobId}`], undefined);
    const replay = await send({ type: "MOON_POLL", id: jobId }, waiter);
    assert.equal(replay.ok, false);
  });

  await t.test("expired jobs reject collection but still allow cancellation", async () => {
    const result = await send({
      type: "MOON_OPEN_LOGIN", request: {
        domain: "example.com", scope: "cookie", check: "https://example.com/userinfo", ticket,
      },
    }, source);
    const tab = tabs.get(result.tabId);
    const sender = { tab, url: tab.url, frameId: 0 };
    session[`login:${result.jobId}`].expiresAt = 0;
    const expired = await send({ type: "MOON_START", id: result.jobId }, sender);
    assert.equal(expired.ok, false);
    assert.match(expired.error, /超时/);
    assert.equal((await send({ type: "MOON_CANCEL", id: result.jobId }, sender)).ok, true);
    assert.equal(session[`login:${result.jobId}`], undefined);
  });
});
