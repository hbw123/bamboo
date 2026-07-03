'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pandaBaseDir, sessionsDir, readJsonSafe, deepMerge, aggregateState } = require('./lib/state');
const { installHooks } = require('./lib/install-hooks');

const BASE_DIR = pandaBaseDir();
const SESSIONS_DIR = sessionsDir(BASE_DIR);
const APP_DIR = __dirname;
const BUILTIN_SKINS_DIR = path.join(APP_DIR, 'assets', 'skins');
const USER_SKINS_DIR = path.join(BASE_DIR, 'skins');
const CACHE_DIR = path.join(BASE_DIR, 'cache', 'skins'); // 预处理后的透明/缩放图缓存

// ---------------------------------------------------------------------------
// 配置加载：内置默认值 + 用户可编辑覆盖（深合并）。
// ---------------------------------------------------------------------------
function loadConfig() {
  const def = readJsonSafe(path.join(APP_DIR, 'config', 'config.default.json')) || {};
  const user = readJsonSafe(path.join(BASE_DIR, 'config.json'));
  return user ? deepMerge(def, user) : def;
}

// 把 patch 深合并进用户级 config.json（保留其它字段），用于持久化皮肤选择等。
function updateUserConfig(patch) {
  const p = path.join(BASE_DIR, 'config.json');
  const cur = readJsonSafe(p) || {};
  const next = deepMerge(cur, patch);
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    const tmp = path.join(BASE_DIR, '.config.tmp');
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error('[panda] 写用户配置失败：', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// 皮肤：
// - 内置：app/assets/skins/<名>/
// - 用户：<用户配置目录>/skins/<名>/（Windows: %APPDATA%\PandaPet\skins，
//   macOS: ~/Library/Application Support/PandaPet/skins）
// 用户皮肤同名时覆盖内置皮肤。
// ---------------------------------------------------------------------------

// 状态 → 默认素材文件名。皮肤按这套命名放图即可，无需任何清单文件。
// working 复用 idle 的图，靠程序里的「呼吸」动效区分，不必单独出图。
const DEFAULT_SPRITES = {
  idle: 'idle.png',
  working: 'idle.png',
  waiting: 'waiting.png',
  done: 'done.png',
  sleep: 'sleeping.png',
  daze: 'daze.png',
  night: 'night.png',
};

function listSkins() {
  const names = new Set();
  for (const root of [BUILTIN_SKINS_DIR, USER_SKINS_DIR]) {
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, d.name);
        // 有 idle.png（约定命名）就算一套皮肤；也兼容仍带 manifest.json 的旧皮肤。
        if (fs.existsSync(path.join(dir, 'idle.png')) || fs.existsSync(path.join(dir, 'manifest.json'))) {
          names.add(d.name);
        }
      }
    } catch (_) { /* 用户目录不存在时忽略 */ }
  }
  return [...names].sort();
}

function currentSkin(config) {
  const want = (config && config.skin) || 'default';
  const all = listSkins();
  if (all.includes(want)) return want;
  return all.includes('default') ? 'default' : (all[0] || 'default');
}

function spritesDir(config) {
  const skin = currentSkin(config);
  const userDir = path.join(USER_SKINS_DIR, skin);
  if (fs.existsSync(path.join(userDir, 'idle.png')) || fs.existsSync(path.join(userDir, 'manifest.json'))) {
    return userDir;
  }
  return path.join(BUILTIN_SKINS_DIR, skin);
}

function skinCacheKey(skin, dir) {
  const rel = path.relative(USER_SKINS_DIR, dir);
  const isUserSkin = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return `${isUserSkin ? 'user' : 'builtin'}-${skin}`;
}

// 状态 → 文件名映射：默认走约定命名（DEFAULT_SPRITES）；皮肤目录若放了
// manifest.json（可选，用于改文件名或让多个状态复用同一张图），则以它为准。
function loadSprites(dir) {
  const manifest = readJsonSafe(path.join(dir, 'manifest.json'));
  if (manifest && manifest.sprites) return manifest.sprites;
  return DEFAULT_SPRITES;
}

// 兼容：manifest 里每个状态的值可以是文件名字符串（推荐），也兼容 { file } 对象。
function spriteFile(def) {
  if (typeof def === 'string') return def;
  return def && def.file;
}

// 台词跟角色走：从当前皮肤的 lines.json 读；皮肤没有则不碎念（保持安静，不用错角色的台词）。
function loadLines(config) {
  return readJsonSafe(path.join(spritesDir(config), 'lines.json')) || { daily: [] };
}

