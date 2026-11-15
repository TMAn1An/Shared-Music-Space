using SharedMusicSpace.Hubs;
using SharedMusicSpace.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSignalR(o =>
{
    o.MaximumReceiveMessageSize = 16 * 1024;
    o.KeepAliveInterval = TimeSpan.FromSeconds(10);
    o.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
});
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<RoomService>();
builder.Services.AddSingleton<YouTubeService>();
builder.Services.AddHostedService<RoomSweeper>();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapHub<MusicHub>("/musicHub");
app.MapGet("/healthz", (RoomService rooms) => Results.Ok(new { status = "ok", rooms = rooms.RoomCount }));
// Invite links look like /r/ABC123 — the SPA reads the code from the path.
app.MapFallbackToFile("/r/{code}", "index.html");

app.Run();

public partial class Program;
