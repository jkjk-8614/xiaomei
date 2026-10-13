const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('../tools/commerce-analysis/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const skills = [
    { id: 'buyer-show-generation', name: '买家秀生成', description: '一键生成电商买家秀图片', enabled: true },
    { id: 'browser-agent', name: '网页操作助手', description: '读取网页与截图', enabled: true },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `skill-${i}`, name: `电商技能 ${i}`, description: '策划商品卖点、整理视觉内容和生成提示词', enabled: true })),
    { id: 'commerce-copy', name: '电商文案策划与商品视觉设计', description: '分析商品卖点，撰写主图和详情页文案', enabled: true },
    { id: 'disabled', name: '停用技能', description: '', enabled: false },
];

test('skill picker keeps horizontal labels and opens with the selected skill first', { timeout: 45000 }, async t => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', socket => socket.close());
    await page.addInitScript(() => {
        if (localStorage.getItem('xiaomei_agent_skill_selection_v1') === null) {
            localStorage.setItem('xiaomei_agent_skill_selection_v1', 'commerce-copy');
        }
    });
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'skill-picker.test') return route.abort();
        if (url.pathname.startsWith('/static/')) {
            const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
            assert.ok(file.startsWith(root + path.sep));
            return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
        }
        if (url.pathname === '/api/agent-skills') return route.fulfill({ json: { skills, categories: [] } });
        if (url.pathname === '/api/config') return route.fulfill({ json: { api_providers: [], comfy_instances: [] } });
        if (url.pathname === '/api/canvases/skills-fixture') return route.fulfill({ json: { canvas: {
            id: 'skills-fixture', title: 'Skills fixture', nodes: [], connections: [], logs: [], settings: { engine: 'api' },
        } } });
        return route.fulfill({ json: { skills: [], categories: [], items: [], cases: [], workflows: [], batches: [] } });
    });
    await page.goto('http://skill-picker.test/static/smart-canvas.html?id=skills-fixture');
    await page.waitForFunction(() => smartConfigReady && canvas);
    await page.locator('#canvasAgentToggle').click();
    await page.waitForFunction(() => document.getElementById('canvasAgentSkill').value === 'commerce-copy');
    const openPicker = async () => {
        await page.locator('#canvasAgentComposerGenerationToggle').click();
        await page.locator('#canvasAgentSkillQuickToggle').click();
    };
    const items = page.locator('[data-agent-quick-skill-id]');
    const firstId = () => items.first().getAttribute('data-agent-quick-skill-id');
    await openPicker();
    assert.equal(await firstId(), 'commerce-copy');
    assert.equal(await items.first().getAttribute('aria-selected'), 'true');
    assert.equal(await items.first().locator('.canvas-agent-skill-quick-action').textContent(), '使用中');
    assert.equal(await page.locator('[data-agent-quick-skill-id="disabled"]').count(), 0);
    const search = page.locator('#canvasAgentSkillQuickSearch');
    await search.fill('网页');
    assert.equal(await items.count(), 1);
    assert.equal(await firstId(), 'browser-agent');
    await page.keyboard.press('Escape');
    await page.locator('#canvasAgentSkillQuickList').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.locator('#canvasAgentSkillQuickPopover [data-agent-popover-close]').click();
    await openPicker();
    assert.equal(await search.inputValue(), '');
    assert.equal(await firstId(), 'commerce-copy');
    assert.equal(await page.locator('#canvasAgentSkillQuickList').evaluate(el => el.scrollTop), 0);
    await search.fill('不存在的技能');
    assert.equal(await items.count(), 0);
    assert.equal(await page.locator('#canvasAgentSkillQuickEmpty').isVisible(), true);
    await page.locator('#canvasAgentSkillQuickPopover [data-agent-popover-close]').click();
    await openPicker();
    assert.equal(await search.inputValue(), '');
    assert.equal(await firstId(), 'commerce-copy');
    await page.locator('[data-agent-quick-skill-id="skill-9"]').click();
    await openPicker();
    assert.equal(await firstId(), 'skill-9');
    await page.reload();
    await page.waitForFunction(() => smartConfigReady && canvas);
    await page.locator('#canvasAgentToggle').click();
    await page.waitForFunction(() => document.getElementById('canvasAgentSkill').value === 'skill-9');
    await openPicker();
    assert.equal(await firstId(), 'skill-9', 'selection persists after reload');
    // Use the long skill name to exercise the narrow mode row.
    await page.locator('[data-agent-quick-skill-id="commerce-copy"]').click();
    for (const width of [1280, 879, 520, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator('#canvasAgentComposerGenerationToggle').click();
        const metrics = await page.locator('#canvasAgentSkillQuickToggle').evaluate(el => {
            const label = el.querySelector('span');
            const rect = label.getBoundingClientRect();
            return { display: getComputedStyle(label).display, height: rect.height, lineHeight: parseFloat(getComputedStyle(label).lineHeight),
                width: el.getBoundingClientRect().width, parentWidth: el.parentElement.getBoundingClientRect().width };
        });
        assert.notEqual(metrics.display, 'none', `skill label stays visible at ${width}px`);
        assert.ok(metrics.height <= metrics.lineHeight + 1, `skill label stays on one line at ${width}px`);
        assert.ok(metrics.width <= metrics.parentWidth + 1, `skill button fits at ${width}px`);
        if (process.env.SKILL_PICKER_SCREENSHOT_DIR && width === 879) {
            fs.mkdirSync(process.env.SKILL_PICKER_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: path.join(process.env.SKILL_PICKER_SCREENSHOT_DIR, 'skill-button.png') });
        }
        await page.locator('#canvasAgentSkillQuickToggle').click();
        await page.waitForFunction(() => document.activeElement === document.getElementById('canvasAgentSkillQuickSearch'));
        const layout = await search.evaluate(el => {
            const icon = el.parentElement.querySelector('svg').getBoundingClientRect();
            const field = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return { aligned: Math.abs(icon.y + icon.height / 2 - field.y - field.height / 2) < 2,
                border: style.borderTopWidth, shadow: style.boxShadow, outline: style.outlineStyle, height: el.parentElement.getBoundingClientRect().height };
        });
        assert.ok(layout.aligned, `search icon and input align horizontally at ${width}px`);
        assert.equal(layout.border, '0px');
        assert.equal(layout.shadow, 'none');
        assert.equal(layout.outline, 'none', `focus ring belongs to the search container at ${width}px`);
        assert.ok(layout.height >= 36, 'search field does not collapse in the scrolling popover');
        if (process.env.SKILL_PICKER_SCREENSHOT_DIR && width === 879) {
            await page.screenshot({ path: path.join(process.env.SKILL_PICKER_SCREENSHOT_DIR, 'skill-list.png') });
        }
        await page.locator('#canvasAgentSkillQuickPopover [data-agent-popover-close]').click();
    }
    assert.deepEqual(errors, []);
});
