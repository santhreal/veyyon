Drives real Chromium tab; full puppeteer access via JS.

<instruction>
- Static content (articles, docs, issues/PRs, JSON, PDFs, feeds)? `read` the URL. Browser only for JS execution, auth, interactive actions.
- Four actions:
  - `open` — acquire/reuse named tab (`name` defaults `"main"`). Optional `url` (navigate once ready; the result carries the page's `tab.ariaSnapshot()` when it is 6,000 chars or less: act on its refs, no second read), `viewport`, `dialogs: "accept" | "dismiss"` (auto-handle `alert`/`confirm`/`beforeunload`; else page hangs till you wire `page.on('dialog', …)`). Headless only: `context` (tabs naming it share cookies/storage, isolated from others — e.g. one per user role), `storage_state` (state file loaded before navigating).
  - `close` — release tab by `name`, or all with `all: true`. `kill: true` also kills spawned-app process trees.
  - `run` — execute JS in existing tab. `code` = async function body; `page`, `browser`, `tab`, `display`, `assert`, `wait` in scope. `wait(ms)` sleeps; `wait(fn, { timeout?, interval? })` polls `fn` until truthy and returns its value (100ms interval; deadline min(30s, cell budget − 1s)) — use it instead of polling inside `tab.evaluate`.
  - `save_state` — write the tab context's cookies + localStorage to `storage_state` (required). It holds live credentials: keep it out of git.
- Tabs survive `run` calls and in-process spawned agents — open once, reuse.
- Browser kinds (`app` on `open`):
  - default (no `app`) → headless Chromium with stealth patches.
  - `app.path` → spawn absolute binary (Electron/CDP). No stealth patches — NEVER tamper with a real desktop app.
  - `app.cdp_url` → connect to existing CDP endpoint (e.g. `http://127.0.0.1:9222`).
  - `app.target` (with `path`/`cdp_url`) — substring on url+title picks BrowserWindow.
- `tab` helpers; drop to raw puppeteer `page` for anything uncovered:
  - `tab.goto(url, { waitUntil? })` — navigate. A hung load fails ~1s before the cell budget with a named error and the navigation stopped; for slow pages raise `timeout` or use `waitUntil: "domcontentloaded"`.
  - `tab.observe({ includeAll?, viewportOnly? })` — accessibility snapshot: `{ url, title, viewport, scroll, elements: [{ id, role, name, value, states, … }] }`. Ids stable until next observe/goto.
  - `tab.ariaSnapshot(selector?, { depth?, boxes? })` — Playwright-format ARIA YAML (roles, names, `/url`, `/placeholder`) of `selector` or the document; each node has a `[ref=eN]`, `[cursor=pointer]` marks clickables. Refs renumber each call and stay valid until the next.
  - `tab.ref("e5")` — ref from the last ariaSnapshot → element handle (`.click()`, `.type()`, `.fill()`, `.hover()`, `.evaluate()`, …); inline as `aria-ref=e5` in `tab.click`/`type`/`fill`/`waitFor`/`scrollIntoView`.
  - `tab.id(n)` — id from last observe → element handle with the same action methods.
  - `tab.click(selector)` / `tab.type(selector, text)` / `tab.fill(selector, value)` / `tab.press(key, { selector? })` / `tab.scroll(dx, dy)`. `fill` replaces the value as one real edit frameworks see; `type` sends keystrokes.
  - `tab.waitFor(selector, { timeout? })` / `tab.waitForSelector(selector, { timeout?, visible?, hidden? })` — wait until attached (optionally visible/hidden); returns an action-method handle.
  - `tab.drag(from, to)` — endpoints: selector (center-to-center) or `{ x, y }` viewport point (canvases, sliders).
  - `tab.scrollIntoView(selector)` — center in viewport; before clicking off-screen elements.
  - `tab.select(selector, …values)` — set `<select>` option(s); returns selection. `tab.fill` NEVER works for selects.
  - `tab.uploadFile(selector, …filePaths)` — attach files to `<input type="file">`; paths relative to cwd.
  - `tab.waitForUrl(pattern, { timeout? })` — substring or `RegExp` (matches SPA pushState nav); returns matched URL.
  - `tab.waitForResponse(pattern, { timeout? })` — substring, `RegExp`, or `(response) => boolean`; returns puppeteer `HTTPResponse` (`.text()`/`.json()`/`.status()`/`.headers()`).
  - `tab.waitForNavigation({ waitUntil?, timeout? })` — resolves on the next navigation. Start it BEFORE the click/submit that triggers it; after `tab.goto` (which already waits) use `tab.waitForUrl`/`tab.waitForSelector` instead.
  - `tab.evaluate(fn, …args)` — run ad-hoc code in the page's MAIN world. DOM and page-defined globals (`window.myFlag`) are visible; mutations affect the page.
  - `tab.screenshot({ selector?, fullPage?, save?, silent? })` — capture + attach for viewing (`silent: true` skips). Pass `save` only when a later step needs the file.
  - `tab.extract(format = "markdown")` — readable page content (`"markdown"` | `"text"`); throws when nothing readable.
  - `tab.storageState({ path? })` / `tab.loadStorageState(stateOrPath)` — save/load the context's cookies + localStorage (object or file).
- Selectors: CSS + puppeteer handlers `aria/Sign in`, `text/Continue`, `xpath/…`, `pierce/…`; also Playwright-style `p-aria/…`, `p-text/…`. Playwright-only engines/pseudos (`:has-text()`, `:visible`, …) are rejected — use `text/…` or `aria/…`. A stalled action fails fast with a named `tab.<op>` error and a match count; a selector matching nothing fails in ~2s (give `waitFor`/`waitForSelector` a `{ timeout }` for slow elements). A cell timeout names the stalled op and any dialog blocking the page.
</instruction>

<critical>
- MUST `open` before `run` — `run` never creates a tab.
- Default to `tab.observe()` for page state — structured data, actionable ids. Screenshot ONLY when appearance matters.
- Every call re-sends the whole conversation: in one `run`, act and return what the next step needs (a value, or `tab.ariaSnapshot(selector)` of the part that changed). Navigation invalidates element ids and refs.
- `code` runs with full Node access. Treat as your code, not sandboxed.
</critical>

<output>
Per call: `display(value)` output, then `code`'s return value; objects and arrays as compact JSON. `run` always produces at least a status line.
</output>
