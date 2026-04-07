namespace SharedMusicSpace.Models
{
    public class SongItem
    {
        public string Id { get; private set; } 
        public string Title { get; private set; } 
        public string Thumbnail { get; private set; } 
        public string Requester { get; private set; } 

        public SongItem(string id, string title, string thumb, string user)
        {
            Id = id;
            Title = title;
            Thumbnail = thumb;
            Requester = user;
        }
    }
}

