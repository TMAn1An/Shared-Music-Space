using Microsoft.AspNetCore.SignalR;
using SharedMusicSpace.Domain;
using SharedMusicSpace.Services;

namespace SharedMusicSpace.Hubs;

/// <summary>
/// Realtime API. Identity always comes from the connection, never from a
/// client-supplied name, so nobody can act on behalf of someone else.
/// </summary>
public sealed class MusicHub(RoomService rooms, YouTubeService youtube, TimeProvider clock, ILogger<MusicHub> log) : Hub
{
    private static readonly HashSet<string> Reactions = ["❤️", "🔥", "😂", "👏", "🎉", "😮"];

    // ---------- lobby ----------

    public Task<JoinResult> CreateRoom(string name, string clientId)
    {
        var clean = CleanName(name);
        if (clean == null) return Task.FromResult(Fail("Pick a nickname first."));
        var room = rooms.CreateRoom($"{clean}'s room");
        return JoinInternal(room, clean, clientId);
    }

    public Task<JoinResult> JoinRoom(string code, string name, string clientId)
    {
        var clean = CleanName(name);
        if (clean == null) return Task.FromResult(Fail("Pick a nickname first."));
        var room = rooms.Find(code);
        if (room == null) return Task.FromResult(Fail("We couldn't find a room with that code."));
        return JoinInternal(room, clean, clientId);
    }

    private async Task<JoinResult> JoinInternal(Room room, string name, string clientId)
    {
        if (string.IsNullOrWhiteSpace(clientId) || clientId.Length > 64) return Fail("Invalid client.");

        await LeaveCurrentRoom(exceptRoom: room.Code);

        var (member, isReconnect, error) = room.Join(clientId, Context.ConnectionId, name, out var previous);
        if (member == null) return Fail(error ?? "Couldn't join.");

        if (previous != null && previous != Context.ConnectionId) rooms.Unbind(previous);
        rooms.Bind(Context.ConnectionId, room);
        await Groups.AddToGroupAsync(Context.ConnectionId, room.Code);

        if (!isReconnect) await Announce(room, $"{member.Name} joined");
        else await Broadcast(room);

        return new JoinResult(true, null, member.Id, member.Name, room.Snapshot(), room.ChatHistory());
    }

    public async Task LeaveRoom() => await LeaveCurrentRoom();

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        await LeaveCurrentRoom();
        await base.OnDisconnectedAsync(exception);
    }

    private async Task LeaveCurrentRoom(string? exceptRoom = null)
    {
        var room = rooms.ForConnection(Context.ConnectionId);
        if (room == null || room.Code == exceptRoom) return;

        rooms.Unbind(Context.ConnectionId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, room.Code);

        var (member, newHost) = room.Leave(Context.ConnectionId);
        if (member == null) return;

        var text = newHost != null ? $"{member.Name} left · {newHost} is now the host" : $"{member.Name} left";
        await Announce(room, text);
    }

    // ---------- time ----------

    public long GetServerTime() => clock.GetUtcNow().ToUnixTimeMilliseconds();

    // ---------- queue ----------

    public async Task<IReadOnlyList<SearchItem>> Search(string query)
    {
        query = (query ?? "").Trim();
        if (query.Length is 0 or > 120) return [];
        try { return await youtube.SearchAsync(query, Context.ConnectionAborted); }
        catch (OperationCanceledException) { return []; }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Search failed for '{Query}'", query);
            throw new HubException("Search is unavailable right now. Try again in a moment.");
        }
    }

    public async Task<CommandResult> AddSong(string videoIdOrUrl)
    {
        var (room, member) = Resolve();
        if (room == null || member == null) return new(false, "You're not in a room.");

        var id = YouTubeService.ParseVideoId((videoIdOrUrl ?? "").Trim());
        if (id == null) return new(false, "That doesn't look like a YouTube link.");

        var (meta, error) = await youtube.GetAsync(id, Context.ConnectionAborted);
        if (meta == null) return new(false, error);

        var song = new Song(Guid.NewGuid().ToString("N")[..10], meta.Id, meta.Title, meta.Author, meta.Duration, member.Name);
        switch (room.AddSong(song))
        {
            case AddOutcome.Duplicate: return new(false, "That song is already playing or queued.");
            case AddOutcome.QueueFull: return new(false, "The queue is full.");
            case AddOutcome.StartedPlaying:
                await Announce(room, $"{member.Name} started “{meta.Title}”");
                return new(true, "Now playing");
            default:
                await Announce(room, $"{member.Name} queued “{meta.Title}”");
                return new(true, "Added to queue");
        }
    }

    public async Task RemoveSong(string queueId)
    {
        var (room, _) = Resolve();
        if (room != null && room.RemoveSong(queueId, Context.ConnectionId)) await Broadcast(room);
    }

    public async Task PlayNext(string queueId)
    {
        var (room, _) = Resolve();
        if (room != null && room.MoveToFront(queueId)) await Broadcast(room);
    }

    // ---------- playback ----------

    public async Task TogglePlay()
    {
        var (room, _) = Resolve();
        if (room != null && room.TogglePlay()) await Broadcast(room);
    }

    public async Task Skip()
    {
        var (room, member) = Resolve();
        if (room == null || member == null || !room.Skip()) return;
        await Announce(room, $"{member.Name} skipped the song");
    }

    public async Task Seek(double seconds)
    {
        var (room, _) = Resolve();
        if (room != null && room.Seek(seconds)) await Broadcast(room);
    }

    public async Task TrackEnded(string videoId)
    {
        var (room, _) = Resolve();
        if (room != null && room.TrackEnded(videoId)) await Broadcast(room);
    }

    public async Task Unplayable(string videoId)
    {
        var (room, _) = Resolve();
        var bad = room?.Unplayable(videoId);
        if (room != null && bad != null) await Announce(room, $"“{bad.Title}” can't be played here, skipping");
    }

    // ---------- social ----------

    public async Task SendChat(string text)
    {
        text = (text ?? "").Trim();
        if (text.Length == 0) return;
        if (text.Length > 500) text = text[..500];

        var (room, _) = Resolve();
        var msg = room?.AddChat(Context.ConnectionId, text);
        if (room != null && msg != null) await Clients.Group(room.Code).SendAsync("chat", msg);
    }

    public async Task React(string emoji)
    {
        if (!Reactions.Contains(emoji)) return;
        var (room, member) = Resolve();
        if (room != null && member != null)
            await Clients.Group(room.Code).SendAsync("reaction", member.Name, emoji);
    }

    // ---------- helpers ----------

    private (Room? Room, Member? Member) Resolve()
    {
        var room = rooms.ForConnection(Context.ConnectionId);
        return (room, room?.FindByConnection(Context.ConnectionId));
    }

    private Task Broadcast(Room room) => Clients.Group(room.Code).SendAsync("state", room.Snapshot());

    private async Task Announce(Room room, string text)
    {
        var msg = room.AddSystem(text);
        await Clients.Group(room.Code).SendAsync("chat", msg);
        await Broadcast(room);
    }

    private static JoinResult Fail(string error) => new(false, error, null, null, null, null);

    private static string? CleanName(string? raw)
    {
        var name = string.Join(' ', (raw ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (name.Length == 0) return null;
        return name.Length > 24 ? name[..24].TrimEnd() : name;
    }
}
