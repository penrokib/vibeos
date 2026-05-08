import { describe, expect, it } from "vitest";
import {
  generateDeviceKeypair,
  initCrypto,
  openSealed,
  sealForRecipient,
} from "./envelope";

describe("E2E envelope crypto", () => {
  it("initialises libsodium without error", async () => {
    await initCrypto();
    expect(true).toBe(true);
  });

  it("generates a keypair with 32-byte public + private keys", async () => {
    const kp = await generateDeviceKeypair();
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKey.length).toBe(32);
    // Sanity: public != private
    expect(kp.publicKey).not.toEqual(kp.privateKey);
  });

  it("seals + opens a round-trip for the right recipient", async () => {
    const kp = await generateDeviceKeypair();
    const plaintext = new TextEncoder().encode("hello vibeOS");
    const env = await sealForRecipient(plaintext, kp.publicKey);
    const decrypted = await openSealed(env, kp);
    expect(new TextDecoder().decode(decrypted)).toBe("hello vibeOS");
  });

  it("refuses to open an envelope sealed for a DIFFERENT recipient", async () => {
    const alice = await generateDeviceKeypair();
    const bob = await generateDeviceKeypair();
    const plaintext = new TextEncoder().encode("secret for alice");
    const env = await sealForRecipient(plaintext, alice.publicKey);
    await expect(openSealed(env, bob)).rejects.toThrow(/not sealed for/);
  });

  it("throws on tampered ciphertext", async () => {
    const kp = await generateDeviceKeypair();
    const plaintext = new TextEncoder().encode("important");
    const env = await sealForRecipient(plaintext, kp.publicKey);
    // Flip a bit in the middle of the ciphertext
    env.ciphertext[Math.floor(env.ciphertext.length / 2)] ^= 0x01;
    await expect(openSealed(env, kp)).rejects.toThrow();
  });

  it("two recipients can each open their own envelope independently", async () => {
    const alice = await generateDeviceKeypair();
    const bob = await generateDeviceKeypair();
    const msgForAlice = new TextEncoder().encode("for alice");
    const msgForBob = new TextEncoder().encode("for bob");
    const envA = await sealForRecipient(msgForAlice, alice.publicKey);
    const envB = await sealForRecipient(msgForBob, bob.publicKey);
    expect(new TextDecoder().decode(await openSealed(envA, alice))).toBe(
      "for alice",
    );
    expect(new TextDecoder().decode(await openSealed(envB, bob))).toBe(
      "for bob",
    );
  });
});
