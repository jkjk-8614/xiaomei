import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopRuntimeFileExclusion } from '../vendor/deepseek-harness/apps/desktop/scripts/runtime-file-policy.ts';
import { selectOfficeEngine } from '../vendor/deepseek-harness/scripts/libreoffice-packages.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(appRoot, 'vendor', 'deepseek-harness');
const output = join(appRoot, 'bundled', 'deepseek-harness');
const nodeOutput = process.platform === 'win32'
  ? join(appRoot, 'bundled', 'node', 'node.exe')
  : join(appRoot, 'bundled', 'node', 'bin', 'node');
const work = mkdtempSync(join(tmpdir(), 'xiaomei-harness-build-'));
const dshPacks = join(work, 'dsh');
const vendorPacks = join(work, 'vendor');
const nativePacks = join(work, 'native');
const packageSet = join(work, 'package-set');
const stage = join(work, 'runtime');

function run(command, args, cwd = source) {
  const result = spawnSync(command, args, {
    cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'pnpm',
    env: { ...process.env, PATH: `${join(source, 'node_modules', '.bin')}${delimiter}${process.env.PATH || ''}` },
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function pnpm(args, cwd = source) {
  const pinned = join(source, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
  if (existsSync(pinned)) run(process.execPath, [pinned, ...args], cwd);
  else run('pnpm', args, cwd);
}

try {
  if (!existsSync(join(source, 'packages', 'storage', 'storage', 'package.json'))) {
    throw new Error('Harness storage source is missing');
  }
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  run(process.execPath, ['--version']);
  pnpm(['--version']);
  pnpm(['install', '--no-frozen-lockfile']);
  pnpm(['run', 'build:lib:host']);
  pnpm(['run', 'build:lib:client']);
  pnpm(['run', 'build:web']);
  pnpm(['run', 'build:official']);
  pnpm(['run', 'release:pack', '--family', 'dsh', '--out', dshPacks, '--concurrency', '8']);
  pnpm(['run', 'release:pack', '--family', 'vendor', '--out', vendorPacks, '--concurrency', '4']);
  pnpm(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', dshPacks]);
  pnpm(['--dir', 'native/system', 'run', 'build:ts']);
  pnpm(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', nativePacks]);
  pnpm(['--dir', 'apps/desktop', 'run', 'prepare:packages', '--from', dshPacks, '--from', vendorPacks, '--from', nativePacks, '--out', packageSet]);

  mkdirSync(stage, { recursive: true });
  cpSync(packageSet, stage, { recursive: true });
  const metadataCode = `import { createRuntimeProjectMetadata } from './apps/desktop/src/project-manager.ts'; createRuntimeProjectMetadata(${JSON.stringify(stage)}, {version: ${JSON.stringify(version)}});`;
  run(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', metadataCode]);
  pnpm(['install', '--lockfile-only', '--config.enable-global-virtual-store=false'], stage);
  pnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile', '--config.enable-global-virtual-store=false'], stage);

  const host = join(stage, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js');
  const dsh = join(stage, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const base = join(stage, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json');
  const web = join(stage, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json');
  for (const file of [host, dsh, base, web]) {
    if (!existsSync(file)) throw new Error(`Prepared Harness runtime is incomplete: ${file}`);
  }
  const modules = join(stage, 'node_modules');
  const kit = JSON.parse(readFileSync(join(modules, '@deepseek-ai', 'libreoffice-kit', 'package.json'), 'utf8'));
  const target = { platform: process.platform, arch: process.arch };
  const officeEngine = selectOfficeEngine(kit, target);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(modules, join(output, 'node_modules'), {
    recursive: true, dereference: true,
    filter: file => desktopRuntimeFileExclusion(relative(modules, file), target, officeEngine) === undefined,
  });
  writeFileSync(join(output, 'package.json'), JSON.stringify({ name: 'xiaomei-harness-runtime', private: true, type: 'module', version }, null, 2) + '\n');
  mkdirSync(dirname(nodeOutput), { recursive: true });
  cpSync(process.execPath, nodeOutput);
  console.log(`Harness runtime prepared for ${process.platform}/${process.arch}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
