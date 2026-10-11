const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');
const portConfiguration = source.slice(source.indexOf('const requestedApiPort ='), source.indexOf('const TEST_BROWSER_PORT ='));
const probeSource = source.match(/^async function probeApiAt\([^]*?^}/m)[0];

test('desktop defaults to 3000 and accepts a configured port', () => {
  for (const [value, expected] of [[undefined, 3000], ['3300', 3300], ['65535', 65535], ['0', 3000], ['65536', 3000], ['bad', 3000], ['3000.5', 3000]]) {
    const context = vm.createContext({ process: { env: value === undefined ? {} : { XIAOMEI_CANVAS_PORT: value } } });
    assert.equal(vm.runInContext(`${portConfiguration}\nCONFIGURED_API_PORT;`, context), expected);
  }
});

test('desktop readiness accepts only its own backend session', async (t) => {
  let body = { desktop_session_id: 'current-desktop' };
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, API_SESSION_ID: 'current-desktop' });
  vm.runInContext(probeSource, context);
  const port = server.address().port;
  assert.equal(await context.probeApiAt(port), true);
  body = { desktop_session_id: 'another-install' };
  assert.equal(await context.probeApiAt(port), false);
  body = { version: 'test' };
  assert.equal(await context.probeApiAt(port), false);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await context.probeApiAt(port), false);
});
