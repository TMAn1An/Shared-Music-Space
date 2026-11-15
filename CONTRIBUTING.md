# Contributing

Thanks for helping make listening together better! Bug reports, ideas and pull requests are all welcome.

## Dev setup

```bash
dotnet run --project SharedMusicSpace   # http://localhost:5271 (hot-reloads static files in Development)
dotnet test                             # unit tests for the server room logic
node --test tests-js/*.test.mjs         # serverless (P2P) engine tests, Node 22+
```

You need the [.NET 8 SDK](https://dotnet.microsoft.com/download). The frontend is plain ES modules — there is no build step and no npm install.

## Where things live

- `SharedMusicSpace/Domain/Room.cs` — every rule about queue and playback. Add a test in `SharedMusicSpace.Tests` for any change here.
- `SharedMusicSpace/Hubs/MusicHub.cs` — the SignalR API. Identity always comes from the connection; never trust a name sent by the client.
- `SharedMusicSpace/wwwroot/js/core/` and `js/p2p/` — the serverless engine. `core/room.js` mirrors `Room.cs`: **change both together** so the modes behave the same. Add a test in `tests-js/` for any change here.
- `SharedMusicSpace/wwwroot/js/` — UI (`main.js`), the YouTube player synced to the server clock (`player.js`), DOM helpers (`dom.js`). Build DOM with `h()` / `textContent`, never `innerHTML` with user data.

## Pull requests

- Keep them focused; describe what changed and why.
- Run `dotnet test` and try the change with two browser windows.
- Include a screenshot for UI changes (desktop and phone width).

By contributing you agree your work is released under the [MIT License](LICENSE).
