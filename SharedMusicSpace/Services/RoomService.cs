using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.SignalR;
using SharedMusicSpace.Domain;
using SharedMusicSpace.Hubs;

namespace SharedMusicSpace.Services;

public sealed class RoomService(TimeProvider clock)
{
    // No 0/O/1/I so codes survive being read out loud.
    private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static readonly TimeSpan EmptyRoomTtl = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<string, Room> _rooms = new();
    private readonly ConcurrentDictionary<string, string> _connectionRoom = new();

    public int RoomCount => _rooms.Count;

    public Room CreateRoom(string name)
    {
        while (true)
        {
            var code = string.Create(6, 0, static (span, _) =>
            {
                for (var i = 0; i < span.Length; i++) span[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
            });
            var room = new Room(code, name, clock);
            if (_rooms.TryAdd(code, room)) return room;
        }
    }

    public Room? Find(string? code) =>
        code != null && _rooms.TryGetValue(Normalize(code), out var room) ? room : null;

    public static string Normalize(string code) => code.Trim().ToUpperInvariant();

    public Room? ForConnection(string connectionId) =>
        _connectionRoom.TryGetValue(connectionId, out var code) && _rooms.TryGetValue(code, out var room) ? room : null;

    public void Bind(string connectionId, Room room) => _connectionRoom[connectionId] = room.Code;

    public void Unbind(string connectionId) => _connectionRoom.TryRemove(connectionId, out _);

    public IEnumerable<Room> AllRooms => _rooms.Values;

    /// <summary>Drops rooms nobody has been in for a while. Returns how many were removed.</summary>
    public int SweepEmptyRooms()
    {
        var removed = 0;
        var now = clock.GetUtcNow();
        foreach (var (code, room) in _rooms)
        {
            if (room.MemberCount == 0 && now - room.LastActivity > EmptyRoomTtl && _rooms.TryRemove(code, out _))
                removed++;
        }
        return removed;
    }
}

/// <summary>Housekeeping: advances overdue songs every few seconds and drops abandoned rooms every minute.</summary>
public sealed class RoomSweeper(RoomService rooms, IHubContext<MusicHub> hub, ILogger<RoomSweeper> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        var ticks = 0;
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            foreach (var room in rooms.AllRooms)
            {
                try
                {
                    if (room.MemberCount > 0 && room.AdvanceIfOverdue(10))
                    {
                        await hub.Clients.Group(room.Code).SendAsync("chat", room.AddSystem("Moving on to the next song"), stoppingToken);
                        await hub.Clients.Group(room.Code).SendAsync("state", room.Snapshot(), stoppingToken);
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogWarning(ex, "Auto-advance failed for room {Code}", room.Code);
                }
            }

            if (++ticks % 12 == 0)
            {
                var n = rooms.SweepEmptyRooms();
                if (n > 0) log.LogInformation("Removed {Count} empty room(s)", n);
            }
        }
    }
}
