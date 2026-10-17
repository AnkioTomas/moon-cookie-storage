// Builds per-browser outputs from src/: dist/chrome, dist/edge, dist/firefox.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const all = ["chrome", "edge", "firefox"];
const args = process.argv.slice(2);
const list = args.length ? args : all;

const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));

function transform(browser) {
  const m = structuredClone(manifest);
  if (browser === "firefox") {
    // Firefox MV3 does not support background service workers.
    m.background = { scripts: ["background.js"], type: "module" };
    m.browser_specific_settings = {
      gecko: { id: "moon-cookie-storage@ankio.net", strict_min_version: "121.0" },
    };
  }
  return m;
}

for (const browser of list) {
  if (!all.includes(browser)) throw new Error(`Unknown target: ${browser}`);
  const out = `dist/${browser}`;
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp("src", out, {
    recursive: true,
    filter: (p) => !p.endsWith("manifest.json"),
  });
  await writeFile(`${out}/manifest.json`, JSON.stringify(transform(browser), null, 2));
  console.log(`built ${out}`);
}
