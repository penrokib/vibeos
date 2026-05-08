// =============================================================================
// vibeOS — E2E envelope crypto (cycle 5 scaffold)
// -----------------------------------------------------------------------------
// libsodium crypto_box envelope: every blob encrypted independently with
// recipient device's public key. v1 ships the scaffold; v1.1 hardening wires
// it into BFF blob storage + completes Signal-style ratchet.
//
// Hard walls:
//   - Keys NEVER leave the device. Sealed boxes only — sender encrypts to a
//     recipient's public key, no shared secret over the wire.
//   - Plaintext NEVER persisted to disk by this module.
//   - No key recovery here — that's a separate flow (24-word seed phrase, v1.1).
// =============================================================================

import sodium from "libsodium-wrappers";

let ready: Promise<void> | null = null;

/** Initialise libsodium. Idempotent — safe to call repeatedly. */
export async function initCrypto(): Promise<void> {
  if (!ready) {
    ready = sodium.ready;
  }
  await ready;
}

export interface DeviceKeypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Generate a new x25519 keypair for this device. Stored encrypted via M12. */
export async function generateDeviceKeypair(): Promise<DeviceKeypair> {
  await initCrypto();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export interface SealedEnvelope {
  /** Sealed ciphertext bytes (sodium crypto_box_seal output). */
  ciphertext: Uint8Array;
  /** Recipient device's public key, included for routing — NOT a secret. */
  recipientPublicKey: Uint8Array;
  /** ISO 8601 timestamp. Not authenticated; for ordering only. */
  ts: string;
}

/**
 * Seal `plaintext` for `recipientPublicKey`. Uses crypto_box_seal — anonymous
 * sealed-box construction, ephemeral sender key. Recipient can decrypt with
 * their private key but cannot identify the sender from the ciphertext alone
 * (good enough for v1; v1.1 adds signed envelopes for sender attestation).
 */
export async function sealForRecipient(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<SealedEnvelope> {
  await initCrypto();
  const ciphertext = sodium.crypto_box_seal(plaintext, recipientPublicKey);
  return {
    ciphertext,
    recipientPublicKey,
    ts: new Date().toISOString(),
  };
}

/**
 * Open a sealed envelope using this device's keypair. Throws if the envelope
 * was not sealed for this recipient (libsodium returns false / throws).
 */
export async function openSealed(
  envelope: SealedEnvelope,
  myKeypair: DeviceKeypair,
): Promise<Uint8Array> {
  await initCrypto();
  // Sanity: the envelope claims this recipient. If the public keys mismatch,
  // we'd waste cycles trying to decrypt — fail fast.
  if (
    envelope.recipientPublicKey.length !== myKeypair.publicKey.length ||
    !arraysEqual(envelope.recipientPublicKey, myKeypair.publicKey)
  ) {
    throw new Error("envelope not sealed for this device's public key");
  }
  const plaintext = sodium.crypto_box_seal_open(
    envelope.ciphertext,
    myKeypair.publicKey,
    myKeypair.privateKey,
  );
  if (!plaintext) {
    throw new Error("crypto_box_seal_open failed (tampered or wrong key)");
  }
  return plaintext;
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
