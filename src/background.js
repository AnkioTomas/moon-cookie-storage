import { api } from "./browser.js";
import {
  SESSION_MS, parseRequest, managementOrigin, encryptPayload, callbackUrl, checkJsonPassed,
} from "./protocol.js";

const keyFor = (id) => `login:${id}`;
const locks = new Set();

async function save(job) {
  await api.storage.session.set({ [keyFor(job.id)]: job });
}

async function getJob(id) {
  return (await api.storage.session.get(keyFor(id)))[keyFor(id)];
}

async function closeTab(id) {
  if (id === undefined) return;
  // A user may already have closed the tab.
  const tabs = await api.tabs.query({});
  if (tabs.some((tab) => tab.id === id)) await api.tabs.remove(id);
}

async function openLogin(message, sender) {
  if (!sender.tab || sender.frameId !== 0 || sender.tab.incognito) {
    throw new Error("请在非隐私窗口的远程管理主页面发起授权");
  }
  const request = parseRequest(message.request ?? {}, sender.url);
  const jobs = Object.entries(await api.storage.session.get(null))
    .filter(([key]) => key.startsWith("login:")).map(([, value]) => value);
  if (jobs.some((job) => job.sourceTabId === sender.tab.id && job.expiresAt > Date.now())) {
    throw new Error("此远程管理页面已有待处理任务，请先完成或取消");
  }
  const job = {
    ...request, id: crypto.randomUUID(), sourceTabId: sender.tab.id,
    expiresAt: Date.now() + SESSION_MS, approved: false,
  };
  await save(job);
  try {
    const tab = await api.tabs.create({ url: `${api.runtime.getURL("wait.html")}?job=${job.id}` });
    // The wait page binds its own tab on first contact, avoiding a tab-load race.
    return { ok: true, jobId: job.id, tabId: tab.id };
  } catch {
    await api.storage.session.remove(keyFor(job.id));
    throw new Error("无法打开授权页面");
  }
}

async function authorizeJob(id, sender, tabId, allowExpired = false) {
  const url = new URL(sender.url);
  const expected = new URL(api.runtime.getURL("wait.html"));
  const tab = sender.tab ?? (Number.isInteger(tabId) ? await api.tabs.get(tabId) : undefined);
  if (
    url.protocol !== expected.protocol || url.host !== expected.host ||
    url.pathname !== expected.pathname ||
    url.searchParams.get("job") !== id || !tab || tab.url !== url.href ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  ) throw new Error("任务来源不正确");
  const job = await getJob(id);
  if (!job) throw new Error("任务不存在或已完成，请从远程管理重新发起");
  if (!allowExpired && job.expiresAt <= Date.now()) throw new Error("授权任务已超时，请重新发起");
  if (job.waitTabId !== undefined && job.waitTabId !== tab.id) {
    throw new Error("此任务已绑定其他授权页面");
  }
  if (job.waitTabId === undefined) {
    job.waitTabId = tab.id;
    await save(job);
  }
  return job;
}

