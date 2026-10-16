const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.cjs'), 'utf8');
const syncSource = source.match(/^function syncXiaomeiHarnessWorkspace\([^]*?^}/m)[0];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-harness-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, '小美画布');
  const home = path.join(project, '.xiaomei-data', 'deepseek-harness');
  const file = path.join(home, 'storages', 'workspace.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const context = vm.createContext({ fs, path, crypto, PROJECT_ROOT: project, console });
  vm.runInContext(syncSource, context);
  return { file, home, project, sync: () => context.syncXiaomeiHarnessWorkspace(home) };
}

test('a corrupt workspace index is backed up and rebuilt for session discovery', t => {
  const f = fixture(t);
  const damaged = Buffer.alloc(1113);
  fs.writeFileSync(f.file, damaged);

  f.sync();

  const backups = fs.readdirSync(path.dirname(f.file)).filter(name => name.startsWith('workspace.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(f.file), backups[0])), damaged);
  const restored = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(restored.unit.name, 'workspace');
  assert.equal(restored.unit.version, 2);
  assert.equal(restored.global.initialized, false);
  const primary = restored.tables.workspaces[restored.global.defaultWorkspaceId];
  assert.equal(primary.path, f.project);
  assert.equal(primary.title, '小美画布工作区');
});

test('a healthy workspace index remains untouched and retains other workspaces', t => {
  const f = fixture(t);
  const original = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['primary', 'other'], defaultWorkspaceId: 'primary', archivedSessionIds: ['session-1'], pinnedSessionIds: [] },
    tables: { workspaces: {
      primary: { path: f.project, title: '小美画布工作区', sessionIds: ['session-1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      other: { path: path.join(f.project, 'other'), title: 'other', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    } },
  };
  const bytes = JSON.stringify(original, null, 2) + '\n';
  fs.writeFileSync(f.file, bytes);

  f.sync();

  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['workspace.json']);
});

test('an unsupported workspace version is preserved for explicit diagnosis', t => {
  const f = fixture(t);
  const bytes = JSON.stringify({ unit: { name: 'workspace', version: 3 }, global: {}, tables: {} });
  fs.writeFileSync(f.file, bytes);
  assert.throws(() => f.sync(), /版本不匹配/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
});

test('session bootstrap order does not replace the primary workspace', t => {
  const f = fixture(t);
  const state = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['other', 'primary'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {
      other: { path: path.join(f.project, 'other'), title: 'other', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      primary: { path: f.project, title: '小美画布工作区', sessionIds: ['session-1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    } },
  };
  fs.writeFileSync(f.file, JSON.stringify(state));

  f.sync();

  const restored = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(restored.global.defaultWorkspaceId, 'primary');
  assert.deepEqual(restored.global.workspaceIds, ['primary', 'other']);
  assert.equal(restored.tables.workspaces.other.title, 'other');
});
