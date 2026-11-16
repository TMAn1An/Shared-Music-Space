// Identity without a server: every user owns an ECDSA P-256 key pair.
// Your member id is derived from your public key, so nobody can claim to be you,
// and every command you send is signed so the host (and anyone replaying the log) can verify it.

import { sha256Hex, canonical, b64, unb64 } from './util.js';

const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

export class Identity {
  #priv;
  constructor(priv, publicKey, id) { this.#priv = priv; this.publicKey = publicKey; this.id = id; }

  static async create() {
    const pair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
    return Identity.#wrap(pair.privateKey, pair.publicKey);
  }

  /** Restore from a JWK pair saved by `export()`. */
  static async restore(saved) {
    const priv = await crypto.subtle.importKey('jwk', saved.priv, ALG, true, ['sign']);
    const pub = await crypto.subtle.importKey('jwk', saved.pub, ALG, true, ['verify']);
    return Identity.#wrap(priv, pub);
  }

  static async #wrap(priv, pub) {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pub));
    const publicKey = b64(raw);
    const id = (await sha256Hex(publicKey)).slice(0, 8);
    return new Identity(priv, publicKey, id);
  }

  async export() {
    const pub = await crypto.subtle.exportKey('jwk', await importPub(this.publicKey));
    return { priv: await crypto.subtle.exportKey('jwk', this.#priv), pub };
  }

  /** Signs any JSON-able value. */
  async sign(value) {
    const sig = await crypto.subtle.sign(SIG, this.#priv, new TextEncoder().encode(canonical(value)));
    return b64(new Uint8Array(sig));
  }
}

const importPub = (publicKey) => crypto.subtle.importKey('raw', unb64(publicKey), ALG, true, ['verify']);

export async function verify(publicKey, signature, value) {
  try {
    return await crypto.subtle.verify(SIG, await importPub(publicKey), unb64(signature), new TextEncoder().encode(canonical(value)));
  } catch { return false; }
}

/** The member id a public key must have — lets peers reject forged id/key pairs. */
export async function idFromKey(publicKey) {
  return (await sha256Hex(publicKey)).slice(0, 8);
}
