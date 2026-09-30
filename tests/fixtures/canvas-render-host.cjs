const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-render-test-')));
app.commandLine.appendSwitch('force-device-scale-factor', '1.5');
app.whenReady().then(() => {
    const window = new BrowserWindow({width:1600,height:1000,useContentSize:true,show:false,
        webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
