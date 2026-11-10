/**
 * Harness Hub 桌面壳(Electron)。
 *
 * 只做三件事, 业务全部留在后端:
 *  1. 拉起包内的 node.exe 跑 dist 后端(数据目录 = <程序目录>\data, 端口随机);
 *  2. 等 /api/health 就绪后开窗口加载它;
 *  3. 关窗口时发 close-intent 让后端自行收敛, 超时才强制结束进程树。
 *
 * 刻意不引任何 npm 依赖: 打包时本文件与 package.json 一起放进 resources/app/,
 * Electron 直接把它当主进程入口。
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// 启动早期就可能崩(原生层), 所以先于 electron 模块写一份 boot 日志, 至少能知道走到哪一步。
const BOOT_LOG = path.join(process.env.HH_APP_ROOT ? path.resolve(process.env.HH_APP_ROOT) : path.dirname(process.execPath), 'data', 'logs', 'boot.log');
function boot(line) {
  try {
    fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
    fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 启动日志写不了也不能影响启动 */
  }
}
boot(`main.js start exe=${process.execPath} electron=${process.versions.electron} runAsNode=${process.env.ELECTRON_RUN_AS_NODE}`);

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
boot('electron module loaded');

const APP_ROOT = process.env.HH_APP_ROOT ? path.resolve(process.env.HH_APP_ROOT) : path.dirname(process.execPath);
const DATA_DIR = path.join(APP_ROOT, 'data');
const NODE_EXE = path.join(APP_ROOT, 'node.exe');
const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'apps', 'server', 'src', 'index.js');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'desktop.log');
const READY_TIMEOUT_MS = 45_000;

let win = null;
let backend = null;
let backendPort = 0;
let shuttingDown = false;
let closing = false;
let forceClose = false;

// Electron 自己的缓存也放进 data, 不在用户 AppData 里留第二份。
// 必须在 app ready 之前设置, 所以放在模块顶层。
app.setPath('userData', path.join(DATA_DIR, 'electron'));
// 崩溃转储同样收进 data: 否则进程崩掉时会在 %LOCALAPPDATA%\CrashDumps 留 .dmp。
try {
  app.setPath('crashDumps', path.join(DATA_DIR, 'electron', 'Crashpad'));
} catch {
  /* 老版本 Electron 没有这个 path, 忽略 */
}
app.commandLine.appendSwitch('disable-crash-reporter');
boot('userData set: ' + path.join(DATA_DIR, 'electron'));

/** 桌面壳自己的日志: 后端起不来时至少有一份现场。 */
function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 日志写不了也不该阻塞启动 */
  }
}

function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** GET /api/health, 800ms 超时; 只用来判断"起来没有", 不解析业务数据。 */
function health(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 800 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等一个已经在跑的后端(上次没关干净时直接复用, 避免双实例抢锁)。 */
async function findRunningBackend() {
  const rt = readRuntime();
  if (!rt || !rt.port) return 0;
  return (await health(rt.port)) ? rt.port : 0;
}

function startBackend() {
  if (!fs.existsSync(NODE_EXE)) throw new Error(`找不到内置运行时: ${NODE_EXE}`);
  if (!fs.existsSync(SERVER_ENTRY)) throw new Error(`找不到后端入口: ${SERVER_ENTRY}`);

  log(`启动后端: ${NODE_EXE} ${SERVER_ENTRY}`);
  backend = spawn(NODE_EXE, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HH_ROOT: APP_ROOT,
      HH_DATA_DIR: DATA_DIR,
      HH_PORT: '0',
      // 后端照常把 close-intent 当"页面要走了": 关窗时页面 unload 会发它, 壳这边再兜底强杀。
      // (不能设 0, 那会把 close-intent 一起禁掉, 壳就只剩硬杀了)
      HH_ERROR_MODE: '1',
    },
  });
  backend.stderr?.on('data', (chunk) => log(`server stderr: ${String(chunk).trimEnd()}`));
  backend.on('error', (err) => log(`server spawn 失败: ${err.message}`));
  backend.on('exit', (code, signal) => {
    log(`server 退出 code=${code} signal=${signal}`);
    backend = null;
    if (!shuttingDown) {
      dialog.showErrorBox('Harness Hub 后端异常退出', `后端进程已结束(code=${code})。\n\n日志: ${LOG_FILE}`);
      void shutdown(1);
    }
  });
}

async function waitForBackend() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rt = readRuntime();
    if (rt && rt.port) {
      if (await health(rt.port)) {
        backendPort = rt.port;
        return backendPort;
      }
    }
    await sleep(250);
  }
  throw new Error(`后端 ${READY_TIMEOUT_MS / 1000}s 内没有就绪。\n\n日志: ${LOG_FILE}`);
}

