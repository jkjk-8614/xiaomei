(function () {
    'use strict';

    function element(tag, className, text) {
        const node = document.createElement(tag);
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function icon(name, className) {
        const node = element('i', className);
        node.dataset.lucide = name;
        node.setAttribute('aria-hidden', 'true');
        return node;
    }

    function providerMark(entry, icons) {
        if (entry.cli) {
            const mark = element('span', 'provider-mark cli-provider-mark');
            mark.classList.add('cli-provider-mark-' + entry.cli.kind);
            mark.append(icon('terminal', 'w-4 h-4'));
            return mark;
        }
        const mark = element('span', 'provider-mark api-provider-mark');
        if (entry.icon && !icons.failed.has(entry.icon)) {
            const image = element('img', 'provider-favicon');
            image.alt = '';
            image.dataset.iconSrc = entry.icon;
            image.classList.toggle('is-loaded', icons.loaded.has(entry.icon));
            image.addEventListener('load', () => icons.onLoad(image));
            image.addEventListener('error', () => icons.onError(image));
            image.src = entry.icon;
            mark.append(image);
        }
        mark.append(icon('link-2', 'w-4 h-4'));
        return mark;
    }

    function providerDescription(entry) {
        const info = element('span', 'provider-info');
        const name = element('span', 'provider-name', entry.name);
        const meta = element('span', 'provider-meta');
        if (entry.cli) {
            meta.classList.add('cli-provider-meta');
            const { install, update, version } = entry.cli;
            meta.append(element('span', 'cli-install-state ' + install.className, install.label));
            meta.append(element('span', 'cli-update-state ' + update.className, update.label));
            if (version) meta.append(element('span', 'cli-provider-version', version));
        } else {
            meta.title = entry.address;
            meta.textContent = entry.host;
        }
        info.append(name, meta);
        return info;
    }

    function providerRow(entry, actions, icons) {
        const card = element('button', 'provider-card provider-card-sortable ' + entry.status);
        card.type = 'button';
        card.classList.toggle('active', entry.selected);
        card.addEventListener('click', () => actions.select(entry.id));
        if (entry.sortable) {
            card.draggable = true;
            card.dataset.providerId = entry.id;
            card.addEventListener('dragstart', event => actions.dragStart(event, entry.id));
            card.addEventListener('dragover', event => actions.dragOver(event, entry.id));
            card.addEventListener('drop', event => actions.drop(event, entry.id));
            card.addEventListener('dragend', actions.dragEnd);
        }
        const grip = element('span', 'provider-drag-handle');
        grip.setAttribute('aria-hidden', 'true');
        grip.append(icon('grip-vertical', 'w-3.5 h-3.5'));
        const detail = element('span', 'provider-side-meta');
        detail.append(element('span', 'provider-protocol-pill', entry.protocol), icon('chevron-right', 'provider-chevron'));
        card.append(grip, providerMark(entry, icons), providerDescription(entry), detail);
        if (!entry.cli) return card;

        card.classList.add('cli-provider-card');
        card.title = entry.cli.title;
        const group = element('div', 'provider-cli-row ' + entry.status);
        group.classList.toggle('active', entry.selected);
        group.append(card);
        return group;
    }

    function render(container, count, entries, actions, icons) {
        const scrollTop = container.scrollTop;
        const focused = container.contains(document.activeElement) ? document.activeElement.dataset.providerId : null;
        const rows = entries.map(entry => providerRow(entry, actions, icons));
        container.replaceChildren(...rows);
        container.scrollTop = scrollTop;
        if (count) count.textContent = entries.length || '';
        if (focused) {
            const matching = Array.from(container.querySelectorAll('[data-provider-id]'))
                .find(button => button.dataset.providerId === focused);
            matching?.focus({preventScroll: true});
        }
    }

    window.ApiSettingsNavigation = {render};
})();
