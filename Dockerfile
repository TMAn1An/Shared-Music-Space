FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY SharedMusicSpace/SharedMusicSpace.csproj SharedMusicSpace/
RUN dotnet restore SharedMusicSpace/SharedMusicSpace.csproj
COPY SharedMusicSpace/ SharedMusicSpace/
RUN dotnet publish SharedMusicSpace/SharedMusicSpace.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "SharedMusicSpace.dll"]
