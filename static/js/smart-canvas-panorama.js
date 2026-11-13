(function (root) {
    'use strict';

    const ratios = {
        square: [1, 1], portrait: [2, 3], landscape: [3, 2],
        portrait43: [3, 4], landscape43: [4, 3], story: [9, 16],
        wide: [16, 9], ultrawide: [21, 9], ultratall: [9, 21]
    };
    const limit = (number, low, high) => Math.min(high, Math.max(low, number));

    function create(host) {
        const doc = root.document;
        const get = id => doc.getElementById(id);
        const stage = get('panoramaStage');
        const surface = get('panoramaCanvas');
        const preview = get('previewStage');
        const frame = get('previewFrame');
        const controls = get('panoramaControls');
        const custom = get('panoramaCustomRatio');
        const fields = [get('panoramaRatioW'), get('panoramaRatioH')];
        const buttons = Array.from(controls.querySelectorAll('[data-panorama-ratio]'));
        let orientation = { yaw: 0, pitch: 0 };
        let fov = 75;
        let ratio = 'wide';
        let dimensions = [16, 9];
        let active = false;
        let texture;
        let loader;
        let generation = 0;
        let pendingFrame = 0;
        let sceneTask;
        let world;

        function paintControls() {
            controls.style.display = active ? 'inline-flex' : 'none';
            custom.style.display = active && ratio === 'custom' ? 'inline-flex' : 'none';
            for (const button of buttons) button.classList.toggle('active', button.dataset.panoramaRatio === ratio);
            fields.forEach((field, index) => {
                if (doc.activeElement !== field) field.value = dimensions[index];
            });
        }

        function paintStage() {
            preview.classList.toggle('panorama-on', active);
            get('imagePreviewTools').classList.toggle('panorama-tools-on', active);
            stage.style.display = active ? 'block' : 'none';
            get('panoramaToggleBtn').classList.toggle('active', active);
            get('panoramaExportBtn').style.display = active ? 'inline-flex' : 'none';
            paintControls();
        }

        function draw() {
            if (!active || !world || !texture) return false;
            const { renderer, scene, camera } = world;
            const radians = Math.PI / 180;
            const pitch = orientation.pitch * radians;
            const yaw = orientation.yaw * radians;
            camera.fov = fov;
            camera.aspect = surface.width / surface.height;
            camera.updateProjectionMatrix();
            camera.lookAt(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
            renderer.render(scene, camera);
            return true;
        }

        function queueDraw() {
            if (pendingFrame || !active || !texture) return;
            pendingFrame = root.requestAnimationFrame(() => {
                pendingFrame = 0;
                draw();
            });
        }

        function resize() {
            if (!active) return;
            const [width, height] = ratios[ratio] || dimensions;
            const outputAspect = width / height;
            const windowAspect = limit(outputAspect, 0.08, 12);
            const availableW = limit(root.innerWidth - 116, 260, 1180);
            const availableH = limit(root.innerHeight - 220, 220, 780);
            const fittedW = Math.min(availableW, availableH * windowAspect);
            const displayW = Math.max(160, Math.round(fittedW));
            const displayH = Math.max(160, Math.round(fittedW / windowAspect));
            stage.style.width = frame.style.width = displayW + 'px';
            stage.style.height = frame.style.height = displayH + 'px';
            stage.style.aspectRatio = width + ' / ' + height;
            const exportScale = 1536 / Math.max(width, height);
            const w = Math.max(1, Math.round(width * exportScale));
            const h = Math.max(1, Math.round(height * exportScale));
            if (world) {
                if (surface.width !== w || surface.height !== h) world.renderer.setSize(w, h, false);
            } else {
                surface.width = w;
                surface.height = h;
            }
            queueDraw();
        }

        async function createScene() {
            const Three = await import('/static/vendor/js/three-0.160.0.module.js?v=2026.05.30');
            const renderer = new Three.WebGLRenderer({ canvas: surface, antialias: true, alpha: false, preserveDrawingBuffer: true });
            renderer.setPixelRatio(1);
            renderer.outputColorSpace = Three.SRGBColorSpace;
            const scene = new Three.Scene();
            const camera = new Three.PerspectiveCamera(75, 16 / 9, 1, 1200);
            const geometry = new Three.SphereGeometry(500, 96, 64);
            geometry.scale(-1, 1, 1);
            const material = new Three.MeshBasicMaterial({ color: 0xffffff });
            scene.add(new Three.Mesh(geometry, material));
            renderer.setSize(surface.width, surface.height, false);
            return { renderer, scene, camera, material, Three };
        }

        function prepare() {
            sceneTask ||= createScene().then(result => {
                world = result;
                return world;
            }).catch(error => {
                sceneTask = null;
                throw error;
            });
            return sceneTask;
        }

        function releaseTexture() {
            if (!texture) return;
            world.material.map = null;
            world.material.needsUpdate = true;
            texture.dispose();
            texture = null;
        }

        function cancelImage() {
            if (!loader) return;
            loader.onload = loader.onerror = null;
            loader.removeAttribute('src');
            loader = null;
        }

        function fail(token) {
            if (token !== generation || !active) return;
            stage.classList.add('ready');
            host.error(host.label('smart.panoramaLoadFailed'));
        }

        function load(urls, token) {
            if (token !== generation || !active) return;
            const [url, ...rest] = urls;
            if (!url) {
                fail(token);
                return;
            }
            const image = new root.Image();
            loader = image;
            image.crossOrigin = 'anonymous';
            image.onload = () => {
                if (image !== loader || token !== generation) return;
                image.onload = image.onerror = null;
                loader = null;
                releaseTexture();
                texture = new world.Three.Texture(image);
                texture.colorSpace = world.Three.SRGBColorSpace;
                texture.needsUpdate = true;
                world.material.map = texture;
                world.material.needsUpdate = true;
                stage.classList.add('ready');
                resize();
            };
            image.onerror = () => {
                if (image !== loader || token !== generation) return;
                image.onload = image.onerror = null;
                loader = null;
                load(rest, token);
            };
            image.src = url;
        }

        function enter(item) {
            if (active || !item?.url) return;
            active = true;
            const token = ++generation;
            const sources = [...new Set([host.display(item), host.proxy(item)].filter(Boolean))];
            stage.classList.remove('ready');
            paintStage();
            resize();
            prepare().then(() => load(sources, token), () => fail(token));
        }

        function leave() {
            if (!active) return;
            active = false;
            ++generation;
            cancelImage();
            if (pendingFrame) root.cancelAnimationFrame(pendingFrame);
            pendingFrame = 0;
            releaseTexture();
            if (world) world.renderer.clear();
            stage.classList.remove('ready');
            frame.style.width = frame.style.height = '';
            paintStage();
        }

        function zoom(delta) {
            fov = limit(fov * (delta < 0 ? 0.92 : 1 / 0.92), 35, 100);
            host.zoomChanged();
            queueDraw();
        }

        function orbit(start, dx, dy) {
            orientation = { yaw: start.yaw - dx * 0.18, pitch: limit(start.pitch + dy * 0.18, -85, 85) };
            queueDraw();
        }

        function reset() {
            orientation = { yaw: 0, pitch: 0 };
            fov = 75;
            host.zoomChanged();
            queueDraw();
        }

        async function capture() {
            if (!draw()) return null;
            const { width, height } = surface;
            const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
            return blob && { blob, width, height };
        }

        for (const button of buttons) {
            button.addEventListener('click', event => {
                event.stopPropagation();
                ratio = button.dataset.panoramaRatio;
                paintControls();
                resize();
            });
        }
        for (const field of fields) {
            field.addEventListener('input', () => {
                ratio = 'custom';
                dimensions = fields.map((field, index) => limit(Number(field.value) || [16, 9][index], 1, 999));
                paintControls();
                resize();
            });
        }

        return { enter, leave, resize, zoom, orbit, reset, capture,
            position: () => orientation, enabled: () => active, scale: () => 75 / fov };
    }

    root.XiaomeiSmartCanvasPanorama = { create };
})(window);
