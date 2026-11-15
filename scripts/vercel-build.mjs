// Vercel build step: point the static frontend at the realtime backend.
import { writeFileSync } from 'node:fs';

const api = (process.env.BACKEND_URL ?? '').trim().replace(/\/$/, '');
if (!api) console.log('[build] BACKEND_URL not set — the site runs in serverless peer-to-peer mode.');
else if (!/^https:\/\//.test(api)) throw new Error(`BACKEND_URL must start with https:// (got "${api}")`);

writeFileSync('SharedMusicSpace/wwwroot/config.js', `window.MUSIC_SPACE_API = ${JSON.stringify(api)};\n`);
console.log(`[build] backend = ${api || '(none: peer-to-peer)'}`);
