// Deterministic 4-character run code, shared by the recorder (C# RunCode.cs) and
// this server. Every modded client in the same PEAK run derives the SAME code from
// the room-shared RunManager.RunId, so the server can merge all their uploads into
// one run without any client-side coordination.
import { createHash } from "node:crypto";

export const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0/o/1/i/l — 31 chars
export const CODE_LENGTH = 4;
export const CODE_SPACE = CODE_ALPHABET.length ** CODE_LENGTH; // 923521
export const MAX_DERIVATION_ATTEMPTS = 8;

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** .NET Guid "D" form: lowercase, hyphenated; anything else is trimmed lowercase. */
export function normalizeRunId(runId) {
  const text = String(runId ?? "").trim().toLowerCase().replace(/^[{[]|[}\]]$/g, "");
  if (GUID_PATTERN.test(text)) return text;
  const compact = text.replaceAll("-", "");
  if (/^[0-9a-f]{32}$/.test(compact)) {
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }
  return text;
}

/** First four code characters for this run; `attempt` walks a deterministic
 * fallback sequence when the server reports a code collision (409). */
export function deriveRunCode(runId, attempt = 0) {
  const normalized = normalizeRunId(runId);
  if (!normalized) return "";
  const digest = createHash("sha256").update(`${normalized}:${attempt}`, "utf8").digest();
  // Explicit little-endian u32 so the C# mirror never depends on machine endianness.
  // >>> 0 reinterprets the signed int32 bitwise result as unsigned, matching C# uint.
  const value = (digest[0] | (digest[1] << 8) | (digest[2] << 16) | (digest[3] << 24)) >>> 0;
  let rest = value % CODE_SPACE;
  const chars = new Array(CODE_LENGTH);
  for (let index = CODE_LENGTH - 1; index >= 0; index -= 1) {
    chars[index] = CODE_ALPHABET[rest % CODE_ALPHABET.length];
    rest = Math.floor(rest / CODE_ALPHABET.length);
  }
  return chars.join("");
}

export function isValidRunCode(code) {
  return typeof code === "string" && code.length === CODE_LENGTH
    && [...code].every((character) => CODE_ALPHABET.includes(character));
}

/** The server "confirms" a uuid by re-deriving it from the runId. */
export function runCodeMatches(runId, code) {
  for (let attempt = 0; attempt < MAX_DERIVATION_ATTEMPTS; attempt += 1) {
    if (deriveRunCode(runId, attempt) === code) return true;
  }
  return false;
}
