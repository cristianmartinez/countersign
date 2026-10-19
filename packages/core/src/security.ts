import { scrypt, timingSafeEqual } from "node:crypto";

function derive(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

import { sha256 } from "./content";

const encoder = new TextEncoder();

export const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function unhex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/.test(value))
    throw new Error("Invalid hex encoding");

  return Uint8Array.from(value.match(/../g)!, (b) => parseInt(b, 16));
}

export const randomToken = () =>
  bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || encoder.encode(password).length > 256)
    throw new Error(
      "Password must be at least 12 characters and at most 256 UTF-8 bytes",
    );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const hash = await derive(encoder.encode(password), salt);

  return `scrypt-v1$${bytesToHex(salt)}$${bytesToHex(hash)}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [version, salt, hash] = stored.split("$");

  if (
    version !== "scrypt-v1" ||
    !salt ||
    !hash ||
    salt.length !== 32 ||
    hash.length !== 64 ||
    encoder.encode(password).length > 256
  )
    return false;

  try {
    return timingSafeEqual(
      await derive(encoder.encode(password), unhex(salt)),
      unhex(hash),
    );
  } catch {
    return false;
  }
}

export interface EncryptedKey {
  ciphertext: string;
  nonce: string;
  version: number;
}

async function aes(secret: string) {
  const raw = unhex(secret);

  if (raw.length !== 32)
    throw new Error("Encryption key must be 32 random bytes encoded as hex");

  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptAgentKey(
  value: string,
  secret: string,
  agentId: string,
): Promise<EncryptedKey> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: encoder.encode(`agent-key:v1:${agentId}`),
    },
    await aes(secret),
    encoder.encode(value),
  );

  return {
    ciphertext: bytesToHex(new Uint8Array(ciphertext)),
    nonce: bytesToHex(nonce),
    version: 1,
  };
}

export async function decryptAgentKey(
  value: EncryptedKey,
  secret: string,
  agentId: string,
): Promise<string> {
  if (value.version !== 1) throw new Error("Unsupported encryption version");

  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unhex(value.nonce),
      additionalData: encoder.encode(`agent-key:v1:${agentId}`),
    },
    await aes(secret),
    unhex(value.ciphertext),
  );

  return new TextDecoder().decode(plain);
}

export { sha256 };
