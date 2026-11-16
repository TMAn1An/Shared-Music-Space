using SharedMusicSpace.Hubs;
using SharedMusicSpace.Services;

var builder = WebApplication.CreateBuilder(args);

// PaaS hosts (Render, Railway, Heroku…) tell us which port to bind via PORT.
if (Environment.GetEnvironmentVariable("PORT") is { Length: > 0 } port)
    builder.WebHost.UseUrls($"http://+:{port}");

// When the frontend is hosted elsewhere (e.g. Vercel), list its origin(s) here, comma-separated.
var allowedOrigins = (builder.Configuration["ALLOWED_ORIGINS"] ?? "")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
    .Select(o => o.TrimEnd('/'))
    .ToArray();
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
{
    if (allowedOrigins.Length > 0)
        p.WithOrigins(allowedOrigins).AllowAnyHeader().AllowAnyMethod().AllowCredentials();
}));

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

app.UseCors();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapHub<MusicHub>("/musicHub");
app.MapGet("/healthz", (RoomService rooms) => Results.Ok(new { status = "ok", rooms = rooms.RoomCount }));
// Invite links look like /r/ABC123 — the SPA reads the code from the path.
app.MapFallbackToFile("/r/{code}", "index.html");

app.Run();

public partial class Program;
