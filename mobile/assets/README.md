# App identity

`icon-master.png` is the approved high-resolution concept master: a borderless,
cyan/blue rising-arrow monogram and signal arcs on a quiet grid canvas.
Run `npm run build:icons` from the repository root after editing it.

The generator exports the opaque 1024 × 1024 `icon.png`, the matching checked-in
Xcode AppIcon used by EAS/TestFlight, a 64px favicon, and a 180px Apple touch icon.
The app icon has full-bleed white corners because iOS applies the outer corner mask.
The browser favicon has transparent rounded corners (14px radius at 64px),
so the white tile blends into browser chrome without a border.
Expo's web export converts `favicon.png` to `favicon.ico`; the export script also
links the Apple touch icon for website bookmarks. Web exports link a content-hashed
favicon filename so artwork changes get a fresh browser cache entry. Generated assets are committed
so builds do not depend on running the generator first.

The gradient icon was published to `internnotifs.app` in Pages deployment
`511ade16` on 2026-09-07. This icon-only deployment preserved all 27 existing
non-shell asset hashes from production deployment `10b7a6ea`; only the HTML icon
links and three icon files changed. The next full web deployment must include
the icon assets and export-script changes from this workspace.

Deployment `7e386625` on 2026-09-07 replaced the framed artwork with the owner's
requested borderless, solid-white version, preserving the gradient N and arcs.
