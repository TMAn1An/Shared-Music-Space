// Picks how the app talks to the world:
//   server — ASP.NET + SignalR (same origin, or the URL in config.js): best for big rooms and keyless search.
//   p2p    — serverless: rooms live in the host's browser, peers connect over WebRTC. Works on any static host.
// MUSIC_SPACE_MODE = 'auto' (default) | 'server' | 'p2p'.  ?p2p=local forces same-browser tabs (demo/testing).

const API = () => (window.MUSIC_SPACE_API || '').replace(/\/$/, '');

async function serverIsReachable() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(`${API()}/healthz`, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res.ok && (await res.json()).status === 'ok';
  } catch { return false; }
}

export async function chooseBackend() {
  const forced = new URLSearchParams(location.search).get('p2p');
  const mode = forced ? 'p2p' : (window.MUSIC_SPACE_MODE || 'auto');
  const useServer = mode === 'server' || (mode === 'auto' && (API() !== '' || await serverIsReachable()));
  return useServer ? createServerBackend() : createP2PBackend(forced === 'local');
}

function createServerBackend() {
  const conn = new signalR.HubConnectionBuilder()
    .withUrl(`${API()}/musicHub`)
    .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => Math.min(1000 * (ctx.previousRetryCount + 1), 8000) })
    .configureLogging(signalR.LogLevel.Warning)
    .build();
  conn.mode = 'server';
  return conn;
}

async function createP2PBackend(local) {
  const [{ P2PBackend }, { createMetaResolver }, { createSearch }] = await Promise.all([
    import('./p2p/engine.js'), import('./p2p/meta.js'), import('./p2p/search.js'),
  ]);
  const createTransport = local
    ? async (room) => (await import('./p2p/transport-local.js')).createLocalTransport(room)
    : async (room) => (await import('./p2p/transport-trystero.js')).createTrysteroTransport(room, window.MUSIC_SPACE_P2P ?? {});
  const read = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode: identity lasts for this page only */ } };

  const backend = new P2PBackend({
    createTransport,
    // One identity per browser tab: survives reloads, so a reload brings you back to your own seat.
    store: { load: () => { try { return JSON.parse(read('ms.identity')); } catch { return null; } }, save: (v) => write('ms.identity', JSON.stringify(v)) },
    meta: createMetaResolver(),
    search: createSearch({ getKey: () => { try { return localStorage.getItem('ms.ytkey') ?? ''; } catch { return ''; } } }),
  });
  backend.local = local;
  return backend;
}
