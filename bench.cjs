// Runs the benchmark inside the app, so it uses the same test browser.
const { app } = require('electron');
app.disableHardwareAcceleration();
// Test windows open and close constantly. Without this, Electron would quit the
// moment the last one closed, in the middle of a run.
app.on('window-all-closed', () => {});
app.whenReady().then(() => import('./bench.js')).catch(err => { console.error(err); app.quit(); });
