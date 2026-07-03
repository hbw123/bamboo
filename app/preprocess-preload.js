'use strict';

// 预处理隐藏窗口的桥接：接收待处理图片、回传处理结果。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pre', {
  onJobs: (cb) => ipcRenderer.on('pre:jobs', (_e, jobs) => cb(jobs)),
  done: (results) => ipcRenderer.send('pre:done', results),
});
