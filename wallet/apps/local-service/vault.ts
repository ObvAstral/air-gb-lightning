import { chmod, link, lstat, mkdir, mkdtemp, rm, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateMnemonic, validateMnemonic } from 'bip39';

export class VaultError extends Error { constructor(public code: string, message: string) { super(message); } }

async function gpg(args: string[], password: string, plaintext?: string): Promise<string> {
  // The agent socket lives inside the homedir. macOS rejects socket paths longer than 104 bytes.
  const home = await mkdtemp(join(tmpdir(), 'airgb-gpg-'));
  await chmod(home, 0o700);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('gpg', [
        '--homedir', home, '--no-options', '--batch', '--yes', '--no-symkey-cache', '--pinentry-mode', 'loopback',
        '--passphrase-fd', '3', ...args,
      ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      let output = '';
      let errorText = '';
      let excessive = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 2048) { excessive = true; child.kill(); } });
      child.stderr.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-300); });
      child.on('error', () => reject(new Error('GnuPG non disponibile')));
      child.on('close', code => code === 0 && !excessive ? resolve(output) : reject(new Error(errorText.trim() ? `Cifratura o decifratura non riuscita: ${errorText.trim()}` : 'Cifratura o decifratura non riuscita')));
      child.stdin.end(plaintext ?? '');
      const passphraseFd = child.stdio[3];
      if (passphraseFd && 'end' in passphraseFd) passphraseFd.end(`${password}\n`);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export class VaultStore {
  readonly file: string;
  constructor(readonly directory: string) { this.file = join(directory, 'vault.gpg'); }
  async exists(): Promise<boolean> {
    try { return (await lstat(this.file)).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async create(password: string, mnemonic?: string): Promise<string | null> {
    if (password.length < 12 || password.length > 256 || /[\r\n]/.test(password)) throw new VaultError('INVALID_PASSWORD', 'La password deve avere 12–256 caratteri e una sola riga');
    if (await this.exists()) throw new VaultError('VAULT_EXISTS', 'Keystore già presente');
    const phrase = mnemonic?.trim().replace(/\s+/g, ' ') ?? generateMnemonic(128);
    if (phrase.split(' ').length !== 12 || !validateMnemonic(phrase)) throw new VaultError('INVALID_MNEMONIC', 'Serve una frase BIP39 valida di 12 parole');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temp = join(this.directory, `vault-${randomUUID()}.gpg`);
    try {
      await gpg(['--symmetric', '--cipher-algo', 'AES256', '--output', temp, '-'], password, phrase);
      await chmod(temp, 0o600);
      await link(temp, this.file); // Atomic, fails if another process created the vault.
    } finally { await unlink(temp).catch(() => undefined); }
    return mnemonic ? null : phrase;
  }
  async unlockMnemonic(password: string): Promise<string> {
    if (!password || password.length > 256 || /[\r\n]/.test(password)) throw new VaultError('INVALID_PASSWORD', 'Password non valida');
    const file = await lstat(this.file);
    if (!file.isFile() || file.size > 4096) throw new VaultError('VAULT_INVALID', 'Keystore non valido');
    let phrase: string;
    try { phrase = (await gpg(['--decrypt', this.file], password)).trim(); }
    catch { throw new VaultError('VAULT_UNLOCK_FAILED', 'Password errata o keystore corrotto'); }
    if (!validateMnemonic(phrase)) throw new VaultError('VAULT_INVALID', 'Frase BIP39 decifrata non valida');
    return phrase;
  }
}
