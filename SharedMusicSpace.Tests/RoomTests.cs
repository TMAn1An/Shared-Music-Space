using SharedMusicSpace.Domain;
using SharedMusicSpace.Services;
using Xunit;

namespace SharedMusicSpace.Tests;

public class TestClock : TimeProvider
{
    private DateTimeOffset _now = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(double seconds) => _now = _now.AddSeconds(seconds);
}

public class RoomTests
{
    private readonly TestClock _clock = new();
    private readonly Room _room;

    public RoomTests() => _room = new Room("ABC123", "Test", _clock);

    private Member Join(string client, string name)
    {
        var (m, _, err) = _room.Join(client, "conn-" + client, name, out _);
        Assert.Null(err);
        return m!;
    }

    private static Song Song(string id, int dur = 200, string by = "Ann") =>
        new(Guid.NewGuid().ToString("N")[..10], id, "Title " + id, "Artist", dur, by);

    [Fact]
    public void First_member_is_host_and_host_transfers_on_leave()
    {
        Join("a", "Ann"); Join("b", "Bob");
        Assert.True(_room.IsHost("conn-a"));
        var (_, newHost) = _room.Leave("conn-a");
        Assert.Equal("Bob", newHost);
        Assert.True(_room.IsHost("conn-b"));
    }

    [Fact]
    public void Duplicate_names_are_made_unique()
    {
        Join("a", "Sam"); var second = Join("b", "sam");
        Assert.Equal("sam 2", second.Name);
    }

    [Fact]
    public void Same_client_rejoining_takes_over_its_slot()
    {
        var first = Join("a", "Ann");
        var (m, reconnect, _) = _room.Join("a", "conn-new", "Ann", out var prev);
        Assert.True(reconnect);
        Assert.Equal("conn-a", prev);
        Assert.Equal(first.Id, m!.Id);
        Assert.Equal(1, _room.MemberCount);
    }

    [Fact]
    public void First_song_plays_immediately_and_next_is_queued()
    {
        Assert.Equal(AddOutcome.StartedPlaying, _room.AddSong(Song("v1")));
        Assert.Equal(AddOutcome.Added, _room.AddSong(Song("v2")));
        var s = _room.Snapshot();
        Assert.Equal("v1", s.Playback.Song!.Id);
        Assert.True(s.Playback.Playing);
        Assert.Single(s.Queue);
    }

    [Fact]
    public void Duplicates_are_rejected()
    {
        _room.AddSong(Song("v1"));
        Assert.Equal(AddOutcome.Duplicate, _room.AddSong(Song("v1")));
    }

    [Fact]
    public void Position_advances_with_time_and_freezes_when_paused()
    {
        _room.AddSong(Song("v1"));
        _clock.Advance(30);
        Assert.Equal(30, _room.Snapshot().Playback.Position, 1);

        _room.TogglePlay();
        _clock.Advance(100);
        var paused = _room.Snapshot().Playback;
        Assert.False(paused.Playing);
        Assert.Equal(30, paused.Position, 1);

        _room.TogglePlay();
        _clock.Advance(10);
        Assert.Equal(40, _room.Snapshot().Playback.Position, 1);
    }

    [Fact]
    public void Seek_is_absolute_and_clamped()
    {
        _room.AddSong(Song("v1", 100));
        _room.Seek(50);
        Assert.Equal(50, _room.Snapshot().Playback.Position, 1);
        _room.Seek(9999);
        Assert.Equal(99, _room.Snapshot().Playback.Position, 1);
        _room.Seek(-5);
        Assert.Equal(0, _room.Snapshot().Playback.Position, 1);
    }

    [Fact]
    public void TrackEnded_is_idempotent_and_ignores_stale_or_early_reports()
    {
        _room.AddSong(Song("v1", 100)); _room.AddSong(Song("v2", 100));

        Assert.False(_room.TrackEnded("v1"));          // far from the end
        _clock.Advance(99);
        Assert.False(_room.TrackEnded("other"));       // wrong video
        Assert.True(_room.TrackEnded("v1"));           // first client wins
        Assert.False(_room.TrackEnded("v1"));          // duplicates from other clients are no-ops

        var s = _room.Snapshot();
        Assert.Equal("v2", s.Playback.Song!.Id);
        Assert.Equal("v1", s.History[0].Id);
    }

    [Fact]
    public void Overdue_song_advances_on_its_own_but_not_while_paused()
    {
        _room.AddSong(Song("v1", 100)); _room.AddSong(Song("v2", 100));
        _clock.Advance(105);
        Assert.False(_room.AdvanceIfOverdue(10));   // inside the grace period
        _clock.Advance(10);
        Assert.True(_room.AdvanceIfOverdue(10));
        Assert.Equal("v2", _room.Snapshot().Playback.Song!.Id);

        _room.TogglePlay();
        _clock.Advance(1000);
        Assert.False(_room.AdvanceIfOverdue(10));   // paused rooms wait
    }

    [Fact]
    public void Two_x_speed_moves_the_playhead_twice_as_fast_without_jumping()
    {
        Join("a", "Ann");
        _room.AddSong(Song("v1", 1000));
        _clock.Advance(10);
        Assert.True(_room.SetRate(2, "conn-a"));
        Assert.Equal(10, _room.Snapshot().Playback.Position, 1);   // no jump when the speed changes
        Assert.Equal(2, _room.Snapshot().Playback.Rate);
        _clock.Advance(10);
        Assert.Equal(30, _room.Snapshot().Playback.Position, 1);   // 10 s of real time = 20 s of music

        Assert.True(_room.SetRate(1, "conn-a"));
        _clock.Advance(5);
        Assert.Equal(35, _room.Snapshot().Playback.Position, 1);
    }

