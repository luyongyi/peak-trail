import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../src/sha256.js";

const FIPS_VECTORS = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
];

// Passing a subtle-less object forces the pure-JS path: `undefined` would trigger
// the default parameter and silently select WebCrypto again.
const FORCE_JS = {};

test("the pure-JS fallback matches FIPS 180-4 vectors", async () => {
  for (const [message, expected] of FIPS_VECTORS) {
    const bytes = new TextEncoder().encode(message);
    const fallback = await sha256Hex(bytes, FORCE_JS);
    assert.equal(fallback, expected, `vector for ${JSON.stringify(message.slice(0, 12))}`);
  }
});

test("multi-block lengths and byte-offset views match WebCrypto", async () => {
  const sizes = [0, 1, 55, 56, 63, 64, 65, 4096, 1_000_003];
  for (const size of sizes) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 13) & 0xff;
    const fallback = await sha256Hex(bytes, FORCE_JS);
    const webcrypto = await sha256Hex(bytes, globalThis.crypto.subtle);
    assert.equal(fallback, webcrypto, `size ${size}`);
  }
  // A view into a larger buffer must hash only its own bytes.
  const big = new Uint8Array(128);
  big.fill(0xab, 0, 64);
  const view = big.subarray(64);
  assert.equal(await sha256Hex(view, FORCE_JS), await sha256Hex(new Uint8Array(64), FORCE_JS),
    "the digest covers the view, not the underlying buffer");
});
