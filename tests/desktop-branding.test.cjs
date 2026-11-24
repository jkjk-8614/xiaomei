const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const desktop = path.resolve(__dirname, '../desktop');
const brandSource = fs.readFileSync(path.join(desktop, 'brand-electron-exe.cjs'), 'utf8');
const startSource = fs.readFileSync(path.join(desktop, 'start-branded.cjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(desktop, 'main.cjs'), 'utf8').replace(/\r\n/g, '\n');

function brandingFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-brand-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('xiaomei-brand-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const desktopDir = path.join(root, 'desktop');
  const sourceExe = path.join(desktopDir, 'node_modules/electron/dist/electron.exe');
  const icon = path.join(root, 'static/images/app-icon.ico');
  const rcedit = path.join(root, 'tools/bin/rcedit-x64.exe');
  const script = path.join(desktopDir, 'brand-electron-exe.cjs');
  for (const file of [sourceExe, icon, rcedit, script]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, file === script ? brandSource : 'fixture');
  }
  const edits = [];
  const module = { exports: {} };
  const context = vm.createContext({
    __dirname: desktopDir, __filename: script, module,
    process: { platform: 'win32', pid: process.pid, stdout: { write() {} } },
    require(name) {
      if (name === 'child_process') return {
        spawnSync(exe, args) {
          edits.push({ exe, args });
          fs.appendFileSync(args[0], '-branded');
          return { status: 0 };
        },
      };
      return require(name);
    },
  });
  vm.runInContext(brandSource, context);
  return { ...module.exports, edits, icon, script };
}

test('Windows runtime receives the application icon and process names', (t) => {
  const fixture = brandingFixture(t);
  assert.equal(fixture.brand().generated, true);
  assert.equal(fixture.edits.length, 1);
  const args = fixture.edits[0].args;
  assert.equal(args[args.indexOf('--set-icon') + 1], fixture.icon);
  for (const field of ['FileDescription', 'ProductName']) {
    assert.equal(args[args.indexOf(field) + 1], '小美画布');
  }
  assert.equal(path.basename(fixture.BRANDED_EXE), '小美画布.exe');
  assert.equal(fixture.brand().skipped, 'up-to-date');
});

test('branded development bootstrap preserves source-mode data selection', (t) => {
  const fixture = brandingFixture(t);
  fixture.brand();
  const bootstrapDir = path.join(path.dirname(fixture.BRANDED_EXE), 'resources/app');
  const bootstrap = fs.readFileSync(path.join(bootstrapDir, 'main.js'), 'utf8');
  const app = { isPackaged: true };
  let requested;
  vm.runInNewContext(bootstrap, {
    __dirname: bootstrapDir,
    process: { argv: [fixture.BRANDED_EXE], cwd: () => desktop },
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'electron') return { app };
      requested = name;
      assert.equal(app.isPackaged, false);
    },
  });
  assert.equal(requested, path.dirname(fixture.script));
});

test('updated icons and branding scripts invalidate the runtime cache', (t) => {
  const fixture = brandingFixture(t);
  fixture.brand();
  fs.appendFileSync(fixture.icon, '-new-icon');
  assert.equal(fixture.brand().generated, true);
  assert.equal(fixture.brand().skipped, 'up-to-date');
  fs.appendFileSync(fixture.script, '\n// updated resources\n');
  assert.equal(fixture.brand().generated, true);
  assert.equal(fixture.edits.length, 3);
});

test('a missing resource tool leaves the original runtime intact', (t) => {
  const fixture = brandingFixture(t);
  fixture.brand();
  fs.unlinkSync(fixture.edits[0].exe);
  fs.appendFileSync(fixture.icon, '-changed');
  assert.equal(fixture.brand().reason, 'rcedit-missing');
  assert.equal(fs.readFileSync(fixture.SOURCE_EXE, 'utf8'), 'fixture');
  assert.equal(fs.readFileSync(fixture.BRANDED_EXE, 'utf8'), 'fixture-branded');
});

test('npm launch uses the branded Windows runtime and the native runtime elsewhere', () => {
  for (const [platform, brandedExists, expected] of [
    ['win32', true, '/runtime/小美画布.exe'],
    ['win32', false, '/runtime/electron.exe'],
    ['darwin', false, '/runtime/Electron.app/Contents/MacOS/Electron'],
  ]) {
    const starts = [];
    vm.runInNewContext(startSource, {
      __dirname: desktop,
      process: { platform, env: {}, stderr: { write() {} } },
      require(name) {
        if (name === 'fs') return { existsSync: () => brandedExists };
        if (name === './brand-electron-exe.cjs') return {
          brand: () => ({ ok: brandedExists || platform !== 'win32', reason: 'rcedit-missing' }),
          BRANDED_EXE: '/runtime/小美画布.exe',
        };
        if (name === 'electron') return expected;
        if (name === 'child_process') return {
          spawn(exe, args, options) {
            starts.push({ exe, args, options });
            return { on() {} };
          },
        };
        return require(name);
      },
    });
    assert.equal(starts[0].exe, expected);
    assert.equal(starts[0].args[0], '.');
    assert.equal(starts[0].options.cwd, desktop);
  }
});

test('double-click and npm entry points select the branded launcher', () => {
  const launcher = fs.readFileSync(path.join(desktop, 'launch-hidden.vbs'), 'utf16le');
  assert.ok(launcher.indexOf('shell.Run brandCmd, 0, True') < launcher.indexOf('If fso.FileExists(brandedExe)'));
  assert.match(launcher, /brandedExe = root & ".*\\小美画布\.exe"/);
  assert.match(launcher, /If fso.FileExists\(brandedExe\) Then electronExe = brandedExe/);
  assert.match(launcher, /shellApp\.ShellExecute electronExe/);
  const { scripts } = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
  assert.equal(scripts.start, 'node start-branded.cjs');
  assert.equal(scripts.dev, scripts.start);
});

test('all Windows windows receive a complete taskbar identity matching the installer', () => {
  const identity = mainSource.match(/^const APP_USER_MODEL_ID = '([^']+)';/m)[1];
  const configuration = mainSource.slice(mainSource.indexOf("if (process.platform === 'win32') {\n  app.setAppUserModelId"), mainSource.indexOf("try {\n  app.setPath('userData'"));
  const builder = fs.readFileSync(path.resolve(desktop, '../electron-builder.yml'), 'utf8');
  assert.equal(builder.match(/^appId: (.+)$/m)[1], identity);
  for (const isPackaged of [false, true]) {
    const handlers = new Map();
    let appId;
    const context = {
      __dirname: desktop,
      APP_USER_MODEL_ID: identity,
      APP_NAME: '小美画布',
      APP_ICON_PATH: path.resolve(desktop, '../static/images/app-icon.ico'),
      process: { platform: 'win32', execPath: 'D:\\中文路径\\小美画布.exe' },
      console,
      app: {
        isPackaged,
        setAppUserModelId(value) { appId = value; },
        on(event, listener) { handlers.set(event, listener); },
      },
    };
    vm.runInNewContext(configuration, context);
    assert.equal(appId, identity);
    assert.equal(handlers.has('browser-window-created'), true);
    for (let count = 0; count < 2; count++) {
      let details;
      handlers.get('browser-window-created')({}, { setAppDetails(value) { details = value; } });
      assert.equal(details.appId, identity);
      assert.equal(details.appIconPath, context.APP_ICON_PATH);
      assert.equal(details.relaunchDisplayName, '小美画布');
      assert.equal(details.relaunchCommand, `"${context.process.execPath}"${isPackaged ? '' : ` "${desktop}"`}`);
    }
  }
});
