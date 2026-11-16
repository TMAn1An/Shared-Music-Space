# Contributing

Thanks for helping make listening together better! Bug reports, ideas, docs fixes and pull requests are all welcome.

Please read the [architecture overview](docs/ARCHITECTURE.md) first — it explains the two modes, and why some code exists twice.

## Dev setup

Requirements: the [.NET 8 SDK](https://dotnet.microsoft.com/download) and, for the serverless tests, Node 22+. The frontend has no build step and no `npm install`.

```bash
dotnet run --project SharedMusicSpace   # http://localhost:5271 (static files reload on refresh in Development)
dotnet test                             # server room logic (xUnit)
node --test tests-js/*.test.mjs         # serverless engine (Node's built-in runner)
```

Try serverless mode without any network: open `http://localhost:5271/?p2p=local` in two tabs of one browser.

> You can't play YouTube in a headless browser, so UI work is best checked by hand in a real browser. For automated checks, block `**/iframe_api` and drive the app with Playwright.

## Where things live

| Path | What |
|---|---|
| `SharedMusicSpace/Domain/Room.cs` | Every rule about queue and playback (server). Add a test in `SharedMusicSpace.Tests` for any change. |
| `SharedMusicSpace/Hubs/MusicHub.cs` | The SignalR API. Identity always comes from the connection — never trust a name sent by the client. |
| `SharedMusicSpace/wwwroot/js/core/room.js` | The same rules, ported to JS for serverless mode. **Change both files together** so the modes behave identically. |
| `SharedMusicSpace/wwwroot/js/p2p/` | Serverless protocol, transports, search, metadata. Add a test in `tests-js/` for any change. |
| `SharedMusicSpace/wwwroot/js/main.js`, `player.js`, `dom.js` | The UI. Build DOM with `h()` / `textContent`, never `innerHTML` with user data. |
| `SharedMusicSpace/wwwroot/css/app.css` | Design system: tokens at the top, then components. Reuse tokens instead of hard-coded colours. |
| `docs/` | User-facing documentation — update it when behaviour or configuration changes. |

## Pull requests

- Keep them focused; explain what changed and why (the PR template will guide you).
- Run both test suites and try the change with two browser windows.
- Include screenshots for UI changes (desktop and phone width).
- Add an entry to [CHANGELOG.md](CHANGELOG.md) under *Unreleased* for user-visible changes.

## Reporting security problems

Privately, as described in [SECURITY.md](SECURITY.md) — not in a public issue.

By contributing you agree your work is released under the [MIT License](LICENSE).
