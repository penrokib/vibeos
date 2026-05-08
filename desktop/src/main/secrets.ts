// =============================================================================
// rokibrain.app — secrets (M12)
// -----------------------------------------------------------------------------
// Secure secrets storage:
//   - Master DEK stored in macOS Keychain item `com.rokibrain.app.kek` via
//     Electron safeStorage (encrypted with OS-level protection).
//   - Other secrets (BFF JWT, GitHub token, mesh creds) encrypted with
//     AES-256-GCM under the DEK.
//   - Encrypted secrets stored at ~/Library/Application Support/rokibrain.app/secrets/
//
// Hard walls (design §8 + §10.12):
//   - NEVER write plaintext secret to disk
//   - NEVER expose master DEK to renderer process
//   - NEVER use dewx
// =============================================================================

import { safeStorage } from 'electron';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SECRETS_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'rokibrain.app',
  'secrets',
);

// Master DEK cached in memory after first retrieval (survives across secret ops,
// but NOT across app restarts — re-fetched from Keychain on launch).
let cachedDek: Buffer | null = null;

// -----------------------------------------------------------------------------
// Master DEK (Data Encryption Key) management
// -----------------------------------------------------------------------------

/**
 * Retrieve or create the master DEK. On first launch, generates a random 32-byte
 * key and stores it in macOS Keychain via safeStorage. On subsequent launches,
 * retrieves it from Keychain.
 *
 * @returns 32-byte DEK as Buffer.
 * @throws if safeStorage is unavailable (should never happen on macOS).
 */
async function getMasterDek(): Promise<Buffer> {
  if (cachedDek) return cachedDek;

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'safeStorage encryption unavailable (macOS Keychain inaccessible?)',
    );
  }

  await mkdir(SECRETS_DIR, { recursive: true, mode: 0o700 });

  const kekPath = join(SECRETS_DIR, '.kek');
  try {
    // Try to load existing KEK-wrapped DEK from disk.
    const encryptedDek = await readFile(kekPath);
    const decryptedStr = safeStorage.decryptString(encryptedDek);
    cachedDek = Buffer.from(decryptedStr, 'base64');
    return cachedDek;
  } catch {
    // First launch: generate new DEK, encrypt with safeStorage (Keychain-backed KEK).
    const newDek = randomBytes(32);
    const encryptedDek = safeStorage.encryptString(newDek.toString('base64'));
    await writeFile(kekPath, encryptedDek, { mode: 0o600 });
    cachedDek = newDek;
    return cachedDek;
  }
}

// -----------------------------------------------------------------------------
// AES-256-GCM encrypt/decrypt under DEK
// -----------------------------------------------------------------------------

interface EncryptedBlob {
  /** Base64-encoded ciphertext. */
  ciphertext: string;
  /** Base64-encoded 12-byte IV (GCM standard). */
  iv: string;
  /** Base64-encoded 16-byte auth tag. */
  tag: string;
}

/**
 * Encrypt plaintext with AES-256-GCM under the master DEK.
 * @param plaintext Secret value as string.
 * @returns JSON-serializable encrypted blob.
 */
async function encryptSecret(plaintext: string): Promise<EncryptedBlob> {
  const dek = await getMasterDek();
  const iv = randomBytes(12); // GCM standard: 12 bytes
  const cipher = createCipheriv('aes-256-gcm', dek, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt an encrypted blob with AES-256-GCM under the master DEK.
 * @param blob Encrypted blob from encryptSecret.
 * @returns Plaintext secret value.
 * @throws if authentication fails (corrupted blob).
 */
async function decryptSecret(blob: EncryptedBlob): Promise<string> {
  const dek = await getMasterDek();
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// -----------------------------------------------------------------------------
// Public secrets API (called from main IPC handlers)
// -----------------------------------------------------------------------------

/**
 * Get a secret value by key. Returns null if not found.
 * NEVER returns the master DEK itself.
 */
export async function getSecret(key: string): Promise<string | null> {
  const secretPath = join(SECRETS_DIR, `${sanitizeKey(key)}.enc`);
  try {
    const raw = await readFile(secretPath, 'utf8');
    const blob: EncryptedBlob = JSON.parse(raw);
    return await decryptSecret(blob);
  } catch {
    return null;
  }
}

/**
 * Set a secret value. Encrypted with AES-256-GCM under master DEK, written to disk.
 * NEVER accepts plaintext writes — all writes go through encryption.
 */
export async function setSecret(key: string, value: string): Promise<void> {
  await mkdir(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const blob = await encryptSecret(value);
  const secretPath = join(SECRETS_DIR, `${sanitizeKey(key)}.enc`);
  await writeFile(secretPath, JSON.stringify(blob), { mode: 0o600 });
}

/**
 * Delete a secret by key. No-op if key doesn't exist.
 */
export async function deleteSecret(key: string): Promise<void> {
  const secretPath = join(SECRETS_DIR, `${sanitizeKey(key)}.enc`);
  try {
    await rm(secretPath);
  } catch {
    // Already gone or never existed — no-op.
  }
}

/**
 * List all secret keys (filenames without .enc extension).
 * NEVER includes the master DEK (.kek file).
 */
export async function listSecrets(): Promise<string[]> {
  try {
    const files = await readdir(SECRETS_DIR);
    return files
      .filter((f) => f.endsWith('.enc'))
      .map((f) => f.replace(/\.enc$/, ''));
  } catch {
    return [];
  }
}

/**
 * Wipe all secrets (called on logout). Deletes the entire secrets directory.
 * On next launch, a new master DEK will be generated.
 */
export async function wipeAllSecrets(): Promise<void> {
  try {
    await rm(SECRETS_DIR, { recursive: true, force: true });
  } catch {
    // Already gone — no-op.
  }
  cachedDek = null; // Clear in-memory cache.
}

/**
 * Sanitize a secret key to a safe filename. Allows alphanumeric + underscore only.
 */
function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}