    [Theory]
    [InlineData(0.5)]
    [InlineData(3)]
    [InlineData(1.5)]
    public void Only_1x_and_2x_are_accepted(double rate)
    {
        Join("a", "Ann");
        _room.AddSong(Song("v1"));
        Assert.False(_room.SetRate(rate, "conn-a"));
        Assert.Equal(1, _room.Snapshot().Playback.Rate);
    }

    [Fact]
    public void Speed_resets_for_the_next_song_and_when_its_owner_leaves()
    {
        Join("a", "Ann"); Join("b", "Bob");
        _room.AddSong(Song("v1")); _room.AddSong(Song("v2"));

        _room.SetRate(2, "conn-b");
        _room.Skip();
        Assert.Equal(1, _room.Snapshot().Playback.Rate);            // new song, normal speed

        _room.SetRate(2, "conn-b");
        _room.Leave("conn-b");                                       // the person holding 2x vanished
        Assert.Equal(1, _room.Snapshot().Playback.Rate);
    }

    [Fact]
    public void Speed_needs_a_song_and_a_member()
    {
        Join("a", "Ann");
        Assert.False(_room.SetRate(2, "conn-a"));                    // nothing playing
        _room.AddSong(Song("v1"));
        Assert.False(_room.SetRate(2, "conn-stranger"));
    }

    [Fact]
    public void Overdue_check_respects_the_speed()
    {
        Join("a", "Ann");
        _room.AddSong(Song("v1", 100)); _room.AddSong(Song("v2", 100));
        _room.SetRate(2, "conn-a");
        _clock.Advance(54);                                          // 108 s of music: past the end, inside the 10 s grace
        Assert.False(_room.AdvanceIfOverdue(10));
        _clock.Advance(6);                                           // 120 s > 100 + 10 grace
        Assert.True(_room.AdvanceIfOverdue(10));
    }

    [Fact]
    public void A_song_of_unknown_length_learns_it_from_the_first_report_only()
    {
        Join("a", "Ann");
        _room.AddSong(Song("v1", 0));                 // looked up without a duration
        _room.AddSong(Song("v2", 0));                 // queued, also unknown
        Assert.Equal(0, _room.Snapshot().Playback.Song!.Duration);

        Assert.True(_room.SetDuration("v1", 212.6, "ignored: title is already real"));
        Assert.Equal(212, _room.Snapshot().Playback.Song!.Duration);
        Assert.Equal("Title v1", _room.Snapshot().Playback.Song!.Title);
        Assert.False(_room.SetDuration("v1", 999, null));            // already known: first report wins

        Assert.True(_room.SetDuration("v2", 100, null));             // works for queued songs too
        Assert.Equal(100, _room.Snapshot().Queue[0].Duration);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(99999)]
    [InlineData(double.NaN)]
    public void Nonsense_durations_are_rejected(double seconds)
    {
        Join("a", "Ann");
        _room.AddSong(Song("v1", 0));
        Assert.False(_room.SetDuration("v1", seconds, null));
        Assert.False(_room.SetDuration("not-in-room", 100, null));
    }

    [Fact]
    public void Queue_empties_into_idle_state()
    {
        _room.AddSong(Song("v1"));
        Assert.True(_room.Skip());
        var s = _room.Snapshot();
        Assert.Null(s.Playback.Song);
        Assert.False(s.Playback.Playing);
        Assert.False(_room.Skip());
    }

    [Fact]
    public void Unplayable_skips_without_polluting_history()
    {
        _room.AddSong(Song("bad")); _room.AddSong(Song("good"));
        Assert.NotNull(_room.Unplayable("bad"));
        Assert.Null(_room.Unplayable("bad"));
        var s = _room.Snapshot();
        Assert.Equal("good", s.Playback.Song!.Id);
        Assert.Empty(s.History);
    }

    [Fact]
    public void Only_adder_or_host_can_remove_a_song()
    {
        Join("a", "Ann"); Join("b", "Bob"); Join("c", "Cat");
        _room.AddSong(Song("now"));
        var queued = Song("q1", by: "Bob");
        _room.AddSong(queued);

        Assert.False(_room.RemoveSong(queued.QueueId, "conn-c")); // stranger
        Assert.True(_room.RemoveSong(queued.QueueId, "conn-a"));  // host
        Assert.Empty(_room.Snapshot().Queue);
    }

    [Fact]
    public void MoveToFront_reorders_queue()
    {
        _room.AddSong(Song("now"));
        var a = Song("a"); var b = Song("b");
        _room.AddSong(a); _room.AddSong(b);
        Assert.True(_room.MoveToFront(b.QueueId));
        Assert.Equal(new[] { "b", "a" }, _room.Snapshot().Queue.Select(s => s.Id));
    }

    [Fact]
    public void Empty_rooms_are_swept_after_ttl_but_occupied_ones_are_kept()
    {
        var rooms = new RoomService(_clock);
        var empty = rooms.CreateRoom("e");
        var busy = rooms.CreateRoom("b");
        busy.Join("a", "c1", "Ann", out _);
        _clock.Advance(11 * 60);
        Assert.Equal(1, rooms.SweepEmptyRooms());
        Assert.Null(rooms.Find(empty.Code));
        Assert.NotNull(rooms.Find(busy.Code));
    }
}
