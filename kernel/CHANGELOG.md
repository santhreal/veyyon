# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Breaking Changes

- `SessionEntryIndex.entriesById()` is removed; `walkBranchPath`, `resolveContextLeaf` and `buildSessionContext` take any `SessionEntryLookup`, which `SessionEntryIndex` and a `Map<string, SessionEntry>` both satisfy.

### Added

- A tool domain manifest can list `resultCodecs`, each a `ToolResultCodec` whose `slim` drops a result `details` field the result's content rebuilds when the session writes the entry and whose `restore` rebuilds it when the session loads.
- `SessionStorage` has an optional `rewriteTailAtomic` that replaces a file atomically with its first `keepBytes` bytes, a new head written over their start, and a new tail; `FileSessionStorage` implements it, and a backend without it receives whole-file writes.
- `SessionManager.getMCPToolSelection()` returns the tool names the newest `mcp_tool_selection` entry on the context branch records, or `undefined` when the branch records none, without rebuilding the branch's messages; `resolveContextLeaf` is the rule `buildSessionContext` and that read share for which entry a context is built up to.
- `SessionStorage` has an optional `openPinnedReaderSync` that opens a read handle whose reads keep answering from the file object a path named when it was opened; `FileSessionStorage` implements it outside Windows.
- `SessionLoadOptions.coolCompactedHistory` makes a streamed load move compacted history to disk as it reads and return the store and the session's usage totals as `cold`, and `SessionEntryIndex.rebuild` takes those totals instead of counting every entry.
- `readColdEntry` returns an entry whose payloads are held in the session file as its line reads back, and leaves the entry's payloads in the file.
- A `ToolResultCodec` can define `settle`, which a persisting `SessionManager` calls on a tool result it records, before writing it, to replace in place each `details` field `slim` drops with the form `restore` builds.

### Changed

