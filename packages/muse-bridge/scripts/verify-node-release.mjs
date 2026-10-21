/**
 * Verify a Node.js SHASUMS256.txt.asc cleartext signature before trusting it.
 *
 * The public key is Antoine du Hamel's Node release key, vendored from
 * https://github.com/nodejs/release-keys (fingerprint
 * 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356). v26.8.2 was signed by that key.
 * Bump the fingerprint and the key file together with NODE_VERSION.
 *
 * Verification uses OpenPGP (the signature format of the .asc file) in this
 * process. A system GnuPG install is not required, and the unsigned
 * SHASUMS256.txt is never trusted.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as openpgp from "openpgp";

export const NODE_RELEASE_FINGERPRINT = "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356";

const keyPath = join(dirname(fileURLToPath(import.meta.url)), "keys", `${NODE_RELEASE_FINGERPRINT}.asc`);

let releaseKey;
function loadReleaseKey() {
  releaseKey ??= openpgp.readKey({ armoredKey: readFileSync(keyPath, "utf8") });
  return releaseKey;
}

/**
 * Verify `ascPath` against the vendored release key and return the signed
 * checksum text. Throws if the key is not the pinned fingerprint or the
 * signature is not valid.
 */
export async function verifySignedChecksums(ascPath) {
  const key = await loadReleaseKey();
  const fingerprint = key.getFingerprint().toUpperCase();
  if (fingerprint !== NODE_RELEASE_FINGERPRINT) {
    throw new Error(`Vendored Node release key is not ${NODE_RELEASE_FINGERPRINT}.`);
  }
  let result;
  try {
    const message = await openpgp.readCleartextMessage({ cleartextMessage: readFileSync(ascPath, "utf8") });
    result = await openpgp.verify({ message, verificationKeys: key });
    if (result.signatures.length === 0) throw new Error("Node SHASUMS256.txt.asc did not carry a signature.");
    for (const signature of result.signatures) {
      // openpgp rejects a bad signature, and a resolved `false` is a bad signature too.
      const verified = await signature.verified;
      if (verified !== true) throw new Error("signature was not accepted.");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.startsWith("Vendored") || detail.startsWith("Node ")) throw error;
    throw new Error(`Refusing to stage Node: ${detail}`);
  }
  return typeof result.data === "string" ? result.data : new TextDecoder().decode(result.data);
}

/** Map `filename → sha256` from a verified checksum document. */
export function checksumMap(text) {
  const sums = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+(\S+)$/i);
    if (match) sums[match[2]] = match[1].toLowerCase();
  }
  return sums;
}
