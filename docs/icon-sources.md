# ShiroBird icons — NetBird visual parity

ShiroBird uses **the same icon libraries** as NetBird's official Traffic Events
dashboard, rather than approximating their shapes with handwritten glyphs.

The SVG artwork is vendored locally under `web/icons/` so browsers make no
requests to a third-party icon CDN. The application accepts only an explicit
allowlist of icon names. Operating systems are determined from the actual
NetBird peer metadata, never guessed from a peer name.

| Icon | Upstream library also used by NetBird | Source and license |
|---|---|---|
| Windows | `react-icons/fa6` / Font Awesome Brands | [Font Awesome](https://github.com/FortAwesome/Font-Awesome/blob/7.x/svgs/brands/windows.svg) — CC BY 4.0, copyright Fonticons, Inc. |
| Linux, Android | `react-icons/fc` / Icons8 Flat Color Icons | [Flat Color Icons](https://github.com/icons8/flat-color-icons) — Apache 2.0 |
| macOS, iOS | Brand silhouettes matching the upstream system marks | [Simple Icons](https://github.com/simple-icons/simple-icons) — CC0; used as independently licensed equivalent Apple/iOS vector silhouettes |
| Resource, unknown OS, Share2 protocol | Lucide React | [Lucide](https://github.com/lucide-icons/lucide) — ISC |
| Received, sent | Lucide React ArrowDown / ArrowUp | [Lucide](https://github.com/lucide-icons/lucide) — ISC; same paths are rendered inline with inherited CSS color |
| Sort ascending, sort descending | Tabler React Icons | [Tabler Icons](https://github.com/tabler/tabler-icons) — MIT; same paths rendered inline |

Upstream NetBird itself is licensed under AGPL-3.0. No upstream NetBird
proprietary assets, fonts, compiled bundles or code from its AGPL components
are redistributed in these icon files.

Traffic arrows indicate **RX/TX from the reporting peer's perspective**,
matching NetBird's `TrafficEventsBytesCell`. A missing OS stays an unknown peer
instead of showing a fabricated Windows/macOS/Linux icon.

Font Awesome free icons attribution: Font Awesome Free by Fonticons, Inc.
([license](https://fontawesome.com/license/free)).