- `getRecentSessions` and `findMostRecentSession` scan session files newest first by mtime and stop once they hold the requested rows, instead of listing the whole directory through `.session-list-index.json` and rewriting it, cutting the welcome shortlist over 1,495 sessions from 37.8 ms to 17.1 ms in a fresh process and from 19.9 ms and 6.3 MiB of heap to 4.0 ms and 0.6 MiB warm (medians of 11 and 8 alternating runs).
- 13 class members that read no instance state are module functions and constants instead of `#private` members, which shrinks the compiled bytecode of their classes; behavior is unchanged.
- The session loader reads a session file 1 MiB at a time and splits lines synchronously instead of decoding each line through an async iterator, cutting the load phase of an 85 MB, 27,600-entry session from 210.0 ms to 149.9 ms (median of 7 alternating runs).
- Session storage and the session retry policy take their exponential delay from `exponentialBackoffDelay` in `@veyyon/utils`; each loop's base, ceiling and jitter are unchanged.
- `buildSessionContextFromPath` reads a branch's settings, emits its messages and strips dangling tool calls in single-purpose steps instead of one 374-line function, and drops content-less dangling turns in one pass instead of splicing each out, cutting a context build that drops 10,000 such turns from 10.4 ms to 0.7 ms with identical contexts across 200,000 generated branches.
- `SessionManager` checks whether an entry id belongs to the session against its id index instead of a second set holding every id, and `getChildren` filters the entry list instead of a parent-to-children map built for every entry, which cut the heap of an opened 390 MiB, 107,917-entry session from 91 MiB to 75 MiB and its open time from 1,002 ms to 961 ms (median of 5 alternating runs).
- The resume warning flattens each command or path onto one line through the shared `collapseWhitespace` helper; no user-visible change.
- A `tool_execution_start` session entry writes no `startedAt`, since the entry's own timestamp holds the start time, and writes its argument summary only when no preceding assistant message records the call, which cut the start markers in local sessions from 581.83 MB to 403.91 MB; a marker that wrote `startedAt` still reads back that time.
- The `ToolResultCodec` contract permits a codec to rebuild a dropped field from the details the written line keeps as well as from the result's content; no behavior change.
- Opening a session points every loaded string of 64 characters or more at one shared copy of its text, whether parsed from the file or read back from the blob store, and keeps no pooled string once the load returns, which cut the heap of a loaded 372.7 MiB session from 608.7 MiB to 401.7 MiB for 136 ms more load time.
- Rebuilding a session context locates the applied compaction by searching from the end of the branch, which takes about 7ms off each rebuild of a 238,084-entry branch.
- `SessionManager.rewriteEntries` takes the entries a caller changed in place and rewrites the session file from the earliest of them on, keeping the bytes before it without parsing or serializing them, which cut the rewrite after a one-entry prune on a 376 MiB, 109,360-entry session from 1.2 s to 135 ms.
- The session listing matches a `--resume` argument against a transcript filename through `sessionFileMatchesResumeArgument` from `@veyyon/utils/session-file`, the matcher the startup profile lookup uses; no user-visible change.
- The first rewrite after resuming a session keeps the file's bytes before the earliest updated entry and reads nothing back when the loaded file holds one clean record per line, which cut the first-turn prune rewrite of a resumed 39 MB, 13,470-entry session from one whole-file write plus a 39 MB read to a partial write with no read.
- `SessionInfo.messageCount` documents that it counts the messages in the scanned prefix and is a lower bound for a longer session; no behavior change.
- `SessionManager` keeps the payloads of entries its live context cannot reach in the session file and reads each back through a handle on the file object it loaded, which cut a resumed 402 MiB, 135,650-entry session from 501 MiB heap plus 369 MiB external memory to 117 MiB plus 46 MiB and its RSS from 1,072 MiB to 602 MiB, for about 400 ms more open time; Windows keeps every entry in memory.
- A context build reads the default model of a session without `model_change` entries from the newest assistant turn on the branch instead of from every assistant turn in order; the model it selects is unchanged.
- `SessionManager` keeps the payloads of `session_init`, `settings_snapshot` and `subagent_spawn` entries in the session file on the live branch as well, reading each back on first use, so a spawned agent's recorded system prompt no longer stays in memory.
- `SessionManager` moves a `session_init`, `settings_snapshot` or `subagent_spawn` entry out of memory as soon as the append that wrote it completes, instead of at the next whole-file publish, which cut the heap after 40 live subagents from 102.4 MiB to 96.9 MiB (median of 3 runs).
- A forwarding tool wrapper reads each forwarded property through one accessor shared by every wrapper instead of a getter and setter pair built per wrapper and per key, which cut the live objects after 40 live subagents from 756,648 to 729,618 and the heap from 95.4 MiB to 94.3 MiB (median of 3 runs).
- A listed session holds at most 4,096 characters of first-message and message text, copied out of the scanned window, and the session list index moves to version 2 so rows an earlier build indexed without the bound are rescanned, which cut the rows of a 125-session directory from 21.39 MiB to 1.97 MiB and its list index from 5.45 MiB to 557 KiB.
- The error a cold entry's failed read-back raises formats its cause with `errorMessage` from `@veyyon/utils`; no user-visible change.
- A listed session copies its bounded texts through `detachedString` from `@veyyon/utils`; no user-visible change.
- `getEffectiveSnapshot` resolves every declared setting without memoizing it, so a store keeps cached values only for paths its session reads, which cut the heap a live spawned session retains from 315.4 KiB to 277.0 KiB (median of 3 runs over 20 sessions).
- `SessionManager.getCwd` returns the absolute cwd the session holds instead of resolving a new copy on every read, so the transcript rows of a resumed 600-turn session share one path string instead of holding 1,599 copies, which cut its heap and extra memory from 123,876 KiB to 123,672 KiB and its live strings from 135,858 to 134,281 (median of five); every returned value is unchanged.
- The resume warning for tool calls left without a result scans the branch from the keep boundary of its newest compaction, so it no longer lists a call before that boundary or reads a compacted entry back from the session file to check it.
- A cold message entry keeps a message object holding the message's `role`, `toolName`, `toolCallId`, `isError`, `stopReason`, `provider` and `model` and reads only its large fields back on access, so the checkpoint and todo scans of a resume read no entry back; with the bounded resume warning this cut the entries a resumed 390 MiB, 44,454-cold-entry session reads back from 43,027 to 0, its heap from 529.7 MiB plus 418.8 MiB external to 109.9 MiB plus 40.8 MiB, its peak RSS from 2,231 MiB to 1,204 MiB and its time to the startup banner from 2.27 s to 1.46 s (median of 3 alternating runs).
- A cold entry and its message stand-in hold the record of where their line is in a private field instead of a `WeakMap` entry, which cut a resumed 153.8 MB, 53,817-entry synthetic session from 40.8 MiB heap plus 13.7 MiB external memory to 37.1 MiB plus 9.7 MiB (median of 5 alternating runs) at the same open time.
- Opening a session shares each repeated string shorter than 64 characters with the equal strings under the same key, such as the `role`, `api`, `provider` and `model` of every message, until a key holds 256 distinct ones, which cut a resumed 153.8 MB, 53,817-entry synthetic session from 37.1 MiB heap plus 9.7 MiB external memory to 34.2 MiB plus 8.4 MiB and its live objects from 603,120 to 501,979 (median of 7 alternating runs), for 6.6 ms more in the load's string walk (65.7 ms to 72.3 ms).
- Opening a session file of 8 MiB or more moves the history each compaction summarized out of memory as the load reads that compaction instead of once the whole file is loaded, and counts the session's usage as it reads, which cut opening a 153.8 MB, 53,817-entry synthetic session from a 325.8 MiB to a 190.0 MiB peak RSS and from a 149.1 MiB to a 52.6 MiB peak heap sampled every 5 ms, with an open time of 358 ms against 371 ms (median of 13 alternating runs each).
- A session file's header line no longer holds a copy of the title the title slot holds, and a title change records where its entry landed instead of discarding the file's line offsets, so the first history rewrite after a rename or after resuming a renamed session writes the lines from its earliest update instead of the whole file, which cut that rewrite on a 45 MB, 20,000-entry session from 44.9 MB serialized in 90.8 ms to 20.8 KB in 14.1 ms (median of 3 runs).
- Opening a session file of 8 MiB or more parses each record after the header from the line's bytes instead of decoding the line to a string first, which cut opening a 312 MB, 108,163-entry synthetic session from a 318 MiB to a 256 MiB peak RSS and from 667 ms to 598 ms (median of 5 runs each).
- `SessionEntryIndex` keys entries by id in a null-prototype object instead of a `Map`, which cut the settled heap of an opened 312 MB, 108,163-entry synthetic session from 58.9 MiB to 56.1 MiB and its settled RSS from 162 MiB to 159 MiB (median of 5 alternating runs).
- `SessionManager` records where its entry lines sit in the published file against the entry list itself instead of a copy of it, which cut the settled heap of an opened 312 MB, 108,163-entry synthetic session from 56.1 MiB to 55.3 MiB (3 runs each, identical).
- A session load looks a record's parent up by id only when the parent is not the record in front of it, so the orphan check and the streamed load's compaction walk build no index of every id for a session appended turn by turn, which cut opening a 312 MB, 108,163-entry synthetic session from 595 ms to 570 ms and from a 249 MiB to a 241 MiB peak RSS (median of 7 alternating runs).
- Cooling an entry finds its shared list of moved fields by walking a trie of field names over the entry's own keys instead of copying the keys into arrays and joining them into a lookup string, which cut cooling the 71,909 large entries of a 312 MB, 108,163-entry synthetic session from 34.3 ms to 22.0 ms and opening it from 546 ms to 527 ms (median of 4 alternating runs of 9 opens each).
- A cold entry holds where its line is and which fields moved in private fields on the entry itself instead of in a separate record object, and its message stand-in names the entry instead of that record, which cut the settled heap of an opened 312 MB, 108,163-entry synthetic session from 55.3 MiB to 52.1 MiB and its settled RSS from 155 MiB to 151 MiB (2 runs each) at the same open time.
- `SessionEntryIndex` extends the active branch while it indexes a loaded session that never branched instead of walking the branch afterward by parent id, which cut the median open of a 312 MB, 108,163-entry synthetic session from 526 ms to 508 ms (7 interleaved runs each).
- A session load's string-pooling walk writes a string back only when an earlier equal string replaces it and skips a cold entry's moved fields by one cursor over its key order, which cut the walk over a 108,163-entry synthetic session with two thirds of it cooled from 89 ms to 80 ms (median of 7 rounds, 2 runs each) and its median open from 500 ms to 494 ms (6 interleaved runs).
- The pass that moves unreachable entries out of memory after a resume, a publish or a compaction matches entries to a never-branched session's active branch by file position instead of building a set of the live entries, which cut that pass over a 312 MB, 108,163-entry synthetic session from 2.86 ms to 2.51 ms (median of 5 interleaved runs of 31 passes each).
- `AgentStorage` builds its credential store on the first credential or cache call instead of when it opens, and leaves a current schema version row unwritten, which cut the memory of a launch's held `agent.db` connection from 384 KiB to 209 KiB and its open plus model-usage read from 827 µs to 606 µs (median of 7 alternating runs of 60 opens).
- `prepareEntryForPersistence` copies an array or object only from its first changed child on, cutting the persistence pass over a 400-entry session with nothing to externalize from 0.33 ms to 0.10 ms (median of 200 alternating rounds, three runs).

