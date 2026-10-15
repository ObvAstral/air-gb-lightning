import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const globalNodeModules = path.resolve(path.dirname(process.execPath), '../lib/node_modules');
const sdkPath = path.join(globalNodeModules, '@qvac/cli/node_modules/@qvac/sdk/dist/src/index.js');
const catalogPath = path.join(globalNodeModules, '@qvac/cli/node_modules/@qvac/inference/dist/models/registry/models.js');

const sdk = await import(sdkPath);
const { models } = await import(catalogPath);

const TARGET_MODEL_NAMES = [
  'WHISPER_EN_TINY_Q8_0',
  'TTS_MULTILINGUAL_SUPERTONIC3_Q4_0',
  'MMPROJ_QWEN3_5_0_8B_MULTIMODAL_Q8_0',
  'EMBEDDINGGEMMA_300M_Q4_0',
  'QWEN3_5_0_8B_MULTIMODAL_Q4_K_M',
  'QWEN3_8B_INST_Q4_K_M',
];

const qvacModelsDir = path.join(os.homedir(), '.qvac', 'models');
fs.mkdirSync(qvacModelsDir, { recursive: true });

function shortHash(input) {
  return crypto.createHash('sha256').update(Buffer.from(input, 'utf8')).digest('hex').slice(0, 16);
}

async function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function isCacheValid(filePath, expectedSize, expectedSha256) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size !== expectedSize) return false;
    const actualSha256 = await computeFileSha256(filePath);
    return actualSha256 === expectedSha256;
  } catch {
    return false;
  }
}

console.log(`=== QVAC Model Pre-Cache Target: ${qvacModelsDir} ===\n`);

for (const modelName of TARGET_MODEL_NAMES) {
  const meta = models.find(m => m.name === modelName);
  if (!meta) {
    throw new Error(`Model ${modelName} not found in @qvac/inference catalog`);
  }
  const filename = meta.registryPath.split('/').pop();
  const cacheFilename = `${shortHash(meta.registryPath)}_${filename}`;
  const targetPath = path.join(qvacModelsDir, cacheFilename);
  const sizeMb = (meta.expectedSize / (1024 * 1024)).toFixed(1);

  console.log(`[${modelName}] (${sizeMb} MB) -> ${cacheFilename}`);

  if (await isCacheValid(targetPath, meta.expectedSize, meta.sha256Checksum)) {
    console.log(`  ✓ Already cached & SHA-256 verified`);
  } else if (meta.registrySource === 'hf') {
    const hfUrl = `https://huggingface.co/${meta.registryPath.replace('/blob/', '/resolve/')}`;
    const partPath = `${targetPath}.part`;
    console.log(`  ↓ Fast-fetching from Hugging Face CDN: ${hfUrl}`);
    const curl = spawnSync(
      'curl',
      ['-fL', '--retry', '3', '--retry-delay', '2', '-C', '-', '-o', partPath, hfUrl],
      { stdio: 'inherit' }
    );
    if (curl.status === 0 && (await isCacheValid(partPath, meta.expectedSize, meta.sha256Checksum))) {
      fs.renameSync(partPath, targetPath);
      console.log(`  ✓ Downloaded from HF & SHA-256 verified (${meta.sha256Checksum.slice(0, 12)}...)`);
    } else {
      console.warn(`  ⚠ Direct HF download failed or mismatched; falling back to QVAC P2P Registry...`);
      try { fs.unlinkSync(partPath); } catch {}
    }
  }

  let lastLoggedPct = -1;
  const resolvedPath = await sdk.downloadAsset({
    assetSrc: sdk[modelName],
    onProgress: p => {
      const pct = Math.floor(p.percentage / 10) * 10;
      if (pct !== lastLoggedPct) {
        lastLoggedPct = pct;
        process.stdout.write(`  [QVAC downloadAsset] ${p.percentage}%\n`);
      }
    },
  });
  console.log(`  ✓ QVAC SDK verified asset: ${resolvedPath}\n`);
}

await sdk.close();
console.log('=== All 6 QVAC models pre-cached and checksum-verified! ===');
