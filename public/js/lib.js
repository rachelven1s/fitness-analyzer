// DOM, formatting, theming and tooltip helpers shared by the charts.

const SVG_NS = 'http://www.w3.org/2000/svg';

function assign(node, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.setAttribute('class', v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  return node;
}

export function el(tag, attrs, ...children) {
  const node = assign(document.createElement(tag), attrs);
  node.append(...children.flat().filter((c) => c != null));
  return node;
}

export function svg(tag, attrs, ...children) {
  const node = assign(document.createElementNS(SVG_NS, tag), attrs);
  node.append(...children.flat().filter((c) => c != null));
  return node;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- dates (all treated as UTC calendar dates) ----------

export const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
export const DAY = 86400e3;
export const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const fmtDate = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts });
const longDate = fmtDate({ year: 'numeric', month: 'short', day: 'numeric' });
const fullDate = fmtDate({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const monthYear = fmtDate({ year: 'numeric', month: 'short' });
export const fmtDay = (d) => longDate.format(dayMs(d));
export const fmtFullDay = (d) => fullDate.format(dayMs(d));
export const fmtMonth = (m) => monthYear.format(dayMs(`${m}-01`));

// ---------- numbers ----------

export const fmtInt = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
export const fmt1 = (v) => (v == null ? '—' : v.toFixed(1));
export const fmtCompact = (v) => {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return `${Math.round(v)}`;
};
export const fmtDuration = (min) => {
  if (min == null) return '—';
  const total = Math.round(min);
  // A negative duration keeps its sign in front: -80 is "-1h 20m", not "-2h 40m".
  const sign = total < 0 ? '-' : '';
  const h = Math.floor(Math.abs(total) / 60);
  const m = Math.abs(total) - h * 60;
  // A bare "44m" reads as metres next to distances, so minutes alone are spelled out.
  return sign + (h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`);
};
// Minutes after 18:00 → clock time
export const fmtClockFrom18 = (m) => {
  if (m == null) return '—';
  return fmtClock((m + 18 * 60) % 1440);
};
export const fmtClock = (minOfDay) => {
  const h = Math.floor(minOfDay / 60) % 24;
  const m = Math.round(minOfDay % 60);
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
export const fmtHourShort = (h) => {
  const v = ((h % 24) + 24) % 24;
  if (v === 0) return '12a';
  if (v === 12) return '12p';
  return v < 12 ? `${v}a` : `${v - 12}p`;
};

export const mean = (a) => {
  const v = a.filter((x) => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
export const median = (a) => {
  const v = a.filter((x) => x != null).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export function niceTicks(lo, hi, count = 5) {
  if (lo === hi) { hi = lo + 1; }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(6));
  return out;
}

export const linear = (d0, d1, r0, r1) => {
  const s = (r1 - r0) / ((d1 - d0) || 1);
  return (v) => r0 + (v - d0) * s;
};

// ---------- theme ----------

const LIGHT_RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    dark: false,
    surface: v('--surface'),
    page: v('--page'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    muted: v('--muted'),
    grid: v('--grid'),
    axis: v('--axis'),
    neg: v('--neg'),
    mid: v('--mid'),
    series: [v('--s1'), v('--s2'), v('--s3'), v('--s4'), v('--s5'), v('--s6'), v('--s7')],
    // Near-zero recedes into the surface.
    ramp: LIGHT_RAMP,
  };
}

function hexToRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

// Returns t∈[0,1] → [r,g,b] by interpolating the sequential ramp, cached in a 256-step table.
export function rampTable(ramp) {
  const stops = ramp.map(hexToRgb);
  const table = [];
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (stops.length - 1);
    const a = Math.floor(p);
    const b = Math.min(stops.length - 1, a + 1);
    const f = p - a;
    table.push(stops[a].map((c, k) => Math.round(c + (stops[b][k] - c) * f)));
  }
  return (t) => table[Math.max(0, Math.min(255, Math.round(t * 255)))];
}

export const rampCss = (ramp) => `linear-gradient(90deg, ${ramp.join(',')})`;

// ---------- tooltip ----------

const tipNode = () => document.getElementById('tooltip');

export function showTip(evt, html) {
  const tip = tipNode();
  tip.innerHTML = html;
  tip.hidden = false;
  const { width, height } = tip.getBoundingClientRect();
  const x = evt.clientX + 14 + width > window.innerWidth ? evt.clientX - width - 14 : evt.clientX + 14;
  const y = Math.max(6, Math.min(window.innerHeight - height - 6, evt.clientY - height - 12));
  tip.style.left = `${Math.max(6, x)}px`;
  tip.style.top = `${y}px`;
}
export const hideTip = () => { tipNode().hidden = true; };
export const tipRow = (color, label, value) => `<div class="row">${color ? `<i style="background:${color}"></i>` : ''}<span>${esc(label)}</span><span>${esc(value)}</span></div>`;

// ---------- figure shell: title, chart, legend and table twin ----------

const figures = new Set();

// Method and caveats, folded away so the page reads as findings first.
export const howMeasured = (text) => el('details', { class: 'method' }, el('summary', { text: 'How it\'s measured' }), el('p', { text }));

// takeaway: one sentence on what the figure shows, which stays readable when the figure is folded.
// sub: a short reading aid for the chart. method: anything longer, folded under the chart.
export function figure({ title, sub, takeaway, method, render, legend, table, height, private: isPrivate }) {
  const host = el('div', { class: 'fig-host' });
  if (height) host.style.minHeight = `${height}px`;
  const legendHost = el('div');
  const node = el('figure', { class: `fig${isPrivate ? ' private' : ''}` },
    el('div', { class: 'fig-head' },
      el('div', { class: 'fig-title', text: title }),
      takeaway ? el('div', { class: 'fig-takeaway', text: takeaway }) : null),
    sub ? el('div', { class: 'fig-sub', text: sub }) : null,
    host,
    legendHost,
    method ? howMeasured(method) : null);

  if (table) {
    const details = el('details', { class: 'table-view' }, el('summary', { text: 'View as table' }));
    details.addEventListener('toggle', () => {
      if (!details.open || details.querySelector('table')) return;
      const { columns, rows } = typeof table === 'function' ? table() : table;
      details.append(el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, columns.map((c) => el('th', { scope: 'col', text: c })))),
        el('tbody', null, rows.map((r) => el('tr', null, r.map((v) => el('td', { text: v ?? '—' }))))))));
    });
    node.append(details);
  }

  const entry = {
    width: 0,
    draw() {
      const width = host.clientWidth;
      if (!width) return;
      entry.width = width;
      host.replaceChildren();
      render(host, width, theme());
      host.style.minHeight = '';
      legendHost.replaceChildren();
      if (legend) legendHost.append(renderLegend(typeof legend === 'function' ? legend(theme()) : legend));
    },
  };
  figures.add(entry);
  // Lets a control on the page redraw just this figure.
  node.redraw = () => entry.draw();
  node.fold = () => foldFigure(node);
  new ResizeObserver(() => {
    if (host.clientWidth && Math.abs(host.clientWidth - entry.width) > 1) entry.draw();
  }).observe(host);
  return node;
}

export const redrawAll = () => figures.forEach((f) => f.draw());

// A folded figure shows only its title and takeaway. The whole header opens it, and the chart draws
// once it has a width.
function foldFigure(node) {
  const head = node.querySelector('.fig-head');
  const toggle = el('button', { type: 'button', class: 'fig-toggle', 'aria-expanded': 'false', text: 'Show' });
  const set = (open) => {
    node.classList.toggle('folded', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Hide' : 'Show';
  };
  head.append(toggle);
  head.addEventListener('click', (e) => {
    if (e.target.closest('a, button') && e.target !== toggle) return;
    set(node.classList.contains('folded'));
  });
  node.classList.add('foldable');
  set(false);
  return node;
}

export function renderLegend(items) {
  return el('div', { class: 'legend' }, items.map((item) => {
    if (item.ramp) {
      const ramp = el('span', { class: 'ramp' });
      ramp.style.background = item.ramp;
      return el('span', { class: 'key' }, el('span', { text: item.from }), ramp, el('span', { text: item.to }));
    }
    if (item.gap) return el('span', { class: 'key' }, el('span', { class: 'gap-swatch' }), el('span', { text: item.label }));
    const sw = el('span', { class: 'swatch' });
    sw.style.background = item.color;
    return el('span', { class: 'key' }, sw, el('span', { text: item.label }));
  }));
}

export function tile(label, value, note, action) {
  return el('div', { class: 'tile' },
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: value }),
    note ? el('div', { class: 'note', text: note }) : null,
    action || null);
}
