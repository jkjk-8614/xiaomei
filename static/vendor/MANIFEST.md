# Local Vendor Assets

This folder contains third-party assets mirrored locally so the app can load without CDN access.

## JavaScript

- `fluent/fluent.js` and `fluent/tokens.css`: local build of Microsoft Fluent UI Web Components, Fluent tokens and FAST Element. Package versions are locked in `tools/fluent-ui/package-lock.json`; rebuild instructions are in `交付文档/依赖与资源清单.md`. Licenses are distributed alongside the bundle.

- `js/perfect-freehand-1.2.3.js`: local browser build of `https://github.com/steveruizok/perfect-freehand` (MIT)
- `js/qrcode-generator-2.0.4.js` + `js/qrcode-generator-utf8-2.0.4.js`: local browser build of `https://github.com/kazuhikoarase/qrcode-generator` (MIT), used for local Device Flow QR rendering
- `js/tailwindcss-cdn.js`: local mirror of `https://cdn.tailwindcss.com`
- `js/lucide.js`: local mirror of `https://unpkg.com/lucide@latest`
- `js/three-0.160.0.module.js`: local mirror of `https://unpkg.com/three@0.160.0/build/three.module.js`

- `js/ag-psd-seethrough.bundle.js`: upstream SeeThrough bundled ag-psd, copied from `jtydhr88/ComfyUI-See-through` commit `98d754bf04f668647919ab750eccb0e0640faa81`; the local export table additionally exposes the bundled `readPsd` for verification and `initializeCanvas` for OffscreenCanvas in a Web Worker. PSD encoding runs locally. Shared export entry: `static/js/image-layer-psd.js` (`XiaomeiLayerPsd.build`), used by ComfyUI and canvas AI layers; encoding/verification worker: `static/js/image-layer-psd-worker.js`. Licenses in `js/ag-psd-LICENSE.txt` and `js/pako-LICENSE.txt`.

## CSS

- `css/fonts.css`: local `@font-face` declarations used by all pages.

## Fonts

- `fonts/inter-5.ttf`: Inter 300
- `fonts/inter-4.ttf`: Inter 400
- `fonts/inter-3.ttf`: Inter 500
- `fonts/inter-2.ttf`: Inter 600
- `fonts/inter-1.ttf`: Inter 800
- `fonts/jetbrains-mono-7.ttf`: JetBrains Mono 400
- `fonts/jetbrains-mono-6.ttf`: JetBrains Mono 700
- `fonts/space-grotesk-9.ttf`: Space Grotesk 300
- `fonts/space-grotesk-10.ttf`: Space Grotesk 500
- `fonts/space-grotesk-8.ttf`: Space Grotesk 700
