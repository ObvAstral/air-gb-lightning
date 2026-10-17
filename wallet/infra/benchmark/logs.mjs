import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const exec = promisify(execFile);

// The same bounded reader runs on the host or inside the existing container.
// It reads only log files, skips symlinks and never copies the node data store.
async function chunks(root, cursors) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const found = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Only the known daemon log trees; do not walk wallet databases.
        if (['logs', '.ldk'].includes(entry.name)) await walk(name);
      } else if (entry.isFile() && /(?:\.log(?:\.[0-9-]+)?|routing-events\.jsonl|benchmark-events\.jsonl|logs\.txt)$/.test(entry.name)) found.push(name);
    }
  }
  await walk(root);
  const result = [];
  for (const file of found.sort()) {
    const name = path.relative(root, file), handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const previous = cursors[name];
      const reset = previous && (previous.ino !== String(stat.ino) || previous.offset > stat.size);
      const offset = !previous || reset ? 0 : previous.offset;
      const buffer = Buffer.alloc(Math.min(512 * 1024, stat.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      result.push({ name, reset: Boolean(reset), data: buffer.subarray(0, bytesRead).toString('base64'),
        cursor: { offset: offset + bytesRead, ino: String(stat.ino) }, more: offset + bytesRead < stat.size });
    } finally { await handle.close(); }
  }
  return result;
}

export class LogCollector {
  constructor({ topology, config, output, repoRoot }) {
    Object.assign(this, { topology, config, output, repoRoot });
    this.cursors = {}; this.containers = {}; this.files = {};
  }
  async collect(node) {
    const cursors = this.cursors[node] ??= {};
    let batches = 0;
    for (;;) {
      let rows;
      const local = this.config.logDirectories?.[node];
      if (local) rows = await chunks(resolve(local), cursors);
      else {
        let container = this.containers[node] ?? this.config.containers?.[node];
        if (!container) {
          const compose = this.config.composeFiles ?? [join(this.repoRoot, 'docker-compose.yml'), join(this.repoRoot, 'docker-compose.topology.yml')];
          const { stdout } = await exec('docker', ['compose', ...compose.flatMap(f => ['-f', resolve(f)]), 'ps', '-q', node], { timeout: 30000 });
          container = stdout.trim();
          if (!container || container.includes('\n')) throw new Error(`No unique running container for ${node}`);
          this.containers[node] = container;
        }
        const script = `const rows = await (${chunks.toString()})(process.argv[1], JSON.parse(process.argv[2])); process.stdout.write(JSON.stringify(rows));`;
        const { stdout } = await exec('docker', ['exec', container, 'node', '--input-type=module', '-e', script,
          this.config.containerLogRoot ?? '/data/rgb-lightning-node', JSON.stringify(cursors)], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
        rows = JSON.parse(stdout);
      }
      if (!rows.length) throw new Error(`No log files found for ${node}`);
      for (const row of rows) {
        if (row.name.split(/[\\/]/).includes('..') || row.name.startsWith('/')) throw new Error('Invalid log filename');
        const destination = join(this.output, 'nodes', node, row.name);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        if (row.reset) throw new Error(`Log rotated or truncated during benchmark: ${node}/${row.name}`);
        await appendFile(destination, Buffer.from(row.data, 'base64'), { mode: 0o600 });
        cursors[row.name] = row.cursor;
        (this.files[node] ??= new Set()).add(destination);
      }
      if (!rows.some(r => r.more)) return;
      if (++batches > 10000) throw new Error(`Log volume exceeds limit for ${node}`);
    }
  }
  async all() {
    const errors = [];
    // Sequential collection avoids overloading a regtest host running many nodes.
    for (const { id } of this.topology.nodes) {
      try { await this.collect(id); } catch (error) { errors.push({ node: id, error: error.message }); }
    }
    return errors;
  }
  async events(node) {
    const result = [];
    for (const file of this.files[node] ?? []) {
      if (!file.endsWith('benchmark-events.jsonl')) continue;
      const raw = await readFile(file, 'utf8');
      const lines = raw.split('\n');
      // The daemon may still be appending the final line; read it on the next poll.
      lines.pop();
      for (const line of lines) if (line.trim()) result.push(JSON.parse(line));
    }
    // Stock RLN already logs PaymentSent's actual paid fee. This parser never
    // treats route estimates or max_fee_msat as settlement measurements.
    const seen = new Set(result.filter(e => e.kind === 'payment_succeeded').map(e => e.paymentHash));
    for (const file of this.files[node] ?? []) {
      if (file.endsWith('.jsonl')) continue;
      const raw = await readFile(file, 'utf8');
      for (const line of raw.split('\n')) {
        const match = /successfully sent payment of .*?\(fee (\d+) msat\).*?payment hash ([0-9a-f]{64})/i.exec(line);
        if (match && !seen.has(match[2])) {
          seen.add(match[2]);
          result.push({ kind: 'payment_succeeded', paymentHash: match[2], feeMsat: match[1], source: 'rln_payment_sent_log' });
        }
      }
    }
    return result;
  }
}
