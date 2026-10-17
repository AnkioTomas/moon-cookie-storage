import { api } from "./browser.js";

const id = new URL(location.href).searchParams.get("job");
const tab = await api.tabs.getCurrent();
const status = document.getElementById("status");
const details = document.getElementById("details");

function phase(name) {
  document.body.dataset.phase = name;
}
const start = document.getElementById("start");
const retry = document.getElementById("retry");
const cancel = document.getElementById("cancel");
let timer;
let busy = false;
let stopped = false;
let expiresAt = 0;

async function send(type) {
  const result = await api.runtime.sendMessage({ type, id, tabId: tab?.id });
  if (!result?.ok) throw new Error(result?.error || "插件连接中断，请从远程管理重新发起");
  return result;
}

function fail(error) {
  clearInterval(timer);
  phase("error");
  status.textContent = error.message;
  retry.hidden = Date.now() >= expiresAt;
}

async function poll() {
  if (busy || stopped) return;
  if (Date.now() >= expiresAt) {
    stopped = true;
    clearInterval(timer);
    phase("error");
    status.textContent = "授权已超时，登录数据不再采集。请取消后重新发起。";
    return;
  }
  busy = true;
  try {
    const result = await send("MOON_POLL");
    if (result.state === "done") {
      stopped = true;
      clearInterval(timer);
      phase("done");
      status.textContent = "远程管理已验证并保存。";
    } else {
      phase("watching");
      status.textContent = result.reason || "等待登录，每约 2 秒检查一次…";
    }
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
  }
}

function beginPolling() {
  clearInterval(timer);
  timer = setInterval(poll, 2000);
  void poll();
}

start.addEventListener("click", async () => {
  start.disabled = true;
  try {
    await send("MOON_START");
    phase("watching");
    status.textContent = "请在新页面登录，授权页请保持打开。";
    beginPolling();
  } catch (error) {
    start.disabled = false;
    phase("error");
    status.textContent = error.message;
    retry.hidden = true;
  }
});

retry.addEventListener("click", () => {
  retry.hidden = true;
  beginPolling();
});

cancel.addEventListener("click", async () => {
  cancel.disabled = true;
  stopped = true;
  clearInterval(timer);
  try {
    await send("MOON_CANCEL");
    window.close();
  } catch (error) {
    status.textContent = error.message;
    cancel.disabled = false;
  }
});

try {
  const job = await send("MOON_DESCRIBE");
  expiresAt = job.expiresAt;
  for (const [label, value, chips] of [
    ["接收设备", job.origin], ["登录域名", job.domain],
    ["采集范围", job.scope, true], ["登录页面", job.login],
    ["检查接口", job.check], ["回调地址", job.callback],
  ]) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    if (chips) {
      description.className = "chips";
      for (const item of value) {
        const chip = document.createElement("span");
        chip.textContent = item;
        description.append(chip);
      }
    } else {
      description.textContent = value;
    }
    details.append(term, description);
  }
  phase(job.approved ? "watching" : "confirm");
  status.textContent = job.approved
    ? "已授权，正在恢复登录检查…"
    : "尚未采集任何数据，请确认后授权。";
  start.disabled = job.approved;
  if (job.approved) beginPolling();
} catch (error) {
  phase("error");
  status.textContent = error.message;
}
