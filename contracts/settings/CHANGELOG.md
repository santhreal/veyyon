# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/settings` states the setting declaration vocabulary: `SettingDef` and its seven definition kinds, `SettingType` with `SETTING_TYPES` and `isSettingType`, `SettingTab`, `AnyUiMetadata` and `SubmenuOption`. A package declares a setting in this vocabulary without importing the store that persists it or the host that draws it. The package has no dependencies.

### Changed

- The `SettingTab` member for the agent pages is `agents` instead of `subagents`; the tab is an in-memory id and no persisted setting key changes.
