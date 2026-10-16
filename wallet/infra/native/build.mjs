import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = JSON.parse(await readFile(new URL('./source-lock.json', import.meta.url), 'utf8'));
const patch = fileURLToPath(new URL('./loopback.patch', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const runtime = join(root, 'native-data/runtime');
const bin = join(runtime, 'bin');
const binaryName = 'rgb-lightning-node';
const manifestName = 'build.json';
const expected = { source: config, patchSha256: sha(await readFile(patch)), platform: process.platform, arch: process.arch };
const matches = async directory => {
  const manifest = JSON.parse(await readFile(join(directory, manifestName), 'utf8'));
  return JSON.stringify(manifest.source) === JSON.stringify(expected.source)
    && manifest.patchSha256 === expected.patchSha256
    && manifest.platform === expected.platform && manifest.arch === expected.arch
    && manifest.binarySha256 === sha(await readFile(join(directory, binaryName)));
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}: ${result.signal ?? result.status}`);
};
const install = async source => {
  await mkdir(bin, { recursive: true });
  const temporary = join(bin, `${binaryName}.${randomUUID()}.tmp`);
  await copyFile(source, temporary);
  await chmod(temporary, 0o755);
  const binarySha256 = sha(await readFile(temporary));
  await rename(temporary, join(bin, binaryName));
  const manifest = join(bin, `${manifestName}.${randomUUID()}.tmp`);
  await writeFile(manifest, JSON.stringify({ ...expected, binarySha256 }, null, 2) + '\n');
  await rename(manifest, join(bin, manifestName));
};
let ready = false;
try { ready = await matches(bin); }
catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
if (!ready) {
  const artifactFlag = process.argv.indexOf('--use-artifact');
  if (artifactFlag !== -1) {
    if (!process.argv[artifactFlag + 1]) throw new Error('Directory artifact mancante');
    const directory = resolve(process.argv[artifactFlag + 1]);
    if (!await matches(directory)) throw new Error('Artifact diverso dalle fork MPP verificate');
    await install(join(directory, binaryName));
  } else {
    if (!['linux', 'darwin'].includes(process.platform)) throw new Error('Build RLN supportata su Linux e macOS');
    const toolchain = spawnSync('rustup', ['which', '--toolchain', config.rustToolchain, 'rustc'], { stdio: 'ignore' });
    if (toolchain.error?.code === 'ENOENT') throw new Error(`Richiesto rustup con Rust ${config.rustToolchain}`);
    if (toolchain.status !== 0) run('rustup', ['toolchain', 'install', config.rustToolchain, '--profile', 'minimal']);
    const source = join(runtime, 'source');
    // Fetch immutable commits over HTTPS. The fork's .gitmodules uses SSH and
    // points at a different branch; never let submodule defaults choose LDK.
    const checkout = async (directory, repository) => {
      if (!await access(join(directory, '.git')).then(() => true, () => false)) {
        await mkdir(directory, { recursive: true });
        run('git', ['init', directory]);
        run('git', ['-C', directory, 'remote', 'add', 'origin', repository.repository]);
        run('git', ['-C', directory, 'fetch', '--depth', '1', 'origin', repository.commit]);
        run('git', ['-C', directory, 'checkout', '--detach', repository.commit]);
      }
      const head = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (head.status !== 0 || head.stdout.trim() !== repository.commit) throw new Error(`Commit inatteso in ${directory}; usare una directory di build pulita`);
    };
    await checkout(source, config.node);
    await checkout(join(source, 'rust-lightning'), config.lightning);
    const lockFile = join(source, 'Cargo.lock');
    if (sha(await readFile(lockFile)) !== config.cargoLockSha256) throw new Error('Cargo.lock della fork non corrispondente');
    const forward = spawnSync('git', ['-C', source, 'apply', '--check', patch], { stdio: 'ignore' });
    if (forward.status === 0) run('git', ['-C', source, 'apply', patch]);
    else run('git', ['-C', source, 'apply', '--reverse', '--check', patch]);
    const main = spawnSync('git', ['-C', source, 'diff', '--full-index', '--no-ext-diff', 'HEAD', '--', 'src/main.rs'], { encoding: 'utf8' });
    if (main.status !== 0 || main.stdout !== await readFile(patch, 'utf8')) throw new Error('Modifiche inattese al listener REST');
    // Reject unrelated edits so that the build manifest describes the source.
    for (const [directory, allowed] of [[source, ['src/main.rs', 'rust-lightning']], [join(source, 'rust-lightning'), []]]) {
      const diff = spawnSync('git', ['-C', directory, 'diff', 'HEAD', '--name-only'], { encoding: 'utf8' });
      if (diff.status !== 0 || diff.stdout.trim().split('\n').filter(Boolean).some(name => !allowed.includes(name))) throw new Error(`Modifiche inattese nei sorgenti ${directory}`);
    }
    process.stdout.write(`Compilazione delle fork RGB MPP con Rust ${config.rustToolchain}; può richiedere diversi minuti.\n`);
    run('rustup', ['run', config.rustToolchain, 'cargo', 'build', '--release', '--locked', '--no-default-features', '--features', config.features.join(',')], {
      cwd: source, env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '1' },
    });
    await install(join(source, 'target/release', binaryName));
  }
}
process.stdout.write(`RLN MPP verificato: ObvAstral/rgb-lightning-node@${config.node.commit.slice(0, 12)}, rust-lightning@${config.lightning.commit.slice(0, 12)}.\n`);
