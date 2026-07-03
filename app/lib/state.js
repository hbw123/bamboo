'use strict';

// 纯逻辑：路径解析、配置合并、状态聚合。刻意不依赖 electron，便于单元测试。
// 路径解析与 hooks/collector.py 保持一致，绝不硬编码 ~。

const fs = require('fs');
const os = require('os');
const path = require('path');

function pandaBaseDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'PandaPet');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || home, 'PandaPet');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'PandaPet');
}

// PANDAPET_STATE_DIR 覆盖的是 sessions 目录（与采集脚本约定一致）。
function sessionsDir(baseDir) {
  return process.env.PANDAPET_STATE_DIR || path.join(baseDir || pandaBaseDir(), 'sessions');
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const k of Object.keys(override)) {
    const b = base ? base[k] : undefined;
    const o = override[k];
    out[k] = (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o))
      ? deepMerge(b, o)
      : o;
  }
  return out;
}

// 优先级：任一在工作中就工作中；否则等待 > 完成 > 空闲。
const STATE_PRIORITY = ['working', 'waiting', 'done', 'idle'];

// 从 cwd 取项目名（末级目录名），用于在提醒里点名「哪个项目」。
function projectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

// 聚合 sessions 目录：读每个 session 状态文件，损坏隔离、过期清理、按优先级汇总。
// 返回整体状态 + 每个活跃会话的明细列表（供提醒点名与点击展开）。
// opts.now 便于测试注入时间。
function aggregateState(dir, staleMinutes, opts) {
  const staleMs = Math.max(1, staleMinutes || 15) * 60 * 1000;
  const now = (opts && opts.now) || Date.now();
  const unlink = !(opts && opts.noUnlink);

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return { state: 'idle', sessions: 0, list: [] };
  }

  const present = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const rec = readJsonSafe(full);
    if (!rec || typeof rec !== 'object') continue; // 损坏隔离：跳过，不崩溃
    const ts = Date.parse(rec.updated_at);
    if (!Number.isFinite(ts) || now - ts > staleMs) {
      if (unlink) { try { fs.unlinkSync(full); } catch (_) {} } // 过期清理，不复活历史会话
      continue;
    }
    if (STATE_PRIORITY.includes(rec.state)) present.push(rec);
  }

  const list = present
    .map((rec) => ({
      session_id: String(rec.session_id || ''),
      state: rec.state,
      project: projectName(rec.cwd),
      message: typeof rec.message === 'string' ? rec.message : '',
      updated_at: rec.updated_at || '',
    }))
    // 最近活动的排前面，方便展开列表阅读
    .sort((a, b) => (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : 0));

  if (present.length === 0) return { state: 'idle', sessions: 0, list: [] };
  let best = 'idle';
  for (const rec of present) {
    if (STATE_PRIORITY.indexOf(rec.state) < STATE_PRIORITY.indexOf(best)) best = rec.state;
  }
  return { state: best, sessions: present.length, list };
}

module.exports = {
  pandaBaseDir,
  sessionsDir,
  readJsonSafe,
  deepMerge,
  aggregateState,
  projectName,
  STATE_PRIORITY,
};
