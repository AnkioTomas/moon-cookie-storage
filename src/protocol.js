export const SESSION_MS = 10 * 60 * 1000;
export const MAX_CALLBACK_LENGTH = 16_384;

export function managementOrigin(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.port !== "9528") {
    throw new Error("远程管理必须使用 HTTP(S) 的 9528 端口");
  }
  if (url.username || url.password) throw new Error("地址不能包含用户名或密码");
  return url.origin;
}

const MAX_CHECK_BODY = 65_536;

// check_json: { path: "data.code", ok?: [200], fail?: [401] } — 2xx 之外再按 JSON 值判登录。
export function parseCheckJson(input) {
  if (input === undefined || input === null) return undefined;
  const { path, ok, fail } = input;
  const scalars = (list) => Array.isArray(list) && list.every((v) => ["string", "number", "boolean"].includes(typeof v));
  if (typeof path !== "string" || !/^[\w-]+(\.[\w-]+)*$/.test(path)) {
    throw new Error("check_json.path 必须是点号分隔的字段路径");
  }
  if ((ok === undefined && fail === undefined) || (ok !== undefined && !scalars(ok)) || (fail !== undefined && !scalars(fail))) {
    throw new Error("check_json 需要 ok / fail 之一，且为字符串、数字、布尔数组");
  }
  return { path, ok, fail };
}

export function checkJsonPassed(rule, body) {
  if (!rule) return true;
  if (typeof body !== "string" || body.length > MAX_CHECK_BODY) return false;
  let value;
  try {
    value = JSON.parse(body);
    for (const key of rule.path.split(".")) value = value?.[key];
  } catch {
    return false;
  }
  if (value === undefined || value === null) return false;
  return (!rule.ok || rule.ok.includes(value)) && !(rule.fail ?? []).includes(value);
}

export function parseRequest(input, sourceUrl) {
  const origin = managementOrigin(sourceUrl);
  const domain = new URL(`https://${input.domain}`);
  if (
    domain.hostname !== input.domain ||
    domain.port || domain.pathname !== "/" || domain.search || domain.hash ||
    domain.username || domain.password
  ) {
    throw new Error("domain 必须是完整主机名，不含协议、端口或路径");
  }
  const scope = [...new Set(String(input.scope ?? "").split(","))];
  if (!scope.length || scope.some((item) => !["cookie", "local", "session"].includes(item))) {
    throw new Error("scope 只支持 cookie、local、session，使用逗号分隔");
  }
  const check = new URL(input.check);
  const login = new URL(input.login || check.origin);
  if (check.origin !== login.origin) throw new Error("登录和检查地址必须同源");
  const callback = new URL(input.callback || "/api/extension/login", origin);
  if (callback.origin !== origin || callback.username || callback.password || callback.hash) {
    throw new Error("回调地址必须与发起任务的远程管理页面同源");
  }
  if (callback.searchParams.has("data")) throw new Error("回调地址不能预先包含 data 参数");
  if (typeof input.ticket !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(input.ticket)) {
    throw new Error("ticket 必须是至少 32 字符的随机 base64url 字符串");
  }
  return {
    domain: domain.hostname,
    scope,
    check: check.href,
    checkJson: parseCheckJson(input.check_json),
    login: login.href,
    ticket: input.ticket,
    callback: callback.href,
    origin,
  };
}

export function base64url(bytes) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function encryptPayload(payload, ticket) {
  const encode = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey(
    "raw", encode.encode(ticket), "HKDF", false, ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encode.encode("moon-cookie-storage/v1") },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encode.encode(ticket), tagLength: 128 },
    key, encode.encode(JSON.stringify(payload)),
  );
  const ticketId = base64url(new Uint8Array(
    await crypto.subtle.digest("SHA-256", encode.encode(ticket)),
  ));
  return {
    v: 1,
    ticketId,
    salt: base64url(salt),
    iv: base64url(iv),
    data: base64url(new Uint8Array(ciphertext)),
  };
}

export function callbackUrl(request, envelope) {
  const url = new URL(request.callback);
  url.searchParams.set("data", JSON.stringify(envelope));
  if (url.href.length > MAX_CALLBACK_LENGTH) {
    throw new Error("加密数据超过 GET 长度限制，未发送。请缩小采集范围或为协议增加 POST 支持");
  }
  return url.href;
}
