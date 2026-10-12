const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');
const code = source.match(/^async function saveWorkflowToDesktop\([^]*?^}/m)[0];
function setup(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaomei-workflow-export-'));
    t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
    const owner = {isDestroyed:() => false};
    const dialogs = [];
    const context = vm.createContext({
        URL, ArrayBuffer, Uint8Array, Buffer, path, crypto,
        fs: options.failWrite ? {promises:{...fs.promises, rename:async () => { throw new Error('目标文件只读'); }}} : fs,
        mainWindow:owner, LOCAL_ORIGIN:'http://127.0.0.1:3001',
        BrowserWindow:{fromWebContents:() => options.denied ? null : owner},
        app:{getPath:key => { assert.equal(key, 'desktop'); return directory; }},
        dialog:{showSaveDialog:async (window, config) => {
            assert.equal(window, owner);
            dialogs.push(config);
            return options.cancel ? {canceled:true} : {filePath:path.join(directory, options.target || '导出的工作流.zip')};
        }},
    });
    vm.runInContext(code, context);
    return {directory, dialogs, save:payload => context.saveWorkflowToDesktop({sender:{}, senderFrame:{url:options.origin || 'http://127.0.0.1:3001/'}}, payload)};
}
test('desktop export preserves ZIP bytes and defaults to the system desktop', async t => {
    const fixture = setup(t);
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 255]);
    const result = await fixture.save({filename:'详情页模板.zip', bytes});
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readFileSync(result.path), Buffer.from(bytes));
    assert.equal(fixture.dialogs[0].defaultPath, path.join(fixture.directory, '详情页模板.zip'));
    assert.equal(fixture.dialogs[0].filters[0].extensions[0], 'zip');
    assert.deepEqual(fs.readdirSync(fixture.directory), ['导出的工作流.zip']);
});
test('JSON export preserves Chinese text and one filename extension', async t => {
    const fixture = setup(t, {target:'中文模板.json'});
    const bytes = Buffer.from('{"name":"主图模板","nodes":[]}');
    const result = await fixture.save({filename:'中文模板.json', bytes});
    assert.equal(result.ok, true);
    assert.deepEqual(fs.readFileSync(result.path), bytes);
    assert.equal(fixture.dialogs[0].filters[0].extensions[0], 'json');
});
test('cancel does not write a file', async t => {
    const fixture = setup(t, {cancel:true});
    const result = await fixture.save({filename:'模板.zip', bytes:new Uint8Array([1])});
    assert.equal(result.canceled, true);
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(fixture.directory), []);
});
test('failed replacement keeps the previous file and removes the temporary file', async t => {
    const fixture = setup(t, {failWrite:true});
    fs.writeFileSync(path.join(fixture.directory, '导出的工作流.zip'), 'original');
    const result = await fixture.save({filename:'模板.zip', bytes:new Uint8Array([1])});
    assert.equal(result.ok, false);
    assert.match(result.message, /目标文件只读/);
    assert.equal(fs.readFileSync(path.join(fixture.directory, '导出的工作流.zip'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(fixture.directory), ['导出的工作流.zip']);
});
test('untrusted pages, invalid extensions and empty bytes cannot open a save dialog', async t => {
    const untrusted = setup(t, {origin:'https://example.com/'});
    assert.equal((await untrusted.save({filename:'模板.zip', bytes:new Uint8Array([1])})).ok, false);
    assert.equal(untrusted.dialogs.length, 0);
    const fixture = setup(t);
    assert.equal((await fixture.save({filename:'模板.exe', bytes:new Uint8Array([1])})).ok, false);
    assert.equal((await fixture.save({filename:'模板.zip', bytes:new Uint8Array()})).ok, false);
    assert.equal(fixture.dialogs.length, 0);
});
