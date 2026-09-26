# Oxytocin brand assets

| Folder | Contents |
|---|---|
| `svg/` | Master artwork: app icon (`app-icon.svg`, 16 px `app-icon-small.svg`), mark and horizontal/stacked logos for dark and light backgrounds, `favicon.svg`. |
| `png/icon/` | App icon rasterized at 16–1024 px. |
| `png/logo/` | Marks (256/512/1024) and logos (@2x/@4x) for dark and light backgrounds. |
| `ico/` | `Oxytocin.ico` (16–256 px, Windows executable/installer/window icon) and `favicon.ico`. |

Where they are used:

- `resources/build/icon.ico` / `icon.png` — packaged application icons (electron-builder).
- `resources/icons/` — window/taskbar icon at runtime (copied into the package as `resources/icons`).
- `src/renderer/src/assets/brand/` — title bar icon, welcome screen logo and favicon; `*-on-light` variants are for the light theme (M7).
