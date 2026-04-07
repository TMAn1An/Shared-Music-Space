using Microsoft.AspNetCore.SignalR;
using SharedMusicSpace.Hubs;
using SharedMusicSpace.Models;

var builder = WebApplication.CreateBuilder(args);

// MVC প্যাটার্ন যুক্ত করা
builder.Services.AddControllersWithViews();

// ১. SignalR সার্ভিস চালু করা
builder.Services.AddSignalR();

// ২. [গুরুত্বপূর্ণ] RoomManager কে Singleton হিসেবে রেজিস্ট্রেশন
// Singleton = পুরো অ্যাপে একটাই ম্যানেজার থাকবে, যে সব রুমের চাবি রাখবে।
builder.Services.AddSingleton<RoomManager>();

var app = builder.Build();

// এরর হ্যান্ডলিং (প্রোডাকশনের জন্য)
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles(); // CSS/JS ফাইল ব্যবহারের জন্য

app.UseRouting();
app.UseAuthorization();

// ৩. ডিফল্ট রাউটিং (Home Controller এর Index পেজে যাবে)
app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

// ৪. SignalR হাবের লিংক তৈরি করা
// ফ্রন্টএন্ড থেকে আমরা এই লিংকে কানেক্ট করব: "/musicHub"
app.MapHub<MusicHub>("/musicHub");

app.Run();