import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.argv[2] || join(appRoot, 'bundled', 'deepseek-harness'));
const node = resolve(process.argv[3] || (process.platform === 'win32'
  ? join(appRoot, 'bundled', 'node', 'node.exe')
  : join(appRoot, 'bundled', 'node', 'bin', 'node')));
const entry = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js');
for (const file of [node, entry, join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), join(runtime, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')]) {
  if (!existsSync(file)) throw new Error(`Harness smoke input is missing: ${file}`);
}
const home = mkdtempSync(join(tmpdir(), 'xiaomei-harness-smoke-'));
const profile = join(home, 'profile');
const scoped = join(profile, 'node_modules', '@deepseek-ai');
mkdirSync(scoped, { recursive: true });
const primaryNode = join(home, 'primary', 'dependencies', 'node', 'bin');
const officeScripts = join(home, 'office-skills', 'scripts');
mkdirSync(primaryNode, { recursive: true });
mkdirSync(officeScripts, { recursive: true });
cpSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-skill-office', 'assets'), join(home, 'office-skills'), { recursive: true, force: true });
writeFileSync(join(primaryNode, process.platform === 'win32' ? 'node.exe' : 'node'), '');
writeFileSync(join(officeScripts, 'check_office.py'), '# smoke placeholder\n');
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'xiaomei-harness-smoke', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, null, 2));
for (const name of ['dsh-base', 'dsh-web-app', 'dsh-skill-filesystem', 'dsh-session-persistence-jsonl']) {
  symlinkSync(join(runtime, 'node_modules', '@deepseek-ai', name), join(scoped, name), process.platform === 'win32' ? 'junction' : 'dir');
}
const child = spawn(node, [entry, runtime, profile, join(home, 'primary')], {
  cwd: runtime, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, DSH_HOME: home, DSH_WEB_PORT: '0' },
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 6000); });
child.stdout.resume();
let settled = false;
const finish = (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.kill();
  rmSync(home, { recursive: true, force: true });
  if (error) { console.error(error.message, stderr); process.exitCode = 1; }
  else console.log('Packaged DeepSeek Harness Host became ready');
};
const timer = setTimeout(() => finish(new Error('Harness Host did not become ready within 60 seconds')), 60000);
child.on('message', message => {
  if (message?.type === 'ready') finish();
  if (message?.type === 'fatal') finish(new Error(`Harness Host failed: ${message.message}\n${message.diagnostic || ''}`));
});
child.on('error', finish);
child.on('exit', code => finish(new Error(`Harness Host exited before readiness (${code})`)));
