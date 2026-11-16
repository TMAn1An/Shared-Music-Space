# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Serverless (peer-to-peer) mode:** rooms run in the host's browser over WebRTC; works on any static host. Includes a hash-chained event log, ECDSA-signed commands with replay protection, automatic host failover and an optional personal YouTube API key for search.
- Automatic mode selection (`/healthz` probe, `config.js`, `?p2p=local`).
- Invite links (`/r/CODE`), pre-filled nickname, "Invite friends" flows, code-or-link join field, installable PWA manifest, screen wake lock.
- Seek bar, volume, queue management (play next, remove, recently played), chat history, floating reactions, keyboard shortcuts, media-session controls.
- Split hosting support: configurable backend URL, `ALLOWED_ORIGINS` CORS, `PORT` binding, `vercel.json`, Render blueprint, Dockerfile.
- MIT license, contributing guide, security policy, CI (.NET + Node tests), documentation in `docs/`.

### Changed
- Complete UI redesign with a hand-written design system; Bootstrap, jQuery and Font Awesome removed.
- Backend rewritten around a thread-safe, unit-tested `Room` with a server-owned playback clock; MVC removed in favour of static files + SignalR.
- Any client can report a finished song (idempotent); the server advances overdue songs itself.
- Video metadata resolves via search cache → YoutubeExplode → oEmbed.

### Fixed
- XSS: user-controlled text was inserted with `innerHTML`.
- Spoofable identity: clients supplied their own names on every call.
- Queue stalled when the admin left (only the admin's browser reported the end of a song).
- Rooms were never cleaned up; reconnects lost the member's seat; the History tab was unreachable; unfinished voice/image chat code removed.
- On invite pages the "Create a room" button joined instead of creating.
