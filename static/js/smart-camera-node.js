(function(){
    'use strict';

    // SPDX-License-Identifier: GPL-3.0-or-later (adapted CainFlow camera control)
    // CainFlow camera-control behavior is adapted here for 小美画布.
    // Upstream: https://github.com/RingoCaviar/CainFlow
    // This file only compiles camera instructions; it never performs generation.
    const DEFAULT_STATE = Object.freeze({
        pitch:12,
        yaw:28,
        distance:6.5,
        fov:50,
        roll:0,
        cameraViewMode:'firstPerson',
        cameraPrompt:'',
        previewSnapshot:''
    });
    const LIMITS = Object.freeze({
        pitch:{min:-85, max:85, step:0.5},
        yaw:{min:-180, max:180, step:0.5},
        distance:{min:1.4, max:18, step:0.1},
        fov:{min:18, max:120, step:0.5},
        roll:{min:-45, max:45, step:0.5}
    });
    const CAMERA_FIELDS = ['pitch','yaw','distance','fov','roll'];

    function clamp(value, min, max){
        return Math.min(max, Math.max(min, value));
    }
    function numberOr(value, fallback){
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }
    function roundToStep(value, step){
        const factor = 1 / step;
        return Math.round(numberOr(value, 0) * factor) / factor;
    }
    function normalizeAngle(value){
        let angle = numberOr(value, 0);
        while(angle > 180) angle -= 360;
        while(angle < -180) angle += 360;
        return angle;
    }
    function normalizeField(value, field){
        const limit = LIMITS[field];
        return clamp(roundToStep(value, limit.step), limit.min, limit.max);
    }
    function hasCanonicalState(value){
        return CAMERA_FIELDS.some(field => Object.prototype.hasOwnProperty.call(value, field));
    }
    function legacyYaw(value){
        const angle = ((numberOr(value, 0) % 360) + 360) % 360;
        return angle > 180 ? angle - 360 : angle;
    }
    function legacyDistance(value){
        // The previous 0..10 zoom slider was wide -> close. Keep that intent
        // while mapping its midpoint to CainFlow's 6.5 default distance.
        const zoom = clamp(numberOr(value, 5), 0, 10);
        return clamp(12 - zoom * 1.1, LIMITS.distance.min, LIMITS.distance.max);
    }
    function normalizeCameraState(source){
        const value = source && typeof source === 'object' ? source : {};
        const canonical = hasCanonicalState(value);
        const pitch = canonical
            ? normalizeField(value.pitch ?? DEFAULT_STATE.pitch, 'pitch')
            : normalizeField(value.verticalAngle ?? DEFAULT_STATE.pitch, 'pitch');
        const yaw = canonical
            ? normalizeField(normalizeAngle(value.yaw ?? DEFAULT_STATE.yaw), 'yaw')
            : normalizeField(legacyYaw(value.horizontalAngle ?? DEFAULT_STATE.yaw), 'yaw');
        const distance = canonical
            ? normalizeField(value.distance ?? DEFAULT_STATE.distance, 'distance')
            : normalizeField(legacyDistance(value.zoom), 'distance');
        const fov = canonical
            ? normalizeField(value.fov ?? DEFAULT_STATE.fov, 'fov')
            : DEFAULT_STATE.fov;
        const roll = canonical
            ? normalizeField(value.roll ?? DEFAULT_STATE.roll, 'roll')
            : DEFAULT_STATE.roll;
        const cameraViewMode = value.cameraViewMode === 'thirdPerson' ? 'thirdPerson' : 'firstPerson';
        const state = {pitch, yaw, distance, fov, roll, cameraViewMode};
        state.cameraPrompt = generateCameraPrompt(state);
        state.previewSnapshot = typeof value.previewSnapshot === 'string' ? value.previewSnapshot : '';
        return state;
    }

    function dedupeSegments(segments=[]){
        const seen = new Set();
        return segments.filter(segment => {
            const key = String(segment || '').trim().toLowerCase();
            if(!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    function formatNumber(value, digits=1){
        return String(roundToStep(value, 10 ** (-digits)));
    }
    function getSubjectHorizontalDirection(yaw){
        return yaw >= 0 ? 'right' : 'left';
    }
    function getPitchLabel(pitch){
        if(pitch >= 60) return "bird's-eye top-down";
        if(pitch >= 32) return 'high-angle';
        if(pitch >= 12) return 'slightly high-angle';
        if(pitch <= -38) return "worm's-eye low-angle";
        if(pitch <= -16) return 'low-angle';
        if(pitch <= -6) return 'slightly low-angle';
        return 'eye-level';
    }
    function getPitchPlacementInstruction(pitch){
        const absPitch = Math.abs(pitch);
        if(absPitch < 3) return 'keep the camera at eye level';
        if(pitch > 0) return `raise the camera ${formatNumber(absPitch, 1)}° above eye level`;
        return `lower the camera ${formatNumber(absPitch, 1)}° below eye level and aim upward`;
    }
    function getYawLabel(yaw){
        const absYaw = Math.abs(yaw);
        const direction = getSubjectHorizontalDirection(yaw);
        if(absYaw <= 18) return 'front view centered on the subject';
        if(absYaw <= 68) return `${direction} front three-quarter view showing the front and ${direction} side of the subject`;
        if(absYaw <= 112) return `${direction} side profile view showing the subject mainly from the side`;
        if(absYaw <= 162) return `${direction} rear three-quarter view showing the back and ${direction} side of the subject`;
        return 'straight rear view showing the back of the subject';
    }
    function getYawPlacementInstruction(yaw){
        const absYaw = Math.abs(yaw);
        const direction = getSubjectHorizontalDirection(yaw);
        if(absYaw <= 5) return 'keep the camera centered on the subject front';
        if(absYaw >= 175) return 'move the camera to a full rear view behind the subject';
        return `orbit the camera ${formatNumber(absYaw, 1)}° toward the subject's ${direction} side from the front reference`;
    }
    function getDistanceProfile(distance){
        if(distance <= 2.4) return {shot:'an extreme close-up', goal:'fill almost the entire frame with subject details and leave only minimal background context'};
        if(distance <= 4) return {shot:'a close-up', goal:'keep the subject filling most of the frame with a tight crop and limited surrounding space'};
        if(distance <= 5.8) return {shot:'a medium close-up', goal:'keep the subject dominant in the frame with only a small amount of surrounding context'};
        if(distance <= 8.2) return {shot:'a medium shot', goal:'show the subject clearly while retaining some surrounding context'};
        if(distance <= 12) return {shot:'a full-body or full-object shot', goal:'keep the complete subject visible with comfortable margins around it'};
        return {shot:'a long shot', goal:'show the subject smaller within a wider environment and preserve clear environmental context'};
    }
    function getFovProfile(fov){
        if(fov < 28) return 'a super-telephoto lens look with strong perspective compression';
        if(fov < 42) return 'a telephoto lens look with compressed perspective and minimal distortion';
        if(fov < 65) return 'a natural standard-lens perspective';
        if(fov < 86) return 'a wide-angle lens perspective with visible spatial depth';
        if(fov < 108) return 'an ultra-wide-angle perspective with expanded space';
        return 'a fisheye-like ultra-wide perspective with strong edge distortion';
    }
    function getRollInstruction(roll){
        const absRoll = Math.abs(roll);
        if(absRoll < 3) return 'keep roll at 0° and the horizon level';
        const direction = roll > 0 ? 'clockwise' : 'counterclockwise';
        if(absRoll < 10) return `apply a ${formatNumber(absRoll, 1)}° ${direction} roll for a subtle Dutch angle`;
        if(absRoll < 20) return `apply a ${formatNumber(absRoll, 1)}° ${direction} roll for a noticeable Dutch angle`;
        return `apply a ${formatNumber(absRoll, 1)}° ${direction} roll for a strong Dutch angle`;
    }
    function getSideConsistencyInstruction(yaw){
        const absYaw = Math.abs(yaw);
        if(absYaw <= 18) return 'Keep the subject front-facing relative to the camera and do not mirror the image.';
        if(absYaw >= 162) return 'Reach the back view by moving the camera around the subject, not by flipping or mirroring the image.';
        const direction = getSubjectHorizontalDirection(yaw);
        return `Reveal the subject's ${direction} side by moving the camera around the subject, not by mirroring the image or swapping left and right details.`;
    }
    function generateCameraPrompt(cameraData={}){
        const normalized = normalizePromptState(cameraData);
        const {pitch, yaw, distance, fov, roll} = normalized;
        const viewpoint = dedupeSegments([getPitchLabel(pitch), getYawLabel(yaw)]).join(' ');
        const distanceProfile = getDistanceProfile(distance);
        const lensProfile = getFovProfile(fov);
        const cameraSpec = [
            `yaw ${formatNumber(yaw, 1)}°: ${getYawPlacementInstruction(yaw)}`,
            `pitch ${formatNumber(pitch, 1)}°: ${getPitchPlacementInstruction(pitch)}`,
            `distance ${formatNumber(distance, 2)}: frame as ${distanceProfile.shot}`,
            `FOV ${formatNumber(fov, 1)}°: use ${lensProfile}`,
            `roll ${formatNumber(roll, 1)}°: ${getRollInstruction(roll)}`
        ].join('; ');
        return [
            'Camera-only transformation of the same subject and scene.',
            `Camera specification: ${cameraSpec}.`,
            `Expected view: ${viewpoint}.`,
            `Framing goal: ${distanceProfile.goal}.`,
            `Strict constraints: keep the same subject identity, pose, proportions, outfit or materials, lighting, background, and scene layout. Change only the camera position, viewing angle, framing, lens perspective, and tilt. ${getSideConsistencyInstruction(yaw)}`
        ].join(' ');
    }
    function normalizePromptState(source){
        const value = source || {};
        return {
            pitch:normalizeField(value.pitch ?? DEFAULT_STATE.pitch, 'pitch'),
            yaw:normalizeField(normalizeAngle(value.yaw ?? DEFAULT_STATE.yaw), 'yaw'),
            distance:normalizeField(value.distance ?? DEFAULT_STATE.distance, 'distance'),
            fov:normalizeField(value.fov ?? DEFAULT_STATE.fov, 'fov'),
            roll:normalizeField(value.roll ?? DEFAULT_STATE.roll, 'roll')
        };
    }
    function stateForNode(node){
        return normalizeCameraState(node || DEFAULT_STATE);
    }
    function applyStateToNode(node, state){
        if(!node) return node;
        const next = normalizeCameraState({...node, ...(state || {})});
        node.pitch = next.pitch;
        node.yaw = next.yaw;
        node.distance = next.distance;
        node.fov = next.fov;
        node.roll = next.roll;
        node.cameraViewMode = next.cameraViewMode;
        node.cameraPrompt = next.cameraPrompt;
        node.text = next.cameraPrompt;
        if(typeof next.previewSnapshot === 'string') node.previewSnapshot = next.previewSnapshot;
        delete node.horizontalAngle;
        delete node.verticalAngle;
        delete node.zoom;
        return node;
    }
    function escapeHtml(value){
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function escapeAttr(value){
        return escapeHtml(value).replace(/\n/g, '&#10;');
    }
    function previewImageForNode(node){
        if(typeof window.smartCameraPreviewImageForNode === 'function'){
            try { return String(window.smartCameraPreviewImageForNode(node) || ''); } catch(e) {}
        }
        return '';
    }
    function previewMarkup(node){
        // After the editor closes, the rendered 2.5D snapshot is the useful
        // preview. Fall back to the untouched reference only before a
        // snapshot exists.
        const snapshot = String(node?.previewSnapshot || '');
        const image = snapshot || previewImageForNode(node);
        const alt = snapshot ? '已编辑的 2.5D 视角预览' : '参考图预览';
        if(image) return '<img class="camera-node-preview-image" src="' + escapeAttr(image) + '" alt="' + escapeAttr(alt) + '" loading="lazy">';
        return '<div class="camera-node-preview-empty"><i data-lucide="image-off"></i><span>等待连接参考图像</span></div>';
    }
    function valueLabel(value, suffix='°'){
        return `${escapeHtml(value)}${suffix}`;
    }
    function bodyHtml(node){
        const state = stateForNode(node);
        applyStateToNode(node, state);
        const previewLabel = state.previewSnapshot ? '2.5D 预览' : '参考图';
        return '<div class="camera-node-card">' +
            '<div class="camera-node-preview">' + previewMarkup(node) + '<span class="camera-preview-badge"><i data-lucide="camera"></i> ' + previewLabel + '</span></div>' +
            '<button class="camera-edit-btn" type="button"><i data-lucide="scan-eye"></i><span>编辑视角</span></button>' +
            '<div class="camera-node-values camera-node-values-wide">' +
                '<div><span>俯仰 Pitch</span><strong>' + valueLabel(state.pitch) + '</strong></div>' +
                '<div><span>偏航 Yaw</span><strong>' + valueLabel(state.yaw) + '</strong></div>' +
                '<div><span>距离 Distance</span><strong>' + valueLabel(state.distance, '') + '</strong></div>' +
                '<div><span>FOV</span><strong>' + valueLabel(state.fov) + '</strong></div>' +
                '<div><span>Roll</span><strong>' + valueLabel(state.roll) + '</strong></div>' +
            '</div>' +
            '<div class="camera-node-engine"><i data-lucide="camera"></i><span>相机提示词已内置，下游绘画节点自动使用</span></div>' +
            '<div class="camera-node-hints"><span><i data-lucide="arrow-down-to-line"></i>连接参考图像</span><span><i data-lucide="arrow-up-right"></i>连接下游绘画节点或提示词节点</span></div>' +
        '</div>';
    }

    let activeEditor = null;
    let threePromise = null;
    function loadThree(){
        if(!threePromise) threePromise = import('/static/vendor/js/three-0.160.0.module.js');
        return threePromise;
    }
    function editorMarkup(){
        const fields = [
            ['pitch','俯仰角 Pitch','-85° – 85°',-85,85,0.5],
            ['yaw','偏航角 Yaw','-180° – 180°',-180,180,0.5],
            ['distance','距离 Distance','1.4 – 18',1.4,18,0.1],
            ['fov','视野角 FOV','18° – 120°',18,120,0.5],
            ['roll','翻滚角 Roll','-45° – 45°',-45,45,0.5]
        ];
        const controls = fields.map(([key,label,range,min,max,step]) =>
            '<div class="smart-camera-control-group"><div class="smart-camera-control-head"><label for="smartCamera' + key + 'Range">' + label + '</label><span>' + range + '</span></div><div class="smart-camera-control-line"><input id="smartCamera' + key + 'Range" data-camera-field="' + key + '" type="range" min="' + min + '" max="' + max + '" step="' + step + '"><input data-camera-number="' + key + '" type="number" min="' + min + '" max="' + max + '" step="' + step + '" aria-label="' + label + '"></div></div>'
        ).join('');
        return '<div class="smart-camera-editor-backdrop" role="presentation">' +
            '<section class="smart-camera-editor" role="dialog" aria-modal="true" aria-labelledby="smartCameraEditorTitle">' +
                '<header class="smart-camera-editor-head"><div><span class="smart-camera-editor-kicker">CAINFLOW CAMERA CONTROL</span><h2 id="smartCameraEditorTitle">编辑视角</h2></div><button class="smart-camera-editor-close" type="button" aria-label="关闭"><i data-lucide="x"></i></button></header>' +
                '<div class="smart-camera-editor-main">' +
                    '<div class="smart-camera-stage-wrap"><div class="smart-camera-stage"><div class="smart-camera-stage-loading">正在加载 2.5D 预览…</div></div><p class="smart-camera-stage-help">拖拽调整水平 / 垂直视角，滚轮调整距离</p></div>' +
                    '<div class="smart-camera-editor-controls">' +
                        '<div class="smart-camera-view-mode"><span>预览模式</span><div><button type="button" data-camera-view-mode="firstPerson" aria-pressed="true">第一人称</button><button type="button" data-camera-view-mode="thirdPerson" aria-pressed="false">第三人称</button></div></div>' +
                        controls +
                        '<div class="smart-camera-editor-actions"><button class="smart-camera-reset" type="button"><i data-lucide="rotate-ccw"></i><span>重置</span></button><button class="smart-camera-done" type="button"><i data-lucide="check"></i><span>完成</span></button></div>' +
                        '<p class="smart-camera-editor-note"><i data-lucide="info"></i><span>预览是辅助构图的 2.5D 图片平面，不是三维重建。相机提示词已内置，实际生图由下游绘画节点完成。</span></p>' +
                    '</div>' +
                '</div>' +
            '</section>' +
        '</div>';
    }
    function createEditorDom(){
        const wrapper = document.createElement('div');
        wrapper.innerHTML = editorMarkup();
        const backdrop = wrapper.firstElementChild;
        document.body.appendChild(backdrop);
        return {
            backdrop,
            dialog:backdrop.querySelector('.smart-camera-editor'),
            stage:backdrop.querySelector('.smart-camera-stage'),
            loading:backdrop.querySelector('.smart-camera-stage-loading'),
            close:backdrop.querySelector('.smart-camera-editor-close'),
            reset:backdrop.querySelector('.smart-camera-reset'),
            done:backdrop.querySelector('.smart-camera-done'),
            fields:[...backdrop.querySelectorAll('[data-camera-field]')],
            numbers:[...backdrop.querySelectorAll('[data-camera-number]')],
            modes:[...backdrop.querySelectorAll('[data-camera-view-mode]')]
        };
    }
    function refreshEditorIcons(){
        try { if(typeof window.refreshIcons === 'function') window.refreshIcons(); } catch(e) {}
    }
    function setEditorMessage(session, message){
        if(session?.dom?.loading){
            session.dom.loading.textContent = message || '';
            session.dom.loading.classList.toggle('is-error', Boolean(message));
        }
    }
    function updateEditorForm(session){
        if(!session || activeEditor !== session) return;
        const state = session.state;
        session.dom.fields.forEach(input => { input.value = String(state[input.dataset.cameraField]); });
        session.dom.numbers.forEach(input => { input.value = String(state[input.dataset.cameraNumber]); });
        session.dom.modes.forEach(button => {
            const active = button.dataset.cameraViewMode === state.cameraViewMode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }
    function setEditorState(session, patch){
        if(!session || activeEditor !== session) return;
        const next = normalizeCameraState({...session.state, ...(patch || {})});
        const changed = CAMERA_FIELDS.some(field => next[field] !== session.state[field]) || next.cameraViewMode !== session.state.cameraViewMode;
        if(!changed) return;
        if(typeof session.options.onBeforeChange === 'function') session.options.onBeforeChange(session.node, {...session.state});
        session.state = next;
        applyStateToNode(session.node, next);
        updateEditorForm(session);
        updateThreeCamera(session);
        if(typeof session.options.onChange === 'function') session.options.onChange(session.node, next);
    }
    function bindEditorEvents(session){
        const cleanups = session.cleanups;
        const on = (target, event, handler, options) => {
            target.addEventListener(event, handler, options);
            cleanups.push(() => target.removeEventListener(event, handler, options));
        };
        session.dom.fields.forEach(input => on(input, 'input', () => setEditorState(session, {[input.dataset.cameraField]:input.value})));
        session.dom.numbers.forEach(input => {
            on(input, 'input', () => setEditorState(session, {[input.dataset.cameraNumber]:input.value}));
            on(input, 'change', () => { if(input.value === '') updateEditorForm(session); });
        });
        session.dom.modes.forEach(button => on(button, 'click', () => setEditorState(session, {cameraViewMode:button.dataset.cameraViewMode})));
        on(session.dom.reset, 'click', () => setEditorState(session, {...DEFAULT_STATE, previewSnapshot:session.state.previewSnapshot}));
        on(session.dom.close, 'click', () => closeEditor(session));
        on(session.dom.done, 'click', () => closeEditor(session));
        on(session.dom.backdrop, 'click', event => { if(event.target === session.dom.backdrop) closeEditor(session); });
        on(session.dom.stage, 'pointerdown', event => {
            if(event.button !== 0) return;
            session.drag = {x:event.clientX, y:event.clientY};
            session.dom.stage.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        on(session.dom.stage, 'pointermove', event => {
            if(!session.drag) return;
            const dx = event.clientX - session.drag.x;
            const dy = event.clientY - session.drag.y;
            session.drag = {x:event.clientX, y:event.clientY};
            if(session.state.cameraViewMode === 'thirdPerson'){
                session.observer.yaw = clamp(session.observer.yaw + dx * 0.5, -180, 180);
                session.observer.pitch = clamp(session.observer.pitch - dy * 0.35, -18, 78);
                updateObserverCamera(session);
                return;
            }
            setEditorState(session, {yaw:session.state.yaw + dx * 0.5, pitch:session.state.pitch - dy * 0.35});
        });
        on(session.dom.stage, 'pointerup', () => { session.drag = null; });
        on(session.dom.stage, 'pointercancel', () => { session.drag = null; });
        on(session.dom.stage, 'wheel', event => {
            event.preventDefault();
            if(session.state.cameraViewMode === 'thirdPerson'){
                session.observer.distance = clamp(session.observer.distance - event.deltaY * 0.02, 4.5, 28);
                updateObserverCamera(session);
                return;
            }
            setEditorState(session, {distance:session.state.distance - event.deltaY * 0.01});
        }, {passive:false});
        session.keydown = event => { if(event.key === 'Escape') closeEditor(session); };
        document.addEventListener('keydown', session.keydown);
        cleanups.push(() => document.removeEventListener('keydown', session.keydown));
    }
    function editorStageSize(session){
        const rect = session.dom.stage.getBoundingClientRect();
        return {width:Math.max(280, Math.round(rect.width || 640)), height:Math.max(180, Math.round(rect.height || 360))};
    }
    function controlledCameraPosition(session){
        const state = session.state;
        const azimuth = state.yaw * Math.PI / 180;
        const elevation = state.pitch * Math.PI / 180;
        const target = session.cameraTarget || {x:0, y:1.2, z:0};
        const flatDistance = state.distance * Math.cos(elevation);
        return {x:Math.sin(azimuth) * flatDistance, y:target.y + Math.sin(elevation) * state.distance, z:Math.cos(azimuth) * flatDistance};
    }
    function updateThreeCamera(session){
        const camera = session.camera;
        if(!camera) return;
        const target = session.cameraTarget || {x:0, y:1.2, z:0};
        const position = controlledCameraPosition(session);
        camera.position.set(position.x, position.y, position.z);
        camera.fov = session.state.fov;
        camera.lookAt(target.x, target.y, target.z);
        camera.rotateZ(session.state.roll * Math.PI / 180);
        camera.updateProjectionMatrix();
        if(session.cameraModel){
            session.cameraModel.position.set(position.x, position.y, position.z);
            session.cameraModel.lookAt(target.x, target.y, target.z);
        }
        updateObserverCamera(session);
    }
    function updateObserverCamera(session){
        const camera = session.observerCamera;
        if(!camera) return;
        const target = session.cameraTarget || {x:0, y:1.2, z:0};
        const yaw = session.observer.yaw * Math.PI / 180;
        const pitch = session.observer.pitch * Math.PI / 180;
        const distance = session.observer.distance;
        const flat = distance * Math.cos(pitch);
        camera.position.set(Math.sin(yaw) * flat, target.y + Math.sin(pitch) * distance, Math.cos(yaw) * flat);
        camera.lookAt(target.x, target.y, target.z);
        camera.updateProjectionMatrix();
        if(session.cameraModel) session.cameraModel.visible = session.state.cameraViewMode === 'thirdPerson';
    }
    function disposeMaterial(material){
        if(!material) return;
        const materials = Array.isArray(material) ? material : [material];
        materials.forEach(item => {
            if(item?.map?.dispose) item.map.dispose();
            if(item?.normalMap?.dispose) item.normalMap.dispose();
            item?.dispose?.();
        });
    }
    function disposeThree(session){
        if(!session) return;
        if(session.raf) cancelAnimationFrame(session.raf);
        session.raf = 0;
        if(session.scene){
            session.scene.traverse(object => { object.geometry?.dispose?.(); disposeMaterial(object.material); });
        }
        session.texture?.dispose?.();
        session.renderer?.dispose?.();
        session.renderer?.forceContextLoss?.();
        if(session.renderer?.domElement?.parentNode) session.renderer.domElement.parentNode.removeChild(session.renderer.domElement);
        session.scene = null;
        session.camera = null;
        session.observerCamera = null;
        session.cameraModel = null;
        session.renderer = null;
        session.texture = null;
        session.plane = null;
    }
    function renderThree(session){
        if(!session.renderer || !session.scene || !session.camera || activeEditor !== session) return;
        const camera = session.state.cameraViewMode === 'thirdPerson' ? session.observerCamera : session.camera;
        session.renderer.render(session.scene, camera);
        session.raf = requestAnimationFrame(() => renderThree(session));
    }
    function resizeThree(session){
        if(!session.renderer || !session.camera) return;
        const size = editorStageSize(session);
        session.renderer.setSize(size.width, size.height, false);
        [session.camera, session.observerCamera].filter(Boolean).forEach(camera => {
            camera.aspect = size.width / size.height;
            camera.updateProjectionMatrix();
        });
    }
    function setImagePlane(session, THREE, texture, imageWidth, imageHeight){
        if(!session.plane) return;
        const aspect = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : 1;
        session.plane.geometry.dispose();
        session.plane.geometry = new THREE.PlaneGeometry(4.8, 4.8 / aspect);
        session.plane.material.map = texture;
        session.plane.material.needsUpdate = true;
        session.texture = texture;
    }
    function initThree(session, THREE){
        if(activeEditor !== session) return;
        try {
            const size = editorStageSize(session);
            const canvas = document.createElement('canvas');
            canvas.className = 'smart-camera-renderer';
            const loading = session.dom.loading;
            session.dom.stage.innerHTML = '';
            session.dom.stage.appendChild(canvas);
            if(loading) session.dom.stage.appendChild(loading);
            const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true, preserveDrawingBuffer:true});
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.setSize(size.width, size.height, false);
            if('outputColorSpace' in renderer && THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
            const scene = new THREE.Scene();
            scene.background = new THREE.Color(document.body.classList.contains('studio-theme-dark') ? 0x0d111b : 0xf2f5fb);
            const camera = new THREE.PerspectiveCamera(DEFAULT_STATE.fov, size.width / size.height, 0.1, 100);
            const observerCamera = new THREE.PerspectiveCamera(52, size.width / size.height, 0.1, 100);
            const grid = new THREE.GridHelper(12, 24, 0x8b6cff, 0xcbd5e1);
            grid.position.y = -1.3;
            scene.add(grid);
            const axes = new THREE.AxesHelper(3.2);
            axes.position.y = -1.3;
            scene.add(axes);
            const planeMaterial = new THREE.MeshBasicMaterial({color:0x283142, side:THREE.DoubleSide});
            const plane = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 4.8), planeMaterial);
            plane.position.y = 1.2;
            scene.add(plane);
            const cameraModel = new THREE.Group();
            const cameraBody = new THREE.Mesh(new THREE.BoxGeometry(.42,.28,.62), new THREE.MeshBasicMaterial({color:0x8b5cf6, wireframe:true}));
            const cameraLens = new THREE.Mesh(new THREE.CylinderGeometry(.12,.12,.18,16), new THREE.MeshBasicMaterial({color:0x38bdf8, wireframe:true}));
            cameraLens.rotation.x = Math.PI / 2;
            cameraLens.position.z = -.38;
            cameraModel.add(cameraBody, cameraLens);
            scene.add(cameraModel);
            session.THREE = THREE;
            session.renderer = renderer;
            session.scene = scene;
            session.camera = camera;
            session.observerCamera = observerCamera;
            session.cameraModel = cameraModel;
            session.plane = plane;
            session.cameraTarget = {x:0, y:1.2, z:0};
            updateThreeCamera(session);
            const source = typeof session.options.getPreviewImage === 'function' ? session.options.getPreviewImage(session.node) : session.options.previewImage;
            if(source){
                const loader = new THREE.TextureLoader();
                loader.load(String(source), texture => {
                    if(activeEditor !== session){ texture.dispose(); return; }
                    const image = texture.image || {};
                    if('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
                    setImagePlane(session, THREE, texture, Number(image.width) || 1, Number(image.height) || 1);
                    setEditorMessage(session, '');
                }, undefined, () => setEditorMessage(session, '参考图无法加载，仍可调整视角'));
            } else {
                setEditorMessage(session, '请先连接参考图像，当前显示为空场景');
            }
            session.resize = () => resizeThree(session);
            window.addEventListener('resize', session.resize);
            session.cleanups.push(() => window.removeEventListener('resize', session.resize));
            resizeThree(session);
            renderThree(session);
        } catch(error) {
            setEditorMessage(session, 'Three.js 预览加载失败：' + (error?.message || '未知错误'));
        }
    }
    function captureSnapshot(session){
        const source = session?.renderer?.domElement;
        if(!source || !source.width || !source.height) return '';
        try {
            const scale = Math.min(1, 360 / source.width, 240 / source.height);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(source.width * scale));
            canvas.height = Math.max(1, Math.round(source.height * scale));
            const context = canvas.getContext('2d');
            context.drawImage(source, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.72);
        } catch(e) { return ''; }
    }
    function closeEditor(session=activeEditor){
        if(!session || activeEditor !== session) return;
        const snapshot = captureSnapshot(session);
        if(snapshot){
            session.node.previewSnapshot = snapshot;
            session.state.previewSnapshot = snapshot;
        }
        session.cleanups.splice(0).forEach(cleanup => { try { cleanup(); } catch(e) {} });
        disposeThree(session);
        session.dom.backdrop.remove();
        activeEditor = null;
        if(typeof session.options.onClose === 'function') session.options.onClose(session.node, snapshot);
    }
    function openEditor(node, options={}){
        if(!node) return;
        if(activeEditor) closeEditor(activeEditor);
        const state = stateForNode(node);
        applyStateToNode(node, state);
        const dom = createEditorDom();
        const session = {
            node,
            state,
            options,
            dom,
            cleanups:[],
            drag:null,
            observer:{yaw:32, pitch:24, distance:11},
            renderer:null,
            scene:null,
            camera:null,
            observerCamera:null,
            cameraModel:null,
            plane:null,
            texture:null,
            raf:0
        };
        activeEditor = session;
        dom.backdrop.classList.add('open');
        updateEditorForm(session);
        bindEditorEvents(session);
        refreshEditorIcons();
        loadThree().then(THREE => initThree(session, THREE)).catch(error => setEditorMessage(session, 'Three.js 预览加载失败：' + (error?.message || '未知错误')));
    }
    function bindNode(element, node, options={}){
        const button = element?.querySelector?.('.camera-edit-btn');
        if(!button) return;
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openEditor(node, options);
        });
    }
    function syncCreateMenuCopy(){
        document.querySelectorAll('.camera-create-card .create-card-title').forEach(el => { el.textContent = '视角控制'; });
        document.querySelectorAll('.camera-create-card .create-card-sub').forEach(el => { el.textContent = '内置相机控制，参考图可传递到绘画'; });
    }

    window.smartCameraDefaultState = function(){
        const state = {...DEFAULT_STATE};
        state.cameraPrompt = generateCameraPrompt(state);
        return state;
    };
    window.smartCameraLimits = JSON.parse(JSON.stringify(LIMITS));
    window.smartCameraNormalizeState = normalizeCameraState;
    window.smartCameraPromptForState = source => normalizeCameraState(source).cameraPrompt;
    window.smartCameraBuckets = {limits:JSON.parse(JSON.stringify(LIMITS))};
    window.SmartCameraNode = {bodyHtml, bindNode, openEditor, closeEditor, stateForNode, compilePrompt:source => normalizeCameraState(source).cameraPrompt};
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncCreateMenuCopy, {once:true});
    else syncCreateMenuCopy();
})();
