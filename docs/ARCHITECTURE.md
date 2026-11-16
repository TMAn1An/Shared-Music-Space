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

1. The room stores `{ song, playing, baseSeconds, baseAt }`. The playhead is `baseSeconds + (now − baseAt)` while playing, or `baseSeconds` while paused. Play, pause, seek, skip and song changes just rewrite those fields.
2. After every change the room sends a **snapshot**: `{ code, name, rev, serverTime, playback: { song, playing, position }, members, queue, history }`.
3. A client computes how long ago the snapshot was made (`now + skew − serverTime`, where `skew` is the measured clock offset to the room's clock) and extrapolates the expected position locally.
4. `js/player.js` drives the YouTube iframe towards that position: it loads the video at the right second, plays or pauses to match, and **re-seeks if the player drifts more than ~1.5 s** (checked every 2 s, ignored for 3 s after a load while buffering).
5. Late joiners and reconnects receive a snapshot on join and land on the exact second.

**Who ends a song?** Every client reports `TrackEnded(videoId)` when its player finishes. The room accepts only the first report that matches the current song and a playhead near the end, so duplicates are harmless and no single browser is special. As a safety net, the room advances on its own 10 s after a song's duration passes (covers everyone's tab being asleep or autoplay-blocked). If a player cannot embed a video (YouTube error codes 2, 100, 101, 150), `Unplayable(videoId)` skips it for everyone.

**Unknown durations.** Serverless mode may only know a title (via noembed.com), not a length. The first player that loads the video reports `SongMeta(videoId, duration, title)` and the room fills it in once.

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
| `TrackEnded(videoId)` · `Unplayable(videoId)` | Reported by clients (idempotent) |
| `SendChat(text)` · `React(emoji)` | Chat (≤ 500 chars) and allow-listed reactions |

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
