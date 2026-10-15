import { timingSafeEqual } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import WalletManagerRgbLightning, { NodeRgbLightningBinding, type RgbLightningBindingConfig } from '@utexo/wdk-rgb-lightning';
import { NativeExternalSigner } from '@utexo/rgb-lightning-node-nodejs';

export class PersistentSignerError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export async function prepareSignerStorage(nativeDirectory: string): Promise<void> {
  const signerDirectory = join(nativeDirectory, 'vls-signer');
  const nativeFiles = await readdir(nativeDirectory);
  let signerFiles: string[] = [];
  try { signerFiles = await readdir(signerDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (nativeFiles.some(name => name !== 'vls-signer') && signerFiles.length === 0) {
    throw new PersistentSignerError('SIGNER_STATE_MISSING', 'Stato nativo esistente senza stato VLS persistente: serve una procedura di recupero verificata');
  }
  await mkdir(signerDirectory, { recursive: true, mode: 0o700 });
}

type SignerFields = {
  _signer: NativeExternalSigner | null;
  _seedHex: Buffer | undefined;
  _fallbackSeedHex: Buffer | undefined;
};
type PersistentSignerFactory = typeof NativeExternalSigner & {
  createWithStorage?: (seed: string, network: RgbLightningBindingConfig['network'], directory: string, permissive: boolean) => NativeExternalSigner;
};

// WDK beta.15 exposes Binding as its runtime extension point. Its Node binding
// still creates an ephemeral VLS signer. Keep WDK's node owner, methods and
// shutdown, replacing only signer construction with beta.16's native API.
// The three retained fields are pinned to the installed beta.15 source; its
// shutdown destroys the signer and wipes these buffers through sodium.
class PersistentNodeBinding extends NodeRgbLightningBinding {
  constructor(private readonly persistentConfig: RgbLightningBindingConfig) {
    super(persistentConfig);
    for (const name of ['_signer', '_seedHex', '_fallbackSeedHex']) {
      if (!Object.hasOwn(this, name)) throw new PersistentSignerError('WDK_BINDING_CHANGED', 'Struttura del binding WDK diversa dalla versione verificata');
    }
  }
  override attachExternalSigner(seedHex: string, fallbackSeedHex?: string): void {
    if (fallbackSeedHex) throw new PersistentSignerError('SIGNER_DERIVATION', 'Il signer persistente richiede derivazione wdk-seed-v2 esplicita');
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) throw new PersistentSignerError('SIGNER_SEED_INVALID', 'Materiale signer non valido');
    const state = this as unknown as SignerFields;
    if (state._signer) {
      const candidate = Buffer.from(seedHex, 'utf8');
      try {
        if (!state._seedHex || state._seedHex.length !== candidate.length || !timingSafeEqual(state._seedHex, candidate)) {
          throw new PersistentSignerError('SIGNER_ALREADY_ATTACHED', 'Un altro signer è già collegato');
        }
      } finally { candidate.fill(0); }
      return;
    }
    const factory = NativeExternalSigner as PersistentSignerFactory;
    if (typeof factory.createWithStorage !== 'function') throw new PersistentSignerError('SIGNER_STORAGE_UNSUPPORTED', 'Il binding nativo installato non supporta lo stato VLS persistente');
    state._signer = factory.createWithStorage(seedHex, this.persistentConfig.network, join(this.persistentConfig.dataDir, 'vls-signer'), this.persistentConfig.permissiveSignerPolicy ?? true);
    state._seedHex = Buffer.from(seedHex, 'utf8');
    state._fallbackSeedHex = undefined;
  }
}

export class PersistentWalletManager extends WalletManagerRgbLightning {
  static override get Binding() { return PersistentNodeBinding; }
}