// ---------------------------------------------------------------------------
// 启动时自动把采集 hooks 写进用户级 settings.json（幂等、先备份、可关）。
// 免去用户手抠 <绝对路径>：collector.py 路径由此处自动探测。
// ---------------------------------------------------------------------------
function autoInstallHooks(config) {
  if (config.hooks && config.hooks.autoInstall === false) return;
  const configuredSettingsPath = config.hooks && config.hooks.settingsPath;
  const defaultSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settingsPath = configuredSettingsPath
    ? path.resolve(expandHome(configuredSettingsPath))
    : defaultSettingsPath;
  // 打包后 hooks 随包放在 resources/hooks（不进 asar，python 才能执行）；开发时在 ../hooks。
  const collectorPath = app.isPackaged
    ? path.join(process.resourcesPath, 'hooks', 'collector.py')
    : path.join(APP_DIR, '..', 'hooks', 'collector.py');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  try {
    if (!configuredSettingsPath && !fs.existsSync(defaultSettingsPath)) {
      console.warn('[panda] 找不到默认 Claude settings.json，跳过 hooks 自动安装：', defaultSettingsPath);
      showMissingClaudeSettingsHint(defaultSettingsPath);
      return;
    }
    if (!fs.existsSync(collectorPath)) {
      console.warn('[panda] 找不到 collector.py，跳过 hooks 自动安装：', collectorPath);
      return;
    }
    const res = installHooks({ settingsPath, collectorPath, python });
    if (res.action === 'skip') console.log('[panda] hooks 已就位，跳过');
    else console.log(`[panda] hooks ${res.action === 'install' ? '已安装' : '已更新'}（备份：${res.backupPath || '无'}）`);
  } catch (e) {
    console.error('[panda] hooks 自动安装失败（不影响桌宠运行）：', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// 皮肤预处理：启动时另起一个隐藏进程，扫描所有皮肤、把「不合适」的图（白底 / 超大）
// 自动抠底 + 缩放，落盘到缓存；桌宠窗口不受影响。已处理且源未变的跳过。
// 就算此过程整个失败，渲染层加载时仍会即时抠底兜底，不影响使用。
// ---------------------------------------------------------------------------
function skinImageJobs() {
  const jobs = [];
  for (const skin of listSkins()) {
    const dir = spritesDir({ skin });
    const cacheKey = skinCacheKey(skin, dir);
    const files = [...new Set(Object.values(loadSprites(dir)).map(spriteFile).filter(Boolean))];
    const meta = readJsonSafe(path.join(CACHE_DIR, cacheKey, '.meta.json')) || {};
    for (const file of files) {
      let st;
      try { st = fs.statSync(path.join(dir, file)); } catch (_) { continue; }
      const sig = st.size + ':' + Math.round(st.mtimeMs);
      if (meta[file] && meta[file].sig === sig) continue; // 已处理且源未变
      let dataUrl;
      try { dataUrl = 'data:image/png;base64,' + fs.readFileSync(path.join(dir, file)).toString('base64'); } catch (_) { continue; }
      jobs.push({ skin, cacheKey, file, sig, dataUrl });
    }
  }
  return jobs;
}

function preprocessSkins() {
  try {
    const jobs = skinImageJobs();
    if (!jobs.length) return;
    const pw = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(APP_DIR, 'preprocess-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    pw.loadFile(path.join(APP_DIR, 'preprocess.html'));

    let settled = false;
    const cleanup = () => { ipcMain.removeListener('pre:done', onDone); if (!pw.isDestroyed()) pw.destroy(); };
    // 兜底：30s 没完成就收摊，避免隐藏窗口卡住（桌宠仍会即时抠图，不受影响）。
    const guard = setTimeout(() => { if (!settled) { settled = true; cleanup(); } }, 30000);

    const onDone = (_e, results) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      ipcMain.removeListener('pre:done', onDone);
      try {
        for (const r of results || []) {
          if (!r || r.error) continue;
          const skinCache = path.join(CACHE_DIR, r.cacheKey || r.skin);
          fs.mkdirSync(skinCache, { recursive: true });
          if (r.changed && r.dataUrl) {
            const b64 = r.dataUrl.split(',')[1] || '';
            fs.writeFileSync(path.join(skinCache, r.file), Buffer.from(b64, 'base64'));
          } else {
            try { fs.unlinkSync(path.join(skinCache, r.file)); } catch (_) {} // 无需处理 → 清掉旧缓存，用源图
          }
          const metaPath = path.join(skinCache, '.meta.json');
          const meta = readJsonSafe(metaPath) || {};
          const job = jobs.find((j) => j.skin === r.skin && j.file === r.file);
          meta[r.file] = { sig: job ? job.sig : '', changed: !!r.changed };
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        }
      } catch (e) {
        console.error('[panda] 写皮肤缓存失败：', e && e.message);
      }
      if (!pw.isDestroyed()) pw.destroy();
      if (win && !win.isDestroyed() && win.webContents) win.webContents.send('panda:reinit'); // 让桌宠用上缓存
      console.log(`[panda] 皮肤预处理完成，共 ${jobs.length} 张`);
    };
    ipcMain.on('pre:done', onDone);
    pw.webContents.once('did-finish-load', () => pw.webContents.send('pre:jobs', jobs));
  } catch (e) {
    console.error('[panda] 皮肤预处理启动失败（不影响运行）：', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// 窗口 / 托盘
// ---------------------------------------------------------------------------
let win = null;
let tray = null;
let pollTimer = null;
let hooksSettingsWarningShown = false;

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function userConfigPath() {
  return path.join(BASE_DIR, 'config.json');
}

function showMissingClaudeSettingsHint(settingsPath) {
  if (hooksSettingsWarningShown) return;
  hooksSettingsWarningShown = true;
  setTimeout(() => {
    dialog.showMessageBox({
      type: 'warning',
      buttons: ['知道了', '打开配置文件夹'],
      defaultId: 0,
      cancelId: 0,
      title: '找不到 Claude 配置',
      message: '没有找到默认的 Claude Code settings.json',
      detail: [
        `默认查找位置：${settingsPath}`,
        '',
        `如果你的 Claude Code settings.json 在其它位置，请在 PandaPet 配置文件里设置 hooks.settingsPath：`,
        userConfigPath(),
      ].join('\n'),
    }).then((res) => {
      if (res.response === 1) {
        try { fs.mkdirSync(BASE_DIR, { recursive: true }); } catch (_) {}
        shell.openPath(BASE_DIR);
      }
    }).catch(() => {});
  }, 0);
}

function createWindow(config) {
  const w = (config.window && config.window.width) || 200;
  const h = (config.window && config.window.height) || 220;
  const { workArea } = screen.getPrimaryDisplay();
  const margin = 24;

  win = new BrowserWindow({
    width: w,
    height: h,
    x: workArea.x + workArea.width - w - margin,
    y: workArea.y + workArea.height - h - margin,
    frame: false,
    transparent: true,
    resizable: true, // 允许程序化改尺寸（展开会话列表时自适应）；无边框故用户看不到拖拉手柄
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: config.window ? config.window.alwaysOnTop !== false : true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (win.alwaysOnTop || (config.window && config.window.alwaysOnTop !== false)) {
    win.setAlwaysOnTop(true, 'floating');
  }
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));

  // 调试：PANDA_DEBUG=1 npm start 会自动打开 DevTools 看控制台报错
  if (process.env.PANDA_DEBUG) win.webContents.openDevTools({ mode: 'detach' });
}

function switchSkin(name) {
  updateUserConfig({ skin: name }); // 持久化选择
  refreshTrayIcon(); // 托盘图标也跟皮肤走
  // 发消息让渲染层软刷新素材——不用 win.reload()：透明+置顶窗口 reload 在 macOS 上会闪退。
  if (win && !win.isDestroyed() && win.webContents) win.webContents.send('panda:reinit');
}

// 每次打开托盘菜单时重新构建 → 实时重扫皮肤目录（新加的皮肤不用重启即可出现）。
function buildTrayMenu() {
  const config = loadConfig();
  const skins = listSkins();
  const active = currentSkin(config);
  const skinItems = skins.length
    ? skins.map((name) => ({
        label: name, type: 'radio', checked: name === active,
        click: () => { if (name !== active) switchSkin(name); },
      }))
    : [{ label: '（无可用皮肤）', enabled: false }];

  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => { if (win) (win.isVisible() ? win.hide() : win.show()); } },
    { label: '皮肤', submenu: skinItems },
    { label: '打开配置文件夹', click: () => { try { fs.mkdirSync(BASE_DIR, { recursive: true }); } catch (_) {} shell.openPath(BASE_DIR); } },
    { label: '打开皮肤文件夹', click: () => { try { fs.mkdirSync(USER_SKINS_DIR, { recursive: true }); } catch (_) {} shell.openPath(USER_SKINS_DIR); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
}

// 托盘图标跟当前皮肤走：取皮肤的 idle.png；皮肤缺图则回退默认熊猫，再不行给空图。
function trayIcon(config) {
  const candidates = [
    path.join(spritesDir(config), 'idle.png'),
    path.join(BUILTIN_SKINS_DIR, 'default', 'idle.png'), // 无图兜底：默认熊猫
  ];
  let img = nativeImage.createEmpty();
  for (const p of candidates) {
    const c = nativeImage.createFromPath(p);
    if (!c.isEmpty()) { img = c.resize({ width: 18, height: 18 }); break; }
  }
  // macOS 模板图：按菜单栏明暗自适应成单色剪影，白熊猫在浅色菜单栏也看得见。
  if (process.platform === 'darwin' && !img.isEmpty()) img.setTemplateImage(true);
  return img;
}

function buildTray(config) {
  tray = new Tray(trayIcon(config));
  tray.setToolTip('熊猫桌宠');
  // 不用 setContextMenu（那样菜单是静态缓存的）；改为点击时弹出实时构建的菜单。
  tray.on('click', () => tray.popUpContextMenu(buildTrayMenu()));
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
}

// 切皮肤后刷新托盘图标（原来只在启动时建一次，切皮肤不更新）。
function refreshTrayIcon() {
  if (tray && !tray.isDestroyed()) {
    try { tray.setImage(trayIcon(loadConfig())); } catch (_) {}
  }
}

function startPolling(config) {
  const interval = Math.max(200, (config.poll && config.poll.intervalMs) || 800);
  const staleMinutes = (config.poll && config.poll.staleMinutes) || 15;
  const tick = () => {
    const agg = aggregateState(SESSIONS_DIR, staleMinutes);
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('panda:state', agg);
    }
  };
  pollTimer = setInterval(tick, interval);
  tick();
}

// ---------------------------------------------------------------------------
// IPC：渲染层启动时拉取初始化数据（配置、台词、素材绝对路径）
// ---------------------------------------------------------------------------
ipcMain.handle('panda:init', () => {
  const config = loadConfig();
  const lines = loadLines(config);
  const skin = currentSkin(config);
  const dir = spritesDir(config);
  const cacheKey = skinCacheKey(skin, dir);
  const sprites = {};
  for (const [state, def] of Object.entries(loadSprites(dir))) {
    const name = spriteFile(def);
    if (!name) continue;
    // 优先用预处理缓存（已抠底+缩放）；没有则用源图（渲染层会即时抠底兜底）。
    // 以 base64 data URL 送图：渲染层要用 canvas 采样像素，而 file:// 图片画进 canvas
    // 会污染画布、无法 getImageData——data URL 不会。
    const cacheFile = path.join(CACHE_DIR, cacheKey, name);
    const srcFile = path.join(dir, name);
    const file = fs.existsSync(cacheFile) ? cacheFile : srcFile;
    let dataUrl = null;
    try {
      dataUrl = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
    } catch (_) { /* 缺图 → 渲染层显示占位 */ }
    sprites[state] = { dataUrl };
  }
  const sounds = {};
  for (const key of ['onDone', 'onWaiting']) {
    const rel = config.sound && config.sound[key];
    if (rel) {
      const abs = path.isAbsolute(rel) ? rel : path.join(APP_DIR, rel);
      sounds[key] = fs.existsSync(abs) ? abs : null;
    }
  }
  return { config, lines, sprites, sounds };
});

// 自定义拖动：渲染层区分「点击」与「拖动」，拖动时按增量移动窗口。
ipcMain.handle('panda:getPos', () => {
  if (!win || win.isDestroyed()) return { x: 0, y: 0 };
  const [x, y] = win.getPosition();
  return { x, y };
});

ipcMain.on('panda:moveTo', (_e, pos) => {
  if (!win || win.isDestroyed() || !pos) return;
  win.setPosition(Math.round(pos.x), Math.round(pos.y));
});

// 展开/收起会话列表时，按内容自适应窗口尺寸，保持右下角锚点不动。
ipcMain.on('panda:setSize', (_e, size) => {
  if (!win || win.isDestroyed() || !size) return;
  const b = win.getBounds();
  const right = b.x + b.width;
  const bottom = b.y + b.height;
  const width = Math.max(120, Math.round(size.width));
  const height = Math.max(120, Math.round(size.height));
  win.setBounds({ x: Math.round(right - width), y: Math.round(bottom - height), width, height });
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  const config = loadConfig();
  autoInstallHooks(config);
  if (process.platform === 'darwin' && app.dock) app.dock.hide(); // 菜单栏应用，不占 Dock
  createWindow(config);
  buildTray(config);
  startPolling(config);
  preprocessSkins(); // 后台预处理皮肤素材（非阻塞）
});

app.on('window-all-closed', () => {
  // 桌宠隐藏到托盘即可，不随窗口关闭退出（除非显式退出）
});

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
});
