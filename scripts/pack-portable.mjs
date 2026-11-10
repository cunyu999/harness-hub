#!/usr/bin/env node
/**
 * 打一个"双击就能跑"的 Windows 便携包。
 *
 * 产物目录默认 D:\1hobby\HarnessHub(可用 HH_PACK_DIR 覆盖), 自带:
 *   node.exe                 运行时(用户机器不用装 Node)
 *   dist/                    后端与 packages 的编译产物
 *   apps/web/dist/           前端静态文件
 *   node_modules/            仅生产依赖(从当前安装裁剪, 不重新下载)
 *   scripts/start.ps1        关掉硬错误弹窗后再拉起 node
 *   HarnessHub.exe           启动器(系统 csc 现编的小 WinExe, 带 --no-sandbox 拉起内核)
 *   HarnessHubCore.exe       Electron 内核(从本机 electron 缓存解压, 不联网)
 *   resources/app/           桌面壳主进程(main.js)
 *   HarnessHub-Edge.vbs      备用启动器: 起服务后用 Edge 应用窗口打开
 *   data/                    运行时数据(数据库/私有 home/工作区/日志), 重打包时保留
 *
 * 用法: npm run pack [-- --skip-build] [-- --no-electron] [-- --zip] [-- --zip-only]
 *       [-- --installer] [-- --sign=<证书指纹>]
 *   --no-electron 只打 Edge 版(体积小, 但窗口是浏览器的)
 *   --zip         打完再压一个 zip 到 release/(不含 data/, 方便发给别人)
 *   --zip-only    不重新打包, 只把现有目录压成 zip
 *   --installer   再编一个 NSIS 安装器到 release/(需要 makensis, 见 findMakensis)
 *   --sign=<指纹> 用 CurrentUser\My 里的证书签 HarnessHub.exe / HarnessHubCore.exe / 安装器
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const wantElectron = !args.has('--no-electron');
const wantZip = args.has('--zip');
const zipOnly = args.has('--zip-only');
const wantInstaller = args.has('--installer');
const signArg = process.argv.slice(2).find((a) => a.startsWith('--sign='));
const signThumb = signArg ? signArg.slice('--sign='.length).trim() : '';
const outDir = process.env.HH_PACK_DIR ? path.resolve(process.env.HH_PACK_DIR) : path.join(root, 'HarnessHub');

/** 从 electron 的下载缓存里找最新的 win32-x64 包: 离线可用, 不联网。 */
function findElectronZip() {
  if (process.env.HH_ELECTRON_ZIP) {
    const zip = path.resolve(process.env.HH_ELECTRON_ZIP);
    return existsSync(zip) ? zip : null;
  }
  const cacheRoot = path.join(process.env.LOCALAPPDATA ?? '', 'electron', 'Cache');
  if (!existsSync(cacheRoot)) return null;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/^electron-v\d+\.\d+\.\d+-win32-x64\.zip$/.test(entry.name)) found.push(full);
    }
  };
  walk(cacheRoot, 0);
  if (found.length === 0) return null;
  const versionOf = (file) => path.basename(file).match(/electron-v([\d.]+)-/)[1].split('.').map(Number);
  found.sort((a, b) => {
    const av = versionOf(a);
    const bv = versionOf(b);
    for (let i = 0; i < 3; i += 1) if (av[i] !== bv[i]) return bv[i] - av[i];
    return 0;
  });
  return found[0];
}

function log(message) {
  process.stdout.write(`[pack] ${message}\n`);
}

/**
 * 目标目录里的 Harness Hub 是否还在跑: 读 data\runtime.json 的端口, 再探 /api/health。
 * 只看到 runtime.json 不算数——上次异常退出会留下过期文件。
 */
async function runningPort() {
  const runtimeFile = path.join(outDir, 'data', 'runtime.json');
  if (!existsSync(runtimeFile)) return 0;
  let port = 0;
  try {
    port = Number(JSON.parse(readFileSync(runtimeFile, 'utf8')).port) || 0;
  } catch {
    return 0;
  }
  if (!(port > 0)) return 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? port : 0;
  } catch {
    return 0;
  }
}

