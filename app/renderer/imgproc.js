'use strict';

// 共享的图像处理：自动抠白底 + 缩放。渲染层（即时）与预处理进程（启动时批量）共用。
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

  // 处理一张图 → { dataUrl, changed }。透明且不超尺寸 → changed:false（原样）。
  async function processToDataUrl(dataUrl, maxSize) {
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
    const info = inspectCorners(data.data, W, H);
    const resized = scale < 1;
    if (info.alreadyTransparent || !info.whiteBg) {
      return resized ? { dataUrl: canvas.toDataURL('image/png'), changed: true } : { dataUrl, changed: false };
    }
    keyOutBackground(data);
    ctx.putImageData(data, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), changed: true };
  }

  window.PandaImg = { loadImage, inspectCorners, keyOutBackground, processToDataUrl };
})();
