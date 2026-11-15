# Music Space

Listen to YouTube music in perfect sync with friends. Create a room, share the invite link, queue songs, chat and react together.

**Stack:** ASP.NET Core 8 · SignalR · YoutubeExplode · vanilla ES modules + hand-written CSS (no build step, no jQuery/Bootstrap).

## Run

```bash
dotnet run --project SharedMusicSpace      # http://localhost:5271
dotnet test                                # server room logic
node --test tests-js/*.test.mjs            # serverless engine (Node 22+)
docker build -t music-space . && docker run -p 8080:8080 music-space
```

## Two ways to run it

| | **Server mode** | **Serverless mode** (peer-to-peer) |
|---|---|---|
| Needs a backend | ASP.NET + SignalR | **No** — static files only (Vercel, Netlify, GitHub Pages…) |
| Room lives in | the server's memory | the **host's browser** |
| Host leaves | room unaffected | next member takes over automatically (failover) |
| Search | works out of the box | paste a link, or add your own free YouTube API key |
| Room size | large | small groups (≤ 12) |

The app picks the mode on its own: if a backend answers at `/healthz` (or `config.js` names one) it uses server mode, otherwise it runs serverless. Force one with `window.MUSIC_SPACE_MODE = 'server' | 'p2p'` in `config.js`. Open the site with `?p2p=local` to try serverless mode between tabs of one browser, with no network.

### How serverless mode works

- **Transport:** WebRTC data channels. Peers find each other through public BitTorrent trackers using [Trystero](https://github.com/dmotz/trystero) (vendored in `wwwroot/vendor`). Traffic is end-to-end encrypted by WebRTC; we run nothing.
- **Host-ordered log:** the host applies every command with the same rules as the server (`js/core/room.js`), appends it to a **hash-chained log** (`js/core/chain.js`) and broadcasts the new state. Every entry commits to the previous one, so peers can detect rewritten, dropped or reordered history, including across a host change.
- **Identity:** each browser tab holds an ECDSA key pair. Your member id is derived from your public key and every command is **signed**; the host rejects forged and replayed commands (`js/core/identity.js`).
- **Failover:** every peer holds a replica of the room. If the host disappears, the oldest reachable member promotes itself and the chain continues from the last entry everyone already verified.
- **Limits:** the host's tab must stay open; rooms vanish when everyone leaves; strict corporate networks may need a TURN server (pass `rtcConfig` via `window.MUSIC_SPACE_P2P` in `config.js`); public tracker relays are best-effort.

There is deliberately no token, mining or consensus: a single host orders events, so a hash chain plus signatures is all the "blockchain" this needs.

## Deploy your own

**Serverless mode:** just host `SharedMusicSpace/wwwroot` on any static host (on Vercel, import the repo and leave `BACKEND_URL` unset). **Server mode:** SignalR needs a long-lived server, so serverless hosts such as Vercel can't run that backend.

| Part | Where | How |
|---|---|---|
| **Backend** (ASP.NET + SignalR) | Render, Fly.io, Railway, any Docker host | Build the root `Dockerfile`. Set `ALLOWED_ORIGINS` to your frontend URL. Health check: `/healthz`. A Render blueprint is in `deploy/render.yaml`. |
| **Frontend** (static) | Vercel, Netlify, or the backend itself | On Vercel: import the repo and set `BACKEND_URL=https://your-backend` (build runs `scripts/vercel-build.mjs`). |

The simplest option is a single Docker host: the backend also serves the frontend, so no extra configuration is needed.

## Features

- Server-authoritative playback: play/pause/seek/skip are the same for everyone; late joiners and reconnects land on the exact second
- Invite links (`/r/ABC123`), room codes, automatic seat restore after a page reload or network drop
- Search YouTube or paste a link; queue, "play next", remove, recently played
- Live chat with history, floating emoji reactions, host crown (auto-transfers when the host leaves)
- Unplayable/blocked videos are skipped automatically; the server advances stuck songs on its own
- Keyboard shortcuts: `Space` play/pause · `←/→` ±10s · `M` mute · `F` fullscreen; media-key / lock-screen controls
- Easy start: a fun nickname is pre-filled, join with a code or a pasted invite link, one-tap "Invite friends", installable as an app (PWA), screen stays awake while playing
- Responsive: split view on desktop, thumb-friendly bottom tabs on phones

## How it works

```
Domain/Room.cs        all room state + rules (thread-safe, unit-tested)
Services/             RoomService (registry), YouTubeService (search + metadata w/ fallbacks), RoomSweeper (housekeeping)
Hubs/MusicHub.cs      SignalR API; identity comes from the connection, never from client-sent names
wwwroot/js/           main.js (UI), player.js (YouTube player locked to the server clock), dom.js (XSS-safe helpers)
```

The server stores `{song, playing, position@time}`. Clients extrapolate the playhead from that and nudge the YouTube iframe whenever it drifts more than ~1.5s.

## Legal note

Playback uses YouTube's official embedded player. Search and metadata lookups use [YoutubeExplode](https://github.com/Tyrrrz/YoutubeExplode), which scrapes YouTube and may break or be rate-limited at any time (the app falls back to oEmbed for titles). Check YouTube's terms before running a public instance. Licensed under [MIT](LICENSE); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

> Rooms live in memory: restarting the server ends all rooms. Scale-out would need a SignalR backplane and shared room store.