/** 把程序目录压成 zip(排除 data/, 免得把本机的任务/凭据发给别人)。 */
function makeZip() {
  const releaseDir = path.join(root, 'release');
  mkdirSync(releaseDir, { recursive: true });
  const zipPath = path.join(releaseDir, `HarnessHub-${pkg.version}-win-x64.zip`);
  rmSync(zipPath, { force: true });
  const entries = readdirSync(outDir).filter((name) => name !== 'data');
  log(`压缩: ${zipPath}(排除 data/)`);
  const res = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', outDir, ...entries], { stdio: 'inherit' });
  if (res.error) {
    log(`压缩失败: ${res.error.message} (Windows 10+ 自带 tar.exe)`);
    process.exit(1);
  }
  if (res.status !== 0) {
    log(`压缩失败: tar 退出码 ${res.status}`);
    process.exit(1);
  }
  log(`zip 完成: ${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB -> ${zipPath}`);
  const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha}  ${path.basename(zipPath)}\r\n`, 'utf8');
  log(`sha256: ${sha}`);
  return zipPath;
}

/** 用证书签名一个 exe(自签名证书的链不受信任是正常的, 签名本身仍会写进文件)。 */
function signFile(file, thumbprint) {
  if (!existsSync(file)) {
    log(`跳过签名(文件不存在): ${file}`);
    return;
  }
  const ps = [
    `$cert = Get-ChildItem Cert:\\CurrentUser\\My | Where-Object { $_.Thumbprint -eq '${thumbprint}' };`,
    `if (-not $cert) { Write-Error '找不到证书 ${thumbprint}'; exit 2 };`,
    `$r = Set-AuthenticodeSignature -FilePath '${file}' -Certificate $cert -HashAlgorithm SHA256;`,
    `Write-Output $r.Status`,
  ].join(' ');
  const res = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  const status = (res.stdout ?? '').trim();
  if (res.status !== 0) {
    console.error(`[pack] 签名失败: ${file} -> ${(res.stderr ?? '').trim() || status}`);
    process.exit(1);
  }
  log(`已签名: ${path.basename(file)} (${status})`);
}

/** 找 makensis: 环境变量 HH_MAKENSIS > 项目内便携 NSIS > PATH。 */
function findMakensis() {
  if (process.env.HH_MAKENSIS) {
    return existsSync(process.env.HH_MAKENSIS) ? process.env.HH_MAKENSIS : null;
  }
  const base = path.join(root, '.local', 'tools', 'nsis');
  if (existsSync(base)) {
    for (const dir of readdirSync(base)) {
      const exe = path.join(base, dir, 'Bin', 'makensis.exe');
      if (existsSync(exe)) return exe;
    }
  }
  const res = spawnSync('where', ['makensis'], { encoding: 'utf8' });
  const found = (res.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return found[0] ?? null;
}

/** 用 NSIS 编一个 per-user 安装器到 release/。 */
function buildInstaller() {
  const makensis = findMakensis();
  if (!makensis) {
    console.error('[pack] 找不到 makensis: 把 NSIS 便携版解压到 .local/tools/nsis, 或设 HH_MAKENSIS 指向 makensis.exe');
    process.exit(1);
  }
  const releaseDir = path.join(root, 'release');
  mkdirSync(releaseDir, { recursive: true });
  const setup = path.join(releaseDir, `HarnessHub-${pkg.version}-win-x64-setup.exe`);
  rmSync(setup, { force: true });
  // makensis 是 32 位程序; 默认临时目录在 C: 时编 300 MB 级负载会 "error creating mmap",
  // 把 TEMP 指到项目内就正常了。
  const tmp = path.join(root, '.local', 'tmp', 'nsis-tmp');
  mkdirSync(tmp, { recursive: true });
  // NSIS 只认 UTF-8 BOM; edit 之类工具写文件会去 BOM, 每次编译前补齐。
  const nsiPath = path.join(root, 'scripts', 'installer.nsi');
  const nsiText = readFileSync(nsiPath, 'utf8');
  if (!nsiText.startsWith('\uFEFF')) writeFileSync(nsiPath, `\uFEFF${nsiText}`, 'utf8');
  log(`编安装器: ${path.basename(setup)}`);
  const res = spawnSync(
    makensis,
    ['/V2', `/DPKG_DIR=${outDir}`, `/DOUT_FILE=${setup}`, `/DAPP_VERSION=${pkg.version}`, nsiPath],
    { stdio: 'inherit', env: { ...process.env, TEMP: tmp, TMP: tmp } },
  );
  if (res.error || res.status !== 0) {
    console.error(`[pack] 安装器编译失败: ${res.error?.message ?? `makensis exit ${res.status}`}`);
    process.exit(1);
  }
  log(`安装器: ${setup}(${(statSync(setup).size / 1024 / 1024).toFixed(1)} MB)`);
  return setup;}

if (zipOnly) {
  if (!existsSync(outDir)) {
    log(`目录不存在: ${outDir}, 先跑 npm run pack`);
    process.exit(1);
  }
  const port = await runningPort();
  if (port > 0) {
    log(`${outDir} 里的 Harness Hub 还在运行(端口 ${port}), 请先关掉窗口再压缩。`);
    process.exit(1);
  }
  makeZip();
  process.exit(0);
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) {
    console.error(`[pack] 命令失败: ${command} ${argv.join(' ')} (exit ${result.status ?? result.signal})`);
    process.exit(1);
  }
}

function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          /* 符号链接/占用文件忽略 */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

// 1) 构建。后端 typecheck 已由 build:server 覆盖; 前端由 vite 产出。
if (!skipBuild) {
  log('构建后端与前端...');
  run('npm', ['run', 'build']);
}
for (const required of ['dist/apps/server/src/index.js', 'apps/web/dist/index.html', 'scripts/start.ps1']) {
  if (!existsSync(path.join(root, required))) {
    console.error(`[pack] 缺少 ${required}, 请先 npm run build`);
    process.exit(1);
  }
}

// 2) 目标目录里如果还有便携版在跑, 先停下: 删运行中的程序文件/数据库会报 EPERM,
//    也会把用户正在用的任务打断。判断依据是 data\runtime.json + /api/health。
const livePort = await runningPort();
if (livePort > 0) {
  console.error(`[pack] ${outDir} 里的 Harness Hub 还在运行(端口 ${livePort}), 请先关掉窗口再打包。`);
  process.exit(1);
}

// 3) 准备输出目录。只清程序文件, data/ 是用户数据, 必须留着。
mkdirSync(outDir, { recursive: true });
for (const entry of readdirSync(outDir)) {
  if (entry === 'data') continue;
  try {
    rmSync(path.join(outDir, entry), { recursive: true, force: true });
  } catch (err) {
    console.error(`[pack] 清理 ${entry} 失败(${err.code ?? err.message}): 可能有进程还占着它, 关掉 Harness Hub 窗口后重试。`);
    process.exit(1);
  }
}
log(`输出目录: ${outDir}`);

// 4) 复制编译产物与前端静态文件。
cpSync(path.join(root, 'dist'), path.join(outDir, 'dist'), {
  recursive: true,
  filter: (src) => {
    // 不打包测试, 也不打包测试运行留下的 .local 残留
    if (src.split(path.sep).includes('.local')) return false;
    return !src.includes(`${path.sep}tests${path.sep}`) && !src.endsWith(`${path.sep}tests`);
  },
});
mkdirSync(path.join(outDir, 'apps', 'web'), { recursive: true });
cpSync(path.join(root, 'apps', 'web', 'dist'), path.join(outDir, 'apps', 'web', 'dist'), { recursive: true });
mkdirSync(path.join(outDir, 'scripts'), { recursive: true });
cpSync(path.join(root, 'scripts', 'start.ps1'), path.join(outDir, 'scripts', 'start.ps1'));

// 4) 运行时与 package.json。node.exe 直接从当前解释器复制, 版本与开发时完全一致。
cpSync(process.execPath, path.join(outDir, 'node.exe'));
writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'harness-hub',
      version: pkg.version,
      private: true,
      type: 'module',
      description: '多 Harness 统一调度系统(便携版)',
      main: 'dist/apps/server/src/index.js',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

// 5) 生产依赖: 让 npm 按当前 node_modules 列出运行时会用到的包(含传递依赖),
//    然后原样复制。@hh/* 是 workspace 包, 已经编译进 dist, 跳过。
log('复制生产依赖(不重新下载)...');
const listed = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const nodeModulesPrefix = path.join(root, 'node_modules') + path.sep;
const deps = (listed.stdout ?? '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith(nodeModulesPrefix));
if (deps.length === 0) {
  console.error('[pack] 没有解析到生产依赖, 请先 npm install');
  process.exit(1);
}
for (const dep of deps) {
  const relative = path.relative(root, dep);
  const target = path.join(outDir, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(dep, target, { recursive: true, dereference: true });
}
log(`生产依赖条目: ${deps.length}`);

// 6) Electron 桌面壳。不重新下载: 直接用本机 electron 缓存里的 win32-x64 zip 解压,
//    再把 apps/desktop 放进 resources/app(main.js 自己拉起包内 node.exe)。
let desktopExe = false;
if (wantElectron) {
  const zip = findElectronZip();
  const desktopMain = path.join(root, 'apps', 'desktop', 'main.js');
  if (!zip) {
    log('未找到 electron 缓存(HH_ELECTRON_ZIP 或 %LOCALAPPDATA%\\electron\\Cache), 跳过桌面壳, 只保留 Edge 启动器');
  } else if (!existsSync(desktopMain)) {
    console.error('[pack] 缺少 apps/desktop/main.js');
    process.exit(1);
  } else {
    log(`解压 Electron 运行时 ${path.basename(zip)} ...`);
    const extracted = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NoLogo',
        '-Command',
        `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${outDir.replaceAll("'", "''")}' -Force`,
      ],
      { cwd: root, stdio: 'inherit' },
    );
    if (extracted.status !== 0) {
      console.error('[pack] 解压 Electron 失败, 请检查磁盘空间或改用 --no-electron');
      process.exit(1);
    }
    const electronExe = path.join(outDir, 'electron.exe');
    if (!existsSync(electronExe)) {
      console.error('[pack] 解压后没有 electron.exe, zip 可能不完整');
      process.exit(1);
    }
    const coreExe = path.join(outDir, 'HarnessHubCore.exe');
    cpSync(electronExe, coreExe);
    rmSync(electronExe, { force: true });
    rmSync(path.join(outDir, 'resources', 'default_app.asar'), { force: true });
    mkdirSync(path.join(outDir, 'resources', 'app'), { recursive: true });
    cpSync(desktopMain, path.join(outDir, 'resources', 'app', 'main.js'));
    cpSync(path.join(root, 'apps', 'desktop', 'package.json'), path.join(outDir, 'resources', 'app', 'package.json'));

    // 图标: icon.png 给 BrowserWindow, icon.ico 给启动器/内核/安装器。
    const iconPng = path.join(root, 'apps', 'desktop', 'assets', 'icon.png');
    const iconIco = path.join(root, 'apps', 'desktop', 'assets', 'icon.ico');
    if (!existsSync(iconIco)) log('缺少 apps/desktop/assets/icon.ico, 可先运行 node scripts/make-icon.mjs');
    if (existsSync(iconPng)) cpSync(iconPng, path.join(outDir, 'resources', 'app', 'icon.png'));

    // 启动器: 双击 exe 带不了 --no-sandbox, 所以用系统自带的 .NET Framework csc 现编一个
    // 小的 WinExe 当门面(它顺手设 SetErrorMode + HH_ERROR_MODE)。没有 csc 就退回裸内核。
    const launcherSrc = path.join(root, 'apps', 'desktop', 'launcher.cs');
    const cscCandidates = [
      path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ];
    const csc = cscCandidates.find((file) => existsSync(file));
    let launcherOk = false;
    if (csc && existsSync(launcherSrc)) {
      log('编译启动器 HarnessHub.exe ...');
      const launcherArgs = [
        '/nologo',
        '/codepage:65001',
        '/target:winexe',
        '/platform:anycpu',
        `/out:${path.join(outDir, 'HarnessHub.exe')}`,
      ];
      if (existsSync(iconIco)) launcherArgs.push(`/win32icon:${iconIco}`);
      launcherArgs.push(launcherSrc);
      const built = spawnSync(csc, launcherArgs, { cwd: root, stdio: 'inherit' });
      launcherOk = built.status === 0 && existsSync(path.join(outDir, 'HarnessHub.exe'));
    }
    if (!launcherOk) {
      log('未找到 csc 或编译失败, 退回直接以 HarnessHubCore.exe 为主程序(沙箱敏感环境可能起不来)');
      cpSync(coreExe, path.join(outDir, 'HarnessHub.exe'));
    }
    desktopExe = true;
    log(`桌面壳: HarnessHub.exe(启动器) + HarnessHubCore.exe + resources/app (Electron ${path.basename(zip).match(/electron-v([\d.]+)-/)?.[1] ?? '?'})`);
  }
}


