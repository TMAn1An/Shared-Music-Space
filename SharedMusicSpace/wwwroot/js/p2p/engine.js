// Serverless backend. Implements the same surface as the SignalR hub connection (invoke / on / start …),
// so the UI doesn't know which mode it runs in.
//
//   host     — the browser that created the room; runs RoomCore as the authority, orders every event,
//              appends it to a hash-chained log and broadcasts the new state.
//   peers    — hold a replica of the state, send *signed* commands to the host, render what the host broadcasts.
//   failover — every replica can become host: when the host disappears, the oldest remaining member takes over
//              from its replica and the chain continues from the last entry everyone already verified.

import { RoomCore } from '../core/room.js';
import { HashChain } from '../core/chain.js';
import { Identity, verify, idFromKey } from '../core/identity.js';
import { randomCode, randomId } from '../core/util.js';
import { parseVideoId } from './meta.js';

const REACTIONS = new Set(['❤️', '🔥', '😂', '👏', '🎉', '😮']);
const MAX_CHAT = 150;

const cleanName = (raw) => {
  const name = String(raw ?? '').split(/\s+/).filter(Boolean).join(' ');
  return name ? name.slice(0, 24).trimEnd() : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Background timers must never keep a Node process (tests) alive; browsers return a number, so guard unref.
const every = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; };
const after = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

export class P2PBackend {
  mode = 'p2p';
  state = 'Connected';

  #createTransport; #store; #meta; #search; now;
  #opts;
  #on = new Map();
  #identity = null;
  #t = null;
  #chain = null;
  #inbox = Promise.resolve();   // serialises incoming messages (signature checks are async)
  #outbox = Promise.resolve();  // serialises commits so peers see states in order
  #timers = [];
  #nonce = 0;
  #seen = new Map();            // memberId -> highest command nonce accepted (replay protection)
  #lastReact = new Map();       // memberId -> time of last accepted reaction
  #pending = new Map();         // rid -> resolve (peer waiting for host's answer)
  #awaiting = false;            // we elected a new host locally and wait for its first state
  #skew = 0;                    // hostClock - localClock
  #bestRtt = Infinity;

  room = null;
  me = null;
  chat = [];
  integrityOk = true;

  constructor({ createTransport, store, meta, search, now = () => Date.now(), helloTimeoutMs = 10000, electionWaitMs = 6000, tickMs = 5000, pingMs = 20000 }) {
    this.#createTransport = createTransport;
    this.#store = store;
    this.#meta = meta;
    this.#search = search;
    this.now = now;
    this.#opts = { helloTimeoutMs, electionWaitMs, tickMs, pingMs };
  }

