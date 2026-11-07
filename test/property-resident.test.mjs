import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createResidentPool } from '../src/resident.ts';
import { CASES, rng, pick, int } from './property-support.mjs';

const PIECES = ['a', ' ', 'b\nc', '"', '\\', '{}', 'é', '€', '😀', '𝄞', 'é€'];

// Stand-in MCP server through the real spawn seam: it answers each JSON-RPC line, and the answer reaches the client
// in chunks cut at byte positions drawn from the seed, so a chunk can end inside a multi-byte character.
class ChunkingServer extends EventEmitter {
  constructor(next) {
    super();
    this.next = next; this.pid = 1; this.exitCode = null; this.signalCode = null;
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) this.answer(JSON.parse(line));
        done();
      },
    });
  }

  answer(request) {
    if (request.id === undefined) return; // Notifications get no response.
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-03-26' }
      : { content: [{ type: 'text', text: request.params.arguments.pattern }] };
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    const cuts = [...new Set(Array.from({ length: int(this.next, 0, 8) }, () => int(this.next, 1, bytes.length - 1)))].sort((a, b) => a - b);
    let from = 0;
    for (const cut of [...cuts, bytes.length]) {
      const piece = bytes.subarray(from, cut); from = cut;
      setImmediate(() => this.stdout.emit('data', piece));
    }
  }

  kill() {
    setImmediate(() => {
      if (this.signalCode) return;
      this.signalCode = 'SIGTERM';
      this.emit('exit', null, 'SIGTERM');
      this.emit('close', null, 'SIGTERM');
    });
    return true;
  }
}

test('resident frames decode the same whatever the chunk boundaries, including inside a character', async () => {
  for (let seed = 1; seed <= CASES / 4; seed++) {
    const next = rng(seed);
    const spawnProcess = () => new ChunkingServer(next);
    const pool = createResidentPool({ timeoutMs: 2000, spawnProcess });
    try {
      for (let k = 0; k < 3; k++) {
        const query = Array.from({ length: int(next, 0, 60) }, () => pick(next, PIECES)).join('');
        const result = await pool.navigate('/repo', 'search', query).catch(error => ({ code: 'rejected', output: error.message }));
        assert.equal(result.output, query, `seed ${seed} request ${k}: frame decoded differently from its bytes`);
        assert.equal(result.code, 0, `seed ${seed} request ${k}: request result`);
      }
    } finally {
      await pool.dispose();
    }
  }
});
