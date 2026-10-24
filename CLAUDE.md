# Sentinels site

Static site on GitHub Pages (sentinels.com.mx, repo JESALAZARE/SENTINELS, public). No server.

- `index.html` — marketing homepage (Formspree contact form).
- `client-portal/index.html` — client portal (English UI).
- `client-portal/admin.html` — admin panel (Spanish UI); publishes to GitHub via the API.
- `client-portal/board.js` — customizable Dashboard / My Contract widget boards.
- `client-portal/sentinel-one.js` + `sentinel-one/worker.js` — "Sentinel One" AI assistant (Claude Haiku 5.5 via a Cloudflare Worker that holds the API key, checks an HMAC pass, caps spend per client/month and stores the client's encrypted chat state). Setup steps: `sentinel-one/LEEME.md`. The Worker is pasted into the Cloudflare dashboard, so it uses plain `fetch` (no build step).
- `client-portal/crypto.js` — shared AES-GCM/PBKDF2 helpers. Everything under `client-portal/data/` is encrypted and public; never write plaintext client data there or in commit messages.

## Every page must work on phone, tablet and desktop
- Breakpoints: `1180px` (tablet landscape), `900px`/`860px` (tablet: sidebars become drawers, grids collapse), `600px` (phone).
- At ≤600px: 16px side padding, single-column grids, full-width primary buttons, inputs `font-size:16px` (prevents iOS zoom) and ≥44px tall, dialogs as bottom sheets with `max-height: calc(100dvh - 24px); overflow-y: auto`.
- No horizontal page scroll: check `document.documentElement.scrollWidth === clientWidth` at 375px; wide tables/filter rows scroll inside their own container.
- Use `100dvh` (with a `100vh` fallback) for full-height layouts.
- Verify new UI at 375×812, 768×1024 and 1366×850 before committing.

## Security conventions
- Each page keeps its `<meta http-equiv="Content-Security-Policy">`, `referrer` meta and the HTTPS/frame-guard script in `<head>`; add any new external origin to the CSP explicitly.
- Escape all user/admin-provided text before inserting HTML (`_esc` / `esc`).
- Third-party scripts need a pinned version and an SRI `integrity` hash.
