// Tiny DOM helpers. Everything user-controlled goes through textContent / attributes,
// never innerHTML, so names, titles and chat can't inject markup.

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(button, name) {
  button.querySelector('use')?.setAttribute('href', `#i-${name}`);
}

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${String(min).padStart(2, '0')}:${sec}` : `${min}:${sec}`;
}

export const thumbUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

export function avatar(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  return h('span', {
    class: 'avatar',
    style: { background: `linear-gradient(135deg, hsl(${hue} 75% 58%), hsl(${(hue + 50) % 360} 75% 45%))` },
    'aria-hidden': 'true',
  }, [...name][0] ?? '?');
}

export function toast(message, kind = 'info') {
  const host = $('#toasts');
  while (host.children.length >= 3) host.firstElementChild.remove();
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}`, text: message });
  host.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  }, 3600);
}

/** Keeps a native range input's filled track in sync (WebKit has no ::progress pseudo). */
export function paintRange(input) {
  const max = Number(input.max) || 100;
  const pct = max > 0 ? (Number(input.value) / max) * 100 : 0;
  input.style.setProperty('--p', `${pct}%`);
}
