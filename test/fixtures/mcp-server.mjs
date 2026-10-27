import { createInterface } from 'node:readline';
const root = process.argv[2];
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id == null) continue;
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  if (request.method === 'initialize') { reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} } }); continue; }
  const query = request.params.arguments.pattern ?? request.params.arguments.task;
  if (query === 'hang') continue;
  if (query === 'malformed') { process.stdout.write('not json\n'); continue; }
  if (query === 'null-response') { process.stdout.write('null\n'); continue; }
  if (query === 'oversize') { process.stdout.write('x'.repeat(8192)); continue; }
  const answer = () => reply({ content: [{ type: 'text', text: JSON.stringify({ root, pid: process.pid, tool: request.params.name, query }) }], _fresh: 'ok', _index: 'fixture', ...(query === 'refuse' ? { isError: true } : {}) });
  if (query === 'slow') setTimeout(answer, 300); else answer();
}
