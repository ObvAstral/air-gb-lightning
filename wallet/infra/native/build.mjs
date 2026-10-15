import { copyFile, readFile, rename, writeFile, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = join(root, 'node_modules/@utexo/rgb-lightning-node-nodejs');
const native = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const wdk = JSON.parse(await readFile(join(root, 'node_modules/@utexo/wdk-rgb-lightning/package.json'), 'utf8'));
const config = native.utexoNativeOverlay;
const signerCommit = '0fb005ec4b927ddbe13e1646d247b5bb11e8ffed';
const originalSignerCommit = '59e2932eb5d3d40ac5ded2b8951a43ecdb7ad865';
const cargoLockSha256 = 'b29880e35285e3672c957b34bb02dcbc4d36438d67e7123acf32889e7edba3e2';
const sha = data => createHash('sha256').update(data).digest('hex');
if (native.version !== '0.1.0-beta.16' || wdk.version !== '0.1.0-beta.15'
    || config?.repository !== 'https://github.com/UTEXO-Protocol/rgb-lightning-node.git'
    || config.commit !== 'f30a5393268de67c6bb5a1c525bc790c5b11afa2'
    || config.patchSha256 !== 'd0b6d4b057edd675e3d4385f2243b266020feeb1bee7714e7625e2f7bc0c945c'
    || config.rustToolchain !== '1.88.0') throw new Error('Versioni native diverse dalla coppia verificata');

const isMusl = process.platform === 'linux' && await access('/etc/alpine-release').then(() => true, () => false);
const suffix = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch) ? `darwin-${process.arch}`
  : process.platform === 'linux' && process.arch === 'x64' ? `linux-x64-${isMusl ? 'musl' : 'gnu'}`
  : process.platform === 'linux' && process.arch === 'arm64' ? 'linux-arm64-gnu' : null;
if (!suffix) throw new Error(`Piattaforma nativa non supportata: ${process.platform}/${process.arch}`);
const addonName = `index-${suffix}.node`;
const addon = join(packageRoot, addonName);
const manifestName = '.airgb-native-build.json';
const manifestFile = join(packageRoot, manifestName);
const patch = join(packageRoot, config.patch);
if (sha(await readFile(patch)) !== config.patchSha256) throw new Error('Hash della patch nativa non valido');

const lockFile = join(packageRoot, 'Cargo.lock');
const currentLock = await readFile(lockFile, 'utf8');
const oldSource = `git+https://github.com/UTEXO-Protocol/rln-external-signer.git?branch=main#${originalSignerCommit}`;
const newSource = `git+https://github.com/UTEXO-Protocol/rln-external-signer.git?branch=main#${signerCommit}`;
const fixedLock = currentLock.replace(oldSource, newSource);
if (sha(fixedLock) !== cargoLockSha256) throw new Error('Lockfile Rust diverso da quello verificato');
if (fixedLock !== currentLock) await writeFile(lockFile, fixedLock);
const expected = {
  schemaVersion: 1, bindingVersion: native.version, wdkVersion: wdk.version,
  repository: config.repository, ref: config.ref, commit: config.commit,
  patchSha256: config.patchSha256, rustToolchain: config.rustToolchain,
  platform: process.platform, arch: process.arch, suffix,
  signerExternalCommit: signerCommit, cargoLockSha256,
};
const matches = async (directory, manifest) => Object.entries(expected).every(([key, value]) => manifest[key] === value)
  && manifest.addonSha256 === sha(await readFile(join(directory, addonName)));
let ready = false;
try { ready = await matches(packageRoot, JSON.parse(await readFile(manifestFile, 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}: ${result.signal ?? result.status}`);
};
const install = async source => {
  const temporary = `${addon}.${randomUUID()}.tmp`;
  await copyFile(source, temporary);
  await rename(temporary, addon);
  const manifest = { ...expected, addonSha256: sha(await readFile(addon)) };
  const temporaryManifest = `${manifestFile}.${randomUUID()}.tmp`;
  await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await rename(temporaryManifest, manifestFile);
};
if (!ready) {
  const artifactFlag = process.argv.indexOf('--use-artifact');
  if (artifactFlag !== -1) {
    if (!process.argv[artifactFlag + 1]) throw new Error('Directory artifact mancante');
    const directory = resolve(process.argv[artifactFlag + 1]);
    const manifest = JSON.parse(await readFile(join(directory, manifestName), 'utf8'));
    if (!await matches(directory, manifest)) throw new Error('Artifact locale non corrispondente alla build verificata');
    await install(join(directory, addonName));
  } else {
    const toolchain = spawnSync('rustup', ['which', '--toolchain', config.rustToolchain, 'rustc'], { stdio: 'ignore' });
    if (toolchain.error?.code === 'ENOENT') throw new Error('Richiesto rustup per la toolchain Rust 1.88.0; installarlo prima di native:build');
    if (toolchain.status !== 0) run('rustup', ['toolchain', 'install', config.rustToolchain, '--profile', 'minimal']);
    const source = join(packageRoot, '.native-source');
    const exists = await access(source).then(() => true, () => false);
    if (!exists) {
      run('git', ['clone', '--recurse-submodules', '--shallow-submodules', '--depth', '1', '--branch', config.ref, config.repository, source]);
    }
    const head = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0 || head.stdout.trim() !== config.commit) throw new Error('Commit del sorgente nativo non corrispondente');
    const forward = spawnSync('git', ['-C', source, 'apply', '--check', patch], { stdio: 'ignore' });
    if (forward.status === 0) run('git', ['-C', source, 'apply', patch]);
    else run('git', ['-C', source, 'apply', '--reverse', '--check', patch]);
    process.stdout.write('Compilazione addon: Rust 1.88.0, signer upstream PR #17; può richiedere diversi minuti.\n');
    run('rustup', ['run', config.rustToolchain, 'cargo', 'build', '--release', '--locked'], {
      env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' },
    });
    const extension = process.platform === 'darwin' ? 'dylib' : 'so';
    await install(join(packageRoot, 'target/release', `librln_node.${extension}`));
  }
}
process.stdout.write('Addon RGB Lightning beta.16 con signer persistente e correzione upstream verificato.\n');