### Fixed

- The session loader no longer instantiates the `@veyyon/utils` barrel through its cold-entry store, which cut the modules it loads from 141 to 88 and the modules the `read` tool loads from 360 to 333.
- A title change made while a session file rewrite is queued or in progress is written to the file once instead of twice, and a change that lands after the rewrite read its body is published by a second pass instead of being lost with its title.
- An enum setting whose configured value is outside its declared values reads as the declared default and logs one warning per setting.
- An unquoted YAML scalar that spells an enum member, such as `advisor.syncBacklog: 3`, reads as that member and is no longer reported as invalid at load.
- `resolveResumableSession` returns a session another profile wrote as `scope: "profile"` with the owning profile's name instead of as a `global` match, and `foreignSessionFileProfile` returns the profile other than the active one that holds a transcript path.
- `SessionManager.continueRecent` ignores a terminal breadcrumb naming another profile's transcript instead of continuing that session, or relocating it into the active profile when its recorded directory is gone.
- With sessions stored under `$XDG_DATA_HOME/veyyon`, the all-projects session listing, `resolveResumableSession`'s other-profile lookup and `foreignSessionFileProfile` read the sessions directory each profile writes to instead of `<agentDir>/sessions`, which held none of them.
- `listAllSessions` and `SessionManager.listAll` list top-level sessions only, leaving out spawned-agent transcripts in a session's artifacts directory and orphaned `orphan-task-*` transcripts; `resolveResumableSession` still resolves an agent transcript by id.
- The resume warning for tool calls left without a result lists at most three calls, each command or path cut to 80 characters on one line, followed by "and N more", and no longer counts a `<id>_2` repeat of a call its original id already answered.
- A tool call recorded in an OpenAI Responses or Codex native history payload keeps its provider id through outbound canonicalization, so its result is sent as that call's output instead of a stale-output note after a "No tool output was recorded" placeholder on every turn.
- A session file under 8 MiB opened for a partial rewrite no longer keeps its whole text alive through the header line the loaded layout holds, which held a second copy of the file for as long as the session stayed open.
- `isSamplingKnob` answers `false` for a name inherited from `Object.prototype`, such as `toString` or `constructor`, instead of `true`.
- A persisted session entry keeps the `lineCount` its producer wrote beside a `content` string instead of recounting it from that string when another field of the same object is dropped or externalized, which recorded the shown head's line count for a mentioned file as the file's.

