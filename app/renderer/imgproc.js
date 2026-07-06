'use strict';

// 共享的图像处理：缩放 + 可选自动抠白底。渲染层（即时）与预处理进程（启动时批量）共用。
// 挂在 window.PandaImg 上。纯 canvas，无外部依赖。
(function () {
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // 采样四角：已透明 → 直接用；不透明且浅色 → 需抠白底；其它（深色底等）→ 原样。
  function inspectCorners(d, W, H) {
    const pts = [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3]];
    let transparent = 0, lightOpaque = 0;
    for (const [x, y] of pts) {
      const i = (y * W + x) * 4;
      const a = d[i + 3];
      if (a < 16) transparent++;
      else if (Math.min(d[i], d[i + 1], d[i + 2]) > 185) lightOpaque++;
    }
    return { alreadyTransparent: transparent >= 3, whiteBg: lightOpaque >= 3 };
  }

  // 从四边对「浅色且局部平滑」的连通区域生长置透明（深色描边成台阶挡住、不伤主体）。
  function keyOutBackground(imgData, delta = 4, minlum = 150) {
    const d = imgData.data, W = imgData.width, H = imgData.height, N = W * H;
    const lum = new Uint8Array(N);
    for (let p = 0, q = 0; p < N; p++, q += 4) lum[p] = (d[q] * 299 + d[q + 1] * 587 + d[q + 2] * 114) / 1000 | 0;
    const visited = new Uint8Array(N);
    const queue = new Int32Array(N);
    let head = 0, tail = 0;
    const push = (p) => { if (!visited[p] && lum[p] >= minlum) { visited[p] = 1; queue[tail++] = p; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (head < tail) {
      const p = queue[head++], cl = lum[p], x = p % W, y = (p / W) | 0;
      const grow = (j) => { if (!visited[j] && lum[j] >= minlum && Math.abs(lum[j] - cl) <= delta) { visited[j] = 1; queue[tail++] = j; } };
      if (x > 0) grow(p - 1);
      if (x < W - 1) grow(p + 1);
      if (y > 0) grow(p - W);
      if (y < H - 1) grow(p + W);
    }
    for (let p = 0, q = 3; p < N; p++, q += 4) if (visited[p]) d[q] = 0;
  }

  function parseHexColor(hex) {
    let h = String(hex).replace(/^#/, '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  // 色键抠图：把接近指定背景色的像素置透明（绿幕原理）。作者把背景涂成角色里不会
  // 出现的纯色，这里就能精确抠掉、绝不误伤主体。边缘做一段羽化，软化锯齿。
  function keyOutColor(imgData, hex, tolerance, feather) {
    const key = parseHexColor(hex);
    if (!key) return false;
    const tol = Number.isFinite(tolerance) ? tolerance : 60;
    const fth = Number.isFinite(feather) ? feather : 30;
    const d = imgData.data;
    const t2 = tol * tol, outer = (tol + fth) * (tol + fth);
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - key.r, dg = d[i + 1] - key.g, db = d[i + 2] - key.b;
      const dist2 = dr * dr + dg * dg + db * db;
      if (dist2 <= t2) {
        d[i + 3] = 0;                       // 就是背景色 → 透明
      } else if (dist2 < outer) {           // 过渡带 → 按距离羽化
        const a = (Math.sqrt(dist2) - tol) / fth; // 0..1
        const na = Math.round(a * 255);
        if (na < d[i + 3]) d[i + 3] = na;
      }
    }
    return true;
  }

  // 处理一张图 → { dataUrl, changed }。透明且不超尺寸 → changed:false（原样）。
  // opts.keyColor 指定背景色 → 走色键抠图（最稳）；否则 opts.keyOut!==false 时猜浅色背景抠白底。
  async function processToDataUrl(dataUrl, maxSize, opts) {
    opts = opts || {};
    const max = maxSize || 512;
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const W = Math.max(1, Math.round(img.naturalWidth * scale));
    const H = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    let data;
    try { data = ctx.getImageData(0, 0, W, H); } catch (_) { return { dataUrl, changed: false }; }
    const resized = scale < 1;

    // 首选：作者指定背景色 → 色键抠图
    if (opts.keyColor && keyOutColor(data, opts.keyColor, opts.tolerance)) {
      ctx.putImageData(data, 0, 0);
      return { dataUrl: canvas.toDataURL('image/png'), changed: true };
    }

    // 否则：猜浅色背景、边缘洪填抠白底（keyOut=false 时跳过，只缩放）
    const keyOut = !(opts.keyOut === false);
    const info = inspectCorners(data.data, W, H);
    if (!keyOut || info.alreadyTransparent || !info.whiteBg) {
      return resized ? { dataUrl: canvas.toDataURL('image/png'), changed: true } : { dataUrl, changed: false };
    }
    keyOutBackground(data);
    ctx.putImageData(data, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), changed: true };
  }

  window.PandaImg = { loadImage, inspectCorners, keyOutBackground, keyOutColor, parseHexColor, processToDataUrl };
})();
