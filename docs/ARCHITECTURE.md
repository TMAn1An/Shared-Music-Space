# Architecture

Music Space has one UI and two interchangeable "backends". The UI talks to a small interface (`invoke(method, …args)`, `on(event, handler)`), and `js/backend.js` decides at start-up which implementation provides it.

```
                    ┌────────────────────── main.js (UI) ──────────────────────┐
                    │   render · player sync · chat · queue · search · tabs    │
                    └───────────────┬──────────────────────────┬───────────────┘
                       invoke / on  │                          │  invoke / on
              ┌─────────────────────▼───────┐        ┌─────────▼──────────────────────┐
              │ Server mode                 │        │ Serverless mode                 │
              │ SignalR hub connection      │        │ P2PBackend (js/p2p/engine.js)   │
              └─────────────┬───────────────┘        └─────────┬───────────────────────┘
                            │ WebSocket                        │ WebRTC data channels
              ┌─────────────▼───────────────┐        ┌─────────▼───────────────────────┐
              │ ASP.NET Core 8              │        │ the host's browser = authority  │
              │ MusicHub → RoomService → Room│       │ RoomCore + hash-chained log     │
              └─────────────────────────────┘        └─────────────────────────────────┘
```

The two implementations share the same room rules (`Domain/Room.cs` and `js/core/room.js` are deliberate mirrors — change both together) and send the same state shape to the UI, so the UI never knows which mode it is in.

## Synchronised playback

The room — never a browser — is the single source of truth for what plays and where the playhead is.

1. The room stores `{ song, playing, rate, baseSeconds, baseAt }`. The playhead is `baseSeconds + (now − baseAt) × rate` while playing, or `baseSeconds` while paused. Play, pause, seek, skip, speed and song changes just rewrite those fields (a speed change re-bases the playhead so it never jumps).
2. After every change the room sends a **snapshot**: `{ code, name, rev, serverTime, playback: { song, playing, position, rate }, members, queue, history }`.
3. A client computes how long ago the snapshot was made (`now + skew − serverTime`, where `skew` is the measured clock offset to the room's clock) and extrapolates the expected position locally.
4. `js/player.js` drives the YouTube iframe towards that position: it loads the video at the right second, plays or pauses to match, and **re-seeks if the player drifts more than ~1.5 s** (checked every 2 s, ignored for 3 s after a load while buffering).
5. Late joiners and reconnects receive a snapshot on join and land on the exact second.

**Hold-to-2× is a room setting.** Pressing and holding the video sets `rate = 2` for *everyone*, so the room keeps listening to the same thing (a private 2× would put you out of sync and the drift correction would pull you back). Only `1` and `2` are accepted; the rate resets to `1` for every new song, and when the member who set it leaves or disconnects, so it can never get stuck. Releasing, tapping while locked, or pressing the on-screen "2×" badge (any member can) sets it back to `1`. The player mirrors the room's rate through the IFrame API's `setPlaybackRate`.

**Who ends a song?** Every client reports `TrackEnded(videoId)` when its player finishes. The room accepts only the first report that matches the current song and a playhead near the end, so duplicates are harmless and no single browser is special. As a safety net, the room advances on its own 10 s after a song's duration passes (covers everyone's tab being asleep or autoplay-blocked). If a player cannot embed a video (YouTube error codes 2, 100, 101, 150), `Unplayable(videoId)` skips it for everyone.

**Unknown durations (both modes).** A pasted link can arrive without a length: in serverless mode there is no server to ask, and in server mode YouTube may rate-limit the server's IP so only the title is available (via oEmbed). The first player that loads the video knows the truth and reports `SongMeta(videoId, duration, title)`; the room accepts the first sane report (0 < length < 4 h) for a song whose duration is still 0 and ignores later ones.

## Server mode

### Hub API (`/musicHub`)

Identity always comes from the SignalR connection (`Context.ConnectionId`), never from a name sent by the client. A browser tab supplies a random `clientId` so a reconnect can take over its own seat.

| Method | Purpose |
|---|---|
| `CreateRoom(name, clientId)` / `JoinRoom(code, name, clientId)` | Returns `{ ok, error, memberId, name, room, chat }` |
| `LeaveRoom()` | Leave; the host role moves to the next-oldest member |
| `GetServerTime()` | Used by the client to measure clock skew |
| `Search(query)` | YouTube search (≤ 15 results, live streams removed) |
| `AddSong(urlOrId)` | Returns `{ ok, message }`; rejects duplicates, live streams, > 4 h |
| `RemoveSong(queueId)` | Allowed for the song's adder or the host |
| `PlayNext(queueId)` | Move a queued song to the front |
| `TogglePlay()` · `Skip()` · `Seek(seconds)` | Playback control — open to everyone |
| `SetRate(rate)` | Room-wide speed, `1` or `2` (hold-to-2×) |
| `TrackEnded(videoId)` · `Unplayable(videoId)` | Reported by clients (idempotent) |
| `SongMeta(videoId, duration, title)` | A player reports the real length of a song added without one (first report wins) |
| `SendChat(text)` · `React(emoji)` | Chat (≤ 500 chars) and allow-listed reactions, limited to ≈ 5 reactions/s per connection |

Server → client events: `state` (snapshot), `chat` (message), `reaction` (name, emoji).

### Server components

| Component | Responsibility |
|---|---|
| `Domain/Room.cs` | All rules, behind one lock. Time comes from an injected `TimeProvider`, so tests control the clock. |
| `Services/RoomService.cs` | Room registry, connection → room map, collision-free room codes (no `0/O/1/I`) |
| `Services/RoomSweeper` | Every 5 s advances overdue songs; every minute removes rooms empty for > 10 min |
| `Services/YouTubeService.cs` | Metadata via search cache → YoutubeExplode → oEmbed (title/author only) |
| `Hubs/MusicHub.cs` | The API above |

