using System.Collections.Concurrent;
using SharedMusicSpace.Domain;
using YoutubeExplode;
using YoutubeExplode.Common;
using YoutubeExplode.Videos;

namespace SharedMusicSpace.Services;

public sealed record VideoMeta(string Id, string Title, string Author, int Duration);

public sealed class YouTubeService(ILogger<YouTubeService> log)
{
    private const int MaxDurationSeconds = 4 * 60 * 60;
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(8) };
    private readonly YoutubeClient _client = new();
    private readonly ConcurrentDictionary<string, VideoMeta> _cache = new();

    public static string? ParseVideoId(string input) => VideoId.TryParse(input)?.Value;

    /// <summary>
    /// Resolves metadata, trying progressively cheaper/more reliable sources:
    /// search cache → YoutubeExplode → oEmbed (title/author only, duration unknown = 0).
    /// </summary>
    public async Task<(VideoMeta? Meta, string? Error)> GetAsync(string videoId, CancellationToken ct)
    {
        if (_cache.TryGetValue(videoId, out var cached)) return (cached, null);

        try
        {
            var video = await _client.Videos.GetAsync(VideoId.Parse(videoId), ct);
            if (video.Duration is null) return (null, "Live streams can't be queued.");
            var seconds = (int)video.Duration.Value.TotalSeconds;
            if (seconds > MaxDurationSeconds) return (null, "That video is longer than 4 hours.");
            return (Remember(new VideoMeta(video.Id.Value, video.Title, video.Author.ChannelTitle, seconds)), null);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            log.LogWarning("YoutubeExplode failed for {VideoId} ({Reason}); trying oEmbed", videoId, ex.GetType().Name);
        }

        try
        {
            var url = $"https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v={videoId}";
            using var doc = await System.Text.Json.JsonDocument.ParseAsync(await Http.GetStreamAsync(url, ct), cancellationToken: ct);
            var title = doc.RootElement.GetProperty("title").GetString() ?? "Untitled";
            var author = doc.RootElement.TryGetProperty("author_name", out var a) ? a.GetString() ?? "" : "";
            return (Remember(new VideoMeta(videoId, title, author, 0)), null);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            log.LogWarning(ex, "oEmbed failed for {VideoId}", videoId);
            return (null, "Couldn't load that video. It may be private, removed, or the link is wrong.");
        }
    }

    private VideoMeta Remember(VideoMeta meta) => _cache[meta.Id] = meta;

    public async Task<IReadOnlyList<SearchItem>> SearchAsync(string query, CancellationToken ct)
    {
        var results = new List<SearchItem>();
        await foreach (var v in _client.Search.GetVideosAsync(query, ct))
        {
            if (v.Duration is null) continue; // skip live streams
            var item = new SearchItem(v.Id.Value, v.Title, v.Author.ChannelTitle, (int)v.Duration.Value.TotalSeconds);
            Remember(new VideoMeta(item.VideoId, item.Title, item.Author, item.Duration)); // adding from results needs no extra lookup
            results.Add(item);
            if (results.Count >= 15) break;
        }
        return results;
    }
}
