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
| `MenuBarIcon.svg` | The macOS menu bar mark. Flat white silhouette — see below. | Yes (macOS) |
| `logo.svg` | Vector wordmark/mark used in the renderer UI. | — |

## What gets generated

`npm run icons:generate` (macOS only — it uses `sips` and `iconutil`) writes:

- `icons/icons/mac/icon.icns` — copied verbatim from `AppIcon.icns` so Apple's own
  representations survive
- `icons/icons/win/icon.ico` — 16/24/32/48/64/128/256
- `icons/icons/png/` — 16 through 1024, for `linux.icon`

The menu bar icon is a separate pipeline, because a scaled-down app icon reads as a blue
blob at 16px:

```bash
npm run icons:menubar
```

writes `public/screenlyTemplate.png` (16×16) and `public/screenlyTemplate@2x.png` (32×32)
from `MenuBarIcon.svg`.

These are macOS **template images**: the system draws them from their alpha channel alone,
tinting for the light or dark menu bar and inverting while the menu is open. So the source
is a flat white silhouette, and giving it a fixed colour would make it invisible in one of
the two appearances. `electron/main.ts` marks them with `setTemplateImage(true)` and does
not resize them — `nativeImage` picks the `@2x` file up from the same path.

`public/screenly.png` is the colour mark the Windows and Linux trays use; those do no
tinting of their own. It is authored by hand and **not** generated here.

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
