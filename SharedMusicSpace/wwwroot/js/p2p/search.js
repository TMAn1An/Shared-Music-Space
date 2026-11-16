// YouTube search without a backend. Browsers can't scrape YouTube (CORS), so:
//   • with a (free) YouTube Data API key the user pastes in settings → official search, ~100 searches/day;
//   • otherwise we try community mirrors (Piped / Invidious) — free but often down.
// If nothing works we say so clearly and the UI points to "paste a link" or "add a key".

const MIRRORS = [
  { kind: 'piped', base: 'https://pipedapi.kavin.rocks' },
  { kind: 'piped', base: 'https://api.piped.private.coffee' },
  { kind: 'invidious', base: 'https://inv.nadeko.net' },
  { kind: 'invidious', base: 'https://yewtu.be' },
];

export class SearchUnavailable extends Error {
  constructor(message) { super(message); this.code = 'SEARCH_UNAVAILABLE'; }
}

const iso8601ToSeconds = (iso) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
};

async function getJson(fetchImpl, url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function viaApiKey(fetchImpl, key, q) {
  const s = await getJson(fetchImpl, `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=15&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`, 6000);
  const ids = s.items.map((i) => i.id.videoId).join(',');
  const d = await getJson(fetchImpl, `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${encodeURIComponent(key)}`, 6000);
  const dur = new Map(d.items.map((v) => [v.id, iso8601ToSeconds(v.contentDetails.duration)]));
  return s.items.map((i) => ({ videoId: i.id.videoId, title: decode(i.snippet.title), author: decode(i.snippet.channelTitle), duration: dur.get(i.id.videoId) ?? 0 }))
    .filter((v) => v.duration > 0);
}

async function viaMirror(fetchImpl, mirror, q) {
  if (mirror.kind === 'piped') {
    const j = await getJson(fetchImpl, `${mirror.base}/search?q=${encodeURIComponent(q)}&filter=videos`, 4500);
    return j.items.filter((v) => v.duration > 0 && v.url).slice(0, 15)
      .map((v) => ({ videoId: v.url.split('v=')[1], title: v.title, author: v.uploaderName, duration: v.duration }));
  }
  const j = await getJson(fetchImpl, `${mirror.base}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, 4500);
  return j.filter((v) => v.lengthSeconds > 0).slice(0, 15)
    .map((v) => ({ videoId: v.videoId, title: v.title, author: v.author, duration: v.lengthSeconds }));
}

const decode = (s) => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));

export function createSearch({ getKey = () => '', fetchImpl = globalThis.fetch?.bind(globalThis), mirrors = MIRRORS } = {}) {
  return async function search(query) {
    const q = String(query).trim();
    const key = getKey();
    if (key) {
      try { return await viaApiKey(fetchImpl, key, q); }
      catch { throw new SearchUnavailable('Search failed — check your YouTube API key and daily quota, or paste a link instead.'); }
    }
    for (const mirror of mirrors) {
      try {
        const results = await viaMirror(fetchImpl, mirror, q);
        if (results.length) return results;
      } catch { /* try the next mirror */ }
    }
    throw new SearchUnavailable('Search needs a free YouTube API key in serverless mode (see “Search settings”) — or just paste a YouTube link.');
  };
}
