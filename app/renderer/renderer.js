'use strict';

// ---------------------------------------------------------------------------
// 展示层核心。一只熊猫聚合所有 Claude Code 会话：
//   - 身体（精灵）跟随「整体状态」：任一在工作中即工作中，否则 等待>完成>空闲。
//   - 提醒（动作+音效+气泡）按「单会话跳变」触发，并点名是哪个项目——
//     这样即便十几个窗口并行、整体一直是工作中，某个窗口跑完/要输入时你也知道是哪个。
//   - 点击熊猫展开进行中的会话列表。
// ---------------------------------------------------------------------------

const el = {
  stage: document.getElementById('stage'),
  inner: document.getElementById('inner'),
  card: document.getElementById('card'),
  panda: document.getElementById('panda'),
  placeholder: document.getElementById('placeholder'),
  placeholderLabel: document.getElementById('placeholder-label'),
  bubble: document.getElementById('bubble'),
  panel: document.getElementById('panel'),
  list: document.getElementById('list'),
};

let CONFIG = null;
let LINES = { daily: [] };
let SPRITES = {};
let SOUNDS = {};

let logical = 'idle';        // 整体状态
let displayKey = null;       // 当前显示的精灵键
let doneTimer = null;
let idleDazeTimer = null;
let idleSleepTimer = null;
let lastMurmurAt = 0;

let prevStates = new Map();  // session_id -> 上一次状态（用于跳变检测）
let currentList = [];        // 最近一次的会话明细
let expanded = false;

// 彩蛋（极稀缺，见 DESIGN.md「那条藏起来的心」）。触发条件由 config.behavior.eggs 控制。
let totalWorkMs = 0;             // 累计「有会话在工作」的时长
let lastWorkTickTs = 0;
let lastEggAt = 0;               // 上次任意彩蛋的时刻（全局冷却）
let lastLongWorkAt = 0;          // 上次 long_work 彩蛋
const workingSince = new Map();  // session_id -> 进入工作中的时刻
const bigDoneFired = new Set();  // 已给过 big_done 的会话（每会话最多一次）

const STATE_LABELS = { idle: '空闲', working: '工作中', waiting: '等待输入', done: '完成', sleep: '打盹' };

// --- 素材 ---------------------------------------------------------------------
function toFileUrl(p) {
  if (!p) return '';
  let n = String(p).replace(/\\/g, '/');
  if (!n.startsWith('/')) n = '/' + n; // Windows 盘符
  return 'file://' + n.split('/').map(encodeURIComponent).join('/');
}

const spriteUrlCache = {}; // key -> 处理后的 data URL（自动抠底+缩放，见 imgproc.js）
async function spriteUrl(key) {
  if (spriteUrlCache[key]) return spriteUrlCache[key];
  const sprite = SPRITES[key];
  if (!sprite || !sprite.dataUrl) return null;
  let url = sprite.dataUrl;
  try { url = (await window.PandaImg.processToDataUrl(sprite.dataUrl, 512)).dataUrl; } catch (_) { /* 退回原图 */ }
  spriteUrlCache[key] = url;
  return url;
}

async function setSprite(key) {
  if (key === displayKey) return;
  displayKey = key;
  const sprite = SPRITES[key];
  if (!sprite || !sprite.dataUrl) return showPlaceholder(key, '');
  const url = await spriteUrl(key);
  if (displayKey !== key) return; // 处理期间状态已切走，丢弃这次
  if (!url) return showPlaceholder(key, sprite.note);
  el.panda.onerror = () => showPlaceholder(key, sprite.note);
  el.panda.hidden = false;
  el.placeholder.hidden = true;
  el.panda.src = url;
}

function showPlaceholder(key, note) {
  el.panda.hidden = true;
  el.placeholder.hidden = false;
  el.placeholderLabel.textContent = (note && note.trim()) || (STATE_LABELS[key] || key) + '（占位·待出图）';
}

function playSound(kind) {
  if (!CONFIG || !CONFIG.sound || CONFIG.sound.enabled === false) return;
  const p = SOUNDS[kind];
  if (!p) return; // 音效文件未提供 → 静默跳过
  try { new Audio(toFileUrl(p)).play().catch(() => {}); } catch (_) {}
}

