#!/usr/bin/env node
// Optional visual check. Not needed to build the profile.
// Renders every SVG in assets/ to PNG at desktop and phone widths, in the static
// (reduced-motion) state, and measures the real text boxes in a browser.
//
// Needs Playwright with Chromium available on the machine:
//   node scripts/preview.mjs [output-dir]      (default: ./preview, git-ignored)

import { readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const OUT = resolve(process.argv[2] || join(ROOT, 'preview'));
const WIDTHS = [840, 375];
const MIN_PX = 11;

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is not installed. This check is optional; see docs/MAINTAINING.md.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const files = readdirSync(ASSETS).filter((f) => f.endsWith('.svg')).sort();
const browser = await chromium.launch();
const problems = [];

for (const file of files) {
  const url = pathToFileURL(join(ASSETS, file)).href;
  const dark = file.includes('-dark');

  // 1. Measure real text geometry in the SVG document itself.
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto(url);
  const report = await page.evaluate(() => {
    const svg = document.documentElement;
    const vb = svg.viewBox.baseVal;
    const out = [];
    for (const t of svg.querySelectorAll('text')) {
      const b = t.getBBox();
      const sizes = [t, ...t.querySelectorAll('tspan')]
        .map((e) => parseFloat(e.getAttribute('font-size')))
        .filter(Boolean);
      out.push({ text: t.textContent, left: b.x, right: b.x + b.width, min: Math.min(...sizes) });
    }
    return { width: vb.width, height: vb.height, texts: out };
  });
  for (const t of report.texts) {
    if (t.left < 12 || t.right > report.width - 12) problems.push(`${file}: "${t.text}" reaches the panel edge (${t.left.toFixed(0)}..${t.right.toFixed(0)})`);
    const px = (t.min * 375) / report.width;
    if (px < MIN_PX) problems.push(`${file}: "${t.text}" renders at ${px.toFixed(1)}px on a 375px column`);
  }
  await page.close();

  // 2. Render the static state at each width. The SVG is opened as a document,
  //    because reduced-motion emulation does not reach an SVG inside <img>.
  for (const width of WIDTHS) {
    const height = Math.ceil((width * report.height) / report.width);
    const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await p.goto(url);
    await p.evaluate((bg) => { document.documentElement.style.background = bg; }, dark ? '#0d1117' : '#ffffff');
    await p.screenshot({ path: join(OUT, `${file.replace('.svg', '')}-${width}.png`) });
    await p.close();
  }
}

await browser.close();
if (problems.length) {
  console.error(`${problems.length} problem(s):`);
  for (const m of problems) console.error('  - ' + m);
  process.exit(1);
}
console.log(`Rendered ${files.length * WIDTHS.length} previews into ${OUT}. Text boxes and sizes are within limits.`);
