# 远程管理接入协议 v1

扩展只实现浏览器侧。Moon 服务端需要实现 ticket 签发、解密、登录有效性验证和保存；
没有服务端确认不会自动关闭登录页。远程管理必须使用端口 **9528**，支持 HTTP 和 HTTPS。
不用维护域名表，登录域名由每次任务提供。

## 1. 自动发现

扩展内容脚本自动在顶层 9528 页面运行。网页先监听，再发发现消息，避免错过首次广播：

```js
let moonWaitUrl;
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.type === "MOON_EXTENSION_READY") {
    moonWaitUrl = event.data.waitUrl;
    // 此时可启用“浏览器授权登录”按钮。
  }
  if (event.data?.type === "MOON_LOGIN_RESULT" && !event.data.ok) {
    // 在网页上显示 event.data.error，不要只写 console。
  }
});
window.postMessage({ type: "MOON_EXTENSION_DISCOVER" }, location.origin);
```

首次安装后需要刷新已经打开的远程管理页。使用实际返回的 `waitUrl`，
不要硬编码扩展 ID；Firefox 为 `moz-extension://`，Chrome/Edge 为 `chrome-extension://`。
网页的发现消息不是身份认证，不可依据这条消息自动释放其他凭证。

## 2. 用户点击链接发起

Moon 服务端先创建一个至少 32 个随机字节的 base64url ticket（例如 43 字符），
绑定当前管理会话、目标域名和采集范围，10 分钟失效，不能使用 `11` 这类可枚举值。
服务器记录 `ticketId = base64url(SHA-256(UTF8(ticket)))` 到 ticket 的映射。
ticket 是加密密钥材料，不能写到日志或公开链接里。

在用户点授权时设置链接：

```js
const url = new URL(moonWaitUrl);
url.search = new URLSearchParams({
  domain: "a.com",
  scope: "local,session,cookie",
  login: "https://a.com/login",
  check: "https://a.com/userinfo.html",
  ticket, // 服务端为此次授权签发的随机值
  callback: "/api/extension/login", // 相对当前远程管理 origin
});
document.querySelector("#browser-login").href = url.href;
```

扩展拦截用户对该链接的点击，将任务绑定到发起页的真实 origin，并打开授权确认页。
确认页只带随机 job ID，不把 ticket 放入扩展页 URL；确认后才打开网站登录页并采集。
链接应放在当前远程管理主页面内，不能在新窗口里直接拼扩展地址。
这是一种**页面导航入口，不是 fetch(GET) 接口**：fetch 扩展 HTML 不会运行授权逻辑。

也可在用户点击按钮后通过消息发起同一个流程：

```js
window.postMessage({
  type: "MOON_LOGIN_REQUEST",
  requestId: crypto.randomUUID(),
  request: {
    domain: "a.com", scope: "local,session,cookie",
    login: "https://a.com/login", check: "https://a.com/userinfo.html",
    ticket, callback: "/api/extension/login",
  },
}, location.origin);
```

| 参数 | 含义 |
| --- | --- |
| `domain` | 完整主机名，不含协议、端口、路径；不隐含所有子域名 |
| `scope` | `cookie`、`local`、`session` 的逗号分隔组合 |
| `login` | HTTPS 登录页，默认是 check 的 origin；必须与 check 同源 |
| `check` | 与 domain 对应的 HTTPS 检查接口 |
| `check_json` | 可选，`{path, ok?, fail?}`：2xx 之外再解析 check 响应（≤64 KiB）的 JSON，按点号路径 `path` 取值；有 `ok` 时值须在其中，有 `fail` 时值不得在其中，取不到值或不是 JSON 都算未登录。用于「一律返回 200、靠 `code` 区分」的接口 |
| `ticket` | 单次授权的高熵随机密钥材料，32–256 个 base64url 字符 |
| `callback` | 默认 `/api/extension/login`；只能回调发起页的同源地址 |

## 3. 检查与采集

授权页保持打开，以 2 秒计时器发起检查；同一任务不并发，慢请求会跳过后续 tick。
浏览器后台节流、休眠时不能保证精确 2 秒，恢复后继续。任务元数据只存
`storage.session`，后台 worker 重启后可继续；浏览器完全关闭后不恢复。

