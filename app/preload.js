'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 只暴露渲染层需要的最小安全接口。
contextBridge.exposeInMainWorld('panda', {
  // 拉取初始化数据：配置、台词、素材与音效绝对路径。
  init: () => ipcRenderer.invoke('panda:init'),
  // 订阅聚合状态推送。
  onState: (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('panda:state', handler);
    return () => ipcRenderer.removeListener('panda:state', handler);
  },
  // 窗口拖动 / 自适应尺寸（供自定义拖拽与展开列表用）。
  getPos: () => ipcRenderer.invoke('panda:getPos'),
  moveTo: (x, y) => ipcRenderer.send('panda:moveTo', { x, y }),
  setSize: (width, height) => ipcRenderer.send('panda:setSize', { width, height }),
  // 软重载：换皮肤 / 预处理完成时，主进程通知渲染层重新取素材（不整页 reload）。
  onReinit: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('panda:reinit', handler);
    return () => ipcRenderer.removeListener('panda:reinit', handler);
  },
});
