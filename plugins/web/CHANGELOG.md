# Changelog

## [Unreleased]

### Added

- The site scrapers behind the `fetch` tool are their own package: 79 site handlers, the shared page loader and the Parallel extraction client, moved out of `@veyyon/coding-agent` unchanged.
- A scraper states the host capabilities it needs through `ScrapeServices` — the credential store, document conversion, external-tool resolution, the session spawn hook and the fetch-provider preference — instead of importing the agent's settings, storage and process modules.
