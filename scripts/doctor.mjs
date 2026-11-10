#!/usr/bin/env node
/**
 * 产物体检。默认只读, 报告 `.local` 下各项占用和可回收项。
 *
 *   node scripts/doctor.mjs               只报告
 *   node scripts/doctor.mjs --clean       清理测试库 / 过期诊断 / 孤儿 mock home
 *   node scripts/doctor.mjs --clean --tmp 连同 7 天前的 tmp 一起清
 *
 * 设计约束: 只动本项目 `.local` 内的生成物; 真实 home 快照、归档、截图默认不删。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const root = process.cwd();
const local = path.join(root, '.local');
const args = new Set(process.argv.slice(2));
const clean = args.has('--clean');
const includeTmp = args.has('--tmp');
const asJson = args.has('--json');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function dirSize(p) {
  let bytes = 0;
  let files = 0;
  const stack = [p];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(child);
      else {
        try {
          bytes += statSync(child).size;
          files += 1;
        } catch {
          /* 被占用/已删除 */
        }
      }
    }
  }
  return { bytes, files };
}

function listDirs(p) {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function listFiles(p) {
  try {
    return readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 从主库读出当前执行配置 id, 用来判断哪些私有 home 已经没人引用。 */
function profileIds() {
  const dbPath = path.join(local, 'data', 'harness-hub.db');
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return new Set(db.prepare('SELECT id FROM profiles').all().map((r) => String(r.id)));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

const report = { root, dirs: {}, data: {}, homes: {}, runs: {}, tmp: {}, cleaned: [] };

if (!existsSync(local)) {
  console.log(`没有 ${local}, 不需要体检。`);
  process.exit(0);
}

for (const name of ['data', 'homes', 'runs', 'tmp', 'logs', 'archive', 'screenshots']) {
  const p = path.join(local, name);
  if (!existsSync(p)) continue;
  report.dirs[name] = dirSize(p);
}

/* --- 测试库: 每次 npm test 留下的 hb-<pid>.db --- */
const dataDir = path.join(local, 'data');
const testDbs = listFiles(dataDir).filter((f) => /^hb-\d+\.db(-wal|-shm)?$/.test(f));
let testDbBytes = 0;
for (const f of testDbs) {
  try {
    testDbBytes += statSync(path.join(dataDir, f)).size;
  } catch {
    /* ignore */
  }
}
report.data.testDbFiles = testDbs.length;
report.data.testDbBytes = testDbBytes;

/* --- 私有 home: 判断孤儿 --- */
const homesDir = path.join(local, 'homes');
const ids = profileIds();
const homes = listDirs(homesDir);
const orphans = [];
const mockOrphans = [];
for (const name of homes) {
  const m = /^[a-z]+-(.+)$/.exec(name);
  const profileId = m ? m[1] : name;
  if (ids === null || ids.has(profileId)) continue;
  orphans.push(name);
  if (/^mock/.test(profileId)) mockOrphans.push(name);
}
report.homes.total = homes.length;
report.homes.orphans = orphans;
report.homes.mockOrphans = mockOrphans;
report.homes.knownProfiles = ids === null ? null : ids.size;

/* --- 诊断目录: 每个 attempt 一份, 超过 14 天的可以清 --- */
const runsDir = path.join(local, 'runs');
const runTasks = listDirs(runsDir);
let runDirs = 0;
let runOld = 0;
for (const task of runTasks) {
  for (const attempt of listDirs(path.join(runsDir, task))) {
    runDirs += 1;
    try {
      const st = statSync(path.join(runsDir, task, attempt));
      if (now - st.mtimeMs > 14 * DAY) runOld += 1;
    } catch {
      /* ignore */
    }
  }
}
report.runs.attemptDirs = runDirs;
report.runs.olderThan14d = runOld;

/* --- tmp: 历史上是最大的一块, 只统计, 需要 --tmp 才清 --- */
const tmpDir = path.join(local, 'tmp');
let tmpEntries = 0;
try {
  tmpEntries = readdirSync(tmpDir).length;
} catch {
  tmpEntries = 0;
}
let tmpOldEntries = 0;
try {
  for (const e of readdirSync(tmpDir, { withFileTypes: true })) {
    try {
      if (now - statSync(path.join(tmpDir, e.name)).mtimeMs > 7 * DAY) tmpOldEntries += 1;
    } catch {
      /* ignore */
    }
  }
} catch {
  /* 没有 tmp 目录 */
}
report.tmp.entries = tmpEntries;
report.tmp.olderThan7d = tmpOldEntries;

/* --- 清理 --- */
if (clean) {
  for (const f of testDbs) {
    try {
      rmSync(path.join(dataDir, f), { force: true });
      report.cleaned.push(f);
    } catch {
      /* 占用中 */
    }
  }
  for (const name of mockOrphans) {
    try {
      rmSync(path.join(homesDir, name), { recursive: true, force: true });
      report.cleaned.push(`homes/${name}`);
    } catch {
      /* ignore */
    }
  }
  for (const task of runTasks) {
    for (const attempt of listDirs(path.join(runsDir, task))) {
      const p = path.join(runsDir, task, attempt);
      try {
        if (now - statSync(p).mtimeMs > 14 * DAY) {
          rmSync(p, { recursive: true, force: true });
          report.cleaned.push(`runs/${task}/${attempt}`);
        }
      } catch {
        /* ignore */
      }
    }
    try {
      if (readdirSync(path.join(runsDir, task)).length === 0) rmSync(path.join(runsDir, task), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  if (includeTmp) {
    for (const e of readdirSync(tmpDir, { withFileTypes: true })) {
      const p = path.join(tmpDir, e.name);
      try {
        if (now - statSync(p).mtimeMs > 7 * DAY) {
          rmSync(p, { recursive: true, force: true });
          report.cleaned.push(`tmp/${e.name}`);
        }
      } catch {
        /* ignore */
      }
    }
  }
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const totalBytes = Object.values(report.dirs).reduce((a, d) => a + d.bytes, 0);
const totalFiles = Object.values(report.dirs).reduce((a, d) => a + d.files, 0);
console.log(`Harness Hub 产物体检  ${root}`);
console.log(`合计 ${mb(totalBytes)} / ${totalFiles} 个文件`);
for (const [name, d] of Object.entries(report.dirs)) {
  console.log(`  ${name.padEnd(12)} ${mb(d.bytes).padStart(10)}  ${String(d.files).padStart(7)} 文件`);
}
console.log('');
console.log(`测试库 hb-*.db       ${testDbs.length} 个, ${mb(testDbBytes)}${testDbs.length ? '  (npm run doctor -- --clean 可清)' : ''}`);
console.log(`私有 home            ${homes.length} 个, 未知配置 ${orphans.length} 个 (其中 mock ${mockOrphans.length} 个)`);
console.log(`诊断目录             ${runDirs} 个 attempt, 14 天前 ${runOld} 个`);
console.log(`临时目录 tmp         ${report.tmp.entries} 项, 7 天前 ${tmpOldEntries} 项`);
if (clean) {
  console.log('');
  console.log(`已清理 ${report.cleaned.length} 项${includeTmp ? '' : ' (未含 tmp, 需要时加 --tmp)'}`);
  for (const c of report.cleaned.slice(0, 20)) console.log(`  - ${c}`);
  if (report.cleaned.length > 20) console.log(`  ... 其余 ${report.cleaned.length - 20} 项`);
}
