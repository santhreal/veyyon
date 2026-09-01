# @veyyon/web

Site scrapers that turn a URL into markdown.

Eighty site handlers (GitHub, crates.io, arXiv, YouTube, Reddit, PyPI and the rest), the page
loader that escalates through three user agents when a site answers as though it is talking to a
bot, and a client for Parallel's extract API.

## Install

```sh
bun add @veyyon/web
```

## Use

`specialHandlers` is the ordered list the dispatcher walks. A handler returns a `RenderResult` for a
URL it claims, `null` for one it declines, and a `ScraperDegrade` when it claims a URL and cannot
scrape it, which tells the caller to fall back to a generic fetch and states why.

```ts
import { specialHandlers } from "@veyyon/web/scrapers";

for (const handler of specialHandlers) {
	const result = await handler("https://crates.io/crates/serde", 10);
	if (result) console.log(result);
}
```

Four handlers need something the process around them owns: a credential store, a document
converter, a managed external binary, and the configured fetch provider. Pass a `ScrapeServices`
object as the fourth argument to supply them; a handler that needs one and is given nothing reports
that rather than reaching for a global.

A cancelled signal raises an error whose `name` is `AbortError` or `TimeoutError`, so
`isCancellation` from `@veyyon/utils` recognizes it and the abort reason survives on `cause`.
