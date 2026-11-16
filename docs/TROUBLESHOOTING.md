# Troubleshooting

## Quick checks

1. Which mode is running? The lobby's status line says **"Connected"** (server mode) or **"Ready · peer-to-peer, no server"** (serverless).
2. Open the browser console (F12). Errors there usually name the cause.
3. Server mode: open `<site>/healthz` — it should return `{"status":"ok",…}`.

## Peers can't connect (serverless mode)

Symptom: *"We couldn't reach that room. The host may be offline, or your network blocks peer-to-peer connections."*

- **Is the host's tab still open?** In serverless mode the room lives in the host's browser. If everyone has left, the room is gone — create a new one.
- **Check the code.** Codes are 6 characters from `A–Z` and `2–9` (no `0`, `O`, `1`, `I`).
- **Different networks and strict NATs.** Direct connections can fail behind some corporate, school or mobile-carrier networks. Try another network, or provide a TURN relay (see [Configuration](CONFIGURATION.md#advanced-peer-to-peer-transport-options)).
- **Blocked trackers.** Peers are matched through public BitTorrent trackers over WebSocket. Some networks, VPNs or privacy extensions block them. Try without the extension/VPN.
- **Non-secure page.** WebCrypto and WebRTC need HTTPS (or `localhost`).
- Still stuck? Use server mode (it needs no peer-to-peer connectivity) — see [Deployment](DEPLOYMENT.md#c-split-vercel-frontend--render-backend).

## "Can't reach the server — retrying…" (server mode)

- The backend is asleep (free hosting tiers) — wait up to a minute.
- Wrong `BACKEND_URL` / `MUSIC_SPACE_API`, or the backend isn't running. Open `<backend>/healthz`.
- CORS: the browser console shows a blocked request to `/musicHub/negotiate`. Set `ALLOWED_ORIGINS` on the backend to your site's exact origin.
- The proxy in front of the backend doesn't allow WebSockets.

## The lobby says "peer-to-peer" but I deployed a backend

`BACKEND_URL` is baked in at build time. Add it in Vercel and **redeploy**. Then hard-refresh.

## No sound / video doesn't start

- Browsers block autoplay until you interact with the page. If the video doesn't start you'll see **"Tap to start listening"** — tap it.
- Check the volume and mute button in the player (and your device volume).
- *"Couldn't load the YouTube player"*: an ad blocker or firewall blocks `youtube.com`/`ytimg.com`, or you're offline.
- A video that can't be embedded (the owner disabled embedding, region lock, removed) is skipped automatically for everyone, with a message in chat.

## Out of sync

The player re-aligns itself whenever it drifts more than ~1.5 s. If one person is consistently behind, their connection is probably buffering. Pausing and resuming from any device re-syncs everyone.

## The music is playing at 2× and I didn't ask for it

Somebody is holding the video (or locked 2× by sliding up). It is a room-wide setting. Tap the purple/dark **"2×"** badge at the top of the video, or tap the video if you locked it yourself, to go back to normal. The speed also resets by itself when the song changes or the person who set it leaves.

## Someone keeps spamming reactions

Open the smiley menu on the video and press the eye icon to hide everyone's reactions on your screen, or open **People** and press the eye next to that person to mute only them. Both only affect your own screen.

## Search doesn't work

- **Server mode:** YouTube may be rate-limiting the server's IP (`RequestLimitExceededException` in the server log). Titles still load through oEmbed, and pasting links always works; the limit usually clears after a few hours. Consider running from a different IP.
- **Serverless mode:** search needs a free YouTube Data API key (Add tab → *Search settings*), otherwise the app tries community mirrors that are often down. Pasting a link always works. A "quota exceeded" error means the key's ~100 searches/day are used up.

## Titles show "YouTube video …" or the seek bar is disabled

The video's metadata couldn't be loaded (rate limit or offline lookup service). In serverless mode the first listener's player reports the real title and length shortly after the video starts, and the bar becomes active.

## "The room history doesn't line up"

Serverless mode only. A peer missed an update, or the host changed while messages were in flight. The app keeps following the room; if playback looks wrong, leave and rejoin with the same code.

## Reporting a bug

Open an [issue](https://github.com/TMAn1An/Shared-Music-Space/issues/new/choose) with the mode, browser/OS, steps to reproduce, and any console errors. Do not post room codes you want to keep private.
