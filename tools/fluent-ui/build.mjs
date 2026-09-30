import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { webLightTheme, webDarkTheme } from '@fluentui/tokens';

const output = new URL('../../static/vendor/fluent/', import.meta.url);
await mkdir(output, { recursive: true });
await build({
    entryPoints: [fileURLToPath(new URL('./entry.js', import.meta.url))],
    outfile: fileURLToPath(new URL('fluent.js', output)),
    bundle: true, minify: true, format: 'esm', target: 'chrome124',
    legalComments: 'linked',
});
const rules = (selector, theme) => `${selector}{${Object.entries(theme).map(([key, value]) => `--${key}:${value};`).join('')}}`;
await writeFile(new URL('tokens.css', output),
    '/* Generated from @fluentui/tokens. Rebuild: npm run build --prefix tools/fluent-ui */\n' +
    rules(':where(html)', webLightTheme) + '\n' + rules(':where(html.studio-theme-dark)', webDarkTheme) + '\n');
for (const [pkg, name] of [['@fluentui/tokens', 'fluent-tokens'], ['tslib', 'tslib']]) {
    const base = new URL(`./node_modules/${pkg}/`, import.meta.url);
    await copyFile(new URL(pkg === 'tslib' ? 'LICENSE.txt' : 'LICENSE', base), new URL(`${name}-LICENSE.txt`, output));
}
