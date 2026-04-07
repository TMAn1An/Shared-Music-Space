using System;
using System.Collections.Generic;
using System.Linq;

namespace SharedMusicSpace.Models
{
    public class MusicSpace
    {
        public delegate void MusicEventHandler(string message, string type, object? data = null);
        public event MusicEventHandler? OnStatusChanged;

        public delegate void UserListHandler(List<string> users);
        public event UserListHandler? OnUserListChanged;

        public delegate void PlaylistHandler(List<SongItem> songs);
        public event PlaylistHandler? OnPlaylistChanged;

        public delegate void HistoryHandler(List<SongItem> songs);
        public event HistoryHandler? OnHistoryChanged;

        public delegate void SeekHandler(double seconds);
        public event SeekHandler? OnSeekChanged;

        public string RoomCode { get; private set; }
        public string RoomName { get; private set; }
        public string AdminName { get; private set; }

        public List<string> Users { get; private set; } = new List<string>();
        public List<SongItem> Playlist { get; private set; } = new List<SongItem>();
        public List<SongItem> History { get; private set; } = new List<SongItem>();

        public SongItem? CurrentSong { get; private set; }
        public bool IsPlaying { get; private set; } = false;
        public DateTime SongStartTime { get; private set; }
        public TimeSpan PausedPosition { get; private set; }

        public MusicSpace(string code, string name, string admin)
        {
            RoomCode = code;
            RoomName = name;
            AdminName = admin;
        }

        public void AddSong(string videoId, string title, string thumb, string userName)
        {
            if ((CurrentSong != null && CurrentSong.Id == videoId) || Playlist.Any(s => s.Id == videoId)) return;

            SongItem newSong = new SongItem(videoId, title, thumb, userName);

            if (CurrentSong == null)
            {
                PlaySong(newSong);
            }
            else
            {
                Playlist.Add(newSong);
                OnPlaylistChanged?.Invoke(Playlist);
                OnStatusChanged?.Invoke("added a new song", "info", new { User = userName });
            }
        }

        public void SeekSong(string requestorName, double offsetSeconds)
        {
            if (CurrentSong == null) return;
            double currentPos = IsPlaying ? (DateTime.Now - SongStartTime).TotalSeconds : PausedPosition.TotalSeconds;
            double newPos = currentPos + offsetSeconds;
            if (newPos < 0) newPos = 0;

            if (IsPlaying) SongStartTime = DateTime.Now - TimeSpan.FromSeconds(newPos);
            else PausedPosition = TimeSpan.FromSeconds(newPos);

            OnSeekChanged?.Invoke(newPos);
            string action = offsetSeconds > 0 ? "forwarded" : "rewound";
            OnStatusChanged?.Invoke(action, "info", new { User = requestorName });
        }

        public void TogglePlayPause(string requestorName)
        {
            if (IsPlaying)
            {
                IsPlaying = false;
                PausedPosition = DateTime.Now - SongStartTime;
                OnStatusChanged?.Invoke("paused", "pause", new { User = requestorName });
            }
            else if (CurrentSong != null)
            {
                IsPlaying = true;
                SongStartTime = DateTime.Now - PausedPosition;
                OnStatusChanged?.Invoke("resumed", "play", new { User = requestorName });
            }
        }

        public void SkipCurrentSong(string requestorName)
        {
            OnStatusChanged?.Invoke("skipped", "info", new { User = requestorName });
            PlayNext();
        }

        public void PlayNext()
        {
            if (Playlist.Count > 0)
            {
                SongItem nextSong = Playlist[0];
                Playlist.RemoveAt(0);
                OnPlaylistChanged?.Invoke(Playlist);
                PlaySong(nextSong);
            }
            else
            {
                CurrentSong = null;
                IsPlaying = false;
                OnStatusChanged?.Invoke("Queue ended", "stop");
            }
        }

        private void PlaySong(SongItem song)
        {
            CurrentSong = song;
            IsPlaying = true;
            SongStartTime = DateTime.Now;
            PausedPosition = TimeSpan.Zero;

            History.Insert(0, song);
            if (History.Count > 20) History.RemoveAt(History.Count - 1);
            OnHistoryChanged?.Invoke(History);

            OnStatusChanged?.Invoke(song.Title, "playNew", new { VideoId = song.Id, StartTime = SongStartTime });
        }

        public void AddUser(string userName) { if (!Users.Contains(userName)) { Users.Add(userName); OnUserListChanged?.Invoke(Users); OnStatusChanged?.Invoke("joined", "info", new { User = userName }); } }
        public void RemoveUser(string userName) { if (Users.Contains(userName)) { Users.Remove(userName); OnUserListChanged?.Invoke(Users); OnStatusChanged?.Invoke("left", "info", new { User = userName }); } }
        public void SendReaction(string userName, string emoji) { OnStatusChanged?.Invoke("reacted", "emoji", new { User = userName, Emoji = emoji }); }
    }
}
