using Microsoft.AspNetCore.SignalR;
using SharedMusicSpace.Models;
using YoutubeExplode;
using YoutubeExplode.Common;

namespace SharedMusicSpace.Hubs
{
    public class MusicHub : Hub
    {
        private readonly RoomManager _roomManager;
        private readonly YoutubeClient _youtube = new YoutubeClient();

        public MusicHub(RoomManager roomManager) { _roomManager = roomManager; }

        public async Task TrackEnded(string roomCode)
        {
            var room = _roomManager.GetRoom(roomCode);
            if (room != null) room.PlayNext();
        }
        public async Task PlayRequest(string roomCode, string videoIdOrUrl, string user)
        {
            await Clients.Caller.SendAsync("ReceiveStatus", "Processing...", "info");
            _ = Task.Run(async () =>
            {
                try
                {
                    var room = _roomManager.GetRoom(roomCode);
                    if (room == null) return;

                    var videoId = YoutubeExplode.Videos.VideoId.Parse(videoIdOrUrl);
                    var video = await _youtube.Videos.GetAsync(videoId);

                    string title = video.Title;
                    string thumb = video.Thumbnails.GetWithHighestResolution().Url;

                    room.AddSong(videoId, title, thumb, user);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Error adding song: {ex.Message}");
                }
            });
        }
        public async Task SendMessage(string roomCode, string user, string message)
        {
            await Clients.Group(roomCode).SendAsync("ReceiveMessage", user, message);
        }
        public async Task SearchYouTube(string query)
        {
            try
            {
                var videos = await _youtube.Search.GetVideosAsync(query).CollectAsync(10);
                var results = videos.Select(v => new
                {
                    videoId = v.Id.Value,
                    title = v.Title,
                    author = v.Author.ChannelTitle,
                    thumbnail = v.Thumbnails.FirstOrDefault()?.Url ?? ""
                }).ToList();
                await Clients.Caller.SendAsync("ReceiveSearchResults", results);
            }
            catch (Exception) { await Clients.Caller.SendAsync("ReceiveStatus", "Search Error", "error"); }
        }

        public async Task<string> CreateRoom(string adminName) { var room = _roomManager.CreateRoom("Music Party", adminName); return room.RoomCode; }
        public async Task JoinRoom(string roomCode, string userName) {  var room = _roomManager.GetRoom(roomCode); if (room != null) { await Groups.AddToGroupAsync(Context.ConnectionId, roomCode); room.AddUser(userName); _roomManager.UserMap.TryAdd(Context.ConnectionId, (roomCode, userName)); await Clients.Caller.SendAsync("JoinSuccess", roomCode, room.RoomName, room.AdminName); await Clients.Caller.SendAsync("UpdateUserList", room.Users); await Clients.Caller.SendAsync("UpdatePlaylist", room.Playlist); await Clients.Caller.SendAsync("UpdateHistory", room.History); if (room.CurrentSong != null) { var currentSeconds = room.IsPlaying ? (DateTime.Now - room.SongStartTime).TotalSeconds : room.PausedPosition.TotalSeconds; await Clients.Caller.SendAsync("SyncNewUser", room.CurrentSong.Id, currentSeconds, room.IsPlaying); } await Clients.Group(roomCode).SendAsync("ReceiveStatus", $"{userName} joined!", "info"); } else await Clients.Caller.SendAsync("ReceiveStatus", "Room not found!", "error"); }
        public async Task SeekRequest(string roomCode, string user, double offset) { var room = _roomManager.GetRoom(roomCode); if (room != null) room.SeekSong(user, offset); }
        public async Task SendReaction(string roomCode, string userName, string emoji) { var room = _roomManager.GetRoom(roomCode); if (room != null) room.SendReaction(userName, emoji); }
        public async Task ActionRequest(string roomCode, string user, string action) { var room = _roomManager.GetRoom(roomCode); if (room != null) { if (action == "toggle") room.TogglePlayPause(user); if (action == "skip") room.SkipCurrentSong(user); } }
        public override async Task OnDisconnectedAsync(Exception? exception) { _roomManager.HandleDisconnect(Context.ConnectionId); await base.OnDisconnectedAsync(exception); }
    }
}
