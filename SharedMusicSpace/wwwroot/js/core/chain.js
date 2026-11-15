// A tiny hash-chained event log (the useful 10% of "blockchain"): every entry commits to the one before it,
// so anyone holding the log can detect if history was rewritten, dropped or reordered —
// e.g. by a host that left, or a new host taking over. No mining, no tokens, no consensus: the host orders events.

import { sha256Hex, canonical } from './util.js';

export class HashChain {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.head = { seq: 0, hash: null }; // hash of the genesis is lazily computed
    this.entries = [];                  // bounded tail kept in memory
  }

  static MAX = 200;

  async #genesis() { return sha256Hex(`music-space:${this.roomCode}`); }

  async append(body) {
    const prev = this.head.hash ?? await this.#genesis();
    const seq = this.head.seq + 1;
    const hash = await sha256Hex(canonical({ seq, prev, body }));
    const entry = { seq, prev, body, hash };
    this.#push(entry);
    return entry;
  }

  /** Verifies and adopts an entry produced elsewhere. Returns false (and resyncs) if the chain doesn't link up. */
  async accept(entry) {
    const prev = this.head.hash ?? await this.#genesis();
    const ok =
      entry.seq === this.head.seq + 1 &&
      entry.prev === prev &&
      entry.hash === await sha256Hex(canonical({ seq: entry.seq, prev: entry.prev, body: entry.body }));
    this.#push(entry); // adopt even when broken so we keep following the room, but report it
    return ok;
  }

  /** Self-check of the retained tail. */
  async verifyTail() {
    for (let i = 1; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e.prev !== this.entries[i - 1].hash || e.hash !== await sha256Hex(canonical({ seq: e.seq, prev: e.prev, body: e.body }))) return false;
    }
    return true;
  }

  #push(entry) {
    this.head = { seq: entry.seq, hash: entry.hash };
    this.entries.push(entry);
    if (this.entries.length > HashChain.MAX) this.entries.shift();
  }
}
