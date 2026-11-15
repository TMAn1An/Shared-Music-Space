// Room rules, ported 1:1 from the server's Room.cs so both modes behave identically.
// In serverless mode the host's browser runs this as the authority; every other peer keeps a replica.

export const MAX_QUEUE = 100;
export const MAX_HISTORY = 30;
export const MAX_MEMBERS = 12; // peer-to-peer meshes get heavy beyond a dozen listeners

export class RoomCore {
  constructor({ code, name, now = () => Date.now() }) {
    this.code = code;
    this.name = name;
    this.now = now;
    this.members = [];       // { id, key, peerId, name, joinSeq }
    this.queue = [];
    this.history = [];
    this.current = null;
    this.playing = false;
    this.baseSeconds = 0;    // playhead at baseAt
    this.baseAt = 0;         // local-clock ms when baseSeconds was valid
    this.hostId = '';
    this.rev = 0;
    this.epoch = 0;          // bumps on every host change so stale hosts can be ignored
    this.joinCounter = 0;
  }

  /* ---------- membership ---------- */

  join({ id, key, peerId, name }) {
    const existing = this.members.find((m) => m.id === id);
    if (existing) { existing.peerId = peerId; this.#touch(); return { member: existing, reconnect: true }; }
    if (this.members.length >= MAX_MEMBERS) return { error: 'This room is full.' };
    const member = { id, key, peerId, name: this.#uniqueName(name), joinSeq: ++this.joinCounter };
    this.members.push(member);
    if (this.members.length === 1) { this.hostId = id; this.epoch++; }
    this.#touch();
    return { member, reconnect: false };
  }

  /** Removes a member; hands the host role to the next-oldest member if needed. */
  leave(memberId) {
    const idx = this.members.findIndex((m) => m.id === memberId);
    if (idx < 0) return { member: null, newHost: null };
    const [member] = this.members.splice(idx, 1);
    let newHost = null;
    if (member.id === this.hostId && this.members.length > 0) {
      this.hostId = this.members[0].id;
      this.epoch++;
      newHost = this.members[0];
    }
    this.#touch();
    return { member, newHost };
  }

  byPeer(peerId) { return this.members.find((m) => m.peerId === peerId) ?? null; }
  byId(id) { return this.members.find((m) => m.id === id) ?? null; }
  get host() { return this.byId(this.hostId); }

  #uniqueName(desired) {
    let name = desired;
    for (let i = 2; this.members.some((m) => m.name.toLowerCase() === name.toLowerCase()); i++) name = `${desired} ${i}`;
    return name;
  }

  /* ---------- queue & playback ---------- */

  addSong(song) {
    if (this.current?.id === song.id || this.queue.some((s) => s.id === song.id)) return 'duplicate';
    if (this.queue.length >= MAX_QUEUE) return 'full';
    this.#touch();
    if (!this.current) { this.#start(song); return 'started'; }
    this.queue.push(song);
    return 'added';
  }

  removeSong(queueId, memberId) {
    const who = this.byId(memberId);
    const idx = this.queue.findIndex((s) => s.queueId === queueId);
    if (!who || idx < 0) return false;
    if (who.id !== this.hostId && this.queue[idx].addedBy !== who.name) return false;
    this.queue.splice(idx, 1);
    this.#touch();
    return true;
  }

  moveToFront(queueId) {
    const idx = this.queue.findIndex((s) => s.queueId === queueId);
    if (idx <= 0) return false;
    this.queue.unshift(...this.queue.splice(idx, 1));
    this.#touch();
    return true;
  }

  togglePlay() {
    if (!this.current) return false;
    const t = this.now();
    if (this.playing) { this.baseSeconds = this.#position(t); this.playing = false; }
    else { this.baseAt = t; this.playing = true; }
    this.#touch();
    return true;
  }

  seek(seconds) {
    if (!this.current || !Number.isFinite(seconds)) return false;
    const max = this.current.duration > 0 ? this.current.duration - 1 : Infinity;
    this.baseSeconds = Math.min(Math.max(seconds, 0), max);
    this.baseAt = this.now();
    this.#touch();
    return true;
  }

  skip() {
    if (!this.current) return false;
    this.#advance();
    return true;
  }

  trackEnded(videoId) {
    if (!this.current || this.current.id !== videoId) return false;
    const nearEnd = this.current.duration <= 0 || this.#position(this.now()) >= this.current.duration - 8;
    if (!nearEnd) return false;
    this.#advance();
    return true;
  }

  unplayable(videoId) {
    if (!this.current || this.current.id !== videoId) return null;
    const bad = this.current;
    this.#advance(false);
    return bad;
  }

  advanceIfOverdue(graceSeconds) {
    if (!this.current || !this.playing || this.current.duration <= 0) return false;
    const raw = this.baseSeconds + (this.now() - this.baseAt) / 1000;
    if (raw < this.current.duration + graceSeconds) return false;
    this.#advance();
    return true;
  }

  /** The first player to learn a pasted video's real length reports it (metadata lookups can't give it without a server). */
  setDuration(videoId, seconds, title) {
    const song = this.current?.id === videoId ? this.current : this.queue.find((s) => s.id === videoId);
    if (!song || song.duration > 0 || !(seconds > 0 && seconds < 14400)) return false;
    song.duration = Math.floor(seconds);
    if (title && song.title.startsWith('YouTube video')) song.title = String(title).slice(0, 200);
    this.#touch();
    return true;
  }

  #advance(addToHistory = true) {
    if (this.current && addToHistory) {
      this.history.unshift(this.current);
      if (this.history.length > MAX_HISTORY) this.history.pop();
    }
    const next = this.queue.shift();
    if (next) this.#start(next);
    else { this.current = null; this.playing = false; this.baseSeconds = 0; }
    this.#touch();
  }

  #start(song) {
    this.current = song;
    this.playing = true;
    this.baseSeconds = 0;
    this.baseAt = this.now();
  }

  #position(t) {
    if (!this.current) return 0;
    let pos = this.playing ? this.baseSeconds + (t - this.baseAt) / 1000 : this.baseSeconds;
    pos = Math.max(0, pos);
    return this.current.duration > 0 ? Math.min(pos, this.current.duration) : pos;
  }

