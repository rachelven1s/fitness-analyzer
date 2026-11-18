// Hand-rolled SVG and canvas charts, so the app has no third-party code or network calls.
import { svg, linear, niceTicks, showTip, hideTip, tipRow, esc, dayMs, DAY, rampTable } from './lib.js';

const yearTicks = (x0, x1) => {
  const out = [];
  for (let y = new Date(x0).getUTCFullYear(); y <= new Date(x1).getUTCFullYear() + 1; y++) {
    const t = Date.UTC(y, 0, 1);
    if (t >= x0 && t <= x1) out.push({ v: t, label: String(y) });
  }
  return out;
};

function monthTicks(x0, x1) {
  const out = [];
  const start = new Date(x0);
  for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1); t <= x1;) {
    const d = new Date(t);
    if (d.getUTCMonth() % 3 === 0) {
      out.push({ v: t, label: d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) });
    }
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}

export const dateTicks = (x0, x1) => {
  const years = yearTicks(x0, x1);
  return years.length >= 2 ? years : monthTicks(x0, x1);
};

function roundedTop(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function axes(root, t, { left, right, top, plotH, W, yScale, yTicks, yFmt, xScale, xTicks }) {
  for (const v of yTicks) {
    const y = yScale(v);
    root.append(svg('line', { x1: left, x2: W - right, y1: y, y2: y, stroke: t.grid, 'stroke-width': 1 }));
    root.append(svg('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'axis-label', text: yFmt(v) }));
  }
  root.append(svg('line', { x1: left, x2: W - right, y1: top + plotH, y2: top + plotH, stroke: t.axis, 'stroke-width': 1 }));
  for (const tick of xTicks || []) {
    root.append(svg('text', { x: xScale(tick.v), y: top + plotH + 16, 'text-anchor': 'middle', class: 'axis-label', text: tick.label }));
  }
}

// ---------- line chart: one y-axis, optional bands, crosshair tooltip, arrow-key access ----------

export function lineChart(host, width, t, opts) {
  const { series, height = 240, yFmt = (v) => `${v}`, xFmt, xType = 'date', breakGap = Infinity, yDomain, onPick, annotations = [], rightPad = 12, xTickList, zeroLine } = opts;
  const W = width;
  const left = opts.left ?? 38;
  const top = 12;
  const bottom = 24;
  const right = rightPad;
  const plotH = height - top - bottom;

  const all = series.flatMap((s) => s.points);
  const xs = all.map((p) => p.x);
  const x0 = opts.xDomain?.[0] ?? Math.min(...xs);
  const x1 = opts.xDomain?.[1] ?? Math.max(...xs);
  // Single readings include outliers, so the axis fits the lines plus the middle 96% of the dots.
  const dotValues = series.filter((s) => s.dots).flatMap((s) => s.points.map((p) => p.y)).filter((v) => v != null).sort((p, q) => p - q);
  const pct = (f) => dotValues[Math.floor((dotValues.length - 1) * f)];
  const fitted = dotValues.length
    ? [...series.filter((s) => !s.dots).flatMap((s) => s.points), { y: pct(0.02) }, { y: pct(0.98) }]
    : all;
  const ys = fitted.flatMap((p) => (p.lo != null ? [p.lo, p.hi] : [p.y])).filter((v) => v != null);
  let [y0, y1] = yDomain || [Math.min(...ys), Math.max(...ys)];
  if (!yDomain) { const pad = (y1 - y0) * 0.08 || 1; y0 -= pad; y1 += pad; }
  const yTicks = opts.yTickList || niceTicks(y0, y1, opts.yCount || 4);
  y0 = Math.min(y0, yTicks[0]);
  y1 = Math.max(y1, yTicks[yTicks.length - 1]);
  const xScale = linear(x0, x1, left, W - right);
  const yScale = linear(y0, y1, top + plotH, top);

  const root = svg('svg', { width: W, height, viewBox: `0 0 ${W} ${height}`, tabindex: 0, role: 'img', 'aria-label': opts.ariaLabel || 'Line chart. Use left and right arrow keys to move through values.' });
  const xTicks = xTickList || (xType === 'date' ? dateTicks(x0, x1) : niceTicks(x0, x1, 6).map((v) => ({ v, label: (opts.xTickFmt || String)(v) })));
  axes(root, t, { left, right, top, plotH, W, yScale, yTicks, yFmt, xScale, xTicks });
  if (zeroLine != null) root.append(svg('line', { x1: left, x2: W - right, y1: yScale(zeroLine), y2: yScale(zeroLine), stroke: t.axis, 'stroke-width': 1 }));

  // Highlighted stretches of time, drawn behind everything else.
  for (const span of opts.spans || []) {
    const sx = xScale(span.x0);
    const ex = xScale(span.x1);
    root.append(svg('rect', { x: sx, y: top, width: Math.max(2, ex - sx), height: plotH, fill: span.color || t.series[0], 'fill-opacity': 0.12 }));
    if (span.label) root.append(svg('text', { x: sx + 4, y: top + plotH - 8, class: 'note-label', text: span.label }));
  }
  // Labels step down a line each so markers close together don't print over each other.
  annotations.forEach((a, i) => {
    const ax = xScale(a.x);
    root.append(svg('line', { x1: ax, x2: ax, y1: top, y2: top + plotH, stroke: t.axis, 'stroke-width': 1 }));
    const nearRight = ax > W - right - 160;
    root.append(svg('text', { x: nearRight ? ax - 5 : ax + 5, y: top + 10 + i * 13, 'text-anchor': nearRight ? 'end' : 'start', class: 'note-label', text: a.label }));
  });
  if (opts.goal != null) {
    const gy = yScale(opts.goal.y);
    root.append(svg('line', { x1: left, x2: W - right, y1: gy, y2: gy, stroke: t.muted, 'stroke-width': 1 }));
    root.append(svg('text', { x: W - right, y: gy - 5, 'text-anchor': 'end', class: 'note-label', text: opts.goal.label }));
  }

  for (const s of series) {
    // Dot series show individual readings behind the lines and stay out of the crosshair.
    if (s.dots) {
      for (const p of s.points) {
        if (p.y == null || p.y < y0 || p.y > y1) continue;
        root.append(svg('circle', { cx: xScale(p.x), cy: yScale(p.y), r: 2, fill: s.color, 'fill-opacity': 0.22 }));
      }
      continue;
    }
    const segments = [];
    let cur = [];
    for (const p of s.points) {
      if (p.y == null) { if (cur.length) segments.push(cur); cur = []; continue; }
      if (cur.length && p.x - cur[cur.length - 1].x > breakGap) { segments.push(cur); cur = []; }
      cur.push(p);
    }
    if (cur.length) segments.push(cur);

    if (s.band) {
      for (const seg of segments) {
        const up = seg.map((p) => `${xScale(p.x).toFixed(1)},${yScale(p.hi).toFixed(1)}`);
        const dn = [...seg].reverse().map((p) => `${xScale(p.x).toFixed(1)},${yScale(p.lo).toFixed(1)}`);
        root.append(svg('path', { d: `M${up.join('L')}L${dn.join('L')}Z`, fill: s.color, 'fill-opacity': 0.12 }));
      }
    }
    for (const seg of segments) {
      if (seg.length === 1 && !s.faint) {
        root.append(svg('circle', { cx: xScale(seg[0].x), cy: yScale(seg[0].y), r: 2.5, fill: s.color }));
        continue;
      }
      const d = `M${seg.map((p) => `${xScale(p.x).toFixed(1)},${yScale(p.y).toFixed(1)}`).join('L')}`;
      root.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.faint ? 1 : 2, 'stroke-opacity': s.faint ? 0.28 : 1, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    if (s.endLabel) {
      const last = s.points.filter((p) => p.y != null).at(-1);
      root.append(svg('text', { x: xScale(last.x) + 6, y: yScale(last.y) + 4, class: 'value-label', text: s.endLabel }));
    }
  }
  for (const m of opts.marks || []) {
    root.append(svg('circle', { cx: xScale(m.x), cy: yScale(m.y), r: 4, fill: m.color || series[0].color, stroke: t.surface, 'stroke-width': 2 }));
    root.append(svg('text', { x: xScale(m.x) + (m.dx ?? 8), y: yScale(m.y) + (m.dy ?? 4), 'text-anchor': m.anchor || 'start', class: 'value-label', text: m.label }));
  }

  // Crosshair layer
  // Series can cover different dates (two watches), so hover tracks every x any visible series has.
  const visible = series.filter((s) => !s.faint && !s.dots);
  const lookups = visible.map((s) => new Map(s.points.filter((p) => p.y != null).map((p) => [p.x, p])));
  const pts = [...new Set(lookups.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b)
    .map((x) => lookups.map((m) => m.get(x)).find(Boolean));
  const cross = svg('line', { y1: top, y2: top + plotH, stroke: t.muted, 'stroke-width': 1, visibility: 'hidden' });
  const dots = visible.map((s) => svg('circle', { r: 4, fill: s.color, stroke: t.surface, 'stroke-width': 2, visibility: 'hidden' }));
  root.append(cross, ...dots);

  const nearest = (x) => {
    let lo = 0; let hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].x < x) lo = mid; else hi = mid; }
    return Math.abs(pts[lo].x - x) <= Math.abs(pts[hi].x - x) ? lo : hi;
  };
  let index = pts.length - 1;
  const show = (i, evt) => {
    index = i;
    const p = pts[i];
    const cx = xScale(p.x);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    const rows = [];
    visible.forEach((s, k) => {
      const match = lookups[k].get(p.x);
      if (match) {
        dots[k].setAttribute('cx', cx); dots[k].setAttribute('cy', yScale(match.y)); dots[k].setAttribute('visibility', 'visible');
        rows.push(tipRow(s.color, s.name, (s.tipFmt || yFmt)(match.y)));
      } else dots[k].setAttribute('visibility', 'hidden');
    });
    const raw = series.find((s) => s.faint)?.points.find((q) => q.x === p.x);
    if (raw?.y != null) rows.push(tipRow(null, series.find((s) => s.faint).name, yFmt(raw.y)));
    const rect = root.getBoundingClientRect();
    const position = evt || { clientX: rect.left + cx, clientY: rect.top + yScale(p.y) };
    showTip(position, `<b>${esc((xFmt || String)(p.x))}</b>${rows.join('')}${onPick ? '<div class="hint">Click to open this day</div>' : ''}`);
  };
  const clear = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    hideTip();
  };
  const toX = (evt) => {
    const rect = root.getBoundingClientRect();
    return x0 + ((evt.clientX - rect.left - left) / (W - left - right)) * (x1 - x0);
  };
  if (pts.length) {
    root.addEventListener('pointermove', (evt) => show(nearest(toX(evt)), evt));
    root.addEventListener('pointerleave', clear);
    root.addEventListener('blur', clear);
    root.addEventListener('focus', () => show(index));
    root.addEventListener('keydown', (evt) => {
      if (evt.key === 'ArrowLeft') { show(Math.max(0, index - 1)); evt.preventDefault(); }
      else if (evt.key === 'ArrowRight') { show(Math.min(pts.length - 1, index + 1)); evt.preventDefault(); }
      else if (evt.key === 'Enter' && onPick) onPick(pts[index].x);
    });
    if (onPick) {
      root.style.cursor = 'pointer';
      root.addEventListener('click', (evt) => onPick(pts[nearest(toX(evt))].x));
    }
  }
  host.append(root);
}

// ---------- stacked columns ----------

export function columnChart(host, width, t, opts) {
  const { categories, series, height = 240, yFmt = (v) => `${v}`, catFmt = String, tickEvery, tickFmt } = opts;
  const W = width;
  const left = opts.left ?? 38;
  const right = 6;
  const top = 12;
  const bottom = 24;
  const plotH = height - top - bottom;
  const totals = categories.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
  const maxTotal = Math.max(...totals, 1);
  const yTicks = niceTicks(0, maxTotal, 4);
  // The ticks stop at or below the data, so add one more step to keep tall columns inside the plot.
  if (yTicks[yTicks.length - 1] < maxTotal) yTicks.push(yTicks[yTicks.length - 1] + (yTicks[1] - yTicks[0]));
  const yMax = yTicks[yTicks.length - 1];
  const band = (W - left - right) / categories.length;
  const barW = Math.min(24, Math.max(1, band - (band > 4 ? 2 : 0.5)));
  const yScale = linear(0, yMax, top + plotH, top);
  const root = svg('svg', { width: W, height, viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': opts.ariaLabel || 'Column chart' });

  const xTicks = [];
  categories.forEach((c, i) => { if (tickEvery?.(c, i)) xTicks.push({ v: left + band * (i + 0.5), label: (tickFmt || String)(c) }); });
  axes(root, t, { left, right, top, plotH, W, yScale, yTicks, yFmt, xScale: (v) => v, xTicks });

  categories.forEach((c, i) => {
    const x = left + band * i + (band - barW) / 2;
    let base = top + plotH;
    const active = series.filter((s) => s.values[i]);
    active.forEach((s, k) => {
      const h = (s.values[i] / yMax) * plotH;
      const isTop = k === active.length - 1;
      const gap = k > 0 && h > 3 ? 2 : 0;
      const y = base - h;
      const drawH = Math.max(0.5, h - gap);
      const d = isTop ? roundedTop(x, y, barW, drawH, barW >= 8 ? 4 : barW / 2) : `M${x},${y}h${barW}v${drawH}h${-barW}Z`;
      root.append(svg('path', { d, fill: s.color }));
      base = y;
    });
    if (totals[i]) {
      const hit = svg('rect', { x: left + band * i, y: top, width: band, height: plotH, fill: 'transparent' });
      const rows = active.map((s) => tipRow(s.color, s.name, yFmt(s.values[i])));
      hit.addEventListener('pointermove', (evt) => showTip(evt, `<b>${esc(catFmt(c))}</b>${rows.join('')}${active.length > 1 ? tipRow(null, 'Total', yFmt(totals[i])) : ''}`));
      hit.addEventListener('pointerleave', hideTip);
      if (opts.onPick) { hit.style.cursor = 'pointer'; hit.addEventListener('click', () => opts.onPick(c)); }
      root.append(hit);
    }
  });
  for (const a of opts.annotations || []) {
    const i = categories.indexOf(a.at);
    if (i < 0) continue;
    const x = left + band * (i + 0.5);
    root.append(svg('text', { x: Math.min(x, W - 4), y: top + 9, 'text-anchor': a.anchor || 'middle', class: 'note-label', text: a.label }));
  }
  host.append(root);
}

// ---------- horizontal bars with value at the tip ----------

export function hBars(host, width, t, { rows, labelWidth = 170, fmt = String, rowH = 27, tipLabel = 'Logged', tipExtra }) {
  const height = rows.length * rowH;
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Bar chart' });
  const max = Math.max(...rows.map((r) => r.value));
  const scale = linear(0, max, 0, width - labelWidth - 62);
  rows.forEach((r, i) => {
    const y = i * rowH;
    const label = svg('text', { x: labelWidth - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'note-label', text: r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label });
    const w = Math.max(2, scale(r.value));
    const bar = svg('path', { d: `M${labelWidth},${y + 5}H${labelWidth + w - 4}Q${labelWidth + w},${y + 5} ${labelWidth + w},${y + 9}V${y + rowH - 9}Q${labelWidth + w},${y + rowH - 5} ${labelWidth + w - 4},${y + rowH - 5}H${labelWidth}Z`, fill: t.series[0] });
    const val = svg('text', { x: labelWidth + w + 6, y: y + rowH / 2 + 4, class: 'value-label', text: fmt(r.value) });
    const hit = svg('rect', { x: 0, y, width, height: rowH, fill: 'transparent' });
    hit.addEventListener('pointermove', (evt) => showTip(evt, `<b>${esc(r.label)}</b>${tipRow(null, tipLabel, fmt(r.value))}${tipExtra ? tipExtra(r) : ''}`));
    hit.addEventListener('pointerleave', hideTip);
    root.append(label, bar, val, hit);
  });
  host.append(root);
}

// ---------- scatter with nearest-point hover ----------

export function scatter(host, width, t, opts) {
  const { points, height = 300, xFmt = String, yFmt = String, xDomain, yDomain, xLabel, yLabel, tip, onPick, xTickFmt, yTickFmt } = opts;
  const left = 42;
  const right = 18;
  const top = 12;
  const bottom = 38;
  const plotH = height - top - bottom;
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.ariaLabel || 'Scatter chart' });
  const xScale = linear(xDomain[0], xDomain[1], left, width - right);
  const yScale = linear(yDomain[0], yDomain[1], top + plotH, top);
  const yTicks = niceTicks(yDomain[0], yDomain[1], 4);
  const xTicks = (opts.xTicks || niceTicks(xDomain[0], xDomain[1], 5)).map((v) => ({ v, label: (xTickFmt || xFmt)(v) }));
  axes(root, t, { left, right, top, plotH, W: width, yScale, yTicks, yFmt: yTickFmt || yFmt, xScale, xTicks });
  root.append(svg('text', { x: width - right, y: height - 4, 'text-anchor': 'end', class: 'axis-label', text: xLabel }));
  if (yLabel) root.append(svg('text', { x: left + 4, y: top + 10, class: 'axis-label', text: yLabel }));

  const placed = points.map((p) => ({ ...p, px: xScale(p.x), py: yScale(p.y) }));
  for (const p of placed) {
    root.append(svg('circle', { cx: p.px, cy: p.py, r: opts.r || 3, fill: p.color, 'fill-opacity': opts.opacity ?? 0.55 }));
  }
  const ring = svg('circle', { r: 6, fill: 'none', stroke: t.ink, 'stroke-width': 2, visibility: 'hidden' });
  root.append(ring);
  const nearest = (evt) => {
    const rect = root.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;
    let best = null; let bestD = 900; // 30px radius
    for (const p of placed) {
      const d = (p.px - mx) ** 2 + (p.py - my) ** 2;
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  };
  root.addEventListener('pointermove', (evt) => {
    const p = nearest(evt);
    if (!p) { ring.setAttribute('visibility', 'hidden'); hideTip(); root.style.cursor = ''; return; }
    ring.setAttribute('cx', p.px); ring.setAttribute('cy', p.py); ring.setAttribute('visibility', 'visible');
    root.style.cursor = onPick ? 'pointer' : '';
    showTip(evt, tip(p));
  });
  root.addEventListener('pointerleave', () => { ring.setAttribute('visibility', 'hidden'); hideTip(); });
  if (onPick) root.addEventListener('click', (evt) => { const p = nearest(evt); if (p) onPick(p); });
  host.append(root);
}

// ---------- canvas raster for the day × time pictures ----------

export function raster(host, width, t, opts) {
  const { height, left = 38, right = 6, top = 4, bottom = 24, columns, paint, yTicks = [], xTicks = [], hover, onPick, marks = [] } = opts;
  const dpr = window.devicePixelRatio || 1;
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', opts.ariaLabel || 'Heatmap. A table view follows.');
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const plotW = width - left - right;
  const plotH = height - top - bottom;
  paint(ctx, { x: left, y: top, w: plotW, h: plotH, dpr, columns });

  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = t.muted;
  ctx.textAlign = 'right';
  for (const tick of yTicks) ctx.fillText(tick.label, left - 7, top + tick.at * plotH + 4);
  ctx.textAlign = 'center';
  for (const tick of xTicks) ctx.fillText(tick.label, left + tick.at * plotW, height - 7);
  for (const m of marks) {
    const x = Math.round(left + m.at * plotW) + 0.5;
    ctx.strokeStyle = t.ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top - 2);
    ctx.lineTo(x, top + plotH + 2);
    ctx.stroke();
    ctx.fillStyle = t.ink2;
    ctx.textAlign = 'left';
    ctx.fillText(m.label, x + 5, height - 7);
  }

  const locate = (evt) => {
    const rect = canvas.getBoundingClientRect();
    const fx = (evt.clientX - rect.left - left) / plotW;
    const fy = (evt.clientY - rect.top - top) / plotH;
    if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) return null;
    return { fx, fy, col: Math.floor(fx * columns) };
  };
  if (hover) {
    canvas.addEventListener('pointermove', (evt) => {
      const at = locate(evt);
      const html = at && hover(at);
      if (html) showTip(evt, html); else hideTip();
    });
    canvas.addEventListener('pointerleave', hideTip);
  }
  if (onPick) canvas.addEventListener('click', (evt) => { const at = locate(evt); if (at) onPick(at); });
  wrap.append(canvas);
  host.append(wrap);
}

