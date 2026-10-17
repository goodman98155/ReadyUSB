# ReadyUSB branding: "Lantern + Plug"

The mark is a lantern with a warm amber flame, topped by a USB connector: light and knowledge
when the power is out, carried on a USB drive.

## Files

| File | Use |
|---|---|
| `readyusb-icon.svg` | App icon: white mark on a green rounded tile. The main logo. |
| `readyusb-icon-180/192/512.png` | The same as PNG (Apple touch icon 180, Android/manifest 192 and 512). |
| `readyusb-favicon.svg` | Browser tab icon. Simplified for 16–48 px: the plug is solid, with no holes. |
| `readyusb-favicon-16/32/48.png` | The same as PNG. |
| `readyusb-mark-green.svg` | The mark alone, green, transparent background (light backgrounds). |
| `readyusb-mark-white.svg` | The mark alone, white, transparent background (green or dark backgrounds). |
| `readyusb-lockup.svg` | Icon tile + "ReadyUSB" wordmark, for light backgrounds. |
| `readyusb-lockup-dark.svg` | Mint mark + wordmark, for dark backgrounds. |

## Colors

| Name | Hex | Where |
|---|---|---|
| Green (brand) | `#2f6b4f` | Tile, "USB" in the wordmark, accent in the app (`--accent`) |
| Flame amber | `#f2b54a` | The flame. Always amber, on every background |
| Ink | `#1d2725` | "Ready" in the wordmark on light backgrounds |
| Paper | `#f6f4ef` | Light background (`--bg`), "Ready" on dark backgrounds |
| Mint | `#8fd3ae` | The mark and "USB" on dark backgrounds |
| Night | `#1a2220` | Dark background |

## Wordmark

"Ready" in bold (700), "USB" in extra-bold (800) brand green, with tight letter spacing (about −2.5%).
The lockup SVGs use the system font stack to match the app's no-web-fonts rule, so the wordmark
looks slightly different on Windows (Segoe UI) and Mac (San Francisco). For print or a fixed look,
convert the text to outlines in a vector editor.

## Integrating into the app (notes for Claude in VS Code)

- Keep all of these files in `branding/`. That folder is for the repo; it doesn't need to ship on the
  drive. Copy only what the app uses into `viewer/`.
- **Favicon:** replace the inline data-URI `<link rel="icon">` in `START HERE.html` with the contents
  of `readyusb-favicon.svg` as a data URI. Keep it inline: no extra file request on `file://`.
- **Header brand mark:** replace the open-book `<svg>` inside `.brand-mark` in `START HERE.html`
  with the mark paths from `readyusb-mark-white.svg` (viewBox `14 3 36 57`). Use solid fills and
  strokes, not the app's generic `svg { stroke: currentColor }` style, which would override them.
- The amber flame color can become a CSS token (for example `--flame: #f2b54a`) if it's reused.