## [1.5.5] - 2026-09-25

### Changed

- `SessionManager.open` parses the session file once instead of twice, cutting a 700 MB resume from 2.83 s to 1.62 s and peak RSS from 3.4 GB to 1.95 GB.

## [1.5.4] - 2026-09-24

### Fixed

- A session rebuilt on a provider that cannot replay its newest server-side compaction starts from the newest compaction that provider can use (`getEffectiveCompactionEntry`) instead of re-expanding the branch from its first entry.
- Deleting a session removes its artifacts directory at the path `sessionFileStem` resolves, the same path the session created it at, instead of cutting a fixed six characters off the file name.
- A session file whose append failed on disk is rewritten in full on the next write instead of being treated as current, and `ensureOnDisk` retries after a disk failure instead of returning without writing.
- Resuming a long session walks its active branch once instead of once per startup reader: `SessionManager` keeps the root-to-leaf path and extends it on append, which cut a 214,000-entry resume from 3.5 s to 3.0 s.
- A session file opened from another profile reads and writes the blob store beside that profile's `sessions` directory instead of the active profile's, so its stored payloads load and new ones stay where that profile's `gc --blobs` counts them as referenced.

## [1.5.0] - 2026-09-18

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

- Session listing reuses a per-directory index for files whose size and mtime are unchanged instead of rescanning every file, cutting a 4,825-session `/resume` list from 6.8 s to 185 ms when a session changed and 88 ms when none did.
- Resolving a session id that no directory in the active profile holds reads the other profiles through the same per-directory index, cutting that lookup from 2.5 s to 126 ms.
- Settings mutations and session storage writers share implementations without changing persistence, hook ordering or error behavior.
- Installed plugin registry readers share JSON validation while preserving numeric-version handling and malformed-file behavior.
- Plugin runtime configuration uses the shared record validator; behavior is unchanged.
- Edit-specific event normalization remains in `@veyyon/coding-agent/extensibility/tool-event-input`; event payloads are unchanged.
- Settings lookups reuse immutable registry key snapshots and build derived indexes in one pass after registrations or resets.
- Settings stores share layer copying and override application while retaining profile values, per-directory resolution and isolated save-failure reports.
- Session title overlays avoid encoding and copying the full transcript when the first line occupies the fixed 256-byte slot.
- The TypeBox `unknown` converter is the `any` converter, which had the same body; emitted schemas are unchanged.
- Session entry validation shares non-empty string checks, and branch labels avoid temporary identifier arrays.
- `@veyyon/kernel/settings/store` exports `groupSettingPaths`, memoizing prefix-grouped schema paths on the schema index with automatic invalidation on schema resets.
- Array copies that allocated with a spread now use `.slice()`, `.concat()` or `Array.from()`. No user-visible behavior changes.
- `@veyyon/kernel/session/session-entries` reads the shared entry vocabulary from `@veyyon/session` and registers its own entry kinds there; every name it exported is still exported and no file format changes.
- The plugin manifest vocabulary (`PluginManifest`, `PluginFeature`, `PluginSettingSchema` and its setting kinds, `PluginSettingType`) moved from `@veyyon/kernel/loader/plugins/types` to `@veyyon/plugin`; `InstalledPlugin`, the lock-file state, the project overrides and the doctor and install option types stay.
- SQL session storage consolidates parameterized queries across PostgreSQL, MySQL, and SQLite dialects.

### Fixed

- Settings queries ignore inherited object properties.
- `Type.Pick` emits the keys it was asked for in the order they were asked for, and keeps a picked key that is own-but-non-enumerable on the validated value.
- A session whose recorded leaf id no longer names an entry reopens on its last entry instead of on an empty conversation.
- `MemorySessionStorage.deleteSessionWithArtifacts` deletes the session entry and its artifact files from memory instead of returning early as a no-op.
- `walkBranchPath` terminates when traversing cyclic parent entry chains.
- `StringEnum` options in the legacy plugin shim avoid `any`.
- `listSessionsReadOnly` writes no session list index, so it makes no write to a directory it states it does not mutate; it still reads an existing index, which is not a mutation.

### Removed

- `@veyyon/kernel/session/content-text` is gone: the session spine calls the `contentText` owner in `@veyyon/utils`, which carries the separator, image, `trimBlocks` and `trimString` options that copy held.
