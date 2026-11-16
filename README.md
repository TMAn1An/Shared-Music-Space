# Music Space

Listen to YouTube music in perfect sync with friends. Create a room, share the invite link, queue songs, chat and react together.

**Stack:** ASP.NET Core 8 · SignalR · YoutubeExplode · vanilla ES modules + hand-written CSS (no build step, no jQuery/Bootstrap).

## Run

```bash
dotnet run --project SharedMusicSpace      # http://localhost:5271
dotnet test                                # room logic unit tests
docker build -t music-space . && docker run -p 8080:8080 music-space
```

## Deploy your own

SignalR needs a long-lived server, so the app has two parts. Serverless hosts alone (including Vercel) can't run the backend.

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
