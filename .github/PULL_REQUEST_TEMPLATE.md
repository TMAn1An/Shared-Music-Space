## What and why
<!-- What does this change, and why? Link the issue it closes (Closes #123). -->

## Mode(s) affected
- [ ] Server mode (ASP.NET / SignalR)
- [ ] Serverless mode (peer-to-peer)
- [ ] Frontend only / docs

## How I tested it
<!-- Commands run, browsers/devices tried, what you verified by hand. -->
- [ ] `dotnet test`
- [ ] `node --test tests-js/*.test.mjs`
- [ ] Tried it with two browser windows

## Screenshots
<!-- For UI changes: desktop and phone width. -->

## Checklist
- [ ] Rule changes are mirrored in both `Domain/Room.cs` and `js/core/room.js`, with tests
- [ ] User-controlled text is rendered with DOM APIs / `textContent` (no `innerHTML`)
- [ ] Docs / CHANGELOG updated if behaviour or configuration changed
