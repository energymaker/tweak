// Entry point. Electron starts here, then the app itself loads.
const { app, dialog } = require('electron');
app.disableHardwareAcceleration();
app.whenReady()
  .then(() => import('./app.mjs'))
  .catch(err => { dialog.showErrorBox('Tweak could not start', String(err && err.stack || err)); app.quit(); });
