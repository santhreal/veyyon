# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/kernel` is a workspace member: the loader, the contribution registry and the session spine, moved out of `@veyyon/coding-agent` unchanged. It names no tool, no host and no mode, and `scripts/the-kernel-names-no-tool-and-no-host.test.ts` fails on the first edge that does.
- `@veyyon/kernel/session/*` publishes the session spine: entries, storage backends, persistence, migrations, listing, paths, retry policy, compaction policy, machine budget and the turn's owned resources.
- `@veyyon/kernel/loader/*` publishes plugin discovery, manifest parsing, the installed registry, the marketplace client and load-failure reporting.
- `@veyyon/kernel/registry/*` publishes the contribution surface a plugin is resolved through: the tool proxy, the tool event input, the widget and host-view declarations, and the TypeBox schema conversion.
- `@veyyon/kernel/registry/tool-domain` declares `ToolDomainManifest`, the name and lazy-factory table a tool domain contributes, so a host reads a domain's tools without depending on the coding agent.
