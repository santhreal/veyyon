# Changelog

## [Unreleased]

### Added

- The site scrapers behind the `fetch` tool are their own package: 79 site handlers, the shared page loader and the Parallel extraction client, moved out of `@veyyon/coding-agent` unchanged.
- A scraper states the host capabilities it needs through `ScrapeServices` — the credential store, document conversion, external-tool resolution, the session spawn hook and the fetch-provider preference — instead of importing the agent's settings, storage and process modules.

### Changed
- Array copies that allocated with a spread now use `.slice()`, `.concat()` or `Array.from()`. No user-visible behavior changes.
- The Hugging Face handler fetches a model, dataset or space record and its README through one `loadHfResource`, and the YouTube handler downloads the manual and auto-generated subtitle tracks through one `downloadSubtitleText`; no behavior change.

- Consolidated specialized web scraper site handlers into parameterized domain engines and declarative site definitions.
- The Discourse handler trims its base path with `trimTrailingSlashes` from `@veyyon/utils/url` rather than its own inline strip. No user-visible behavior changes.
- Business, media, documentation, discussion and security-advisory handlers share dispatch without changing host matching or scrape results.
- Package-registry scrapers share Markdown section assembly without changing rendered results.
- Academic-paper, license and discussion scrapers share PDF conversion and Markdown assembly without changing site-specific output.
- Package-registry, academic-paper and declarative scrapers omit unused metadata fallbacks while preserving request headers and failure handling.
- Package-registry and academic-paper handlers share URL dispatch while preserving callback receivers and request-local notes.
