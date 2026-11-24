import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workbench = path.resolve(process.argv[2] || '.', 'tools/video-workbench');
const require = createRequire(path.join(workbench, 'package.json'));
await import(pathToFileURL(path.join(workbench, 'server.js')).href);

const sharp = require('sharp');
const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
assert.equal((await sharp(image).metadata()).width, 1);
for (const name of ['@ffmpeg-installer/ffmpeg', '@ffprobe-installer/ffprobe']) {
  execFileSync(require(name).path, ['-version'], { windowsHide: true, timeout: 15000 });
}

const { FISH_VOICES } = await import(pathToFileURL(path.join(workbench, 'fish-voices.js')).href);
assert.ok(FISH_VOICES.length > 0);
await Promise.all(FISH_VOICES.map(({ id }) => access(path.join(workbench, 'public', 'voice-previews', `${id}.mp3`))));
console.log('Video workbench runtime and voice previews passed');
