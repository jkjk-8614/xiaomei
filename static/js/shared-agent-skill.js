(function (global) {
    'use strict';

    const KEY = 'xiaomei_agent_skill_selection_v1';
    const LEGACY_SKILL_ALIASES = Object.freeze({
        'dabi-browser': 'browser-agent',
    });
    let skillListPromise = null;

    function normalizeId(value) {
        return String(value || '').trim();
    }

    function canonicalId(value) {
        const id = normalizeId(value);
        return Object.prototype.hasOwnProperty.call(LEGACY_SKILL_ALIASES, id) ? LEGACY_SKILL_ALIASES[id] : id;
    }

    function getSelected(fallback = '') {
        try {
            const raw = localStorage.getItem(KEY);
            // An explicit empty choice must take precedence over older panel preferences.
            const stored = normalizeId(raw === null ? fallback : raw);
            const selected = canonicalId(stored);
            if (selected !== stored) {
                try { localStorage.setItem(KEY, selected); } catch (_) {}
            }
            return selected;
        } catch (error) {
            return '';
        }
    }

    function setSelected(value) {
        const id = canonicalId(value);
        try {
            // 保留空字符串而不是删除键，兼容旧版小美画布的 storage 监听。
            localStorage.setItem(KEY, id);
        } catch (error) {}
        try {
            window.dispatchEvent(new CustomEvent('studio-shared-skill-change', {
                detail: { id }
            }));
        } catch (error) {}
        return id;
    }

    async function load(force = false) {
        if (!force && skillListPromise) return skillListPromise;
        skillListPromise = fetch('/api/agent-skills', { cache: 'no-store' })
            .then(response => {
                if (!response.ok) throw new Error(`Skill API ${response.status}`);
                return response.json();
            })
            .then(data => {
                const skills = Array.isArray(data?.skills) ? data.skills : [];
                // Keep the historical array return shape for canvas/commerce,
                // while carrying the new persisted category definitions along
                // for clients that need category management.
                skills.categories = Array.isArray(data?.categories) ? data.categories : [];
                return skills;
            })
            .catch(error => {
                skillListPromise = null;
                throw error;
            });
        return skillListPromise;
    }

    async function instructions(skillId) {
        const id = canonicalId(skillId);
        if (!id) return '';
        try {
            const response = await fetch(`/api/agent-skills/${encodeURIComponent(id)}`, { cache: 'no-store' });
            if (!response.ok) return '';
            const data = await response.json();
            return String(data?.instructions || '').trim();
        } catch (error) {
            return '';
        }
    }

    function subscribe(callback) {
        if (typeof callback !== 'function') return () => {};
        const onStorage = event => {
            if (event.key !== KEY) return;
            const stored = normalizeId(event.newValue);
            const selected = canonicalId(stored);
            if (selected !== stored) {
                try { localStorage.setItem(KEY, selected); } catch (_) {}
            }
            callback(selected);
        };
        const onChange = event => callback(canonicalId(event.detail?.id));
        window.addEventListener('storage', onStorage);
        window.addEventListener('studio-shared-skill-change', onChange);
        return () => {
            window.removeEventListener('storage', onStorage);
            window.removeEventListener('studio-shared-skill-change', onChange);
        };
    }

    global.StudioSharedSkill = {
        KEY,
        canonicalId,
        getSelected,
        setSelected,
        load,
        instructions,
        subscribe,
    };
})(window);
