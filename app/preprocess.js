'use strict';

// 独立隐藏进程：批量处理皮肤图片（自动抠白底 + 缩放），把结果回传主进程落盘缓存。
// 不阻塞桌宠窗口。处理逻辑与渲染层共用 imgproc.js。
window.pre.onJobs(async (jobs) => {
  const out = [];
  for (const job of jobs || []) {
    try {
      const r = await window.PandaImg.processToDataUrl(job.dataUrl, job.maxSize || 512);
      out.push({ skin: job.skin, cacheKey: job.cacheKey, file: job.file, changed: r.changed, dataUrl: r.changed ? r.dataUrl : null });
    } catch (e) {
      out.push({ skin: job.skin, cacheKey: job.cacheKey, file: job.file, error: String((e && e.message) || e) });
    }
  }
  window.pre.done(out);
});