function animate(cls) {
  el.card.classList.remove('bounce', 'nudge');
  void el.card.offsetWidth; // 触发重排以便重复播放
  el.card.classList.add(cls);
}

// --- 精灵状态机（只管身体，不发提醒）------------------------------------------
function clearTimers() {
  if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
  if (idleDazeTimer) { clearTimeout(idleDazeTimer); idleDazeTimer = null; }
  if (idleSleepTimer) { clearTimeout(idleSleepTimer); idleSleepTimer = null; }
}

function isNight() {
  const n = (CONFIG.behavior && CONFIG.behavior.night) || {};
  const s = Number.isFinite(n.startHour) ? n.startHour : 23;
  const e = Number.isFinite(n.endHour) ? n.endHour : 7;
  const h = new Date().getHours();
  return s <= e ? (h >= s && h < e) : (h >= s || h < e);
}

// 空闲：深夜显「深夜」神情；白天则 空闲 → 发呆 → 打盹 的静默递进。
function enterIdle() {
  const b = CONFIG.behavior || {};
  const sleepMs = b.idleSleepMs || 90000;
  if (isNight()) {
    setSprite('night');
    idleSleepTimer = setTimeout(() => setSprite('sleep'), sleepMs);
    return;
  }
  setSprite('idle');
  idleDazeTimer = setTimeout(() => setSprite('daze'), b.idleDazeMs || 30000);
  idleSleepTimer = setTimeout(() => setSprite('sleep'), sleepMs);
}

function applyLogical(next) {
  if (next === logical && displayKey !== null) return;
  logical = next;
  clearTimers();
  // 工作中：复用 idle 图，但加「呼吸」动效以和空闲区分。
  el.panda.classList.toggle('breathing', next === 'working');
  if (next === 'working') { setSprite('working'); return; }
  if (next === 'waiting') { setSprite('waiting'); return; }
  if (next === 'done') {
    setSprite('done');
    const linger = (CONFIG.behavior && CONFIG.behavior.doneLingerMs) || 6000;
    doneTimer = setTimeout(() => { if (logical === 'done') enterIdle(); }, linger);
    return;
  }
  enterIdle();
}

// --- 单会话跳变 → 点名提醒 ----------------------------------------------------
function alertSession(kind, session, opts) {
  if (!CONFIG.behavior || CONFIG.behavior.notifyPerSession === false) return;
  const proj = session.project ? `「${session.project}」` : '这个';
  if (kind === 'done') {
    animate('bounce'); playSound('onDone');
    // 大任务跑通：把 big_done 彩蛋给这个值得的时刻，替代普通的「xx 好了」。
    if (opts && opts.egg) {
      const line = pickRandom((LINES.eggs && LINES.eggs.big_done) || []);
      if (line) { showEgg(line); return; }
    }
    showBubbleAlert(`${proj}好了`);
  } else if (kind === 'waiting') {
    animate('nudge'); playSound('onWaiting'); showBubbleAlert(`${proj}在等你`);
  }
}

function diffAndAlert(list) {
  const now = Date.now();
  const seen = new Set();
  for (const s of list) {
    seen.add(s.session_id);
    const prev = prevStates.get(s.session_id);
    if (s.state === 'working' && prev !== 'working') workingSince.set(s.session_id, now);
    if (prev && prev !== s.state) {
      if (s.state === 'done' && prev === 'working') {
        const dur = now - (workingSince.get(s.session_id) || now);
        const egg = bigDoneEligible(s, dur, now);
        alertSession('done', s, { egg });
        if (egg) bigDoneFired.add(s.session_id);
      } else if (s.state === 'waiting' && prev === 'working') {
        alertSession('waiting', s);
      }
    }
    prevStates.set(s.session_id, s.state);
  }
  for (const id of [...prevStates.keys()]) {
    if (!seen.has(id)) { prevStates.delete(id); workingSince.delete(id); bigDoneFired.delete(id); }
  }
}