// 6) 启动器。VBScript 用 WScript 隐藏起服务, 再开 Edge 的 --app 窗口;
//    没有 Edge 就退回默认浏览器, 至少保证能用。
const vbs = `' Harness Hub portable launcher.
' Starts the backend hidden (via scripts\\start.ps1), waits for data\\runtime.json + /api/health,
' then opens the UI as an Edge app window. Double-click this file to start.
Option Explicit

Dim fso, sh, base, nodeExe, entry, dataDir, runtimeFile, port, i, ps1, url

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
dataDir = base & "\\data"
runtimeFile = dataDir & "\\runtime.json"
nodeExe = base & "\\node.exe"
entry = base & "\\dist\\apps\\server\\src\\index.js"
ps1 = base & "\\scripts\\start.ps1"

If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir

If fso.FileExists(runtimeFile) Then
  port = ReadPort(runtimeFile)
  If port > 0 Then
    If IsHealthy(port) Then
      OpenWindow port
      WScript.Quit 0
    End If
  End If
End If

If Not fso.FileExists(nodeExe) Or Not fso.FileExists(entry) Then
  MsgBox "HarnessHub package is incomplete: node.exe or server bundle is missing.", 16, "Harness Hub"
  WScript.Quit 1
End If

' 用 start.ps1 启动: 它先关掉 Windows 硬错误弹窗, 再跑 node。
sh.Environment("PROCESS")("HH_ROOT") = base
sh.Environment("PROCESS")("HH_DATA_DIR") = dataDir
sh.Environment("PROCESS")("HH_PORT") = "0"
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False

For i = 1 To 150
  WScript.Sleep 200
  If fso.FileExists(runtimeFile) Then
    port = ReadPort(runtimeFile)
    If port > 0 Then
      If IsHealthy(port) Then
        OpenWindow port
        WScript.Quit 0
      End If
    End If
  End If
Next

MsgBox "Harness Hub backend did not start within 30 seconds." & vbCrLf & vbCrLf & _
      "Run the following command in this folder to see the error:" & vbCrLf & _
      "  node dist\\apps\\server\\src\\index.js", 48, "Harness Hub"
WScript.Quit 1

Function ReadPort(file)
  Dim f, text, re, matches
  ReadPort = 0
  On Error Resume Next
  Set f = fso.OpenTextFile(file, 1)
  text = f.ReadAll
  f.Close
  Set re = New RegExp
  re.Pattern = """port""\\s*:\\s*(\\d+)"
  Set matches = re.Execute(text)
  If matches.Count > 0 Then ReadPort = CLng(matches(0).SubMatches(0))
  On Error GoTo 0
End Function

Function IsHealthy(port)
  Dim xhr
  IsHealthy = False
  On Error Resume Next
  Set xhr = CreateObject("MSXML2.XMLHTTP")
  xhr.Open "GET", "http://127.0.0.1:" & port & "/api/health", False
  xhr.Send
  If Err.Number = 0 And xhr.Status = 200 Then IsHealthy = True
  On Error GoTo 0
End Function

Sub OpenWindow(port)
  Dim edge
  url = "http://127.0.0.1:" & port & "/"
  edge = EdgePath()
  If edge <> "" Then
    sh.Run """" & edge & """ --app=" & url & " --window-size=1440,900 --window-position=60,40", 1, False
  Else
    sh.Run url, 1, False
  End If
End Sub

Function EdgePath()
  Dim candidate
  EdgePath = ""
  candidate = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe")
  If fso.FileExists(candidate) Then
    EdgePath = candidate
    Exit Function
  End If
  candidate = sh.ExpandEnvironmentStrings("%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe")
  If fso.FileExists(candidate) Then EdgePath = candidate
End Function
`;
writeFileSync(path.join(outDir, 'HarnessHub-Edge.vbs'), vbs, 'ascii');

