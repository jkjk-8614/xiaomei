// Minimal MCP server over stdio used by the desktop Harness MCP tests.
// Speaks newline-delimited JSON-RPC 2.0 and exits when stdin closes.
'use strict';

const TOOLS = [
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'greet',
    description: 'Greets a person by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'xiaomei-mcp-fixture', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const args = params?.arguments ?? {};
    const text = method === 'tools/call' && params?.name === 'add'
      ? String(Number(args.a) + Number(args.b))
      : `Hello, ${args.name}!`;
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // Ignore malformed frames: the client only sends well-formed JSON-RPC.
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