// --- 气泡 ---------------------------------------------------------------------
// 在标点后插入换行机会：配合 CSS 的 word-break:keep-all + overflow-wrap:anywhere，
// 让长句优先在标点处断行；某段没有标点又超过面板宽度时，才直接断字。
const BREAK_AFTER = /([。！？…，、；：—.!?,;:）〕】》」』])/g;
function bubbleHtml(text) {
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(BREAK_AFTER, '$1<wbr>');
}

let bubbleTimer = null;
function showBubble(text, ms) {
  el.bubble.innerHTML = bubbleHtml(text);
  el.bubble.classList.add('show');
  el.bubble.setAttribute('aria-hidden', 'false');
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    el.bubble.classList.remove('show');
    el.bubble.setAttribute('aria-hidden', 'true');
  }, ms);
}
function showBubbleAlert(text) {
  showBubble(text, (CONFIG.behavior && CONFIG.behavior.alertBubbleMs) || 5000);
}

function maybeMurmur() {
  const m = CONFIG.behavior && CONFIG.behavior.murmur;
  if (!m || m.enabled === false) return;
  if (!(displayKey === 'idle' || displayKey === 'sleep' || displayKey === 'working')) return;
  const now = Date.now();
  if (now - lastMurmurAt < (m.minGapMs || 25000)) return;
  if (Math.random() >= (m.chancePerTick || 0.02)) return;
  const pool = (LINES && Array.isArray(LINES.daily)) ? LINES.daily : [];
  if (pool.length === 0) return;
  showBubble(pool[Math.floor(Math.random() * pool.length)], m.showMs || 4200);
  lastMurmurAt = now;
}

// --- 彩蛋 ---------------------------------------------------------------------
// 极度克制：条件本身已稀有，再加全局冷却与每会话/每段一次，宁可几乎不出现。
function pickRandom(arr) {
  return Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}
function eggsCfg() { return (CONFIG.behavior && CONFIG.behavior.eggs) || {}; }
function eggsEnabled() { return eggsCfg().enabled !== false; }
function eggCooldownOk(now) { return now - lastEggAt >= (eggsCfg().cooldownMs || 1800000); }

function showEgg(text) {
  if (!text) return false;
  showBubble(text, (CONFIG.behavior && CONFIG.behavior.alertBubbleMs) || 5000);
  lastEggAt = Date.now();
  return true;
}

// big_done：某会话连续工作 ≥ 阈值后完成，且过了全局冷却、这个会话还没给过。
function bigDoneEligible(session, durMs, now) {
  if (!eggsEnabled()) return false;
  if (bigDoneFired.has(session.session_id)) return false;
  if (durMs < (eggsCfg().bigDoneMinWorkMs || 600000)) return false;
  return eggCooldownOk(now);
}

// long_work：累计工作 ≥ 阈值，或已过深夜仍在工作。每 longWorkRepeatMs 最多一次。
function tryLongWork() {
  if (!eggsEnabled()) return;
  const e = eggsCfg();
  const now = Date.now();
  if (!eggCooldownOk(now)) return;
  if (now - lastLongWorkAt < (e.longWorkRepeatMs || 10800000)) return;
  const eligible = totalWorkMs >= (e.longWorkTotalMs || 14400000) || isNight();
  if (!eligible) return;
  if (showEgg(pickRandom((LINES.eggs && LINES.eggs.long_work) || []))) lastLongWorkAt = now;
}

// --- 会话列表面板 -------------------------------------------------------------
function renderPanel() {
  el.list.innerHTML = '';
  if (currentList.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = '没有进行中的会话';
    el.list.appendChild(d);
    return;
  }
  for (const s of currentList) {
    const row = document.createElement('div');
    row.className = 'row';
    const proj = document.createElement('div');
    proj.className = 'proj';
    proj.textContent = s.project || (s.session_id ? s.session_id.slice(0, 8) : '会话');
    proj.title = s.message || s.project || '';
    const badge = document.createElement('div');
    badge.className = 'badge ' + s.state;
    badge.textContent = STATE_LABELS[s.state] || s.state;
    row.appendChild(proj);
    row.appendChild(badge);
    el.list.appendChild(row);
  }
}

