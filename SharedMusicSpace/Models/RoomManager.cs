using Microsoft.AspNetCore.SignalR;
using SharedMusicSpace.Hubs;
using System.Collections.Concurrent;

namespace SharedMusicSpace.Models
{
    public class RoomManager
    {
        private ConcurrentDictionary<string, MusicSpace> _activeRooms = new();
        public ConcurrentDictionary<string, (string RoomCode, string UserName)> UserMap = new();
        private readonly IHubContext<MusicHub> _hubContext;

        public RoomManager(IHubContext<MusicHub> hubContext)
        {
            _hubContext = hubContext;
        }

        public MusicSpace CreateRoom(string roomName, string adminName)
        {
            string roomCode = Guid.NewGuid().ToString("N").Substring(0, 6).ToUpper();
            var newRoom = new MusicSpace(roomCode, roomName, adminName);

            // --- Event Wiring ---
            newRoom.OnStatusChanged += async (msg, type, data) => await _hubContext.Clients.Group(roomCode).SendAsync("ReceiveStatus", msg, type, data);
            newRoom.OnUserListChanged += async (users) => await _hubContext.Clients.Group(roomCode).SendAsync("UpdateUserList", users);
            newRoom.OnPlaylistChanged += async (songs) => await _hubContext.Clients.Group(roomCode).SendAsync("UpdatePlaylist", songs);
            newRoom.OnSeekChanged += async (sec) => await _hubContext.Clients.Group(roomCode).SendAsync("SyncSeek", sec);

            // [NEW] হিস্ট্রি কানেকশন
            newRoom.OnHistoryChanged += async (songs) => await _hubContext.Clients.Group(roomCode).SendAsync("UpdateHistory", songs);

            _activeRooms.TryAdd(roomCode, newRoom);
            return newRoom;
        }

        public MusicSpace? GetRoom(string roomCode)
        {
            _activeRooms.TryGetValue(roomCode, out var room);
            return room;
        }

        public void HandleDisconnect(string connectionId)
        {
            if (UserMap.TryRemove(connectionId, out var userInfo))
            {
                var room = GetRoom(userInfo.RoomCode);
                if (room != null)
                {
                    room.RemoveUser(userInfo.UserName);
                    // নোট: রুম থেকে সবাই চলে গেলে রুম ডিলিট করার লজিক এখানে বসানো যায়, 
                    // তখন অটোমেটিক হিস্ট্রিও ডিলিট হয়ে যাবে কারণ MusicSpace অবজেক্ট মেমোরি থেকে চলে যাবে।
                }
            }
        }
    }
}