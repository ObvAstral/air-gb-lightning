import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const walletRoot = fileURLToPath(new URL('../../', import.meta.url));
const nodeVersion = '24.19.0';
const nodeHome = join(walletRoot, 'native-data', `node-v${nodeVersion}`);
const nodeBin = join(nodeHome, 'bin', 'node');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: walletRoot, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const rgbLibDir = () => {
  const scope = join(walletRoot, 'node_modules/@utexo');
  const match = readdirSync(scope).find(name => name.startsWith('rgb-lib-') && name.includes(process.platform) && name.includes(process.arch));
  if (!match) throw new Error(`Addon rgb-lib assente per ${process.platform}/${process.arch}`);
  return join(scope, match);
};

const ensureAddon = node => {
  const directory = rgbLibDir();
  const wrap = join(directory, 'swig_wrap.cxx');
  const source = readFileSync(wrap, 'utf8');
  const addon = join(directory, 'build/Release/rgblib.node');
  if (source.includes('args.Holder()')) {
    writeFileSync(wrap, source.replaceAll('args.Holder()', 'args.This()'));
    rmSync(addon, { force: true });
  }
  if (existsSync(addon)) return;
  const gyp = join(walletRoot, 'node_modules/node-gyp/bin/node-gyp.js');
  run(node, [gyp, 'rebuild'], { cwd: directory });
};

const ensureNode24 = async () => {
  if (existsSync(nodeBin)) return nodeBin;
  await mkdir(join(walletRoot, 'native-data'), { recursive: true });
  const archive = join(walletRoot, 'native-data', `node-v${nodeVersion}.tar.gz`);
  const folder = `node-v${nodeVersion}-${process.platform}-${process.arch}`;
  run('curl', ['-fsSL', '-o', archive, `https://nodejs.org/dist/v${nodeVersion}/${folder}.tar.gz`]);
  run('tar', ['-xzf', archive, '-C', join(walletRoot, 'native-data')]);
  run('mv', [join(walletRoot, 'native-data', folder), nodeHome]);
  return nodeBin;
};

if (process.versions.node === nodeVersion) {
  ensureAddon(process.execPath);
  await import('./e2e-rgb.mjs');
} else {
  const node = await ensureNode24();
  ensureAddon(node);
  run(node, ['--env-file=native-data/regtest/wallet.env', '--import', 'tsx', 'infra/regtest/e2e-rgb.mjs']);
}
