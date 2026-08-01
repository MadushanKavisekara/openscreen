# Icon sources

Authored icon artwork lives here. Everything under `icons/icons/` is **generated** from
these files — edit the sources, then regenerate:

```bash
npm run icons:generate
```

## Files

| File | Purpose | Required |
|---|---|---|
| `AppIcon.icon` | Icon Composer project. Compiled into a Liquid Glass asset catalog at package time. | Optional |
| `AppIcon.icns` | Icon Composer → File → Export. The source of truth for every generated raster. | Yes (or `AppIcon.png`) |
| `AppIcon.png` | Flat 1024×1024 fallback if there's no `.icns`. Converted to `.icns` locally. | Alternative |
| `logo.svg` | Vector wordmark/mark used in the renderer UI. | — |

## What gets generated

`npm run icons:generate` (macOS only — it uses `sips` and `iconutil`) writes:

- `icons/icons/mac/icon.icns` — copied verbatim from `AppIcon.icns` so Apple's own
  representations survive
- `icons/icons/win/icon.ico` — 16/24/32/48/64/128/256
- `icons/icons/png/` — 16 through 1024, for `linux.icon`

`public/screenly.png` (the menu bar icon) is authored separately and is **not** generated
here — a scaled-down app icon reads as a blue blob at 16px.

## Liquid Glass on macOS 26

A `.icns` only holds flat bitmaps, so the Dock cannot re-render it for the dark, clear and
tinted appearance modes. For that macOS needs a compiled `Assets.car` plus `CFBundleIconName`,
which is what `scripts/after-pack-icon.cjs` produces from `AppIcon.icon` during
`electron-builder`'s `afterPack` phase.

That compile step needs `actool`, which ships **only with full Xcode** — the Command Line
Tools alone are not enough. The hook is best-effort: if `AppIcon.icon` is missing, `actool`
isn't installed, or the compile fails, it logs and moves on, and the app ships the static
`.icns`. Builds never fail because of it.

To enable the dynamic icon:

```bash
xcode-select --print-path   # should be inside Xcode.app, not /Library/Developer/CommandLineTools
```

If it points at the Command Line Tools, install Xcode and repoint it
(`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`), then rebuild.