/** 通知后端优雅退出(会先落库、再结束子进程), 最多等 6s, 不行就杀进程树。 */
async function stopBackend() {
  if (!backend) return;
  const proc = backend;
  if (backendPort) {
    await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: backendPort,
          path: '/api/runtime/close-intent',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          timeout: 1500,
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.on('error', resolve);
      req.end('{}');
    });
  }

  const exited = await Promise.race([
    new Promise((resolve) => proc.once('exit', () => resolve(true))),
    sleep(6000).then(() => false),
  ]);
  if (exited) return;

  log('后端未在 6s 内退出, 强制结束进程树');
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    }
    proc.kill();
  } catch {
    /* 已经退出就算了 */
  }
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stopBackend();
  } finally {
    app.exit(code);
  }
}

/** GET /api/runtime, 800ms 超时; 只取 activeSessions(关窗前确认有没有任务在跑)。 */
function activeSessions(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/runtime', method: 'GET', timeout: 800 },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve(Number(JSON.parse(raw).activeSessions) || 0);
          } catch {
            resolve(0);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

/** 关窗拦截: 有任务在跑就先问一句, 否则直接放行(不弹浏览器那套 beforeunload 提示)。 */
async function handleCloseRequest() {
  if (shuttingDown || closing) return;
  closing = true;
  try {
    const active = backendPort ? await activeSessions(backendPort) : 0;
    if (active > 0) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        title: 'Harness Hub',
        message: `还有 ${active} 个任务在运行`,
        detail: '关闭窗口会中断这些任务(已有进度会保存, 下次启动可以在任务里看到中断记录)。',
        buttons: ['取消', '仍然关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (choice !== 1) return;
    }
    forceClose = true;
    win?.destroy(); // 跳过页面 beforeunload, 由下面的 shutdown 走 close-intent
  } finally {
    closing = false;
  }
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0b0d10',
    title: 'Harness Hub',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => {
    win?.show();
    // 从后台进程(计划任务/脚本)里拉起时, Windows 会把首个窗口按"最小化"处理, 这里纠一次
    if (win?.isMinimized()) win.restore();
    win?.focus();
    log(`窗口已显示: minimized=${win?.isMinimized()} bounds=${JSON.stringify(win?.getBounds())}`);
  });
  win.on('close', (event) => {
    if (shuttingDown || forceClose) return;
    event.preventDefault();
    void handleCloseRequest();
  });
  win.on('closed', () => {
    log('窗口已销毁');
    win = null;
  });
  // 渲染进程崩了/页面加载失败也要留痕, 否则只会看到"窗口没了"
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`渲染进程退出: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    log(`页面加载失败: ${code} ${desc} ${url}`);
  });
  win.webContents.on('unresponsive', () => log('页面无响应'));
  // 页面里的外链走系统浏览器, 不在壳里开新窗口
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  void win.loadURL(url);
}

const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HarnessHub';

/**
 * 安装版(同目录有 Uninstall.exe)才登记「应用和功能」条目; 绿色版(zip 解压)不写任何注册表。
 * 走 32 位注册表视图, 与 NSIS 卸载脚本的 DeleteRegKey 对齐, 卸载时能一起清掉。
 */
function registerUninstallEntry() {
  const uninstaller = path.join(APP_ROOT, 'Uninstall.exe');
  if (!fs.existsSync(uninstaller)) return;

  let version = '0.1.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'resources', 'app', 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch {
    /* 读不到就用默认版本 */
  }

  const values = [
    ['DisplayName', 'Harness Hub'],
    ['DisplayVersion', version],
    ['Publisher', '1hobby'],
    ['InstallLocation', APP_ROOT],
    ['DisplayIcon', path.join(APP_ROOT, 'HarnessHub.exe')],
    ['UninstallString', `"${uninstaller}"`],
    ['QuietUninstallString', `"${uninstaller}" /S`],
    ['NoModify', '1', 'REG_DWORD'],
    ['NoRepair', '1', 'REG_DWORD'],
  ];
  for (const [name, data, type] of values) {
    const res = spawnSync(
      'reg.exe',
      ['add', UNINSTALL_KEY, '/v', name, '/t', type ?? 'REG_SZ', '/d', data, '/f', '/reg:32'],
      { windowsHide: true, stdio: 'ignore' },
    );
    if (res.error || res.status !== 0) {
      log(`写卸载注册表项失败(${name}): ${res.error?.message ?? `exit ${res.status}`}`);
      return;
    }
  }
  log(`已登记卸载信息: ${UNINSTALL_KEY}`);
}

async function main() {
  boot('main() start');
  Menu.setApplicationMenu(null);

  let port = await findRunningBackend();
  if (port) {
    log(`复用已在运行的后端: ${port}`);
  } else {
    startBackend();
    port = await waitForBackend();
  }
  backendPort = port;
  log(`后端就绪: http://127.0.0.1:${port}`);
  createWindow(`http://127.0.0.1:${port}/`);
  try {
    registerUninstallEntry();
  } catch (err) {
    log(`登记卸载信息失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 单实例: 第二次双击只把已有窗口拉到前台
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('window-all-closed', () => {
    void shutdown(0);
  });

  app.whenReady().then(() => {
    main().catch((err) => {
      log(`启动失败: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      dialog.showErrorBox('Harness Hub 启动失败', err instanceof Error ? err.message : String(err));
      void shutdown(1);
    });
  });
}
