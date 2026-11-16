# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository (<https://github.com/TMAn1An/Shared-Music-Space/security/advisories/new>). Include what you found, how to reproduce it and the impact. We'll acknowledge the report, work on a fix and credit you if you wish.

## Security model in short

- **No accounts, no stored personal data.** A nickname is the only identity; rooms live in memory and disappear when empty (server mode) or when everyone leaves (serverless mode).
- **No HTML injection.** Names, titles and chat are rendered with `textContent`/DOM APIs, never `innerHTML`.
- **Server mode:** identity comes from the SignalR connection, not from client-supplied names; inputs are length-limited and reactions are allow-listed; CORS is closed unless `ALLOWED_ORIGINS` lists your frontend.
- **Serverless mode:** each tab has an ECDSA key pair; commands are signed and replay-protected; state updates are only accepted from the peer the room names as host; history is hash-chained. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#identity-and-signatures).

## Known limitations

- Anyone who has a room code or invite link can join; treat codes like unlisted links. There are no passwords or moderation tools yet.
- In serverless mode the host is trusted to apply commands honestly (peers can *detect* a broken hash chain but cannot stop a malicious host). Peers' IP addresses are visible to other peers, as with any peer-to-peer WebRTC application.
- A personal YouTube Data API key entered in serverless mode is kept in `localStorage` in that browser; restrict it by HTTP referrer in the Google Cloud Console.
- Rate limiting is minimal; a public server deployment should sit behind a reverse proxy that limits abusive clients.
