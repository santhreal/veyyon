# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/kernel` is a workspace member: the loader, the contribution registry and the session spine, moved out of `@veyyon/coding-agent` unchanged. It names no tool, no host and no mode, and `scripts/the-kernel-names-no-tool-and-no-host.test.ts` fails on the first edge that does.
- `@veyyon/kernel/session/*` publishes the session spine: entries, storage backends, persistence, migrations, listing, paths, retry policy, compaction policy, machine budget and the turn's owned resources.
- `@veyyon/kernel/loader/*` publishes plugin discovery, manifest parsing, the installed registry, the marketplace client and load-failure reporting.
- `@veyyon/kernel/registry/*` publishes the contribution surface a plugin is resolved through: the tool proxy, the tool event input, the widget and host-view declarations, and the TypeBox schema conversion.
- `@veyyon/kernel/registry/tool-domain` declares `ToolDomainManifest`, the name and lazy-factory table a tool domain contributes, so a host reads a domain's tools without depending on the coding agent.
- `@veyyon/kernel/registry/message-kind` declares `AgentMessageKind`, a transcript role a tool domain records with its conversion to provider messages and to text, and `ToolDomainManifest.messageKinds` carries a domain's kinds; `@veyyon/kernel/session/message-kinds` is the role-keyed table the session spine converts them through, which throws on a role no domain declared and on a second kind for one role.
- `@veyyon/kernel/session/session-manager`, `session-context`, `session-loader` and `agent-storage` publish the session manager, its context builder, its file loader and the credential store, moved from `@veyyon/coding-agent/session/*` unchanged; `session/custom-message-payload` publishes the custom-message payload normaliser and the rehydration sanitiser they call.

### Changed

- Array copies that allocated with a spread now use `.slice()`, `.concat()` or `Array.from()`. No user-visible behavior changes.
- `@veyyon/kernel/session/session-entries` reads the shared entry vocabulary from `@veyyon/session` and registers its own entry kinds there; every name it exported is still exported and no file format changes.
- The plugin manifest vocabulary (`PluginManifest`, `PluginFeature`, `PluginSettingSchema` and its setting kinds, `PluginSettingType`) moved from `@veyyon/kernel/loader/plugins/types` to `@veyyon/plugin`; `InstalledPlugin`, the lock-file state, the project overrides and the doctor and install option types stay.

### Removed

- `@veyyon/kernel/session/content-text` is gone: the session spine calls the `contentText` owner in `@veyyon/utils`, which carries the separator, image, `trimBlocks` and `trimString` options that copy held.
