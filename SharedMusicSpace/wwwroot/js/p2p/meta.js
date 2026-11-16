// Video metadata without a backend. Order of preference:
//   1. results from our own search (full metadata incl. duration)
//   2. noembed.com (CORS-enabled oEmbed proxy) for title/author
//   3. a placeholder title — the first player to load the video reports the real title/duration to the host.

const ID_RE = /^[\w-]{11}$/;

export function parseVideoId(input) {
  const text = String(input ?? '').trim();
  if (ID_RE.test(text)) return text;
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return ID_RE.test(url.pathname.slice(1, 12)) ? url.pathname.slice(1, 12) : null;
    if (host === 'youtube.com') {
      const v = url.searchParams.get('v');
      if (v && ID_RE.test(v)) return v;
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch { /* not a URL */ }
  return null;
}

export function createMetaResolver({ fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 4000 } = {}) {
  const known = new Map(); // id -> { id, title, author, duration }

  return {
    remember(items) { for (const v of items) known.set(v.videoId ?? v.id, { id: v.videoId ?? v.id, title: v.title, author: v.author, duration: v.duration ?? 0 }); },

    async resolve(idOrUrl) {
      const id = parseVideoId(idOrUrl);
      if (!id) return null;
      if (known.has(id)) return known.get(id);

      let meta = { id, title: `YouTube video ${id}`, author: 'YouTube', duration: 0 };
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        const res = await fetchImpl(`https://noembed.com/embed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { signal: ctl.signal });
        clearTimeout(timer);
        const j = await res.json();
        if (j?.title) meta = { ...meta, title: String(j.title), author: String(j.author_name ?? 'YouTube') };
      } catch { /* offline or blocked: keep placeholder */ }
      known.set(id, meta);
      return meta;
    },
  };
}
