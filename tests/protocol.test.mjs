import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest, encryptPayload, callbackUrl } from "../src/protocol.js";

const source = "http://192.168.1.5:9528/settings";
const ticket = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const input = {
  domain: "example.com", scope: "cookie,local,session",
  check: "https://example.com/userinfo", ticket,
};

async function decrypt(envelope, secret) {
  const bytes = (text) => Buffer.from(text, "base64url");
  const encode = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw", encode.encode(secret), "HKDF", false, ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256", salt: bytes(envelope.salt),
    info: encode.encode("moon-cookie-storage/v1"),
  }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: bytes(envelope.iv),
    additionalData: encode.encode(secret), tagLength: 128,
  }, key, bytes(envelope.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

test("requests bind callback to source origin, not an arbitrary recipient", () => {
  const request = parseRequest(input, source);
  assert.equal(request.callback, "http://192.168.1.5:9528/api/extension/login");
  assert.deepEqual(request.scope, ["cookie", "local", "session"]);
  assert.equal(parseRequest({ ...input, callback: "/receive?device=1" }, source).callback,
    "http://192.168.1.5:9528/receive?device=1");
  for (const override of [
    { callback: "https://attacker.example:9528/receive" },
    { callback: "//attacker.example:9528/receive" },
    { check: "https://different.example/userinfo" },
    { login: "http://example.com/login" },
    { login: "https://example.com:8443/login" },
    { domain: "example.com/path" },
    { domain: "example.com:443" },
    { domain: "example.com?x=1" },
    { ticket: "11" },
    { scope: "cookie,passwords" },
  ]) assert.throws(() => parseRequest({ ...input, ...override }, source));
  assert.throws(() => parseRequest(input, "http://192.168.1.5:8080/"));
});

test("AES-GCM round trip, fresh nonces, and authentication", async () => {
  const payload = { cookies: [{ name: "session", value: "secret", httpOnly: true }] };
  const a = await encryptPayload(payload, ticket);
  const b = await encryptPayload(payload, ticket);
  assert.deepEqual(await decrypt(a, ticket), payload);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.salt, b.salt);
  assert.equal(a.ticketId, b.ticketId);
  assert.equal(JSON.stringify(a).includes("secret"), false);
  await assert.rejects(decrypt(a, "different-ticket-with-at-least-32-characters"));
  const corrupted = { ...a, data: `${a.data[0] === "A" ? "B" : "A"}${a.data.slice(1)}` };
  await assert.rejects(decrypt(corrupted, ticket));
});

test("GET callback encodes envelope and refuses oversized data", async () => {
  const request = parseRequest(input, source);
  const envelope = await encryptPayload({ local: { token: "test" } }, ticket);
  const url = new URL(callbackUrl(request, envelope));
  assert.deepEqual(JSON.parse(url.searchParams.get("data")), envelope);
  assert.equal(url.href.includes(ticket), false);
  assert.throws(() => callbackUrl(request, { data: "a".repeat(20_000) }), /GET/);
});
