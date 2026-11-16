namespace SharedMusicSpace.Domain;

/// <summary>A track waiting in (or played from) a room's queue.</summary>
public sealed record Song(string QueueId, string Id, string Title, string Author, int Duration, string AddedBy);

public sealed record Member(string Id, string ClientId, string ConnectionId, string Name);

public sealed record ChatMessage(string Id, string Kind, string Name, string Text, long Time);

// ---- Wire contracts (serialised by SignalR in camelCase) ----

public sealed record MemberDto(string Id, string Name, bool IsHost);

public sealed record PlaybackDto(Song? Song, bool Playing, double Position);

public sealed record RoomSnapshot(
    string Code,
    string Name,
    long Rev,
    long ServerTime,
    PlaybackDto Playback,
    IReadOnlyList<MemberDto> Members,
    IReadOnlyList<Song> Queue,
    IReadOnlyList<Song> History);

public sealed record JoinResult(
    bool Ok,
    string? Error,
    string? MemberId,
    string? Name,
    RoomSnapshot? Room,
    IReadOnlyList<ChatMessage>? Chat);

public sealed record SearchItem(string VideoId, string Title, string Author, int Duration);

public sealed record CommandResult(bool Ok, string? Message = null);
