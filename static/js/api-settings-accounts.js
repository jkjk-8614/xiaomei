(function () {
    'use strict';

    function records(provider) {
        return Array.isArray(provider?.key_profiles)
            ? provider.key_profiles.filter(profile => profile && String(profile.id || '').trim())
            : [];
    }

    function activeProfile(provider, profiles) {
        return profiles.find(profile => String(profile.id) === String(provider.active_key_profile_id || ''))
            || profiles.find(profile => profile.active)
            || profiles[0];
    }

    function applyBundle(provider, data) {
        provider.key_profiles = data.profiles;
        provider.active_key_profile_id = String(data.active_id || '');
        provider.key_profile_count = data.profiles.length;
        provider.has_key = Boolean(data.has_key);
        provider.key_preview = data.key_preview || '';
        if (data.key_env) provider.key_env = data.key_env;
    }

    function bind(options) {
        const byId = id => document.getElementById(id);
        const nameInput = byId('keyProfileNameInput'), keyInput = byId('keyInput');
        const trigger = byId('keyProfileTrigger'), menu = byId('keyProfileMenu');
        const frame = byId('keyProfileSwitchFrame');
        const hint = byId('keyProfileHint'), add = byId('keyProfileAddBtn');
        const edit = byId('keyProfileEditBtn'), remove = byId('keyProfileDeleteBtn');
        const save = byId('saveKeyBtn'), clear = byId('keyClearBtn');
        const cancel = byId('keyProfileCancelBtn');
        const nodes = {
            selectRow: byId('keyProfileSelectRow'),
            editPanel: byId('keyProfileEditPanel'),
            editTitle: byId('keyProfileEditTitle'),
            editHint: byId('keyProfileEditHint'),
            nameRow: byId('keyProfileNameRow'),
            keyEditor: byId('keyProfileKeyEditor'),
            keyLabel: byId('keyProfileKeyLabel'),
            triggerName: byId('keyProfileTriggerName'),
            triggerMeta: byId('keyProfileTriggerMeta'),
        };
        const tr = key => options.translate('api.' + key);
        const message = (key, name) => options.format('api.' + key, {name});
        const supports = provider => options.supports(provider) && Array.isArray(provider?.key_profiles);
        const pending = new Map();
        let draft = null;

        function displayName(profile, index = 0) {
            return String(profile?.name || (tr('account') + ' ' + (index + 1))).trim();
        }

        function statusText(profile, selected) {
            if (!profile) return '';
            return [
                tr(profile.has_key ? 'keyProfileSavedStatus' : 'keyProfileMissingStatus'),
                profile.key_preview,
                selected ? tr('activeKeyProfile') : '',
            ].filter(Boolean).join(' · ');
        }

        function closeMenu(restoreFocus = false) {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            if (restoreFocus && !trigger.disabled) trigger.focus();
        }

        function openMenu() {
            if (trigger.disabled) return;
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
        }

        function reset() {
            draft = null;
            nameInput.value = '';
            closeMenu();
        }

        function ownsDraft(provider) {
            return Boolean(draft && draft.providerId === provider?.id);
        }

        function editing(provider) {
            return ownsDraft(provider) && supports(provider);
        }

        function hasDraft() {
            return editing(options.provider()) && Boolean(keyInput.value.trim() || nameInput.value.trim() !== draft.initialName);
        }

        function option(profile, index, selected) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'key-profile-option';
            button.dataset.profileId = String(profile.id);
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(selected));
            button.tabIndex = -1;
            const name = document.createElement('span'), meta = document.createElement('span');
            name.className = 'key-profile-option-name';
            name.textContent = displayName(profile, index);
            meta.className = 'key-profile-option-meta';
            meta.textContent = statusText(profile, selected);
            button.append(name, meta);
            return button;
        }

        function render(provider = options.provider()) {
            const supported = supports(provider);
            if (draft && (!supported || !ownsDraft(provider))) reset();
            const profiles = supported ? records(provider) : [];
            const active = supported ? activeProfile(provider, profiles) : undefined;
            const activeName = active ? displayName(active, profiles.indexOf(active)) : '';
            const changing = editing(provider);
            const creating = changing && draft.mode === 'new';
            const busy = pending.has(provider?.id);

            closeMenu();
            menu.replaceChildren(...profiles.map((profile, index) => option(profile, index, profile === active)));
            trigger.disabled = !active || changing || busy;
            nodes.triggerName.textContent = supported ? activeName || tr('noKeyProfiles') : '';
            nodes.triggerMeta.textContent = statusText(active, true);
            hint.textContent = !supported ? '' : busy ? tr('keyProfileWorking')
                : active ? message('currentKeyProfile', activeName) : tr('keyProfileNoAccountsHint');
            add.hidden = !supported;
            add.disabled = changing || busy;
            nodes.selectRow.hidden = !supported || changing;
            edit.hidden = remove.hidden = !active || changing || busy;
            nodes.editPanel.hidden = nodes.nameRow.hidden = cancel.hidden = !changing;
            nodes.keyEditor.hidden = supported && !changing;
            nodes.keyLabel.hidden = !changing;
            clear.hidden = supported;
            save.disabled = busy || (supported && !changing);
            nameInput.disabled = keyInput.disabled = cancel.disabled = busy;
            if (!changing) {
                save.title = tr('saveKeyTitle');
                return;
            }

            const mode = creating ? 'new' : 'edit';
            nodes.editTitle.textContent = tr(mode + 'KeyProfileTitle');
            nodes.editHint.textContent = busy ? tr('keyProfileWorking') : tr(mode + 'KeyProfileHint');
            nodes.keyLabel.textContent = tr(mode + 'KeyProfileKeyLabel');
            nameInput.placeholder = tr(mode + 'KeyProfileNamePlaceholder');
            keyInput.placeholder = tr(creating ? 'enterKeyForNewProfile' : 'enterKeyForEditProfile');
            cancel.title = tr(creating ? 'cancelKeyProfileTitle' : 'cancelKeyProfileEditTitle');
            save.title = tr(creating ? 'saveNewKeyProfileTitle' : 'saveEditedKeyProfileTitle');
        }

        function startDraft(provider, mode, keepKey = false) {
            if (!supports(provider) || pending.has(provider.id) || options.saving()) return;
            const profiles = records(provider);
            const profile = mode === 'edit' ? activeProfile(provider, profiles) : null;
            if (mode === 'edit' && !profile) return;
            const initialName = profile ? displayName(profile, profiles.indexOf(profile)) : '';
            draft = {providerId: provider.id, mode, profileId: profile?.id || '', initialName};
            if (!keepKey) keyInput.value = '';
            nameInput.value = initialName;
            render(provider);
            options.draftChanged();
            if (keepKey && profile) {
                keyInput.focus();
            } else {
                nameInput.focus();
                if (profile) nameInput.select();
            }
        }

        function submit(provider, method, suffix, body, resultKey, subject) {
            if (pending.has(provider.id) || options.saving()) return;
            options.sync();
            if (!supports(provider)) return;
            const id = provider.id;
            const job = Promise.resolve().then(async () => {
                let result;
                try {
                    const response = await fetch('/api/providers/' + encodeURIComponent(id) + '/key-profiles' + suffix, {
                        method, cache: 'no-store',
                        ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {}),
                    });
                    const data = await response.json().catch(() => null);
                    if (!response.ok || !Array.isArray(data?.profiles)) {
                        throw new Error(typeof data?.detail === 'string' && data.detail ? data.detail : tr('keyProfileActionFailed'));
                    }
                    result = data;
                } catch (error) {
                    if (options.provider()?.id === id) options.status(error.message || tr('keyProfileActionFailed'));
                } finally {
                    pending.delete(id);
                }
                const target = result && options.lookup(id);
                if (!target) {
                    if (options.provider()?.id === id) render();
                    options.draftChanged();
                    return;
                }
                applyBundle(target, result);
                const name = subject || displayName(activeProfile(target, records(target)));
                if (options.provider()?.id === id) {
                    reset();
                    keyInput.value = '';
                }
                const credentialsChanged = !body || Boolean(body.key);
                options.saved(target, message(resultKey, name), credentialsChanged);
            });
            pending.set(id, job);
            render(provider);
            options.draftChanged();
            return job;
        }

        function saveProfile(provider) {
            if (pending.has(provider.id) || options.saving()) return;
            const key = keyInput.value.trim();
            if (!editing(provider)) {
                if (!key) { window.alert(tr('enterKeyAlert')); return; }
                startDraft(provider, records(provider).length ? 'edit' : 'new', true);
                return;
            }
            const creating = draft.mode === 'new';
            if (creating && !key) { window.alert(tr('enterKeyAlert')); return; }
            const name = nameInput.value.trim();
            if (!name) {
                options.status(tr('enterKeyProfileName'));
                nameInput.focus();
                return;
            }
            return submit(provider, 'POST', '', {
                key, name, profile_id: draft.profileId, create_new: creating,
            }, creating ? 'keyProfileCreated' : 'keyProfileUpdated', name);
        }

        function deleteProfile(provider) {
            if (pending.has(provider.id) || options.saving() || editing(provider)) return;
            const profiles = records(provider);
            const active = activeProfile(provider, profiles);
            if (!active || !window.confirm(tr('confirmDeleteKeyProfile'))) return;
            return submit(provider, 'DELETE', '/' + encodeURIComponent(active.id), null,
                'keyProfileDeleted', displayName(active, profiles.indexOf(active)));
        }

        function activate(id) {
            closeMenu(true);
            const provider = options.provider();
            if (!supports(provider) || editing(provider) || pending.has(provider.id) || options.saving()) return;
            const profiles = records(provider);
            const target = profiles.find(profile => String(profile.id) === id);
            if (!target || target === activeProfile(provider, profiles)) return;
            return submit(provider, 'POST', '/' + encodeURIComponent(id) + '/activate', null, 'keyProfileSwitched');
        }

        add.addEventListener('click', () => startDraft(options.provider(), 'new'));
        edit.addEventListener('click', () => startDraft(options.provider(), 'edit'));
        cancel.addEventListener('click', () => {
            if (pending.has(options.provider()?.id)) return;
            options.sync();
            reset();
            keyInput.value = '';
            options.refresh();
            options.draftChanged();
            add.focus();
        });
        trigger.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu());
        menu.addEventListener('click', event => {
            const item = event.target.closest('[data-profile-id]');
            if (item) activate(item.dataset.profileId);
        });
        frame.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !menu.hidden) {
                event.preventDefault();
                closeMenu(true);
                return;
            }
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || trigger.disabled) return;
            const items = [...menu.querySelectorAll('[role="option"]')];
            if (!items.length) return;
            event.preventDefault();
            const index = items.indexOf(document.activeElement);
            const initial = items.findIndex(item => item.getAttribute('aria-selected') === 'true');
            openMenu();
            let next = Math.max(0, initial);
            if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else if (index >= 0) next = Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
            items[next].focus();
        });
        frame.addEventListener('focusout', event => {
            if (!frame.contains(event.relatedTarget)) closeMenu();
        });
        document.addEventListener('click', event => { if (!frame.contains(event.target)) closeMenu(); });
        return {
            render, reset, supports, ownsDraft, editing, hasDraft, saveProfile, deleteProfile,
            isDraftInput: input => input === nameInput || (input === keyInput && supports(options.provider())),
            clearDraftInputs() { nameInput.value = keyInput.value = ''; },
            busy: () => pending.size > 0,
            settled: () => Promise.all([...pending.values()]),
        };
    }

    window.ApiSettingsAccounts = {bind};
})();