  #touch() { this.rev++; }

  /* ---------- views ---------- */

  /** Same shape the SignalR server sends, so the UI doesn't care which mode it runs in. */
  snapshot() {
    const t = this.now();
    return {
      code: this.code, name: this.name, rev: this.rev, serverTime: t,
      playback: { song: this.current, playing: this.playing, position: Math.round(this.#position(t) * 100) / 100 },
      members: this.members.map((m) => ({ id: m.id, name: m.name, isHost: m.id === this.hostId })),
      queue: [...this.queue],
      history: [...this.history],
    };
  }

  /** Everything a peer needs to hold a replica (and take over as host). Positions are frozen at `hostTime`. */
  exportState() {
    const t = this.now();
    return {
      code: this.code, name: this.name, rev: this.rev, epoch: this.epoch, hostId: this.hostId, joinCounter: this.joinCounter,
      members: this.members.map((m) => ({ ...m })),
      queue: this.queue, history: this.history, current: this.current, playing: this.playing,
      position: this.#position(t), hostTime: t,
    };
  }

  /** `skewMs` = hostClock − localClock, so replicas can place the playhead on their own clock. */
  static fromState(state, { now = () => Date.now(), skewMs = 0 } = {}) {
    const room = new RoomCore({ code: state.code, name: state.name, now });
    room.members = state.members.map((m) => ({ ...m }));
    room.queue = state.queue.map((s) => ({ ...s }));
    room.history = state.history.map((s) => ({ ...s }));
    room.current = state.current ? { ...state.current } : null;
    room.playing = state.playing;
    room.baseSeconds = state.position;
    room.baseAt = state.hostTime - skewMs;
    room.hostId = state.hostId;
    room.rev = state.rev;
    room.epoch = state.epoch;
    room.joinCounter = state.joinCounter;
    return room;
  }
}