  /* ----- hub-connection surface ----- */
  async start() {}
  onreconnecting() {} onreconnected() {} onclose() {}
  on(event, fn) { (this.#on.get(event) ?? this.#on.set(event, []).get(event)).push(fn); }
  #emit(event, ...args) { for (const fn of this.#on.get(event) ?? []) fn(...args); }

  async invoke(method, ...a) {
    switch (method) {
      case 'GetServerTime': return this.now();
      case 'CreateRoom': return this.#create(a[0]);
      case 'JoinRoom': return this.#join(a[0], a[1]);
      case 'LeaveRoom': return this.#leave();
      case 'Search': { const found = await this.#search(a[0]); this.#meta.remember(found); return found; }
      case 'AddSong': return this.#addSong(a[0]);
      case 'TogglePlay': return this.#command({ type: 'toggle' });
      case 'Skip': return this.#command({ type: 'skip' });
      case 'Seek': return this.#command({ type: 'seek', s: Number(a[0]) });
      case 'TrackEnded': return this.#command({ type: 'ended', v: a[0] });
      case 'Unplayable': return this.#command({ type: 'unplayable', v: a[0] });
      case 'RemoveSong': return this.#command({ type: 'remove', q: a[0] });
      case 'PlayNext': return this.#command({ type: 'next', q: a[0] });
      case 'SendChat': return this.#command({ type: 'chat', text: a[0] });
      case 'React': return this.#command({ type: 'react', emoji: a[0] });
      case 'SetRate': return this.#command({ type: 'rate', r: Number(a[0]) });
      case 'SongMeta': return this.#command({ type: 'meta', v: a[0], d: a[1], title: a[2] });
      default: throw new Error(`Unknown method ${method}`);
    }
  }

  get #isHost() { return !!this.room && !!this.me && this.room.hostId === this.me.id; }
  get #hostPeer() { return this.room?.host?.peerId ?? null; }

  /* ===================== lobby ===================== */

  async #ensureIdentity() {
    if (this.#identity) return this.#identity;
    const saved = this.#store.load();
    try { this.#identity = saved ? await Identity.restore(saved) : null; } catch { this.#identity = null; }
    if (!this.#identity) { this.#identity = await Identity.create(); this.#store.save(await this.#identity.export()); }
    return this.#identity;
  }

  async #create(name) {
    const nick = cleanName(name);
    if (!nick) return fail('Pick a nickname first.');
    await this.#leave();
    const identity = await this.#ensureIdentity();
    const code = randomCode();
    await this.#attach(code);

    this.room = new RoomCore({ code, name: `${nick}'s room`, now: this.now });
    const { member } = this.room.join({ id: identity.id, key: identity.publicKey, peerId: this.#t.selfId, name: nick });
    this.me = { id: member.id, name: member.name };
    this.#chain = new HashChain(code);
    this.chat = [];
    this.#startHostTimers();
    await this.#system(`${member.name} joined`);
    await this.#commit('create');
    return this.#joinResult();
  }

  async #join(code, name) {
    const nick = cleanName(name);
    if (!nick) return fail('Pick a nickname first.');
    const roomCode = String(code ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(roomCode)) return fail('That room code doesn’t look right.');
    await this.#leave();
    const identity = await this.#ensureIdentity();
    await this.#attach(roomCode);
    const t = this.#t;

    const sentAt = this.now();
    const hello = async (to) => {
      const value = { t: 'hello', room: roomCode, name: nick, peerId: t.selfId };
      t.send('hello', { ...value, key: identity.publicKey, id: identity.id, sig: await identity.sign(value) }, to);
    };

    this.#joining = true;
    this.#early = [];
    const welcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), this.#opts.helloTimeoutMs);
      this.#welcomeWaiter = (msg, from) => { clearTimeout(timer); resolve({ msg, from }); };
      t.onPeerJoin((peerId) => hello(peerId));
      for (const peerId of t.peers()) hello(peerId);
    });
    this.#welcomeWaiter = null;

    if (!welcome) { this.#joining = false; await this.#detach(); return fail('We couldn’t reach that room. The host may be offline, or your network blocks peer-to-peer connections.'); }
    const { msg } = welcome;
    if (!msg.ok) { this.#joining = false; await this.#detach(); return fail(msg.error ?? 'Couldn’t join.'); }

    const rtt = this.now() - sentAt;
    this.#skew = msg.full.hostTime + rtt / 2 - this.now();
    this.#bestRtt = rtt;
    this.me = { id: msg.you.id, name: msg.you.name };
    this.room = RoomCore.fromState(msg.full, { now: this.now, skewMs: this.#skew });
    this.chat = msg.chat ?? [];
    this.#chain = new HashChain(roomCode);
    this.#chain.head = { ...msg.head };
    this.#timers.push(every(() => this.#ping(), this.#opts.pingMs));
    // States that raced ahead of the welcome are replayed once the caller has the join result.
    const early = this.#early;
    this.#joining = false;
    this.#early = [];
    setTimeout(() => { for (const [d, f] of early) this.#inbox = this.#inbox.then(() => this.#onState(d, f)); }, 0);
    return this.#joinResult();
  }
  #welcomeWaiter = null;
  #joining = false;
  #early = [];

  #joinResult() {
    return { ok: true, error: null, memberId: this.me.id, name: this.me.name, room: this.room.snapshot(), chat: [...this.chat] };
  }

  async #attach(code) {
    this.#t = await this.#createTransport(code);
    await this.#t.ready;
    const t = this.#t;
    const guard = (fn) => (data, from) => { this.#inbox = this.#inbox.then(() => fn(data, from)).catch((e) => console.error('[p2p]', e)); };
    t.on('hello', guard((d, f) => this.#onHello(d, f)));
    t.on('welcome', guard((d, f) => this.#welcomeWaiter?.(d, f)));
    t.on('cmd', guard((d, f) => this.#onCmd(d, f)));
    t.on('res', guard((d, f) => this.#onRes(d, f)));
    t.on('state', guard((d, f) => (this.#joining ? this.#early.push([d, f]) : this.#onState(d, f))));
    t.on('chat', guard((d, f) => this.#onChat(d, f)));
    t.on('reaction', guard((d, f) => { if (f === this.#hostPeer) this.#emit('reaction', d.name, d.emoji); }));
    t.on('ping', guard((d, f) => { if (this.#isHost) t.send('pong', { t0: d.t0, hostTime: this.now() }, f); }));
    t.on('pong', guard((d, f) => this.#onPong(d, f)));
    t.on('bye', guard((_, f) => { const m = this.#isHost ? this.room.byPeer(f) : null; if (m) return this.#hostRemoveMember(m); }));
    t.onPeerLeave((peerId) => { this.#inbox = this.#inbox.then(() => this.#onPeerLeave(peerId)).catch((e) => console.error('[p2p]', e)); });
  }

  async #detach() {
    this.#timers.forEach(clearInterval);
    this.#timers = [];
    clearTimeout(this.#electionTimer);
    this.#awaiting = false;
    const t = this.#t;
    this.#t = null; this.room = null; this.me = null; this.chat = []; this.#seen.clear();
    for (const resolve of this.#pending.values()) resolve({ ok: false, message: 'You left the room.' });
    this.#pending.clear();
    await t?.leave();
  }

  async #leave() {
    if (!this.room) return;
    if (this.#isHost && this.room.members.length > 1) {
      // Graceful hand-over: promote the next member before disappearing.
      const { member, newHost } = this.room.leave(this.me.id);
      await this.#system(`${member.name} left · ${newHost.name} is now the host`);
      await this.#commit('handover');
      await sleep(150);
    } else if (!this.#isHost && this.#hostPeer) {
      this.#t.send('bye', {}, this.#hostPeer);
      await sleep(50);
    }
    await this.#detach();
  }

  /* ===================== commands (peer → host) ===================== */

  async #addSong(input) {
    const id = parseVideoId(input);
    if (!id) return { ok: false, message: 'That doesn’t look like a YouTube link.' };
    const meta = await this.#meta.resolve(id);
    if (!meta) return { ok: false, message: 'Couldn’t load that video.' };
    return this.#command({ type: 'addSong', song: { id: meta.id, title: meta.title, author: meta.author, duration: meta.duration } }, true);
  }

  async #command(c, wantResult = false) {
    if (!this.room) return wantResult ? { ok: false, message: 'You’re not in a room.' } : undefined;
    if (this.#isHost) return this.#hostHandle(this.me.id, c);

    const n = ++this.#nonce;
    const rid = wantResult ? randomId(8) : undefined;
    const value = { room: this.room.code, id: this.me.id, c, n };
    const sig = await this.#identity.sign(value);
    const reply = wantResult ? new Promise((resolve) => {
      this.#pending.set(rid, resolve);
      after(() => { if (this.#pending.delete(rid)) resolve({ ok: false, message: 'The host didn’t respond. Are they still online?' }); }, 8000);
    }) : null;
    this.#t.send('cmd', { id: this.me.id, c, n, sig, rid }, this.#hostPeer);
    return reply;
  }

  #onRes(d, from) { if (from === this.#hostPeer) this.#pending.get(d.rid)?.(d.result), this.#pending.delete(d.rid); }

  /* ===================== host side ===================== */

  async #onHello(d, from) {
    if (!this.#isHost) return;
    const r = this.room;
    const reject = (error) => this.#t.send('welcome', { ok: false, error }, from);

    const nick = cleanName(d?.name);
    const proven = d && nick && d.peerId === from && d.id === await idFromKey(d.key)
      && await verify(d.key, d.sig, { t: 'hello', room: r.code, name: d.name, peerId: d.peerId });
    if (!proven) return reject('We couldn’t verify your identity.');

    const { member, reconnect, error } = r.join({ id: d.id, key: d.key, peerId: from, name: nick });
    if (error) return reject(error);
    this.#t.send('welcome', {
      ok: true, you: { id: member.id, name: member.name },
      full: r.exportState(), chat: this.chat.slice(-MAX_CHAT), head: this.#chain.head,
    }, from);
    if (!reconnect) await this.#system(`${member.name} joined`);
    await this.#commit(`join:${member.id}`);
  }

  async #onCmd(d, from) {
    if (!this.#isHost) return;
    const member = this.room.byId(d?.id);
    if (!member || member.peerId !== from) return;
    if (!(d.n > (this.#seen.get(member.id) ?? 0))) return;                       // replayed or out of order
    if (!await verify(member.key, d.sig, { room: this.room.code, id: member.id, c: d.c, n: d.n })) return;
    this.#seen.set(member.id, d.n);
    const result = await this.#hostHandle(member.id, d.c);
    if (d.rid) this.#t.send('res', { rid: d.rid, result }, from);
  }

  /** Applies one command as the authority. Mirrors MusicHub.cs, including its messages. */
  async #hostHandle(memberId, c) {
    const r = this.room;
    const who = r.byId(memberId);
    if (!who || !c) return undefined;
    let changed = false;
    let result;

    switch (c.type) {
      case 'toggle': changed = r.togglePlay(); break;
      case 'seek': changed = r.seek(c.s); break;
      case 'rate': changed = r.setRate(c.r, memberId); break;
      case 'ended': changed = r.trackEnded(String(c.v)); break;
      case 'remove': changed = r.removeSong(String(c.q), memberId); break;
      case 'next': changed = r.moveToFront(String(c.q)); break;
      case 'meta': changed = r.setDuration(String(c.v), Number(c.d), c.title); break;
      case 'skip':
        if (r.skip()) { changed = true; await this.#system(`${who.name} skipped the song`); }
        break;
      case 'unplayable': {
        const bad = r.unplayable(String(c.v));
        if (bad) { changed = true; await this.#system(`“${bad.title}” can't be played here, skipping`); }
        break;
      }
      case 'addSong': {
        const s = c.song ?? {};
        if (!/^[\w-]{11}$/.test(s.id ?? '') || typeof s.title !== 'string') return { ok: false, message: 'That video can’t be added.' };
        const song = {
          queueId: randomId(10), id: s.id, title: s.title.slice(0, 200), author: String(s.author ?? '').slice(0, 100),
          duration: Number.isInteger(s.duration) && s.duration >= 0 && s.duration <= 14400 ? s.duration : 0, addedBy: who.name,
        };
        const outcome = r.addSong(song);
        if (outcome === 'duplicate') return { ok: false, message: 'That song is already playing or queued.' };
        if (outcome === 'full') return { ok: false, message: 'The queue is full.' };
        changed = true;
        await this.#system(outcome === 'started' ? `${who.name} started “${song.title}”` : `${who.name} queued “${song.title}”`);
        result = { ok: true, message: outcome === 'started' ? 'Now playing' : 'Added to queue' };
        break;
      }
      case 'chat': {
        const text = String(c.text ?? '').trim().slice(0, 500);
        if (text) this.#pushChat({ id: randomId(10), kind: 'user', name: who.name, text, time: this.now() });
        return undefined;
      }
      case 'react': {
        const t = this.now();
        if (t - (this.#lastReact.get(memberId) ?? 0) < 200) return undefined; // ≈5 per second per person, no flooding
        this.#lastReact.set(memberId, t);
        if (REACTIONS.has(c.emoji)) { this.#t.send('reaction', { name: who.name, emoji: c.emoji }); this.#emit('reaction', who.name, c.emoji); }
        return undefined;
      }
      default: return undefined;
    }
    if (changed) await this.#commit(`${c.type}:${memberId}`);
    return result;
  }

  async #hostRemoveMember(member) {
    const { newHost } = this.room.leave(member.id);
    await this.#system(newHost ? `${member.name} left · ${newHost.name} is now the host` : `${member.name} left`);
    await this.#commit(`leave:${member.id}`);
  }

  #startHostTimers() {
    this.#timers.push(every(() => {
      if (this.#isHost && this.room.advanceIfOverdue(10)) {
        this.#system('Moving on to the next song').then(() => this.#commit('tick'));
      }
    }, this.#opts.tickMs));
  }

  /** Append to the hash chain and broadcast. Serialised so every peer sees states in order. */
  #commit(label) {
    this.#outbox = this.#outbox.then(async () => {
      if (!this.room || !this.#t) return;
      const entry = await this.#chain.append({ by: label, rev: this.room.rev });
      this.#t.send('state', { full: this.room.exportState(), entry });
      this.#emit('state', this.room.snapshot());
    }).catch((e) => console.error('[p2p]', e));
    return this.#outbox;
  }

  async #system(text) { this.#pushChat({ id: randomId(10), kind: 'system', name: '', text, time: this.now() }); }

  #pushChat(msg) {
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    this.#t?.send('chat', msg);
    this.#emit('chat', msg);
  }

  /* ===================== peer side ===================== */

  #onChat(msg, from) {
    if (this.#isHost || from !== this.#hostPeer || !msg?.id) return;
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    this.#emit('chat', msg);
  }

  async #onState({ full, entry }, from) {
    if (!this.room || !full) return;
    const senderIsHostInState = full.members.find((m) => m.id === full.hostId)?.peerId === from;
    if (!senderIsHostInState) return; // only the host named in the state may speak for the room

    const cur = this.room;
    if (this.#isHost) {
      if (full.epoch <= cur.epoch) return; // we are the newer host; ignore the old one
    } else if (!this.#awaiting && !(full.epoch > cur.epoch || (full.epoch === cur.epoch && full.rev >= cur.rev))) return;

    this.#awaiting = false;
    clearTimeout(this.#electionTimer);
    const wasHost = this.#isHost;
    this.room = RoomCore.fromState(full, { now: this.now, skewMs: this.#skew });
    if (!this.room.byId(this.me.id)) { this.#emit('kicked'); return; }
    if (entry && !(await this.#chain.accept(entry))) {
      this.integrityOk = false;
      this.#emit('integrity', 'The room history doesn’t line up — someone may have missed an update.');
    }
    if (this.#isHost && !wasHost) this.#startHostTimers();
    this.#emit('state', this.room.snapshot());
  }

  #ping() {
    if (!this.#isHost && this.#hostPeer) this.#t.send('ping', { t0: this.now() }, this.#hostPeer);
  }
  #onPong(d, from) {
    if (from !== this.#hostPeer) return;
    const rtt = this.now() - d.t0;
    if (rtt <= this.#bestRtt * 1.5) { this.#bestRtt = Math.min(rtt, this.#bestRtt * 1.2); this.#skew = d.hostTime + rtt / 2 - this.now(); }
  }

  /* ----- failover ----- */
  #electionTimer = null;

  async #onPeerLeave(peerId) {
    if (!this.room) return;
    if (this.#isHost) {
      const m = this.room.byPeer(peerId);
      if (m) await this.#hostRemoveMember(m);
    } else if (this.#hostPeer === peerId) {
      await this.#elect(this.room.hostId);
    }
  }

  /** The host vanished: the oldest member we can still reach takes over. Every replica computes the same answer. */
  async #elect(lostHostId) {
    const r = this.room;
    const lost = r.byId(lostHostId);
    r.leave(lostHostId);
    const reachable = this.#t.peers();
    while (r.host && r.host.id !== this.me.id && !reachable.has(r.host.peerId)) r.leave(r.host.id);

    if (r.host?.id === this.me.id) {
      this.#awaiting = false;
      await this.#system(`${lost?.name ?? 'The host'} left · ${this.me.name} is now the host`);
      this.#startHostTimers();
      await this.#commit('failover');
      return;
    }
    this.#awaiting = true;
    this.#emit('state', r.snapshot());
    clearTimeout(this.#electionTimer);
    const elected = r.host?.id;
    this.#electionTimer = after(() => {
      // The elected member never spoke up (e.g. it vanished too) — drop it and try the next one.
      if (this.#awaiting && this.room?.hostId === elected) this.#inbox = this.#inbox.then(() => this.#elect(elected));
    }, this.#opts.electionWaitMs);
  }
}

const fail = (error) => ({ ok: false, error, memberId: null, name: null, room: null, chat: null });
