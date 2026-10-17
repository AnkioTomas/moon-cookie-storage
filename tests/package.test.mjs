import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { packageExtensions } from "../scripts/package.mjs";

const exec = promisify(execFile);

test("packages have manifest at zip root and do not rewrite source version", async () => {
  const before = await readFile("src/manifest.json", "utf8");
  const assets = await packageExtensions({ version: "9.9.9" });
  assert.deepEqual(assets.map((file) => file.split("/").at(-1)), [
    "moon-cookie-storage-chrome-9.9.9.zip",
    "moon-cookie-storage-edge-9.9.9.zip",
    "moon-cookie-storage-firefox-9.9.9.zip",
  ]);
  assert.equal(await readFile("src/manifest.json", "utf8"), before);

  for (const archive of assets) {
    const { stdout } = await exec("unzip", ["-Z1", archive]);
    const names = stdout.split("\n").filter(Boolean);
    assert.equal(names.includes("manifest.json"), true);
    assert.equal(names.some((name) => name.includes("/") && name.endsWith("manifest.json")), false);
    const { stdout: raw } = await exec("unzip", ["-p", archive, "manifest.json"]);
    const manifest = JSON.parse(raw);
    assert.equal(manifest.version, "9.9.9");
    assert.equal(manifest.background.service_worker !== undefined, !archive.includes("firefox"));
    const hash = (await readFile(`${archive}.sha256`, "utf8")).slice(0, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
  await assert.rejects(packageExtensions({ version: "1.0.0-beta" }), /MAJOR\.MINOR\.PATCH/);
});
