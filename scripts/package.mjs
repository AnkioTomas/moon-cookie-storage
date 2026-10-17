// Builds each browser target and zips it with manifest.json at the archive root.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const browsers = [
  ["chrome", "zip"],
  ["edge", "zip"],
  ["firefox", "zip"],
];

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`版本必须是 MAJOR.MINOR.PATCH，Chrome 不接受预发布后缀：${version}`);
  }
}

async function zipRoot(dir, archive) {
  await exec("zip", [
    "-r", "-X", "-q", archive, ".",
    "-x", "*.DS_Store", "-x", "__MACOSX/*", "-x", "*.map",
  ], { cwd: dir });
  const { stdout } = await exec("unzip", ["-Z1", archive]);
  const names = stdout.split("\n").filter(Boolean);
  if (!names.includes("manifest.json") || names.some((name) => name.startsWith("/") || name.includes(".."))) {
    throw new Error(`${archive} 的 manifest.json 不在压缩包根目录`);
  }
}

export async function packageExtensions({ version, root = process.cwd() } = {}) {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const release = version || pkg.version;
  assertVersion(release);
  await exec(process.execPath, ["scripts/build.mjs"], { cwd: root });

  const out = path.join(root, "dist/packages");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const assets = [];

  for (const [browser, ext] of browsers) {
    const dir = path.join(root, "dist", browser);
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = release;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const name = `moon-cookie-storage-${browser}-${release}.${ext}`;
    const archive = path.join(out, name);
    await zipRoot(dir, archive);
    const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
    await writeFile(`${archive}.sha256`, `${hash}  ${name}\n`);
    assets.push(archive);
    console.log(`packaged ${name}`);
  }
  return assets;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageExtensions({ version: process.argv[2] });
}
