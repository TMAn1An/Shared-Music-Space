// Wraps the YouTube IFrame player and keeps it locked to the server's playback clock.
// The server says "song X, playing, at 42.0s (as of T)". We extrapolate locally and
// nudge the iframe whenever it drifts. The iframe is never the source of truth.

const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
const DRIFT_TOLERANCE = 1.5;   // seconds before we re-seek a playing video
const SETTLE_MS = 3000;        // ignore drift right after a load/seek while it buffers

let apiPromise;
function loadYouTubeApi() {
  apiPromise ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => reject(new Error('YouTube API failed to load'));
    document.head.append(script);
  });
  return apiPromise;
}

export class SyncPlayer {
  #player = null;
  #ready = false;
  #target = null;      // { id, playing, pos, at }
  #loadedId = null;
  #loadedAt = 0;
  #volume = 80;
  #muted = false;
  #blockedTimer = 0;
  #hooks;

  #mountId;
  #started = false;

  constructor(mountId, hooks = {}) {
    this.#hooks = hooks;
    this.#mountId = mountId;
    // Drift correction heartbeat.
    setInterval(() => this.reconcile(), 2000);
  }

  /** Loads the YouTube iframe API on first use (keeps the lobby light and fast). */
  start() {
    if (this.#started) return;
    this.#started = true;
    const mountId = this.#mountId;
    loadYouTubeApi()
      .then((YT) => {
        this.#player = new YT.Player(mountId, {
          width: '100%', height: '100%',
          playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, fs: 0, iv_load_policy: 3, modestbranding: 1 },
          events: {
            onReady: () => { this.#ready = true; this.#applyVolume(); this.reconcile(); },
            onStateChange: (e) => this.#onState(e.data),
            onError: (e) => this.#hooks.onError?.(this.#loadedId, e.data),
          },
        });
      })
      .catch(() => this.#hooks.onFail?.());
  }

  /** Seconds into the current song according to the server clock. */
  expected() {
    const t = this.#target;
    if (!t) return 0;
    return t.playing ? t.pos + (performance.now() - t.at) / 1000 : t.pos;
  }

  /** Apply a server snapshot. `skewMs` = serverClock - localClock. */
  apply(playback, serverTime, skewMs) {
    const song = playback.song;
    if (!song) {
      this.#target = null;
      this.#loadedId = null;
      clearTimeout(this.#blockedTimer);
      this.#hooks.onBlocked?.(false);
      if (this.#ready) this.#player.stopVideo();
      return;
    }
    const age = Math.max(0, (Date.now() + skewMs - serverTime) / 1000);
    this.#target = {
      id: song.id,
      playing: playback.playing,
      pos: playback.position + (playback.playing ? age : 0),
      at: performance.now(),
    };
    this.reconcile(true);
  }

  reconcile(force = false) {
    const t = this.#target;
    if (!this.#ready || !t) return;
    const p = this.#player;
    const want = this.expected();

    if (this.#loadedId !== t.id) {
      this.#loadedId = t.id;
      this.#loadedAt = performance.now();
      if (t.playing) { p.loadVideoById({ videoId: t.id, startSeconds: want }); this.#watchBlocked(); }
      else p.cueVideoById({ videoId: t.id, startSeconds: want });
      return;
    }

    const state = p.getPlayerState();
    const settled = performance.now() - this.#loadedAt > SETTLE_MS;

    if (t.playing) {
      if (state === S.PAUSED || state === S.CUED) { p.playVideo(); this.#watchBlocked(); }
      else if (state === S.PLAYING && (force || settled)) {
        if (Math.abs(p.getCurrentTime() - want) > (force ? 0.8 : DRIFT_TOLERANCE)) {
          p.seekTo(want, true);
          this.#loadedAt = performance.now();
        }
      }
    } else {
      if (state === S.PLAYING || state === S.BUFFERING) p.pauseVideo();
      if (Math.abs(p.getCurrentTime() - want) > 0.6 && state !== S.UNSTARTED) p.seekTo(want, true);
    }
  }

  /** Resume after the browser blocked autoplay (needs a user gesture). */
  resume() {
    if (!this.#ready) return;
    this.#player.playVideo();
    this.reconcile(true);
  }

  setVolume(v) { this.#volume = v; this.#applyVolume(); }
  setMuted(m) { this.#muted = m; this.#applyVolume(); }
  get volume() { return this.#volume; }
  get muted() { return this.#muted; }

  #applyVolume() {
    if (!this.#ready) return;
    this.#player.setVolume(this.#volume);
    this.#muted ? this.#player.mute() : this.#player.unMute();
  }

  #onState(state) {
    if (state === S.PLAYING) { clearTimeout(this.#blockedTimer); this.#hooks.onBlocked?.(false); }
    if (state === S.ENDED && this.#loadedId) this.#hooks.onEnded?.(this.#loadedId);
  }

  #watchBlocked() {
    clearTimeout(this.#blockedTimer);
    this.#blockedTimer = setTimeout(() => {
      const st = this.#player?.getPlayerState?.();
      if (this.#target?.playing && st !== S.PLAYING && st !== S.BUFFERING) this.#hooks.onBlocked?.(true);
    }, 3500);
  }
}
