# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/plugin` states the plugin manifest vocabulary: `PluginManifest`, `PluginFeature`, `PluginSettingSchema` with its four setting kinds and `PluginSettingType`. A package declares what its `package.json` `veyyon` field contributes without importing the loader that installs it or the host that draws its settings. The package has no dependencies.
