import { createHash } from "node:crypto";

/** Chromium extension ID from the manifest "key" (base64 SPKI DER): SHA-256, first 32 hex digits mapped 0-f to a-p. */
export function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, "base64");
  return createHash("sha256").update(der).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
}
