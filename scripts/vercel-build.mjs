// Vercel build step: point the static frontend at the realtime backend.
import { writeFileSync } from 'node:fs';

const api = (process.env.BACKEND_URL ?? '').trim().replace(/\/$/, '');
if (!api) console.warn('[build] BACKEND_URL is not set — the site will try to reach a backend on its own origin and fail.');
else if (!/^https:\/\//.test(api)) throw new Error(`BACKEND_URL must start with https:// (got "${api}")`);

writeFileSync('SharedMusicSpace/wwwroot/config.js', `window.MUSIC_SPACE_API = ${JSON.stringify(api)};\n`);
console.log(`[build] backend = ${api || '(same origin)'}`);