// Runs in the login tab's isolated world, using that page's actual cookie context.
async function capturePage(check, scope, wantBody) {
  if (location.origin !== new URL(check).origin) return { state: "waiting" };
  let response;
  try {
    response = await fetch(check, {
      credentials: "include", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { state: "waiting", reason: "检查请求失败，可能尚未登录或网络不可达" };
  }
  if (response.type === "opaqueredirect" || !response.ok || response.redirected) {
    return { state: "waiting", reason: "检查接口未返回 2xx，继续等待登录" };
  }
  let body;
  if (wantBody) {
    try {
      body = await response.text();
    } catch {
      return { state: "waiting", reason: "检查接口响应读取失败" };
    }
  }
  try {
    const read = (storage) => Object.fromEntries(
      Array.from({ length: storage.length }, (_, i) => {
        const key = storage.key(i);
        return [key, storage.getItem(key)];
      }),
    );
    return {
      state: "ready",
      body,
      local: scope.includes("local") ? read(localStorage) : undefined,
      session: scope.includes("session") ? read(sessionStorage) : undefined,
    };
  } catch {
    return { state: "error", reason: "登录页面禁止访问 Web Storage" };
  }
}

async function poll(job) {
  if (!job.approved || job.loginTabId === undefined) throw new Error("尚未授权");
  const loginTab = await api.tabs.get(job.loginTabId);
  if (
    loginTab.status === "loading" || !loginTab.url ||
    new URL(loginTab.url).origin !== new URL(job.check).origin
  ) {
    return { ok: true, state: "waiting", reason: "等待登录页面回到目标站点" };
  }
  const results = await api.scripting.executeScript({
    target: { tabId: job.loginTabId, frameIds: [0] },
    func: capturePage, args: [job.check, job.scope, Boolean(job.checkJson)],
  });
  const snapshot = results[0]?.result;
  if (!snapshot || snapshot.state === "error") {
    throw new Error(snapshot?.reason || "无法读取登录页面");
  }
  if (snapshot.state !== "ready") return { ok: true, ...snapshot };
  if (!checkJsonPassed(job.checkJson, snapshot.body)) {
    return { ok: true, state: "waiting", reason: "检查接口返回的登录状态未通过，继续等待登录" };
  }
  // Confirm that navigation did not change while the check was in flight.
  const current = await api.tabs.get(job.loginTabId);
  if (current.url !== loginTab.url) return { ok: true, state: "waiting" };
  let cookies;
  if (job.scope.includes("cookie")) {
    const stores = await api.cookies.getAllCookieStores();
    const store = stores.find((item) => item.tabIds.includes(job.loginTabId));
    if (!store) throw new Error("无法确定登录页面的 Cookie 容器");
    cookies = await api.cookies.getAll({ url: job.check, storeId: store.id });
  }
  const payload = {
    v: 1, ticket: job.ticket, domain: job.domain, check: job.check,
    capturedAt: new Date().toISOString(), cookies,
    local: snapshot.local, session: snapshot.session,
  };
  const encrypted = await encryptPayload(payload, job.ticket);
  const url = callbackUrl(job, encrypted);
  // Ensure the management tab has not navigated to a different origin.
  const source = await api.tabs.get(job.sourceTabId);
  if (managementOrigin(source.url) !== job.origin) throw new Error("远程管理页面已离开原地址");
  if (!await getJob(job.id) || job.expiresAt <= Date.now()) {
    throw new Error("授权任务已取消或超时，未发送登录数据");
  }
  let response;
  try {
    response = await fetch(url, {
      method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("回调网络请求失败，登录页已保留，可手动重试");
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(
      `远程管理拒绝回调（HTTP ${response.status}），登录页已保留` +
      (detail ? `：${detail}` : "（服务端未返回错误详情）"),
    );
  }
  let ack;
  try {
    ack = await response.json();
  } catch {
    throw new Error("远程管理未返回 JSON 确认，登录页已保留");
  }
  if (ack?.ok !== true || ack.close !== true || ack.ticketId !== encrypted.ticketId) {
    throw new Error("远程管理未确认验证和保存成功，登录页已保留");
  }
  await api.storage.session.remove(keyFor(job.id));
  await closeTab(job.loginTabId);
  await closeTab(job.waitTabId);
  return { ok: true, state: "done" };
}

async function handle(message, sender) {
  if (message.type === "MOON_OPEN_LOGIN") {
    const key = `source:${sender.tab?.id}`;
    if (locks.has(key)) throw new Error("此页面正在创建授权任务");
    locks.add(key);
    try {
      return await openLogin(message, sender);
    } finally {
      locks.delete(key);
    }
  }
  if (!["MOON_DESCRIBE", "MOON_START", "MOON_POLL", "MOON_CANCEL"].includes(message.type)) {
    return undefined;
  }
  if (locks.has(message.id)) throw new Error("任务正在处理，请稍候");
  locks.add(message.id);
  try {
    const job = await authorizeJob(
      message.id, sender, message.tabId, message.type === "MOON_CANCEL",
    );
    if (message.type === "MOON_DESCRIBE") {
      return {
        ok: true, domain: job.domain, scope: job.scope, origin: job.origin,
        check: job.check, login: job.login, callback: job.callback,
        approved: job.approved, expiresAt: job.expiresAt,
      };
    }
    if (message.type === "MOON_START") {
      if (job.approved) return { ok: true };
      const tab = await api.tabs.create({ url: job.login });
      job.approved = true;
      job.loginTabId = tab.id;
      await save(job);
      return { ok: true };
    }
    if (message.type === "MOON_CANCEL") {
      await api.storage.session.remove(keyFor(job.id));
      await closeTab(job.loginTabId);
      return { ok: true };
    }
    return await poll(job);
  } finally {
    locks.delete(message.id);
  }
}

// Use sendResponse for Firefox and Chromium compatibility.
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("MOON_")) return;
  handle(message, sender).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "授权任务失败" });
  });
  return true;
});

api.tabs.onRemoved.addListener((tabId) => {
  void api.storage.session.get(null).then(async (entries) => {
    for (const [key, job] of Object.entries(entries)) {
      if (!key.startsWith("login:")) continue;
      if (job.waitTabId === tabId || job.sourceTabId === tabId) {
        await api.storage.session.remove(key);
        await closeTab(job.loginTabId);
      }
    }
  }).catch(() => {
    console.error("清理已关闭页面的授权任务失败");
  });
});
