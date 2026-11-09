// Early Warning desktop app: runs the collector every few minutes in the background, shows the dashboard,
// keeps a coloured status icon in the system tray and pops up notifications for new serious alerts.
'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, ipcMain, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { collect } = require('./collector');
const { buildFeeds, MET_REGIONS } = require('./feeds');
const { locate } = require('./locate');
const { trayIcon, appIcon } = require('./icons');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('uk.prepping.earlywarning');   // Windows notifications need this

if (process.env.EW_USERDATA) app.setPath('userData', process.env.EW_USERDATA);   // used for testing
const userDir = app.getPath('userData');
const dataDir = path.join(userDir, 'data');
const settingsFile = path.join(userDir, 'settings.json');
const logFile = path.join(dataDir, 'collector.log');
fs.mkdirSync(dataDir, { recursive: true });

let settings = null, lastData = null, running = false, timer = null;
let dashWin = null, setWin = null, tray = null, quitting = false;

function log(m) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${m}\n`;
  try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1e6) fs.unlinkSync(logFile); fs.appendFileSync(logFile, line); } catch {}
}
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return null; } }
function saveSettings(s) { fs.writeFileSync(settingsFile, JSON.stringify(s, null, 1)); settings = s; }
function loadLast() { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8')); } catch { return null; } }

// ---------------- collection ----------------
async function runCollect(reason = 'timer') {
  if (running || !settings) return;
  running = true;
  try {
    const { data, fresh } = await collect(settings, buildFeeds(settings), dataDir, log);
    lastData = data;
    fs.writeFileSync(path.join(dataDir, 'data.json'), JSON.stringify(data));
    if (dashWin && !dashWin.isDestroyed()) dashWin.webContents.send('ew:data', data);
    updateTray();
    if (settings.notifications !== false) notify(fresh);
  } catch (e) { log('ERROR ' + (e.stack || e.message)); }
  finally { running = false; }
}
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => runCollect(), Math.max(2, settings.refreshMinutes || 5) * 60000);
  // catch up after the computer wakes from sleep
  setInterval(() => { if (lastData && (Date.now() - new Date(lastData.generated)) > (settings.refreshMinutes || 5) * 2 * 60000) runCollect('wake'); }, 60000);
}
function notify(fresh) {
  if (!Notification.isSupported()) return;
  for (const i of fresh.slice(0, 3)) {
    const n = new Notification({ title: i.level === 'critical' ? 'EARLY WARNING: CRITICAL' : 'Early warning', body: `${i.title}\n${i.source}`, icon: nativeImage.createFromBuffer(appIcon(128)), urgency: i.level === 'critical' ? 'critical' : 'normal' });
    n.on('click', () => showDashboard());
    n.show();
  }
}

// ---------------- tray ----------------
const LABEL = { info: 'All clear', watch: 'Watch', warning: 'Warning', critical: 'CRITICAL' };
function updateTray() {
  if (!tray) return;
  const lvl = lastData ? lastData.overall : 'stale';
  tray.setImage(nativeImage.createFromBuffer(trayIcon(lvl, process.platform === 'darwin' ? 22 : 32)));
  const why = lastData && lastData.reasons.length ? ' - ' + lastData.reasons[0] : '';
  tray.setToolTip(`Early Warning: ${LABEL[lvl] || 'starting'}${why}`.slice(0, 120));
}
function buildTray() {
  try { tray = new Tray(nativeImage.createFromBuffer(trayIcon('stale', 32))); } catch (e) { log('Tray unavailable: ' + e.message); return; }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: () => showDashboard() },
    { label: 'Refresh now', click: () => runCollect('manual') },
    { label: 'Settings', click: () => showSettings() },
    { type: 'separator' },
    { label: 'Start with this computer', type: 'checkbox', checked: getAutostart(), click: m => setAutostart(m.checked) },
    { type: 'separator' },
    { label: 'Quit Early Warning', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => showDashboard());
  updateTray();
}

// ---------------- start with the computer ----------------
const linuxAutostart = path.join(os.homedir(), '.config', 'autostart', 'early-warning.desktop');
function getAutostart() {
  if (process.platform === 'linux') return fs.existsSync(linuxAutostart);
  return app.getLoginItemSettings().openAtLogin;
}
function setAutostart(on) {
  if (process.platform === 'linux') {
    if (on) { fs.mkdirSync(path.dirname(linuxAutostart), { recursive: true }); fs.writeFileSync(linuxAutostart, `[Desktop Entry]\nType=Application\nName=Early Warning\nExec="${process.env.APPIMAGE || process.execPath}" --hidden\nX-GNOME-Autostart-enabled=true\n`); }
    else try { fs.unlinkSync(linuxAutostart); } catch {}
  } else app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
}

// ---------------- windows ----------------
function lockDown(win) {
  // links open in the normal browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}
function showDashboard() {
  if (dashWin && !dashWin.isDestroyed()) { dashWin.show(); dashWin.focus(); return; }
  const b = settings && settings.window, wa = screen.getPrimaryDisplay().workArea;
  dashWin = new BrowserWindow({
    width: b ? b.width : Math.min(1600, wa.width), height: b ? b.height : Math.min(950, wa.height), x: b ? b.x : undefined, y: b ? b.y : undefined,
    backgroundColor: '#0b0e12', title: 'Early Warning', icon: nativeImage.createFromBuffer(appIcon(256)), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  lockDown(dashWin);
  dashWin.loadFile(path.join(__dirname, 'ui', 'dashboard.html'));
  if (settings && settings.window && settings.window.maximized) dashWin.maximize();
  const remember = () => { if (!dashWin || dashWin.isDestroyed() || !settings) return; settings.window = { ...dashWin.getNormalBounds(), maximized: dashWin.isMaximized() }; saveSettings(settings); };
  dashWin.on('resized', remember); dashWin.on('moved', remember);
  dashWin.on('close', e => { remember(); if (!quitting && tray) { e.preventDefault(); dashWin.hide(); } });
}
function showSettings() {
  if (setWin && !setWin.isDestroyed()) { setWin.show(); setWin.focus(); return; }
  setWin = new BrowserWindow({
    width: 760, height: 860, backgroundColor: '#0b0e12', title: 'Early Warning - Settings', icon: nativeImage.createFromBuffer(appIcon(256)), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  lockDown(setWin);
  setWin.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  setWin.on('closed', () => { setWin = null; if (!settings) { quitting = true; app.quit(); } });
}

// ---------------- IPC ----------------
ipcMain.handle('ew:get-data', () => lastData);
ipcMain.handle('ew:refresh', async () => { await runCollect('manual'); return lastData; });
ipcMain.handle('ew:get-settings', () => ({ settings, metRegions: MET_REGIONS, autostart: getAutostart(), feeds: settings ? buildFeeds({ ...settings, disabledFeeds: [] }).map(f => ({ id: f.id, name: f.name, panel: f.panel })) : [] }));
ipcMain.handle('ew:feeds-for', (e, s) => buildFeeds({ ...s, disabledFeeds: [] }).map(f => ({ id: f.id, name: f.name, panel: f.panel })));
ipcMain.handle('ew:locate', async (e, postcode) => { try { return { ok: true, home: await locate(postcode) }; } catch (err) { return { ok: false, error: String(err.message || err) }; } });
ipcMain.handle('ew:save-settings', async (e, s, autostart) => {
  const first = !settings;
  saveSettings({ refreshMinutes: 5, notifications: true, ...(settings || {}), ...s });
  if (autostart !== undefined) setAutostart(!!autostart);
  if (first) { schedule(); }
  for (const f of fs.readdirSync(dataDir)) if (/^(cache|fail)-/.test(f)) try { fs.unlinkSync(path.join(dataDir, f)); } catch {}   // location may have changed
  if (setWin) setWin.close();
  showDashboard();
  runCollect('settings');
  return true;
});
ipcMain.handle('ew:open-settings', () => showSettings());
ipcMain.handle('ew:open-log', () => shell.openPath(logFile));

// ---------------- start up ----------------
app.on('second-instance', () => showDashboard());
app.whenReady().then(() => {
  settings = loadSettings();
  lastData = loadLast();
  buildTray();
  if (!settings) { showSettings(); return; }   // first run: set up location
  schedule();
  if (!process.argv.includes('--hidden')) showDashboard();
  runCollect('startup');
});
app.on('window-all-closed', () => { if (!tray || quitting) app.quit(); });
app.on('before-quit', () => { quitting = true; });
app.on('activate', () => { if (settings) showDashboard(); });
