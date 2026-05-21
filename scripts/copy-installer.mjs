#!/usr/bin/env node
// electron-builder 산출물 중 현재 package.json 버전만 OneDrive\Developed Apps\YouTube Music\로 복사.
// 옛 빌드 잔재가 dist에 남아 있어도 무시 (혼선 방지).
// Policy: feedback_installer_distribution_path.md
import { readdirSync, copyFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROJECT = "YouTube Music";
const DIST = "dist";
const ONEDRIVE_ROOT = process.env.OneDrive || process.env.ONEDRIVE || join(homedir(), "OneDrive");
const DST = join(ONEDRIVE_ROOT, "Developed Apps", PROJECT);

const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const VERSION_TAG = `-${VERSION}.`;

function shouldCopy(name) {
  // 메타데이터 (auto-updater)
  if (/^latest.*\.yml$/i.test(name)) return true;
  // 현재 버전과 매칭되는 산출물만
  if (!name.includes(VERSION_TAG)) return false;
  return /\.(exe|dmg|zip|blockmap)$/i.test(name);
}

mkdirSync(DST, { recursive: true });

let entries;
try {
  entries = readdirSync(DIST);
} catch {
  console.error(`No ${DIST}/ directory found. Did the build succeed?`);
  process.exit(1);
}

let copied = 0;
for (const name of entries) {
  const src = join(DIST, name);
  let s;
  try {
    s = statSync(src);
  } catch {
    continue;
  }
  if (!s.isFile()) continue;
  if (!shouldCopy(name)) continue;
  copyFileSync(src, join(DST, name));
  console.log(`copied: ${name}`);
  copied++;
}

if (copied === 0) {
  console.warn("No installer artifacts found in dist/.");
  process.exit(1);
}
console.log(`\n→ ${DST} (${copied} file${copied > 1 ? "s" : ""})`);
