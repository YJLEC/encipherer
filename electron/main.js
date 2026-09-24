/* Encipherer Electron 主进程
 * - 直接加载内嵌单文件 dist/Encipherer.html(完全离线;file:// 下存储自动降级,应用层已适配)
 * - 阻断一切导航/新窗口;下载必须经保存对话框
 * - 无菜单栏,单实例 */
const { app, BrowserWindow, session, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_HTML = path.join(__dirname, '..', 'dist', 'Encipherer.html');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1024, minHeight: 680,
    show: false,
    title: 'Encipherer · 表格隐私卫士',
    backgroundColor: '#f6f8f7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.once('ready-to-show', () => win.show());
  // 任何导航一律阻止(应用不联网);白名单仅本应用页面
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(APP_HTML).catch(err => {
    dialog.showErrorBox('启动失败', '无法加载应用页面:' + err.message);
    app.quit();
  });
  return win;
}

/* 下载:弹保存对话框,默认文件名取下载项名称 */
function wireDownloads() {
  session.defaultSession.on('will-download', (event, item) => {
    const defaultPath = path.join(app.getPath('downloads'), item.getFilename());
    const win = BrowserWindow.getFocusedWindow();
    const target = dialog.showSaveDialogSync(win, {
      title: '保存文件',
      defaultPath
    });
    if (!target) { event.preventDefault(); return; }
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      const w = BrowserWindow.getFocusedWindow();
      if (w && state === 'completed') {
        dialog.showMessageBox(w, {
          type: 'info',
          message: '已保存:' + target,
          buttons: ['打开所在文件夹', '关闭']
        }).then(r => { if (r.response === 0) shell.showItemInFolder(target); });
      }
    });
  });
}

/* 单实例锁:重复启动时聚焦已有窗口 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    if (!fs.existsSync(APP_HTML)) {
      dialog.showErrorBox('缺少应用文件', '未找到 dist/Encipherer.html。请先运行 npm run build 再打包桌面版。');
      app.quit();
      return;
    }
    // 注意:不要用 net.fetch(pathToFileURL) 流式转发——大响应会触发渲染进程崩溃;
    // 以 Buffer 直接构造 Response 返回。
    Menu.setApplicationMenu(null);
    wireDownloads();
    createWindow();
    // 冒烟测试模式:EC_SMOKE_MS=8000 electron . → 8 秒后干净退出并输出 SMOKE-OK
    if (process.env.EC_SMOKE_MS) {
      setTimeout(() => { console.log('SMOKE-OK'); app.exit(0); }, Number(process.env.EC_SMOKE_MS) || 8000);
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => app.quit());
}
