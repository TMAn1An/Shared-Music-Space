# Deployment

Choose the layout that fits how you want to run it. All three use the same code.

| Layout | Needs | Best for |
|---|---|---|
| [A. Static only (serverless mode)](#a-static-only-serverless-mode) | Any static host | Free hosting, small groups, forks |
| [B. Single Docker host](#b-single-docker-host-server-mode) | A host that runs containers | Simplest "everything works" setup |
| [C. Split: static frontend + Docker backend](#c-split-vercel-frontend--render-backend) | Static host + container host | Keep the frontend on Vercel/Netlify but use server mode |

> **Why can't Vercel run the backend?** The server mode relies on long-lived WebSocket connections and keeps rooms in memory. Serverless platforms (including Vercel) start a fresh instance per request, so rooms and connections can't be shared. Vercel is perfect for the static frontend, though.

## A. Static only (serverless mode)

Everything is plain files in `SharedMusicSpace/wwwroot`. No backend, no environment variables.

### Vercel

1. Import the repository at [vercel.com/new](https://vercel.com/new). The included `vercel.json` already sets the output directory, the build command and the `/r/:code` rewrite — leave the framework preset as "Other".
2. **Do not set `BACKEND_URL`.** The site then starts in peer-to-peer mode.
3. Deploy. Open the URL; the lobby should say **"Ready · peer-to-peer, no server"**.

Or from a terminal: `npx vercel --prod` in the repository root.

### Other static hosts

Upload the contents of `SharedMusicSpace/wwwroot`. Invite links look like `/r/ABC123`, so the host must serve `index.html` for those paths (Netlify: add `/r/* /index.html 200` to `_redirects`; Cloudflare Pages: the same rule; GitHub Pages: copy `index.html` to `404.html`). Without that rule invite links 404, but room codes still work.

### Checklist

- Serve over **HTTPS** (WebCrypto and WebRTC need a secure context; `localhost` is fine for development).
- Two people on different networks can create/join a room. If they can't connect, see [Troubleshooting](TROUBLESHOOTING.md#peers-cant-connect-serverless-mode).

## B. Single Docker host (server mode)

The ASP.NET app serves the frontend *and* the SignalR hub, so there is nothing else to configure.

```bash
docker build -t music-space .
docker run -p 8080:8080 music-space        # http://localhost:8080
```

On a platform such as Render, Railway or Fly.io: create a **Web Service from the repository's Dockerfile**. The app binds to the `PORT` the platform provides (default 8080). Settings that matter:

- Health check path: `/healthz`
- The platform's proxy must allow **WebSockets** (all of the above do by default).
- Put it behind HTTPS (the platform does this for you). `UseHttpsRedirection` is intentionally off, because the proxy terminates TLS.
- Keep a **single instance**: rooms live in memory, so scaling out would split rooms across instances.

Free tiers may sleep after inactivity; the first visit then takes 30–60 s to wake the server.

## C. Split: Vercel frontend + Render backend

Use this when you want the frontend on a static host but server mode's keyless search and big rooms.

### 1. Backend on Render

1. In Render choose **New → Web Service** (or **New → Blueprint** and point it at `deploy/render.yaml`), select this repository and use **Docker** as the runtime.
2. Add the environment variable `ALLOWED_ORIGINS` set to your frontend's exact origin, e.g. `https://music-space.vercel.app` (comma-separate several; no trailing slash).
3. Set the health check path to `/healthz` and deploy. Note the URL, e.g. `https://music-space-api.onrender.com`.
4. Check it: `curl https://music-space-api.onrender.com/healthz` → `{"status":"ok","rooms":0}`.

### 2. Frontend on Vercel

1. In the Vercel project settings add the environment variable `BACKEND_URL=https://music-space-api.onrender.com` (https, no trailing slash).
2. Redeploy (environment variable changes need a new build — `scripts/vercel-build.mjs` writes it into `config.js`).
3. Open the site; the lobby should say **"Connected"** (not "peer-to-peer").

### Troubleshooting the split setup

| Symptom | Cause |
|---|---|
| Lobby says "peer-to-peer" although you set a backend | `BACKEND_URL` was added after the last build — redeploy |
| Browser console: CORS error on `/musicHub/negotiate` | `ALLOWED_ORIGINS` doesn't exactly match the site origin (scheme + host, no path, no trailing slash) |
| "Can't reach the server — retrying…" | Backend asleep or wrong URL; open `<backend>/healthz` in a browser |

## Running locally for development

```bash
dotnet run --project SharedMusicSpace          # server mode at http://localhost:5271
# serverless mode between tabs, no network:
#   open http://localhost:5271/?p2p=local in two tabs
```

## Releasing changes

Pushes to `main` run CI (`dotnet test` and `node --test tests-js/*.test.mjs`). Vercel redeploys the frontend on every push if the GitHub integration is connected; the backend redeploys from the Dockerfile on your container host.
