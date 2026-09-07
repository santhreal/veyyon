# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/kernel` is a workspace member: the loader, the contribution registry and the session spine, moved out of `@veyyon/coding-agent` unchanged. It names no tool, no host and no mode, and `scripts/the-kernel-names-no-tool-and-no-host.test.ts` fails on the first edge that does.
- `@veyyon/kernel/session/*` publishes the session spine: entries, storage backends, persistence, migrations, listing, paths, retry policy, compaction policy, machine budget and the turn's owned resources.
- `@veyyon/kernel/loader/*` publishes plugin discovery, manifest parsing, the installed registry, the marketplace client and load-failure reporting.
- `@veyyon/kernel/registry/*` publishes generic contribution interfaces, tool proxying, widget and host-view declarations, and TypeBox schema conversion.
- `@veyyon/kernel/registry/tool-domain` declares `ToolDomainManifest`, the name and lazy-factory table a tool domain contributes, so a host reads a domain's tools without depending on the coding agent.
- `SubagentSpawnEntry` and `SubagentSpawnRecord` in `@veyyon/kernel/session/session-entries` are `AgentSpawnEntry` and `AgentSpawnRecord`; the persisted `subagent_spawn` entry type is unchanged.
- `@veyyon/kernel/registry/message-kind` declares `AgentMessageKind`, a transcript role a tool domain records with its conversion to provider messages and to text, and `ToolDomainManifest.messageKinds` carries a domain's kinds; `@veyyon/kernel/session/message-kinds` is the role-keyed table the session spine converts them through, which throws on a role no domain declared and on a second kind for one role.
- `@veyyon/kernel/session/session-manager`, `session-context`, `session-loader` and `agent-storage` publish the session manager, its context builder, its file loader and the credential store, moved from `@veyyon/coding-agent/session/*` unchanged; `session/custom-message-payload` publishes the custom-message payload normaliser and the rehydration sanitiser they call.
- `@veyyon/kernel/settings/schema` publishes the settings schema registry: `declareSettings` registers a package's table and rejects a path declared twice, `DeclaredSettings` merges each table's type so `SettingPath` and `SettingValue` span every registered table, and `getDefault`, `getType`, `getUi`, `hasUi`, `getPathsForTab`, `retiredBy`, `isSettingPath`, `getEnumValues`, `isUnsetNumberPath` and `describeSettingTypeMismatch` answer from the registry; a query before any table has registered, or for a path no table declares, throws naming the cause. `@veyyon/kernel/settings/optional-number` publishes the unset-number owner, moved from `@veyyon/coding-agent/config/optional-number` unchanged.
- `@veyyon/kernel/settings/store` publishes `SettingsStore`, the layered settings store moved out of `@veyyon/coding-agent/config/settings`: the profile, overlay and runtime layers and their merge, `get`, `set`, `unset`, `override`, `getSource`, `isConfigured`, `layerValue`, the YAML load with quarantine and type-mismatch collection, the debounced locked text-preserving save with its failure report, `forkWithRuntimeOverrides`, `cloneForCwd`, `reloadForCwd` and the one-shot migration stamp (`stripLegacyUnsetSentinels`, `stampOwnedConfigMigrations`, `SETTINGS_MIGRATION_VERSION`), with `RawSettings`, `SettingsOptions`, `SettingSource`, `SettingsSaveFailure`, `InvalidSettingValue`, `QuarantinedSettingsFile`, `getByPath`, `setByPath`, `deleteByPath` and `deepMergeSettings`. The store takes a `SettingsStoreHooks` at construction (`globalBinding`, `migrate`, `loadLegacySources`, `afterOwnedConfigLoaded`, `resolveForCwd`, `applyHook`, `applyAllHooks`, `notifyEffectiveChange`, `mergedViewRebuilt`) and names no setting. `@veyyon/kernel/settings/signal` publishes `SettingSignal`, `clearSettingSignals` and `settingSignalListenerCounts`, moved unchanged.

### Changed

- Plugin runtime configuration uses the shared record validator; behavior is unchanged.
- Edit-specific event normalization remains in `@veyyon/coding-agent/extensibility/tool-event-input`; event payloads are unchanged.
- Settings lookups reuse immutable registry key snapshots and refresh derived indexes after registrations or resets.
- Array copies that allocated with a spread now use `.slice()`, `.concat()` or `Array.from()`. No user-visible behavior changes.
- `@veyyon/kernel/session/session-entries` reads the shared entry vocabulary from `@veyyon/session` and registers its own entry kinds there; every name it exported is still exported and no file format changes.
- The plugin manifest vocabulary (`PluginManifest`, `PluginFeature`, `PluginSettingSchema` and its setting kinds, `PluginSettingType`) moved from `@veyyon/kernel/loader/plugins/types` to `@veyyon/plugin`; `InstalledPlugin`, the lock-file state, the project overrides and the doctor and install option types stay.

### Removed

- `@veyyon/kernel/session/content-text` is gone: the session spine calls the `contentText` owner in `@veyyon/utils`, which carries the separator, image, `trimBlocks` and `trimString` options that copy held.