// ---------- grid heatmap made of rounded cells ----------

export function cellGrid(host, width, t, opts) {
  const { rows, cols, value, max, rowLabels, colLabels, tip, cellH = 22, labelW = 36 } = opts;
  const colorAt = rampTable(t.ramp);
  const gap = 2;
  const cw = (width - labelW) / cols;
  const height = rows * cellH + 20;
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': opts.ariaLabel || 'Heatmap' });
  for (let r = 0; r < rows; r++) {
    root.append(svg('text', { x: labelW - 8, y: r * cellH + cellH / 2 + 3, 'text-anchor': 'end', class: 'axis-label', text: rowLabels[r] }));
    for (let c = 0; c < cols; c++) {
      const v = value(r, c);
      const rgb = v ? colorAt(opts.scale ? opts.scale(v) : Math.sqrt(v / max)) : null;
      const cell = svg('rect', {
        x: labelW + c * cw + gap / 2,
        y: r * cellH + gap / 2,
        width: Math.max(1, cw - gap),
        height: cellH - gap,
        rx: 3,
        fill: rgb ? `rgb(${rgb})` : t.mid,
      });
      cell.addEventListener('pointermove', (evt) => showTip(evt, tip(r, c, v)));
      cell.addEventListener('pointerleave', hideTip);
      root.append(cell);
    }
  }
  colLabels.forEach((label, c) => {
    if (label) root.append(svg('text', { x: labelW + c * cw + cw / 2, y: height - 4, 'text-anchor': 'middle', class: 'axis-label', text: label }));
  });
  host.append(root);
}

export { dayMs, DAY };
