# @veyyon/kernel

The only Veyyon member that is not a plugin. It loads plugins, resolves what they contribute, and
runs a session. It names no tool and no host.

## Direction

Every import edge points one way. The kernel may name `contracts/`, the shared runtime packages
(`@veyyon/agent-core`, `@veyyon/ai`, `@veyyon/catalog`, `@veyyon/utils`) and the platform. It may not
name a tool, a host, a mode, or `@veyyon/coding-agent`.
`scripts/the-kernel-names-no-tool-and-no-host.test.ts` resolves every specifier under `kernel/src`
and fails on the first edge that points the other way.

A consumer names the concern it needs, not the kernel as a whole:

```ts
import { sessionBodyToString } from "@veyyon/kernel/session/session-storage";
import { parsePluginSpec } from "@veyyon/kernel/loader/plugins/parser";
```

Import the required subpath; the package has no root barrel.

## Layout

|Directory|Contents|
|---|---|
|`src/registry/`|Contribution points: the tool domain manifest and the message kind a domain declares on it, tool proxying, widget and host-view declarations, schema conversion|
|`src/loader/`|Plugin discovery, manifest parsing, the installed registry, the marketplace client, load failure|
|`src/session/`|The session spine: entries, the session manager and its context builder and loader, the credential store, the role-keyed message kind table, storage, persistence, migrations, listing, retry policy, compaction policy, machine budget|
|`src/settings/`|The settings schema registry: a package declares the settings it owns as a table through `declareSettings` and merges its type into `DeclaredSettings`; the queries over a declaration (`getDefault`, `getType`, `getUi`, `isSettingPath`, ...) and the unset-number owner|

The settings store is published as `@veyyon/kernel/settings/store`. Log sinks remain
in `packages/coding-agent`.
