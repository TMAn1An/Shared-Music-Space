namespace SharedMusicSpace.Domain;

public enum AddOutcome { Added, StartedPlaying, Duplicate, QueueFull }

/// <summary>
/// One listening room. The room is the single source of truth for playback:
/// clients never decide what plays or where the playhead is, they only render
/// the snapshot the server hands out. All public members are thread-safe.
/// </summary>
public sealed class Room
{
    public const int MaxQueue = 100;
    public const int MaxHistory = 30;
    public const int MaxChat = 150;
    public const int MaxMembers = 50;

    private readonly object _gate = new();
    private readonly TimeProvider _clock;
    private readonly List<Member> _members = new();
    private readonly List<Song> _queue = new();
    private readonly List<Song> _history = new();
    private readonly List<ChatMessage> _chat = new();

    private Song? _current;
    private bool _playing;
    private double _rate = 1;          // playback speed shared by the whole room (1 or 2)
    private string? _rateByClientId;   // who set a non-1x speed, so it can be released if they vanish
    private double _baseSeconds;      // playhead at _baseAt (or frozen playhead when paused)
    private DateTimeOffset _baseAt;   // wall-clock moment _baseSeconds was valid
    private string _hostClientId = "";
    private long _rev;

    public Room(string code, string name, TimeProvider? clock = null)
    {
        Code = code;
        Name = name;
        _clock = clock ?? TimeProvider.System;
        LastActivity = _clock.GetUtcNow();
    }

    public string Code { get; }
    public string Name { get; }
    public DateTimeOffset LastActivity { get; private set; }

    public int MemberCount { get { lock (_gate) return _members.Count; } }

    // ---------- membership ----------

    /// <summary>Adds a member, or takes over the existing slot of the same client (reconnects).</summary>
    public (Member? Member, bool IsReconnect, string? Error) Join(string clientId, string connectionId, string desiredName, out string? previousConnectionId)
    {
        lock (_gate)
        {
            previousConnectionId = null;
            var existing = _members.FindIndex(m => m.ClientId == clientId);
            if (existing >= 0)
            {
                var old = _members[existing];
                previousConnectionId = old.ConnectionId;
                var updated = old with { ConnectionId = connectionId };
                _members[existing] = updated;
                Touch();
                return (updated, true, null);
            }

            if (_members.Count >= MaxMembers) return (null, false, "This room is full.");

            var name = UniqueName(desiredName);
            var member = new Member(Guid.NewGuid().ToString("N")[..8], clientId, connectionId, name);
            _members.Add(member);
            if (_members.Count == 1) _hostClientId = clientId;
            Touch();
            return (member, false, null);
        }
    }

    public (Member? Member, string? NewHostName) Leave(string connectionId)
    {
        lock (_gate)
        {
            var idx = _members.FindIndex(m => m.ConnectionId == connectionId);
            if (idx < 0) return (null, null);

            var member = _members[idx];
            _members.RemoveAt(idx);
            if (_rate != 1 && member.ClientId == _rateByClientId) ResetRate();
            string? newHost = null;
            if (member.ClientId == _hostClientId && _members.Count > 0)
            {
                _hostClientId = _members[0].ClientId;
                newHost = _members[0].Name;
            }
            Touch();
            return (member, newHost);
        }
    }

    public Member? FindByConnection(string connectionId)
    {
        lock (_gate) return _members.FirstOrDefault(m => m.ConnectionId == connectionId);
    }

    public bool IsHost(string connectionId)
    {
        lock (_gate)
        {
            var m = _members.FirstOrDefault(x => x.ConnectionId == connectionId);
            return m != null && m.ClientId == _hostClientId;
        }
    }

    private string UniqueName(string desired)
    {
        var name = desired;
        for (var i = 2; _members.Any(m => string.Equals(m.Name, name, StringComparison.OrdinalIgnoreCase)); i++)
            name = $"{desired} {i}";
        return name;
    }

    // ---------- queue & playback ----------

    public AddOutcome AddSong(Song song)
    {
        lock (_gate)
        {
            if (_current?.Id == song.Id || _queue.Any(s => s.Id == song.Id)) return AddOutcome.Duplicate;
            if (_queue.Count >= MaxQueue) return AddOutcome.QueueFull;

            Touch();
            if (_current == null)
            {
                StartSong(song);
                return AddOutcome.StartedPlaying;
            }
            _queue.Add(song);
            return AddOutcome.Added;
        }
    }

    public bool RemoveSong(string queueId, string byConnectionId)
    {
        lock (_gate)
        {
            var requester = _members.FirstOrDefault(m => m.ConnectionId == byConnectionId);
            if (requester == null) return false;
            var idx = _queue.FindIndex(s => s.QueueId == queueId);
            if (idx < 0) return false;
            var isHost = requester.ClientId == _hostClientId;
            if (!isHost && _queue[idx].AddedBy != requester.Name) return false;
            _queue.RemoveAt(idx);
            Touch();
            return true;
        }
    }

    public bool MoveToFront(string queueId)
    {
        lock (_gate)
        {
            var idx = _queue.FindIndex(s => s.QueueId == queueId);
            if (idx <= 0) return false;
            var song = _queue[idx];
            _queue.RemoveAt(idx);
            _queue.Insert(0, song);
            Touch();
            return true;
        }
    }

    public bool TogglePlay()
    {
        lock (_gate)
        {
            if (_current == null) return false;
            var now = _clock.GetUtcNow();
            if (_playing)
            {
                _baseSeconds = PositionAt(now);
                _playing = false;
            }
            else
            {
                _baseAt = now;
                _playing = true;
            }
            Touch();
            return true;
        }
    }

