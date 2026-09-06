# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/session` states what a session file is made of: the `SessionEntry` vocabulary, the `AgentMessage` union and the `CustomCompactionSessionEntries` and `CustomAgentMessages` hooks a package augments. It imports only types from `@veyyon/model`.

### Changed

- Doc comments refer to a spawned session as an agent and to its record as `AgentSpawnEntry`; the persisted `subagent_spawn` entry type is unchanged.
