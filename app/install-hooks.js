'use strict';

// 把采集 hooks 幂等地写进 Claude Code 的 settings.json：
// 自动探测 collector.py 绝对路径、合并不覆盖其它键与已有 hooks、改动前备份、
// 已写入且一致则跳过。纯 fs，便于单测。

const fs = require('fs');
const path = require('path');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];

// 识别「我们这套」hook 条目：命令里带 collector.py，且以我们的事件名结尾。
const OURS_RE = /collector\.py['"]?\s+(SessionStart|UserPromptSubmit|Notification|Stop|SessionEnd)\b/;

function desiredCommand(python, collectorPath, event) {
  // 给路径加引号：打包后装在「/Applications/Panda Pet.app/…」这类带空格的路径下，
  // 不加引号会被 shell 按空格拆断。
  return `${python} "${collectorPath}" ${event}`;
}

// 计算需要的 settings（不落盘）。返回 { settings, changed }。
function computeSettings(existing, collectorPath, python) {
  const settings = existing && typeof existing === 'object' ? existing : {};
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  let changed = false;

  for (const event of EVENTS) {
    const want = desiredCommand(python, collectorPath, event);
    let arr = settings.hooks[event];
    if (!Array.isArray(arr)) { arr = []; settings.hooks[event] = arr; }

    // 在该事件下找我们的条目
    let ours = null;
    for (const group of arr) {
      if (!group || !Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) {
        if (h && typeof h.command === 'string' && OURS_RE.test(h.command)) { ours = h; break; }
      }
      if (ours) break;
    }

    if (ours) {
      if (ours.command !== want) { ours.command = want; changed = true; } // 路径变了→就地更新
    } else {
      arr.push({ matcher: '*', hooks: [{ type: 'command', command: want, timeout: 5 }] });
      changed = true;
    }
  }

  return { settings, changed };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return null; }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.settings.panda.tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

// 时间戳（可注入，便于测试确定性）
function stamp(now) {
  return (now || new Date()).toISOString().replace(/[:.]/g, '-');
}

// 主入口：确保 hooks 已安装。opts: { settingsPath, collectorPath, python, now }
// 返回 { changed, action: 'skip'|'install'|'update', backupPath|null }
function installHooks(opts) {
  const { settingsPath, collectorPath } = opts;
  const python = opts.python || 'python3';
  const existing = readJson(settingsPath);
  const hadHooks = !!(existing && existing.hooks && Object.keys(existing.hooks).some((e) => EVENTS.includes(e)
    && Array.isArray(existing.hooks[e]) && existing.hooks[e].some((g) => g && Array.isArray(g.hooks)
    && g.hooks.some((h) => h && typeof h.command === 'string' && OURS_RE.test(h.command)))));

  const { settings, changed } = computeSettings(existing ? JSON.parse(JSON.stringify(existing)) : {}, collectorPath, python);

  if (!changed) return { changed: false, action: 'skip', backupPath: null };

  // 改动前备份原文件（仅当原文件存在）
  let backupPath = null;
  if (fs.existsSync(settingsPath)) {
    backupPath = `${settingsPath}.panda-bak-${stamp(opts.now)}`;
    try { fs.copyFileSync(settingsPath, backupPath); } catch (_) { backupPath = null; }
  }

  writeJsonAtomic(settingsPath, settings);
  return { changed: true, action: hadHooks ? 'update' : 'install', backupPath };
}

module.exports = { installHooks, computeSettings, EVENTS, OURS_RE };
