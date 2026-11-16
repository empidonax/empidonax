# Maintaining this profile

The profile is a small build. Content lives in one JSON file, a script turns it into SVG panels, and `README.md` arranges the panels with the same content as plain text.

```
data/profile.json    all copy, products, stack, figures, links, status labels
data/icons.json      technology marks (Simple Icons path data, CC0)
scripts/build.mjs    writes every panel to assets/ in dark and light
scripts/preview.mjs  optional visual check (needs Playwright)
assets/              generated SVGs, committed
README.md            written by hand around the assets
```

## Update and rebuild

1. Edit `data/profile.json`.
2. Run the build. It needs Node 18 or later and nothing else.

```bash
node scripts/build.mjs
```

3. If the change affects text that also appears in `README.md` (a status, a description, a new product), update the README to match. The README text is what search engines and screen readers get, so it must agree with the panels.
4. Commit `data/`, `assets/` and `README.md` together.

## Common changes

**Change a status.** Set the `status` field on the entry. The value must be a key in `statusStyles`, which maps each label to a chip style: `solid` (gold fill, filled dot), `half` (outline, half dot) or `outline` (outline, hollow dot). Add a new label by adding a key there.

**Add a product.** Append an object to `builds.cekapsys.products` or `builds.client.products` with `name`, `status`, `description` and `stack` (an array, which may be empty). Panel heights adjust on their own.

**Change the readout in the hero.** Edit `inBuild.items`.

**Add a technology.** Add its name to a `stack` array. If Simple Icons has a mark for it, copy the icon's `title` and `path` into `data/icons.json` under its slug and map the display name to that slug in the `icons` object of `profile.json`. Names with no mapping get a neutral node glyph.

**Change a figure.** Edit `scale`. Use confirmed numbers only.

## What the build checks

The build exits with an error and a list of problems when:

- a text and background pair is under 4.5:1 contrast (WCAG AA). The log prints every pair it used and its ratio;
- text is smaller than 25 viewBox units, which is 11px when a panel is scaled to a 375px phone column;
- a line of text is estimated to overflow its box or the panel. Widths are estimated for the widest font in each fallback stack, so a pass holds on machines without the first-choice font;
- an SVG is over 100 KB.

If a new description fails the overflow check, shorten it. The layout wraps paragraphs, but names, labels and chips stay on one line.

## Design rules

- Palette: gold `#FFC52D`, deep green `#0E3A1F`, cream `#F7F4E6`, leaf green `#7BAA66`. Every other colour is a mix of these, defined once in `THEMES` at the top of the build script.
- Gold and cream are text colours on deep green. On cream, gold and leaf green are fills, rules and indicators only. Text there is deep green.
- A state is never shown by colour alone. Status chips carry a text label and a dot shape.
- Fonts are system stacks. An SVG shown through `<img>` cannot load fonts, images or scripts.
- Motion sits inside `@media (prefers-reduced-motion: no-preference)`, uses transform and opacity only, and each panel is complete without it.
- No third-party widgets, badges or requests. GitHub strips `<style>`, `<script>` and `class` from README HTML, so all styling lives inside the SVG files and themes switch through `<picture>`.

## Optional visual check

`scripts/preview.mjs` renders each panel to PNG at 840px and 375px in its static state and measures the real text boxes in Chromium. It needs Playwright installed on the machine and is not part of the build.

```bash
node scripts/preview.mjs
```

Output goes to `preview/`, which is git-ignored.

## Credits

Technology marks use path data from [Simple Icons](https://simpleicons.org) (CC0 1.0), recoloured to the palette. The marks remain trademarks of their owners.