    public bool Seek(double seconds)
    {
        lock (_gate)
        {
            if (_current == null || double.IsNaN(seconds) || double.IsInfinity(seconds)) return false;
            var max = _current.Duration > 0 ? _current.Duration - 1 : double.MaxValue;
            _baseSeconds = Math.Clamp(seconds, 0, max);
            _baseAt = _clock.GetUtcNow();
            Touch();
            return true;
        }
    }

    /// <summary>Skips to the next queued song (or stops when the queue is empty).</summary>
    public bool Skip()
    {
        lock (_gate)
        {
            if (_current == null) return false;
            Advance();
            return true;
        }
    }

    /// <summary>
    /// Fast-forward for everyone (hold-to-2x). Only 1x and 2x exist; the playhead is re-based so the
    /// position never jumps when the speed changes.
    /// </summary>
    public bool SetRate(double rate, string byConnectionId)
    {
        lock (_gate)
        {
            if (_current == null || (rate != 1 && rate != 2) || rate == _rate) return false;
            var member = _members.FirstOrDefault(m => m.ConnectionId == byConnectionId);
            if (member == null) return false;
            Rebase();
            _rate = rate;
            _rateByClientId = rate == 1 ? null : member.ClientId;
            Touch();
            return true;
        }
    }

    private void Rebase()
    {
        var now = _clock.GetUtcNow();
        _baseSeconds = PositionAt(now);
        _baseAt = now;
    }

    private void ResetRate()
    {
        Rebase();
        _rate = 1;
        _rateByClientId = null;
    }

    /// <summary>
    /// A client reports the player reached the end. Idempotent: every client sends it,
    /// only the first one that matches the current song and playhead advances the room.
    /// </summary>
    public bool TrackEnded(string videoId)
    {
        lock (_gate)
        {
            if (_current == null || _current.Id != videoId) return false;
            var nearEnd = _current.Duration <= 0 || PositionAt(_clock.GetUtcNow()) >= _current.Duration - 8;
            if (!nearEnd) return false;
            Advance();
            return true;
        }
    }

    /// <summary>
    /// Safety net for rooms where no client reported the end (everyone's tab blocked or asleep):
    /// once the playhead has been past the end for <paramref name="graceSeconds"/>, move on.
    /// </summary>
    public bool AdvanceIfOverdue(double graceSeconds)
    {
        lock (_gate)
        {
            if (_current == null || !_playing || _current.Duration <= 0) return false;
            var raw = _baseSeconds + (_clock.GetUtcNow() - _baseAt).TotalSeconds * _rate;
            if (raw < _current.Duration + graceSeconds) return false;
            Advance();
            return true;
        }
    }

    /// <summary>A client reports the current video cannot be embedded/played.</summary>
    public Song? Unplayable(string videoId)
    {
        lock (_gate)
        {
            if (_current == null || _current.Id != videoId) return null;
            var bad = _current;
            Advance(addToHistory: false);
            return bad;
        }
    }

    private void Advance(bool addToHistory = true)
    {
        if (_current != null && addToHistory)
        {
            _history.Insert(0, _current);
            if (_history.Count > MaxHistory) _history.RemoveAt(_history.Count - 1);
        }

        if (_queue.Count > 0)
        {
            var next = _queue[0];
            _queue.RemoveAt(0);
            StartSong(next);
        }
        else
        {
            _current = null;
            _playing = false;
            _rate = 1;
            _rateByClientId = null;
            _baseSeconds = 0;
        }
        Touch();
    }

    private void StartSong(Song song)
    {
        _current = song;
        _playing = true;
        _rate = 1;                 // every new song starts at normal speed
        _rateByClientId = null;
        _baseSeconds = 0;
        _baseAt = _clock.GetUtcNow();
    }

    private double PositionAt(DateTimeOffset now)
    {
        if (_current == null) return 0;
        var pos = _playing ? _baseSeconds + (now - _baseAt).TotalSeconds * _rate : _baseSeconds;
        pos = Math.Max(0, pos);
        return _current.Duration > 0 ? Math.Min(pos, _current.Duration) : pos;
    }

    // ---------- chat ----------

    public ChatMessage? AddChat(string connectionId, string text)
    {
        lock (_gate)
        {
            var member = _members.FirstOrDefault(m => m.ConnectionId == connectionId);
            if (member == null) return null;
            var msg = NewChat("user", member.Name, text);
            Touch();
            return msg;
        }
    }

    public ChatMessage AddSystem(string text)
    {
        lock (_gate) return NewChat("system", "", text);
    }

    private ChatMessage NewChat(string kind, string name, string text)
    {
        var msg = new ChatMessage(Guid.NewGuid().ToString("N")[..10], kind, name, text, _clock.GetUtcNow().ToUnixTimeMilliseconds());
        _chat.Add(msg);
        if (_chat.Count > MaxChat) _chat.RemoveAt(0);
        return msg;
    }

    public IReadOnlyList<ChatMessage> ChatHistory()
    {
        lock (_gate) return _chat.ToList();
    }

    // ---------- snapshot ----------

    public RoomSnapshot Snapshot()
    {
        lock (_gate)
        {
            var now = _clock.GetUtcNow();
            return new RoomSnapshot(
                Code, Name, _rev, now.ToUnixTimeMilliseconds(),
                new PlaybackDto(_current, _playing, Math.Round(PositionAt(now), 2), _rate),
                _members.Select(m => new MemberDto(m.Id, m.Name, m.ClientId == _hostClientId)).ToList(),
                _queue.ToList(),
                _history.ToList());
        }
    }

    private void Touch()
    {
        _rev++;
        LastActivity = _clock.GetUtcNow();
    }
}