let lastSize = '';
function applySize() {
  const cfgW = (CONFIG.window && CONFIG.window.width) || 200;
  const cfgH = (CONFIG.window && CONFIG.window.height) || 220;
  let w = cfgW, h = cfgH;
  if (expanded) {
    const rows = Math.min(currentList.length || 1, 6);
    w = Math.max(cfgW, 252);
    h = cfgH + 34 + rows * 33 + 12;
  }
  const key = w + 'x' + h;
  if (key === lastSize) return; // 尺寸未变则不重复 resize，避免抖动
  lastSize = key;
  window.panda.setSize(w, h);
}

function toggleExpand() {
  expanded = !expanded;
  el.panel.hidden = !expanded;
  if (expanded) renderPanel();
  applySize();
}

// --- 自定义拖拽（区分点击与拖动）----------------------------------------------
function initDrag() {
  let down = null;
  // 整个内容区（熊猫 + 会话面板）都能发起拖动；只有点在熊猫身上才切换展开。
  el.inner.addEventListener('mousedown', async (e) => {
    if (e.button !== 0) return;
    const onCard = el.card.contains(e.target);
    const pos = await window.panda.getPos();
    down = { mx: e.screenX, my: e.screenY, wx: pos.x, wy: pos.y, moved: false, onCard };
  });
  window.addEventListener('mousemove', (e) => {
    if (!down) return;
    const dx = e.screenX - down.mx;
    const dy = e.screenY - down.my;
    if (!down.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) down.moved = true;
    if (down.moved) window.panda.moveTo(down.wx + dx, down.wy + dy);
  });
  window.addEventListener('mouseup', () => {
    if (!down) return;
    const wasClick = !down.moved;
    const onCard = down.onCard;
    down = null;
    if (wasClick && onCard) toggleExpand(); // 点熊猫=展开/收起；点面板不切换，但可拖
  });
}

// --- 启动 ---------------------------------------------------------------------
async function loadData() {
  const init = await window.panda.init();
  CONFIG = init.config || {};
  LINES = init.lines || { daily: [] };
  SPRITES = init.sprites || {};
  SOUNDS = init.sounds || {};
  document.body.classList.toggle('transparent', (CONFIG.window && CONFIG.window.renderMode) === 'transparent');
}

async function boot() {
  await loadData();
  initDrag();
  applyLogical('idle');
  applySize();

  window.panda.onState((agg) => {
    if (!agg) return;
    // 累计「有会话在工作」的时长（忽略休眠等异常大间隔），用于 long_work 彩蛋。
    const now = Date.now();
    if (lastWorkTickTs && agg.state === 'working') {
      const dt = now - lastWorkTickTs;
      if (dt > 0 && dt < 60000) totalWorkMs += dt;
    }
    lastWorkTickTs = now;

    currentList = Array.isArray(agg.list) ? agg.list : [];
    diffAndAlert(currentList);
    if (agg.state === 'working') tryLongWork();
    if (typeof agg.state === 'string') applyLogical(agg.state);
    if (expanded) { renderPanel(); applySize(); }
  });

  // 软重载：换皮肤 / 预处理完成时刷新素材，不整页 reload（reload 透明窗口会闪退）。
  window.panda.onReinit(async () => {
    const cur = displayKey;
    for (const k of Object.keys(spriteUrlCache)) delete spriteUrlCache[k]; // 清图缓存
    await loadData();
    displayKey = null;          // 强制重画当前状态
    if (cur) setSprite(cur); else applyLogical(logical);
  });

  setInterval(maybeMurmur, 3000);
}

// 任何启动/运行错误都显示在卡片上，而不是留一张白图。
function showFatal(msg) {
  try {
    el.panda.hidden = true;
    el.placeholder.hidden = false;
    el.placeholderLabel.textContent = '出错了：' + msg;
  } catch (_) { /* DOM 都拿不到就算了 */ }
}

window.addEventListener('error', (e) => showFatal((e && e.message) || 'script error'));
window.addEventListener('unhandledrejection', (e) => showFatal((e && e.reason && e.reason.message) || 'promise rejected'));

boot().catch((err) => showFatal((err && err.message) || String(err)));
