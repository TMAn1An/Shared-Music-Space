# Third-party software

| Component | License | Where |
|---|---|---|
| [@microsoft/signalr](https://github.com/dotnet/aspnetcore) 8.0.7 (browser client) | MIT | `SharedMusicSpace/wwwroot/vendor/signalr.min.js` |
| [YoutubeExplode](https://github.com/Tyrrrz/YoutubeExplode) | LGPL-3.0 | NuGet dependency |
| [Trystero](https://github.com/dmotz/trystero) 0.27 (torrent strategy, bundled) | MIT | `SharedMusicSpace/wwwroot/vendor/trystero-torrent.js` |
| YouTube IFrame Player API | [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service) | loaded at runtime from youtube.com |

Music Space does not download or re-host any media. Audio and video are played through YouTube's official embedded player.

Serverless mode optionally contacts third-party services from the user's browser: public WebTorrent trackers (peer discovery), noembed.com (video titles), and — only if the user supplies a key — the YouTube Data API or community Piped/Invidious mirrors (search).
