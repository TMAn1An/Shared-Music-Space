# Configuration reference

## Backend environment variables (server mode)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | — | Port to listen on. Set automatically by Render/Railway/Heroku-style platforms. |
| `ASPNETCORE_URLS` | `http://+:8080` in the Docker image | Standard ASP.NET binding. `PORT`, if set, wins. |
| `ALLOWED_ORIGINS` | *(empty = same origin only)* | Comma-separated browser origins allowed to call the hub when the frontend is hosted elsewhere, e.g. `https://music-space.vercel.app`. Exact match, no trailing slash. |
| `ASPNETCORE_ENVIRONMENT` | `Production` | `Development` enables detailed errors. |
| `Logging__LogLevel__Default` | `Information` | Standard ASP.NET logging configuration. |

Endpoints: `/` (frontend), `/r/{code}` (invite links, served as the frontend), `/musicHub` (SignalR), `/healthz` (`{"status":"ok","rooms":N}`).

## Frontend build variable (Vercel)

| Variable | Purpose |
|---|---|
| `BACKEND_URL` | `https://…` URL of the backend. Written into `config.js` by `scripts/vercel-build.mjs` at build time. Leave **unset** for serverless (peer-to-peer) mode. Changing it needs a redeploy. |

## `wwwroot/config.js`

Loaded before the app. Edit it by hand for static hosting without Vercel's build step.

```js
window.MUSIC_SPACE_API  = '';      // backend base URL; '' = same origin
window.MUSIC_SPACE_MODE = 'auto';  // 'auto' | 'server' | 'p2p'
window.MUSIC_SPACE_P2P  = {};      // optional extra options for the peer-to-peer transport
```

**Mode selection (`auto`):** if `MUSIC_SPACE_API` is set → server mode. Otherwise the app asks `/healthz` on its own origin (2.5 s timeout); a valid answer → server mode, anything else → serverless mode.

**URL switches:** `?p2p=local` forces serverless mode over `BroadcastChannel`, so several tabs of one browser act as separate people — useful for demos and tests.

### Advanced: peer-to-peer transport options

`MUSIC_SPACE_P2P` is passed to Trystero's `joinRoom` configuration. Useful keys:

```js
window.MUSIC_SPACE_P2P = {
  // Strict NATs / corporate networks may need a TURN relay:
  rtcConfig: { iceServers: [{ urls: 'turn:turn.example.com:3478', username: '…', credential: '…' }] },
  // Use your own BitTorrent trackers for peer discovery:
  relayConfig: { urls: ['wss://tracker.example.com'] },
};
```

> These options are forwarded as-is to the vendored Trystero 0.27 and have not been exercised in this project's tests; see the [Trystero docs](https://github.com/dmotz/trystero) for the full list. Never put credentials you can't expose in a public site into `config.js` — it is served to every visitor.

## Browser storage

| Key | Where | Content |
|---|---|---|
| `ms.name` | localStorage | Last nickname |
| `ms.volume`, `ms.muted` | localStorage | Player volume (0–100) and mute |
| `ms.hideReactions` | localStorage | `1` when floating emoji from others are hidden on this device |
| `ms.ytkey` | localStorage | Optional personal YouTube Data API key (serverless search). Never leaves your browser except in requests to Google. |
| `ms.cid` | sessionStorage | Per-tab client id (server mode seat restore) |
| `ms.session` | sessionStorage | Current room code + name, to rejoin after a reload |
| `ms.mutedFrom` | sessionStorage | Names whose reactions you muted in the People tab |
| `ms.identity` | sessionStorage | Per-tab signing key pair (serverless mode) |

## Built-in limits

| Limit | Server | Serverless |
|---|---|---|
| Members per room | 50 | 12 |
| Queue length | 100 | 100 |
| History kept | 30 | 30 |
| Chat messages kept | 150 | 150 |
| Nickname length | 24 | 24 |
| Chat message length | 500 | 500 |
| Max video length | 4 h | 4 h |
| Empty-room lifetime | 10 min | — (room ends when everyone leaves) |

Reactions are limited to ❤️ 🔥 😂 👏 🎉 😮, and to about five per second per person. Playback speed is limited to 1× and 2×.

## Serverless search

Browsers can't scrape YouTube, so serverless mode searches in this order:

1. **Your own YouTube Data API key** (Add tab → *Search settings*). Free quota ≈ 100 searches/day. Create one in the [Google Cloud Console](https://developers.google.com/youtube/v3/getting-started) and restrict it to your site's domain.
2. **Community mirrors** (Piped / Invidious) — free but frequently down.
3. **Paste a link** — always works.