检查由登录页的隔离脚本执行 `fetch(check, {credentials:"include", redirect:"manual"})`，
使用该标签页真实的登录上下文。只有 **2xx 且未重定向** 才采集；
401、301、302、其他错误状态和网络失败都会继续等待。服务端必须提供适合此语义的
接口，不能用永远返回 200 的登录页或 SPA 首页作为 check；接口一律 200 但 JSON 带登录状态码时，用 `check_json` 判定。最终登录真实性仍由 Moon 验证。

- Cookie 通过扩展 API 获取，包括 HttpOnly，保留 domain/path/secure 等属性；
  范围是**适用于 check URL** 的 Cookie，并使用登录标签页所在的 Cookie 容器。
- localStorage/sessionStorage 从该登录标签页顶层、check 同源页面读取。
  不抓 iframe、跨源存储或浏览器全部数据。
- scope 内会读取所有键值，因此授权页会明确提示账号凭证风险。
  不需要的 scope 不要申请。只支持普通窗口，不支持隐私窗口任务。
- 只有扩展创建的登录页、授权页会被关闭；管理页始终保留。

## 4. 加密 GET 回调

请求：`GET http(s)://设备:9528/api/extension/login?data=<URL编码的JSON>`。
不携带网站 Cookie 或明文 ticket，不跟随回调重定向，禁用缓存。
回调 URL 总长上限 16 KiB，超过就显示错误且不发送，不能截断数据。
GET 对完整 Storage 容易超长；服务端也必须配置匹配的 URL 长度限制。
若数据较大，需要另行升级为 POST，而不是静默丢字段。

`data` 解码后的结构：

```json
{
  "v": 1,
  "ticketId": "base64url SHA-256 ticket摘要",
  "salt": "16字节随机盐的base64url",
  "iv": "12字节随机IV的base64url",
  "data": "密文与16字节GCM标签拼接后的base64url"
}
```

服务端按 ticketId 找到当前管理会话绑定、尚未过期的 ticket，使用下列规则解密：

1. HKDF-SHA-256：IKM = `UTF8(ticket)`，salt = 上面的 salt，
   info = `UTF8("moon-cookie-storage/v1")`，派生 32 字节 AES 密钥。
2. AES-256-GCM：IV = 上面的 iv，AAD = `UTF8(ticket)`，tag = 最后 16 字节。
3. 明文为 UTF-8 JSON，示例：

```json
{
  "v": 1,
  "ticket": "本次授权的随机ticket",
  "domain": "a.com",
  "check": "https://a.com/userinfo.html",
  "capturedAt": "2026-10-17T10:30:00.000Z",
  "cookies": [{"name": "sessionid", "value": "...", "domain": ".a.com", "path": "/", "httpOnly": true}],
  "local": {"token": "..."},
  "session": {"token": "..."}
}
```

未申请的 scope 对应字段不传。服务端验证 ticket/域名/scope、用自己的源接口验证登录态，
成功保存后，返回 `Content-Type: application/json` 和：

```json
{"ok": true, "close": true, "ticketId": "请求中的ticketId"}
```

扩展收到匹配确认才关闭登录页和授权页。其他响应、验证失败或网络异常均保留页面，
在授权页显示错误，用户可重试。服务端应以 ticketId 幂等处理：第一次验证保存后消费 ticket，
短时间保留成功回执，重复回调只返回同一确认，不再次写入凭证。
这样可处理“已保存但 HTTP 响应丢失”的情况。

## 安全和部署限制

- 9528 端口仅用于自动发现，不代表可信身份；每次任务都要在扩展页面确认接收设备和采集范围。
- AES 不能替代 HTTPS。如果 ticket 通过明文 HTTP 页面下发，局域网攻击者仍可能获取密钥
  或篡改页面；正式部署应使用 HTTPS，包括 ticket 签发页面。
- 不要记录 ticket、解密后的凭证或 GET 查询串；回调响应应设置 `Cache-Control: no-store`，
  服务端排除回调路径的访问日志，拒绝不匹配会话/过期任务和非 9528 的源。
- 扩展目前需要 HTTP(S) 全站 host 权限用于自动发现设备和临时访问下发的域名，
  但桥接脚本在非 9528 页面立即退出，采集受单次用户授权约束。
- 本项目测试覆盖模拟浏览器 API 的完整授权流程及实际加密算法；真实浏览器、
  Moon 接口和各站点登录还需联调。浏览器对本地网络访问的许可/策略可能额外要求用户授权。
