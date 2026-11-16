#!/usr/bin/env node
// Builds every profile panel from data/profile.json into assets/, in both themes.
// Zero dependencies. Run: node scripts/build.mjs
//
// The build fails (exit 1) when:
//   - any text/background pair is under 4.5:1 contrast
//   - any text is smaller than the minimum size
//   - any text is estimated to overflow its box with a wide fallback font
//   - any SVG is over 100 KB

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data/profile.json'), 'utf8'));
const icons = JSON.parse(readFileSync(join(ROOT, 'data/icons.json'), 'utf8'));
const OUT = join(ROOT, 'assets');

// ---------------------------------------------------------------- tokens

const PALETTE = { gold: '#FFC52D', green: '#0E3A1F', cream: '#F7F4E6', leaf: '#7BAA66' };

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
// mix(a, b, t): move a towards b by t (0..1). Tints and shades come only from here.
const mix = (a, b, t) => {
  const A = hex2rgb(a), B = hex2rgb(b);
  return rgb2hex(A.map((v, i) => v + (B[i] - v) * t));
};
const { gold, green, cream, leaf } = PALETTE;

const THEMES = {
  dark: {
    bg: mix(green, '#000000', 0.42),
    surface: green,
    rule: mix(green, leaf, 0.38),
    grid: mix(mix(green, '#000000', 0.42), leaf, 0.09),
    text: cream,
    muted: mix(cream, green, 0.3),
    accent: gold,
    secondary: leaf,
    trace: gold,
    traceCase: null,
    chipFill: gold,
    chipInk: green,
  },
  light: {
    bg: cream,
    surface: mix(cream, '#FFFFFF', 0.6),
    rule: mix(cream, green, 0.3),
    grid: mix(cream, green, 0.07),
    text: green,
    muted: mix(green, cream, 0.22),
    accent: green,
    secondary: mix(green, leaf, 0.3),
    trace: gold,
    traceCase: green,
    chipFill: gold,
    chipInk: green,
  },
};

const W = 840;          // viewBox width; the README column on desktop
const M = 40;           // side margin
const CW = W - 2 * M;   // content width
// 25 viewBox units is 11px when the panel is scaled to a 375px phone column.
const MIN_TEXT = 25;
const SIZE = { label: 25, body: 27, small: 26, h3: 32, h2: 44, name: 66, figure: 60 };
const MIN_CONTRAST = 4.5;
const MAX_BYTES = 100 * 1024;

// ---------------------------------------------------------------- checks

const problems = [];
const contrastSeen = new Map();

