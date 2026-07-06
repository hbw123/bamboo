'use strict';

// 共享的图像处理：缩放 + 背景抠除。渲染层（即时）与预处理进程（启动时批量）共用。
// 挂在 window.PandaImg 上。纯 canvas，无外部依赖。
//
// 背景抠除策略（零配置）：采样上方两个角（左上、右上，因为很多角色图下方是主体）——
//   · 两个上角都透明      → 已经是透明图，直接用
//   · 两个上角颜色一致     → 那就是纯色背景，用这个颜色做色键抠掉（绿幕原理）
//   · 两个上角不一致（照片等）→ 不是纯色底，不抠
// 作者只要「把背景涂成角色里不会出现的纯色」即可，无需填任何颜色值。
(function () {
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function parseHexColor(hex) {
    let h = String(hex).replace(/^#/, '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function toRGB(color) {
    if (Array.isArray(color)) return { r: color[0], g: color[1], b: color[2] };
    if (color && typeof color === 'object') return color;
    return parseHexColor(color);
  }

  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    let h = 0;
    if (c) {
      if (mx === r) h = ((g - b) / c) % 6;
      else if (mx === g) h = (b - r) / c + 2;
      else h = (r - g) / c + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: mx ? c / mx : 0, v: mx };
  }

  function hueDist(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  // 采样「上方两个角」（左上、右上）判断背景——很多角色图下方是主体/被裁掉，
  // 只有上方是背景，所以以上角为准。返回 { transparent } | { bgColor:[r,g,b] } | {}。
  function detectBackground(d, W, H) {
    const pts = [[2, 2], [W - 3, 2]];
    const cs = pts.map(([x, y]) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; });
    if (cs.every((c) => c[3] < 16)) return { transparent: true };
    if (!cs.every((c) => c[3] > 200)) return {};
    const bgColor = [0, 1, 2].map((k) => Math.round((cs[0][k] + cs[1][k]) / 2));
    const a = rgb2hsv(cs[0][0], cs[0][1], cs[0][2]);
    const b = rgb2hsv(cs[1][0], cs[1][1], cs[1][2]);
    // 都是饱和纯色 且 色相接近 → 彩色背景（绿幕/品红幕，容忍打光造成的明暗差）
    if (a.s >= 0.25 && b.s >= 0.25 && hueDist(a.h, b.h) <= 25) return { bgColor };
    // 都是低饱和（近白/灰）且 RGB 接近 → 浅色纯背景
    const dr = cs[0][0] - cs[1][0], dg = cs[0][1] - cs[1][1], db = cs[0][2] - cs[1][2];
    if (a.s < 0.25 && b.s < 0.25 && dr * dr + dg * dg + db * db <= 28 * 28) return { bgColor };
    return {};
  }

  // 色键抠图：把接近某背景色的像素置透明，边缘按距离羽化以软化锯齿。
  // color 可为 "#RRGGBB" 或 [r,g,b]。
  function keyOutColor(imgData, color, tolerance, feather) {
    const key = toRGB(color);
    if (!key) return false;
    const kh = rgb2hsv(key.r, key.g, key.b);
    const d = imgData.data;
    if (kh.s >= 0.25) {
      // 饱和纯色背景（绿幕/品红幕等）→ 按「色相」抠：容忍打光明暗差；
      // 低饱和像素（肤色浅处、白、灰）一律保留，异色相主体也保留。
      const hueTol = Number.isFinite(tolerance) ? tolerance : 34; // 色相容差(度)
      const fth = Number.isFinite(feather) ? feather : 12;
      const satMin = 0.15;
      for (let i = 0; i < d.length; i += 4) {
        const p = rgb2hsv(d[i], d[i + 1], d[i + 2]);
        if (p.s < satMin) continue;
        const hd = hueDist(p.h, kh.h);
        if (hd <= hueTol) d[i + 3] = 0;
        else if (hd < hueTol + fth) { const a = (hd - hueTol) / fth; const na = Math.round(a * 255); if (na < d[i + 3]) d[i + 3] = na; }
      }
    } else {
      // 近白/灰背景 → 按 RGB 距离抠
      const tol = Number.isFinite(tolerance) ? tolerance : 60;
      const fth = Number.isFinite(feather) ? feather : 30;
      const t2 = tol * tol, outer = (tol + fth) * (tol + fth);
      for (let i = 0; i < d.length; i += 4) {
        const dr = d[i] - key.r, dg = d[i + 1] - key.g, db = d[i + 2] - key.b;
        const dist2 = dr * dr + dg * dg + db * db;
        if (dist2 <= t2) d[i + 3] = 0;
        else if (dist2 < outer) { const a = (Math.sqrt(dist2) - tol) / fth; const na = Math.round(a * 255); if (na < d[i + 3]) d[i + 3] = na; }
      }
    }
    return true;
  }

  // 处理一张图 → { dataUrl, changed }。
  // 优先级：显式 opts.keyColor（覆盖）> 自动检测的纯色背景 > 原样。opts.keyOut===false 关闭抠除。
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
    const asIs = () => (resized ? { dataUrl: canvas.toDataURL('image/png'), changed: true } : { dataUrl, changed: false });
    const keyed = () => { ctx.putImageData(data, 0, 0); return { dataUrl: canvas.toDataURL('image/png'), changed: true }; };

    const autoKey = !(opts.keyOut === false);

    // 1) 作者显式指定了背景色 → 直接色键（覆盖自动检测）
    if (autoKey && opts.keyColor && keyOutColor(data, opts.keyColor, opts.tolerance)) return keyed();

    // 2) 自动检测四角
    const bg = detectBackground(data.data, W, H);
    if (bg.transparent) return asIs();                 // 已透明
    if (autoKey && bg.bgColor) {                       // 四角一致的纯色背景 → 色键掉
      keyOutColor(data, bg.bgColor, opts.tolerance);
      return keyed();
    }

    // 3) 非纯色底 / 关闭了抠除 → 原样（必要时只缩放）
    return asIs();
  }

  window.PandaImg = { loadImage, parseHexColor, detectBackground, keyOutColor, processToDataUrl };
})();
