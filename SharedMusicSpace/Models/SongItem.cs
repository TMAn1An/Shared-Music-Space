namespace SharedMusicSpace.Models
{
    public class SongItem
    {
        public string Id { get; private set; } // ভিডিও আইডি
        public string Title { get; private set; } // গানের আসল নাম
        public string Thumbnail { get; private set; } // ছবির লিংক
        public string Requester { get; private set; } // কে রিকোয়েস্ট করেছে

        public SongItem(string id, string title, string thumb, string user)
        {
            Id = id;
            Title = title;
            Thumbnail = thumb;
            Requester = user;
        }
    }
}