const lum = (h) => {
  const [r, g, b] = hex2rgb(h).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Width estimates assume the widest font in each stack, so a layout that passes
// here holds when the viewer falls back to a wider face.
const monoW = (s, size, ls = 0) => [...s].length * (size * 0.62 + ls);
const sansEm = (ch) => {
  if (ch === ' ') return 0.28;
  if ("iljI.,:;'|!".includes(ch)) return 0.26;
  if ('ftr()-/[]'.includes(ch)) return 0.34;
  if ('mw'.includes(ch)) return 0.82;
  if ('MW'.includes(ch)) return 0.9;
  if (ch >= 'A' && ch <= 'Z') return 0.69;
  if (ch >= '0' && ch <= '9') return 0.56;
  return 0.54;
};
const sansW = (s, size, bold) =>
  [...s].reduce((w, ch) => w + sansEm(ch), 0) * size * (bold ? 1.07 : 1) * 1.1;
const textW = (s, { font = 'mono', size = SIZE.label, weight = 400, ls = 0 } = {}) =>
  font === 'mono' ? monoW(s, size, ls) : sansW(s, size, weight >= 600);

const wrap = (s, max, opts) => {
  const lines = [];
  let line = '';
  for (const word of s.split(/\s+/)) {
    const next = line ? line + ' ' + word : word;
    if (line && textW(next, opts) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v) => +v.toFixed(2);

// ---------------------------------------------------------------- panel

class Panel {
  constructor(id, themeName, title, desc) {
    this.id = id;
    this.themeName = themeName;
    this.t = THEMES[themeName];
    this.title = title;
    this.desc = desc;
    this.out = [];
    this.motion = [];   // CSS that only applies when motion is allowed
  }

  raw(s) { this.out.push(s); }

  check(fill, on, sample) {
    const fg = this.t[fill], bg = this.t[on];
    if (!fg || !bg) throw new Error(`${this.id}: unknown token ${fill}/${on}`);
    const r = ratio(fg, bg);
    const key = `${this.themeName}  ${fill} on ${on}`;
    if (!contrastSeen.has(key)) contrastSeen.set(key, { fg, bg, r });
    if (r < MIN_CONTRAST) problems.push(`contrast ${r.toFixed(2)}:1 ${key} in ${this.id} ("${sample}")`);
  }

  // One line of text. spans: string or [{ str, fill, font, size, weight, ls, dx }].
  text(x, y, spans, o = {}) {
    const base = { font: 'mono', size: SIZE.label, weight: 400, fill: 'text', ls: 0, ...o };
    const on = o.on || 'bg';
    if (typeof spans === 'string') spans = [{ str: spans }];
    spans = spans.filter((s) => s.str !== '').map((s) => ({ ...base, ...s }));
    let width = 0;
    const attrs = (s) => {
      if (s.size < MIN_TEXT) problems.push(`text under ${MIN_TEXT} units in ${this.id} ("${s.str}")`);
      this.check(s.fill, on, s.str);
      width += textW(s.str, s) + (s.dx || 0);
      return `class="${s.font === 'mono' ? 'm' : 's'}" font-size="${s.size}" fill="${this.t[s.fill]}"` +
        (s.weight !== 400 ? ` font-weight="${s.weight}"` : '') +
        (s.ls ? ` letter-spacing="${s.ls}"` : '');
    };
    let body;
    if (spans.length === 1) {
      body = `<text x="${n(x)}" y="${n(y)}" ${attrs(spans[0])}${o.anchor ? ` text-anchor="${o.anchor}"` : ''}>${esc(spans[0].str)}</text>`;
    } else {
      const inner = spans.map((s) => `<tspan ${attrs(s)}${s.dx ? ` dx="${s.dx}"` : ''}>${esc(s.str)}</tspan>`).join('');
      body = `<text x="${n(x)}" y="${n(y)}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''} xml:space="preserve">${inner}</text>`;
    }
    const sample = spans.map((s) => s.str).join('');
    const left = o.anchor === 'end' ? x - width : o.anchor === 'middle' ? x - width / 2 : x;
    if (left < 16 || left + width > W - 16) problems.push(`text may leave the panel in ${this.id} ("${sample}")`);
    if (o.max != null && width > o.max + 0.5) problems.push(`text may overflow its box by ${Math.round(width - o.max)} units in ${this.id} ("${sample}")`);
    this.out.push(body);
    return width;
  }

  // Wrapped paragraph. Returns the y below the last line.
  para(x, top, str, o = {}) {
    const opts = { font: 'sans', size: SIZE.body, ...o };
    const lh = o.lh || Math.round(opts.size * 1.42);
    const lines = wrap(str, o.max ?? CW, opts);
    lines.forEach((line, i) => this.text(x, top + opts.size * 0.84 + i * lh, line, { ...opts, max: o.max ?? CW }));
    return top + lines.length * lh;
  }

  // The signature element: a gold trace on the schematic grid.
  trace(d) {
    const t = this.t;
    if (t.traceCase) this.raw(`<path d="${d}" fill="none" stroke="${t.traceCase}" stroke-width="6" stroke-linejoin="round"/>`);
    this.raw(`<path d="${d}" fill="none" stroke="${t.trace}" stroke-width="3" stroke-linejoin="round"/>`);
  }

  node(x, y, { filled = false, on = 'bg' } = {}) {
    const t = this.t;
    const edge = t.traceCase || t.trace;
    this.raw(filled
      ? `<circle cx="${x}" cy="${y}" r="7" fill="${t.trace}" stroke="${edge}" stroke-width="2"/>`
      : `<circle cx="${x}" cy="${y}" r="7" fill="${t[on]}" stroke="${edge}" stroke-width="2"/><circle cx="${x}" cy="${y}" r="2.5" fill="${t.traceCase ? t.trace : edge}"/>`);
  }

  // The moving pulse. Drawn at its resting point; motion is added separately.
  pulse(x, y, cls) {
    const t = this.t;
    this.raw(`<g class="${cls}" transform="translate(${x} ${y})"><circle r="13" fill="${t.trace}" opacity="0.28"/><circle r="6.5" fill="${t.trace}"${t.traceCase ? ` stroke="${t.traceCase}" stroke-width="2"` : ''}/></g>`);
  }

  // Keyframes that move `cls` through orthogonal waypoints at constant speed,
  // using transform and opacity only.
  travel(cls, points, seconds, travelShare = 0.72) {
    const d = points.slice(1).map((p, i) => Math.abs(p[0] - points[i][0]) + Math.abs(p[1] - points[i][1]));
    const total = d.reduce((a, b) => a + b, 0);
    let acc = 0;
    const frames = points.map((p, i) => {
      if (i) acc += d[i - 1];
      const pct = n((acc / total) * travelShare * 100);
      const op = i === 0 ? 0 : 1;
      return `${pct}%{transform:translate(${p[0]}px,${p[1]}px);opacity:${op}}`;
    });
    const [sx, sy] = points[0], [ex, ey] = points[points.length - 1];
    const fadeIn = `${n((Math.min(d[0], 30) / total) * travelShare * 100)}%{opacity:1}`;
    const out = `${n(travelShare * 100 + 5)}%,100%{transform:translate(${ex}px,${ey}px);opacity:0}`;
    this.motion.push(`@keyframes ${cls}{${frames[0]}${fadeIn}${frames.slice(1).join('')}${out}}` +
      `.${cls}{animation:${cls} ${seconds}s linear infinite}`);
    void sx; void sy;
  }

  card(x, y, w, h, on = 'surface') {
    const t = this.t;
    this.raw(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${t[on]}" stroke="${t.rule}"/>`);
  }

  // Reserve a slot for a card whose height is known only after its content.
  cardAround(x, top, w, draw) {
    const at = this.out.length;
    this.out.push('');
    const bottom = draw();
    this.out[at] = `<rect x="${x}" y="${top}" width="${w}" height="${bottom - top}" rx="10" fill="${this.t.surface}" stroke="${this.t.rule}"/>`;
    return bottom;
  }

  render(height) {
    const t = this.t;
    const svg =
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="100%" role="img" aria-labelledby="t d">
<title id="t">${esc(this.title)}</title>
<desc id="d">${esc(this.desc)}</desc>
<style>.m{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.s{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}${this.motion.length ? `@media (prefers-reduced-motion:no-preference){${this.motion.join('')}}` : ''}</style>
<defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${t.grid}"/></pattern><clipPath id="c"><rect width="${W}" height="${height}" rx="14"/></clipPath></defs>
<g clip-path="url(#c)">
<rect width="${W}" height="${height}" fill="${t.bg}"/>
<rect width="${W}" height="${height}" fill="url(#g)"/>
${this.out.join('\n')}
</g>
<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="14" fill="none" stroke="${t.rule}"/>
</svg>
`;
    return svg;
  }
}

// ---------------------------------------------------------------- parts

const STATUS_STYLES = ['solid', 'half', 'outline'];

function statusChip(p, xRight, yMid, status, on = 'bg') {
  const style = data.statusStyles[status];
  if (!STATUS_STYLES.includes(style)) throw new Error(`status "${status}" has no style in statusStyles`);
  const t = p.t;
  const label = status.toUpperCase();
  const tw = monoW(label, SIZE.label, 1);
  const w = Math.round(36 + tw + 14), h = 38, x = xRight - w, y = yMid - h / 2;
  const solid = style === 'solid';
  p.raw(solid
    ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${t.chipFill}"/>`
    : `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="6" fill="${t[on]}" stroke="${t.secondary}" stroke-width="2"/>`);
  // Filled, half or hollow dot: the state never depends on colour alone.
  const ink = solid ? t.chipInk : t.text;
  p.raw(style === 'outline'
    ? `<circle cx="${x + 20}" cy="${yMid}" r="5" fill="none" stroke="${ink}" stroke-width="2"/>`
    : style === 'half'
      ? `<circle cx="${x + 20}" cy="${yMid}" r="5" fill="none" stroke="${ink}" stroke-width="2"/><path d="M${x + 20} ${yMid - 5}a5 5 0 0 1 0 10z" fill="${ink}"/>`
      : `<circle cx="${x + 20}" cy="${yMid}" r="6" fill="${ink}"/>`);
  p.text(x + 36 + tw / 2, yMid + 9, label, {
    anchor: 'middle', weight: 700, ls: 1, fill: solid ? 'chipInk' : 'text', on: solid ? 'chipFill' : on,
  });
  return w;
}

// Section header strip: the trace steps up off the rule into a node, then the label.
function header(p, index, label, sub, right) {
  p.raw(`<path d="M0 78.5H${W}" stroke="${p.t.rule}"/>`);
  p.trace('M0 78H40V46H60');
  p.node(60, 46);
  p.text(80, 55, [
    { str: `${index} / ${label.toUpperCase()}`, fill: 'accent', weight: 700, ls: 1 },
    { str: sub ? ` / ${sub.toUpperCase()}` : '', fill: 'muted', ls: 1 },
  ]);
  if (right?.status) statusChip(p, W - M, 46, right.status);
  else if (right?.text) p.text(W - M, 55, right.text, { anchor: 'end', fill: 'muted' });
  return 112;
}

function sectionLabel(p, x, top, str, on = 'bg') {
  p.raw(`<path d="M${x} ${top + 13}h14" stroke="${p.t.traceCase || p.t.trace}" stroke-width="3"/>`);
  p.text(x + 24, top + 22, str.toUpperCase(), { fill: 'accent', weight: 700, ls: 2, on });
  return top + 46;
}

// Technology mark: Simple Icons path when one is mapped, a neutral node otherwise.
function techIcon(p, x, y, name) {
  const slug = data.icons[name];
  const c = p.t.secondary;
  if (slug && !icons[slug]) throw new Error(`icon "${slug}" for "${name}" is not in data/icons.json`);
  p.raw(slug
    ? `<path transform="translate(${n(x)} ${n(y)})" fill="${c}" d="${icons[slug].path}"/>`
    : `<g transform="translate(${n(x)} ${n(y)})" fill="none" stroke="${c}" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 0v4M12 20v4M0 12h4M20 12h4"/></g>`);
}

function techItem(p, x, baseline, name, on) {
  techIcon(p, x, baseline - 21, name);
  return 34 + p.text(x + 34, baseline, name, { on });
}

// Lay technology items out left to right, wrapping. Returns the y below the last row.
function techFlow(p, x, top, max, names, on = 'bg') {
  const rowH = 44, gap = 30;
  let cx = x, row = 0;
  for (const name of names) {
    const w = 34 + monoW(name, SIZE.label);
    if (cx > x && cx + w > x + max) { cx = x; row++; }
    techItem(p, cx, top + 26 + row * rowH, name, on);
    cx += w + gap;
  }
  return top + (row + 1) * rowH;
}

function bullet(p, x, baseline) {
  p.raw(`<rect x="${x}" y="${baseline - 16}" width="10" height="10" fill="none" stroke="${p.t.secondary}" stroke-width="2"/>`);
}

// ---------------------------------------------------------------- panels

function hero(p) {
  const d = data.person;
  header(p, '01', 'Profile', null, { text: `github.com/${d.handle}` });
  p.text(M, 180, [
    { str: d.name, font: 'sans', size: SIZE.name, weight: 700 },
    { str: d.short, size: 27, weight: 700, fill: 'accent', ls: 3, dx: 20 },
  ]);
  p.text(M, 232, d.tagline, { font: 'sans', size: 29, max: CW });
  // location pin
  p.raw(`<g transform="translate(${M} 259)" fill="none" stroke="${p.t.secondary}" stroke-width="2" stroke-linejoin="round"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></g>`);
  p.text(M + 34, 280, d.location, { fill: 'muted' });

  // readout
  const bx = 440, by = 322, bw = W - M - bx, rows = data.inBuild.items;
  const bh = 78 + rows.length * 46 + 6;
  // a short dead-end stub, for schematic texture
  p.raw(`<path d="M0 372H60V332H170" fill="none" stroke="${p.t.rule}" stroke-width="2"/><circle cx="170" cy="332" r="4" fill="${p.t.bg}" stroke="${p.t.rule}" stroke-width="2"/>`);
  const pts = [[0, 480], [100, 480], [100, 400], [220, 400], [220, 520], [330, 520], [330, 440], [bx, 440]];
  p.trace('M' + pts.map((q) => q.join(' ')).join('L'));
  p.node(220, 520);
  p.card(bx, by, bw, bh);
  p.node(bx, 440, { filled: true });
  p.pulse(bx, 440, 'pulse');
  p.travel('pulse', pts, 8);

  const label = data.inBuild.label.toUpperCase();
  const lw = Math.round(monoW(label, SIZE.label, 2) + 28);
  p.raw(`<rect x="${bx + 24}" y="${by + 18}" width="${lw}" height="38" rx="6" fill="${p.t.chipFill}"/>`);
  p.text(bx + 24 + lw / 2, by + 46, label, { anchor: 'middle', weight: 700, ls: 2, fill: 'chipInk', on: 'chipFill' });
  const r0 = by + 78;
  // the marker steps through the rows; static state rests on the first
  p.raw(`<g class="mark"><rect x="${bx + 1}" y="${r0}" width="${bw - 2}" height="40" fill="${p.t.trace}" opacity="0.14"/><rect x="${bx + 1}" y="${r0}" width="6" height="40" fill="${p.t.traceCase || p.t.trace}"/></g>`);
  const stepPct = 100 / rows.length;
  const frames = rows.map((_, i) =>
    `${n(i * stepPct)}%,${n((i + 1) * stepPct - 4)}%{transform:translateY(${i * 46}px)}`).join('') + '100%{transform:translateY(0)}';
  p.motion.push(`@keyframes mark{${frames}}.mark{animation:mark ${rows.length * 3}s ease-in-out infinite}`);
  rows.forEach((name, i) => {
    const base = r0 + 29 + i * 46;
    p.text(bx + 24, base, String(i + 1).padStart(2, '0'), { fill: 'muted', on: 'surface' });
    p.text(bx + 76, base, name, { weight: 700, on: 'surface', max: bw - 76 - 16 });
  });
  return by + bh + 40;
}

function asSafa(p) {
  const d = data.builds.asSafa;
  let y = header(p, '02', 'Builds', d.name, { status: d.status });
  p.text(M, y + 44, d.name, { font: 'sans', size: SIZE.h2, weight: 700 });
  p.text(M, y + 84, d.role, { fill: 'muted', max: CW });
  y = p.para(M, y + 108, d.description) + 22;

  y = sectionLabel(p, M, y, 'Surfaces');
  const noteX = M + 34 + Math.max(...d.surfaces.map((s) => monoW(s.name, SIZE.label))) + 30;
  d.surfaces.forEach((s, i) => {
    const base = y + 24 + i * 40;
    bullet(p, M + 4, base);
    p.text(M + 34, base, s.name, { weight: 700 });
    p.text(noteX, base, s.note, { fill: 'muted', max: W - M - noteX });
  });
  y += d.surfaces.length * 40 + 24;

  y = sectionLabel(p, M, y, 'Architecture');
  const a = d.architecture, t = p.t;
  const top = y;
  y = p.cardAround(M, top, CW, () => {
    const wallX = 452, boxY = top + 72, boxH = 64;
    p.text(wallX, top + 44, a.title.toUpperCase(), { anchor: 'middle', weight: 700, ls: 1, on: 'surface', fill: 'accent' });
    // protected side
    p.raw(`<rect x="${M + 24}" y="${boxY}" width="290" height="${boxH}" rx="6" fill="${t.bg}" stroke="${t.secondary}" stroke-width="2"/>`);
    p.text(M + 24 + 145, boxY + 41, a.protected.toUpperCase(), { anchor: 'middle', weight: 700, on: 'bg', max: 270 });
    // the wall
    p.raw(`<rect x="${wallX - 7}" y="${boxY - 12}" width="14" height="${boxH + 24}" fill="${t.trace}"${t.traceCase ? ` stroke="${t.traceCase}" stroke-width="1.5"` : ''}/>`);
    // blocked side
    const hx = 600, hw = W - M - 24 - hx;
    p.raw(`<rect x="${hx}" y="${boxY}" width="${hw}" height="${boxH}" rx="6" fill="${t.bg}" stroke="${t.rule}" stroke-width="2"/>`);
    p.text(hx + hw / 2, boxY + 41, a.blocked.toUpperCase(), { anchor: 'middle', weight: 700, on: 'bg', max: hw - 20 });
    // a request leaves HR and stops at the wall
    const cy = boxY + boxH / 2, stopX = wallX + 26;
    p.raw(`<path d="M${hx} ${cy}H${stopX}" stroke="${t.text}" stroke-width="2" stroke-dasharray="6 6"/><path d="M${stopX - 8} ${cy - 8}l16 16M${stopX + 8} ${cy - 8}l-16 16" stroke="${t.text}" stroke-width="2.5"/>`);
    p.raw(`<circle class="req" cx="0" cy="${cy}" r="6" transform="translate(${hx - 14} 0)" fill="${t.text}"/>`);
    p.motion.push(`@keyframes req{0%{transform:translateX(${hx - 14}px);opacity:0}12%{opacity:1}62%{transform:translateX(${stopX + 22}px);opacity:1}78%,100%{transform:translateX(${stopX + 22}px);opacity:0}}.req{animation:req 5s ease-out infinite}`);
    return p.para(M + 24, boxY + boxH + 30, a.note, { size: SIZE.small, on: 'surface', max: CW - 48 }) + 22;
  }) + 28;

  y = sectionLabel(p, M, y, 'Stack');
  y = techFlow(p, M, y, CW, d.stack);
  return y + 30;
}

function lima(p) {
  const d = data.builds.lima;
  let y = header(p, '02', 'Builds', d.name, { status: d.status });
  p.text(M, y + 44, d.name, { font: 'sans', size: SIZE.h2, weight: 700 });
  p.text(M, y + 84, d.role, { fill: 'muted', max: CW });
  y += 116;
  y = sectionLabel(p, M, y, 'Capabilities');
  for (const c of d.capabilities) {
    bullet(p, M + 4, y + 26);
    y = p.para(M + 34, y, c, { max: CW - 34 }) + 6;
  }
  y += 22;
  y = sectionLabel(p, M, y, 'Stack');
  for (const s of d.stack) {
    techIcon(p, M, y + 2, s.tech);
    y = p.para(M + 34, y, s.text, { font: 'mono', size: SIZE.label, max: CW - 34, lh: 36 }) + 10;
  }
  return y + 26;
}

function productCards(p, y, products) {
  for (const prod of products) {
    const top = y;
    y = p.cardAround(M, top, CW, () => {
      const chipW = monoW(prod.status.toUpperCase(), SIZE.label, 1) + 50;
      statusChip(p, W - M - 20, top + 39, prod.status, 'surface');
      p.text(M + 24, top + 50, prod.name, { font: 'sans', size: SIZE.h3, weight: 700, on: 'surface', max: CW - 48 - chipW - 16 });
      let cy = p.para(M + 24, top + 72, prod.description, { size: SIZE.small, on: 'surface', max: CW - 48 });
      if (prod.stack.length) cy = techFlow(p, M + 24, cy + 8, CW - 48, prod.stack, 'surface');
      return cy + 20;
    }) + 16;
  }
  return y;
}

function cekapsys(p) {
  const d = data.builds.cekapsys;
  let y = header(p, '02', 'Builds', d.name);
  p.text(M, y + 44, d.name, { font: 'sans', size: SIZE.h2, weight: 700 });
  p.text(M, y + 84, d.role, { fill: 'muted', max: CW });
  y = p.para(M, y + 108, d.description) + 24;
  return productCards(p, y, d.products) + 24;
}

function client(p) {
  const d = data.builds.client;
  let y = header(p, '02', 'Builds', d.name, { text: d.note });
  return productCards(p, y + 4, d.products) + 24;
}

function delivery(p) {
  const d = data.delivery, t = p.t;
  let y = header(p, '03', 'Delivery');
  const x = 62, step = 68, y0 = y + 30;
  const pts = d.stages.map((_, i) => [x, y0 + i * step]);
  p.trace(`M${x} ${y0}V${pts[pts.length - 1][1]}`);
  d.stages.forEach((name, i) => {
    const [, cy] = pts[i];
    p.node(x, cy, { filled: i === d.stages.length - 1 });
    p.text(x + 34, cy + 9, String(i + 1).padStart(2, '0'), { fill: 'muted' });
    p.text(x + 86, cy + 9, name, { weight: 700, size: SIZE.body, max: 372 });
  });
  p.pulse(x, pts[pts.length - 1][1], 'pulse');
  p.travel('pulse', pts, 7);

  // the two environments, beside the stages that use them
  const e = d.environments, ex = 568, ew = W - M - ex, eh = 48;
  const ya = pts[e.afterStage - 1][1], yb = pts[e.afterStage][1];
  p.raw(`<path d="M${ex + ew / 2} ${ya + eh / 2}V${yb - eh / 2 - 9}" stroke="${t.text}" stroke-width="2"/><path d="M${ex + ew / 2 - 7} ${yb - eh / 2 - 12}l7 9l7-9" fill="none" stroke="${t.text}" stroke-width="2" stroke-linejoin="round"/>`);
  [[e.from, ya, t.rule], [e.to, yb, t.secondary]].forEach(([name, cy, stroke]) => {
    p.raw(`<rect x="${ex}" y="${cy - eh / 2}" width="${ew}" height="${eh}" rx="6" fill="${t.surface}" stroke="${stroke}" stroke-width="2"/>`);
    p.text(ex + ew / 2, cy + 9, name.toUpperCase(), { anchor: 'middle', weight: 700, ls: 1, on: 'surface', max: ew - 16 });
  });

  y = pts[pts.length - 1][1] + 52;
  p.raw(`<path d="M${M} ${y + 0.5}H${W - M}" stroke="${t.rule}"/>`);
  y += 26;
  y = sectionLabel(p, M, y, 'Tooling');
  const roleW = Math.max(...d.tooling.map((r) => monoW(r.role, SIZE.label)));
  d.tooling.forEach((r, i) => {
    const base = y + 26 + i * 44;
    p.text(M, base, r.role, { fill: 'muted' });
    techItem(p, M + roleW + 40, base, r.tool);
  });
  y += d.tooling.length * 44 + 14;
  y = p.para(M, y, d.note, { size: SIZE.small });
  return y + 30;
}

function scale(p) {
  let y = header(p, '04', 'Scale');
  const numX = 150, labelX = 190, max = W - M - labelX;
  data.scale.forEach((s, i) => {
    const lines = wrap(s.label, max, { font: 'sans', size: SIZE.body });
    const rowH = 96;
    if (i) p.raw(`<path d="M${M} ${y + 0.5}H${W - M}" stroke="${p.t.rule}"/>`);
    p.text(numX, y + 69, s.figure, { font: 'sans', size: SIZE.figure, weight: 700, fill: 'accent', anchor: 'end' });
    const lh = 38, top = y + rowH / 2 - (lines.length * lh) / 2;
    lines.forEach((line, j) => p.text(labelX, top + 27 + j * lh, line, { font: 'sans', size: SIZE.body, max }));
    y += rowH;
  });
  return y + 14;
}

function stack(p) {
  let y = header(p, '05', 'Stack') - 8;
  const itemX = 214;
  data.stack.forEach((row, i) => {
    if (i) p.raw(`<path d="M${M} ${y + 0.5}H${W - M}" stroke="${p.t.rule}"/>`);
    p.text(M, y + 40, row.layer.toUpperCase(), { fill: 'accent', weight: 700, ls: 1, max: itemX - M - 12 });
    y = techFlow(p, itemX, y + 14, W - M - itemX, row.items) + 14;
  });
  return y + 12;
}

function footer(p) {
  const c = data.footer.cta, t = p.t;
  const bx = 400, by = 28, bw = W - M - bx, bh = 104, cy = by + bh / 2;
  const pts = [[0, cy], [90, cy], [90, cy - 30], [200, cy - 30], [200, cy + 30], [310, cy + 30], [310, cy], [bx, cy]];
  p.trace('M' + pts.map((q) => q.join(' ')).join('L'));
  p.node(200, cy + 30);
  p.card(bx, by, bw, bh);
  p.node(bx, cy, { filled: true });
  p.pulse(bx, cy, 'pulse');
  p.travel('pulse', pts, 7);
  p.text(bx + 28, by + 44, c.label.toUpperCase(), { weight: 700, size: SIZE.body, ls: 2, fill: 'accent', on: 'surface', max: bw - 100 });
  p.text(bx + 28, by + 82, c.display, { on: 'surface', max: bw - 44 });
  // arrow
  p.raw(`<path d="M${bx + bw - 62} ${by + 35}h26m-10-9l10 9l-10 9" fill="none" stroke="${t.text}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`);
  return by + bh + 28;
}

// ---------------------------------------------------------------- build

const b = data.builds;
const list = (a) => a.join(', ');
const PANELS = [
  ['hero', hero,
    `${data.person.name} (${data.person.short}). ${data.person.tagline}. ${data.person.location}.`,
    `A gold signal trace runs along a schematic grid into a status readout. ${data.inBuild.label}: ${list(data.inBuild.items)}.`],
  ['build-as-safa', asSafa,
    `${b.asSafa.name}: ${b.asSafa.status}`,
    `${b.asSafa.description} Surfaces: ${list(b.asSafa.surfaces.map((s) => `${s.name} (${s.note})`))}. ${b.asSafa.architecture.title}: ${b.asSafa.architecture.note} Stack: ${list(b.asSafa.stack)}.`],
  ['build-lima', lima,
    `${b.lima.name}: ${b.lima.status}`,
    `${b.lima.role} ${list(b.lima.capabilities)}. Stack: ${list(b.lima.stack.map((s) => s.text))}.`],
  ['build-cekapsys', cekapsys,
    `${b.cekapsys.name} products`,
    `${b.cekapsys.description} ${b.cekapsys.products.map((x) => `${x.name} (${x.status}): ${x.description}`).join(' ')}`],
  ['build-client', client,
    'Client work',
    b.client.products.map((x) => `${x.name} (${x.status}): ${x.description}`).join(' ')],
  ['delivery', delivery,
    'Delivery pipeline',
    `${data.delivery.stages.join(', then ')}. ${data.delivery.tooling.map((r) => `${r.role}: ${r.tool}`).join('. ')}. ${data.delivery.note}`],
  ['scale', scale,
    'Scale',
    data.scale.map((s) => `${s.figure} ${s.label}`).join('. ') + '.'],
  ['stack', stack,
    'Stack by layer',
    data.stack.map((r) => `${r.layer}: ${list(r.items)}`).join('. ') + '.'],
  ['footer', footer,
    `${data.footer.cta.label}: ${data.footer.cta.display}`,
    `A gold signal trace resolves into a call to action. ${data.footer.cta.label} at ${data.footer.cta.display}.`],
];

mkdirSync(OUT, { recursive: true });
const sizes = [];
for (const [id, draw, title, desc] of PANELS) {
  for (const themeName of Object.keys(THEMES)) {
    const p = new Panel(id, themeName, title, desc);
    const height = Math.ceil(draw(p));
    const svg = p.render(height);
    const bytes = Buffer.byteLength(svg);
    if (bytes > MAX_BYTES) problems.push(`${id}-${themeName}.svg is ${bytes} bytes, over ${MAX_BYTES}`);
    writeFileSync(join(OUT, `${id}-${themeName}.svg`), svg);
    sizes.push([`${id}-${themeName}.svg`, bytes, height]);
  }
}

console.log('Contrast (text on background, minimum 4.5:1)');
for (const [key, v] of [...contrastSeen].sort()) {
  console.log(`  ${v.r >= MIN_CONTRAST ? 'pass' : 'FAIL'}  ${v.r.toFixed(2).padStart(5)}:1  ${key.padEnd(28)} ${v.fg} on ${v.bg}`);
}
// The stated palette rules, checked directly so the reasoning stays visible.
console.log('Palette rules');
for (const [fg, bg, expect] of [['gold', 'green', true], ['cream', 'green', true], ['leaf', 'green', true], ['gold', 'cream', false], ['leaf', 'cream', false], ['green', 'gold', true]]) {
  const r = ratio(PALETTE[fg], PALETTE[bg]);
  const ok = (r >= MIN_CONTRAST) === expect;
  console.log(`  ${ok ? 'as expected' : 'UNEXPECTED '}  ${r.toFixed(2).padStart(5)}:1  ${fg} on ${bg}: ${expect ? 'usable as text' : 'fill, rule or indicator only'}`);
  if (!ok) problems.push(`palette rule changed: ${fg} on ${bg} is ${r.toFixed(2)}:1`);
}
console.log('Files');
for (const [name, bytes, height] of sizes) console.log(`  ${name.padEnd(28)} ${(bytes / 1024).toFixed(1).padStart(5)} KB  ${W}x${height}`);

if (problems.length) {
  console.error(`\nBuild failed: ${problems.length} problem(s)`);
  for (const m of [...new Set(problems)]) console.error('  - ' + m);
  process.exit(1);
}
console.log(`\nBuilt ${sizes.length} files into assets/`);