// 7) 使用说明。
writeFileSync(
  path.join(outDir, 'README.txt'),
  [
    'Harness Hub 便携版',
    '',
    desktopExe
      ? '启动: 双击 HarnessHub.exe'
      : '启动: 双击 HarnessHub-Edge.vbs',
    desktopExe
      ? '  桌面壳会先在后台拉起服务(不弹黑框), 端口就绪后开窗口; 关窗口即退出并落盘。'
      : '  它会在后台启动服务(不弹黑框), 等端口就绪后用 Edge 的应用窗口打开界面。',
    desktopExe
      ? '  万一桌面壳起不来, 可以双击 HarnessHub-Edge.vbs 用 Edge 窗口打开(同一个后端与数据)。'
      : '  关闭窗口后约 2.5 秒, 后台服务会自动退出; 数据已经落盘。',
    '',
    '数据目录: data\\',
    '  数据库 data\\harness-hub.db; 私有 home 在 data\\homes; 工作区与诊断日志在 data\\runs。',
    '  升级版本时只替换程序文件, 保留 data\\ 即可继续用原来的任务与配置。',
    '  端口是自动分配的, 实际地址记在 data\\runtime.json(服务退出时会删掉)。',
    desktopExe ? '  桌面壳自己的日志在 data\\logs\\desktop.log。' : '',
    '',
    '依赖: 本机已安装并登录的 codex / claude / dsh。程序只调用它们, 不复制认证。',
    '  如果双击后没反应, 在本目录执行下面命令看报错:',
    '    node dist\\apps\\server\\src\\index.js',
    '',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\r\n'),
  'utf8',
);

// 8) 图标/版本信息 -> 签名(可选) -> 安装器 -> 汇总 -> 打包。
// Electron 内核是现成二进制, 用 rcedit 改图标与版本串; 没有 rcedit 就跳过(不致命)。
const rcedit = [process.env.HH_RCEDIT, path.join(root, '.local', 'tools', 'rcedit', 'rcedit-x64.exe')]
  .filter(Boolean)
  .find((file) => existsSync(file));
const iconIcoPath = path.join(root, 'apps', 'desktop', 'assets', 'icon.ico');
if (desktopExe && rcedit && existsSync(iconIcoPath)) {
  for (const exe of ['HarnessHubCore.exe', 'HarnessHub.exe']) {
    const res = spawnSync(
      rcedit,
      [
        path.join(outDir, exe),
        '--set-icon', iconIcoPath,
        '--set-file-version', pkg.version,
        '--set-product-version', pkg.version,
        '--set-version-string', 'FileDescription', 'Harness Hub',
        '--set-version-string', 'ProductName', 'Harness Hub',
        '--set-version-string', 'CompanyName', 'Harness Hub',
        '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 Harness Hub',
      ],
      { stdio: 'ignore' },
    );
    if (res.status !== 0) log(`rcedit 处理 ${exe} 失败(exit ${res.status}), 图标可能仍是 Electron 默认`);
  }
} else if (desktopExe) {
  log('没有 rcedit, 内核 exe 的图标保持 Electron 默认(启动器仍有图标)');
}

if (signThumb) {
  signFile(path.join(outDir, 'HarnessHub.exe'), signThumb);
  signFile(path.join(outDir, 'HarnessHubCore.exe'), signThumb);
}
if (wantInstaller) {
  const setup = buildInstaller();
  if (signThumb) signFile(setup, signThumb);
  const setupSha = createHash('sha256').update(readFileSync(setup)).digest('hex');
  writeFileSync(`${setup}.sha256`, `${setupSha}  ${path.basename(setup)}\r\n`, 'utf8');
  log(`安装器 sha256: ${setupSha}`);
}
// 汇总时只看程序文件: data/ 是用户数据(可能很大), 不该混进"包体积"。
const total = dirSize(outDir);
const programBytes = readdirSync(outDir)
  .filter((name) => name !== 'data')
  .reduce((sum, name) => {
    const full = path.join(outDir, name);
    return sum + (statSync(full).isDirectory() ? dirSize(full).bytes : statSync(full).size);
  }, 0);
log(`完成: ${(programBytes / 1024 / 1024).toFixed(1)} MB 程序文件(${total.files} 个文件含 data)`);
log(`双击 ${path.join(outDir, desktopExe ? 'HarnessHub.exe' : 'HarnessHub-Edge.vbs')} 启动`);
if (wantZip) makeZip();