## Serverless (peer-to-peer) mode

### Roles

- **Host** — the browser that created the room. It runs `RoomCore` (the authority), applies each command, appends it to the hash chain and broadcasts the new state.
- **Peers** — hold a replica of the state, send *signed* commands to the host and render what the host broadcasts.
- **Failover** — any peer can become host (see below).

### Transport

`js/p2p/transport-*.js` implement one tiny interface (`send(type, data, to?)`, `on(type, fn)`, `onPeerJoin`, `onPeerLeave`, `peers()`, `leave()`):

| Transport | Used for |
|---|---|
| `transport-trystero.js` | Production: WebRTC data channels; peers are matched through public BitTorrent trackers by [Trystero](https://github.com/dmotz/trystero) (vendored). WebRTC encrypts traffic end to end. |
| `transport-local.js` | `?p2p=local`: tabs of one browser via `BroadcastChannel` — demos and Playwright tests, no network |
| `transport-memory.js` | Unit tests: an in-process network |

### Messages

| Type | Direction | Payload |
|---|---|---|
| `hello` | joiner → all | `{ name, key, id, peerId, sig }` — a signature proving key ownership |
| `welcome` | host → joiner | `{ ok, you, full, chat, head }` or `{ ok:false, error }` |
| `cmd` | peer → host | `{ id, c:{type,…}, n, sig, rid? }` — signed command |
| `res` | host → peer | `{ rid, result }` — answer to `AddSong` |
| `state` | host → all | `{ full, entry }` — the whole room state plus its hash-chain entry |
| `chat`, `reaction` | host → all | broadcast messages |
| `ping` / `pong` | peer ↔ host | clock-skew measurement |
| `bye` | peer → host | polite leave |

Commands (`cmd.c.type`): `toggle`, `skip`, `seek`, `rate`, `ended`, `unplayable`, `remove`, `next`, `addSong`, `chat`, `react`, `meta`.

Peers ignore `state`, `chat`, `reaction`, `res` and `pong` unless they come from the peer that the state itself names as host.

### Identity and signatures

Each browser tab generates an **ECDSA P-256 key pair** (kept in `sessionStorage`, so a reload keeps your seat). Your member id is the first 8 hex characters of `SHA-256(publicKey)`, so an id cannot be forged without the key.

- `hello` is signed over `{ room, name, peerId }`; the host checks the key↔id match, the signature, and that `peerId` equals the transport peer it came from (a replayed `hello` from another peer fails).
- Every `cmd` is signed over `{ room, id, c, n }` with a per-member increasing nonce `n`. The host rejects unknown members, wrong sender peers, bad signatures and replayed or out-of-order nonces.

### Hash-chained log (the useful part of "blockchain")

Each applied command produces an entry `{ seq, prev, body, hash }` where `hash = SHA-256(canonical({ seq, prev, body }))` and `prev` is the previous entry's hash (the genesis hash is derived from the room code). Peers verify every entry they receive, so they can detect history that was rewritten, dropped or reordered — including across a host change, because the new host continues from the last entry everyone already holds. A mismatch raises an integrity warning in the UI.

There is deliberately **no** mining, token or consensus protocol: a single host orders events, so a hash chain plus signatures is all that is needed.

### Failover

Every `state` carries the full room state, so each peer holds a replica.

- **Graceful leave:** the host promotes the next member (by join order), broadcasts, then disconnects.
- **Abrupt loss:** when peers see the host's connection drop, each one independently removes the host from its replica and elects the oldest member it can still reach — all replicas reach the same answer. That member announces itself as host (`epoch` increases), and the others accept its state. If the elected member never speaks up within 6 s, it is dropped and the next one is tried.

The room therefore survives as long as at least one member stays. Playback position is preserved because the new host rebases the playhead onto its own clock.

### Limits

Room size ≤ 12 (full-mesh WebRTC), queue ≤ 100, history 30, chat 150 messages kept, names 24 characters, chat messages 500 characters.

## Gestures and reactions (frontend)

| Gesture on the video | Result |
|---|---|
| Tap / click | Play or pause for everyone |
| Press and hold (≈ 0.4 s) | 2× for the whole room while held |
| …then slide up | Locks 2×; the next tap (or the badge) returns to 1× |
| Mouse move / touch | Brings the YouTube-style controls back; they fade after 3 s while playing |

`touch-action: none` on the video shield keeps the page from scrolling during a hold, and every way a hold can end without a release event (`pointercancel`, blur, tab hidden, page hide) sets the speed back to 1×.

Reactions never have to be annoying: one switch hides everyone's floating emoji on *your* screen only (your own still float), each person in the People tab can be muted individually, only the first few reactions of a rapid burst from one person are drawn, and the server (or the host, in serverless mode) rate-limits each sender. These preferences are local to your browser.

## Frontend structure

| File | Role |
|---|---|
| `index.html`, `css/app.css` | Markup and the hand-written design system (design tokens at the top of the stylesheet) |
| `js/main.js` | UI state, rendering, events, tabs, keyboard shortcuts, media-session |
| `js/backend.js` | Chooses server or serverless and builds the backend object |
| `js/player.js` | YouTube iframe wrapper locked to the room clock |
| `js/dom.js` | `h()` element builder, icons, formatting, toasts — user text goes through `textContent`, never `innerHTML` |
| `js/core/*` | Serverless engine: room rules, hash chain, identity |
| `js/p2p/*` | Serverless engine: protocol, transports, metadata, search |
