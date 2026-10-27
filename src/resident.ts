// @ts-nocheck -- follows the reloadable, untyped modules in this package.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const tools = { search: ['grep', 'pattern'], task: ['for', 'task'] };
const uncertain = reason => new Error(`Resident MCP ${reason}; dispatched requests were not replayed. Inspect the failure before another request.`);

function frameReader(maxBytes, accept, fail) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return data => {
    buffer += decoder.write(data);
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > maxBytes) { fail(uncertain('output limit')); return; }
      let response;
      try { response = JSON.parse(line); } catch { fail(uncertain('protocol corruption')); return; }
      if (!response || typeof response !== 'object' || Array.isArray(response) || response.jsonrpc !== '2.0') {
        fail(uncertain('protocol envelope invalid')); return;
      }
      accept(response);
    }
    if (Buffer.byteLength(buffer) > maxBytes) fail(uncertain('output limit'));
  };
}

function toolResult(result, fail) {
  if (!Array.isArray(result.content) || result.content.some(item => item.type !== 'text' || typeof item.text !== 'string')) {
    const error = uncertain('protocol content unsupported'); fail(error); throw error;
  }
  const { content, ...metadata } = result;
  const output = content.map(item => item.text).join('\n');
  return { code: result.isError ? 1 : 0, output, bytes: Buffer.byteLength(output), truncated: false, metadata };
}

function cancellable(job, signal) {
  if (!signal) return job;
  return new Promise((resolve, reject) => {
    const abort = () => reject(uncertain('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    job.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Routes one JSON-RPC response to the single in-flight request; anything else poisons the server. */
function responseRouter(current, fail) {
  return response => {
    if (response.id == null) return;
    const active = current();
    if (!active || response.id !== active.id) { fail(uncertain('protocol response mismatch')); return; }
    if (response.error) active.reject(uncertain(`protocol error (${response.error.code})`));
    else if (!response.result || typeof response.result !== 'object') fail(uncertain('protocol result missing'));
    else active.resolve(response.result);
  };
}

function createServer(root, { binary, spawnProcess, timeoutMs, maxBytes }) {
  const child = spawnProcess(binary, [root, '--mcp', '--mcp-tools=grep,for'], {
    cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0; let active; let failure; let initialized = false;
  let killTimer;
  const reaped = new Promise(resolve => child.once('close', () => { clearTimeout(killTimer); resolve(); }));
  const fail = error => {
    if (failure) return;
    failure = error;
    active?.reject(error);
    child.stdin.destroy();
    child.kill();
    // Ripwire owns no detached descendants for the two allowed read tools.
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    killTimer.unref?.();
  };
  child.on('error', error => fail(uncertain(`process error (${error.code || 'unknown'})`)));
  child.on('exit', () => { if (!failure) fail(uncertain('process exited')); });
  child.stdin.on('error', () => fail(uncertain('input stream failed')));
  // Drain diagnostics, but never substitute them for a JSON-RPC response.
  child.stderr.resume();
  child.stdout.on('data', frameReader(maxBytes, responseRouter(() => active, fail), fail));

  async function call(method, params, signal, deadline) {
    if (failure) throw failure;
    if (signal?.aborted) throw new Error('Resident request cancelled before dispatch');
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const abort = () => fail(uncertain('cancelled'));
      const timer = setTimeout(() => fail(uncertain('timeout')), Math.max(0, deadline - Date.now()));
      const finish = fn => value => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); active = undefined; fn(value);
      };
      active = { id, resolve: finish(resolve), reject: finish(reject) };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  return {
    root, queued: 0, chain: Promise.resolve(),
    get closed() { return !!failure; },
    async request(action, query, signal) {
      const deadline = Date.now() + timeoutMs;
      if (!initialized) {
        const hello = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pi-ripwire', version: '1' } }, signal, deadline);
        if (hello.protocolVersion !== '2025-03-26') { fail(uncertain('protocol version mismatch')); throw failure; }
        child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
        initialized = true;
      }
      const [name, field] = tools[action];
      const result = await call('tools/call', { name, arguments: { path: root, [field]: query, ...(action === 'search' ? { limit: 12 } : { budget_tokens: 2200 }) } }, signal, deadline);
      return toolResult(result, fail);
    },
    async close() {
      clearTimeout(this.idleTimer);
      fail(uncertain('closed'));
      await reaped;
    },
  };
}

/** Ends one request; the last one out arms the server's idle exit. */
function release(server, servers, idleMs) {
  if (--server.queued > 0) return;
  clearTimeout(server.idleTimer);
  server.idleTimer = setTimeout(() => {
    // Admission increments `queued` synchronously after the map lookup, so this check cannot race it.
    if (server.queued > 0 || servers.get(server.root) !== server) return;
    servers.delete(server.root);
    void server.close();
  }, idleMs);
  server.idleTimer.unref?.();
}

/**
 * Session-owned, repository-isolated MCP clients; admission is bounded, never retried.
 * A server with no request for `idleMs` exits: a live server holds its root as cwd, which on
 * Windows blocks removing that worktree, and keeps a process per root for the whole session.
 */
export function createResidentPool({ binary = 'ripwire', spawnProcess = spawn, maxServers = 2, maxPending = 16, timeoutMs = 60000, maxBytes = 4 * 1024 * 1024, idleMs = 5 * 60000 } = {}) {
  const servers = new Map(); let closed = false; let pending = 0; let admission = Promise.resolve();
  const config = { binary, spawnProcess, timeoutMs, maxBytes };

  async function acquire(root) {
    if (closed) throw new Error('Resident pool closed');
    let server = servers.get(root);
    if (server?.closed) { await server.close(); servers.delete(root); server = undefined; }
    if (!server) {
      if (servers.size >= maxServers) {
        const idle = [...servers.values()].find(candidate => candidate.queued === 0);
        if (!idle) throw new Error('Resident server capacity full; wait for the current requests');
        await idle.close(); servers.delete(idle.root);
      }
      if (closed) throw new Error('Resident pool closed');
      server = createServer(root, config); servers.set(root, server);
    }
    clearTimeout(server.idleTimer);
    server.queued++;
    return server;
  }

  return {
    async navigate(root, action, query, { signal } = {}) {
      if (!Object.hasOwn(tools, action)) throw new Error('Unsupported resident action');
      if (closed) throw new Error('Resident pool closed');
      if (signal?.aborted) throw new Error('Resident request cancelled before dispatch');
      if (pending >= maxPending) throw new Error('Resident request queue full; wait for current requests');
      pending++;
      const acquired = admission.then(() => {
        if (signal?.aborted) throw new Error('Resident request cancelled before dispatch');
        return acquire(root);
      });
      // Serialize admission only; the caller observes this rejection through `job`.
      admission = acquired.then(() => {}, () => {});
      const job = acquired.then(server => {
        const request = server.chain.then(() => server.request(action, query, signal));
        server.chain = request.catch(() => { /* The request caller retains the error. */ });
        return request.finally(() => release(server, servers, idleMs));
      }).finally(() => { pending--; });
      return cancellable(job, signal);
    },
    async dispose() {
      closed = true;
      await admission;
      await Promise.all([...servers.values()].map(server => server.close()));
      servers.clear();
    },
  };
}
