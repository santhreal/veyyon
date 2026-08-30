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

There is no root barrel. A single entry point would republish 53 modules as one surface, which is the
shape this restructure exists to remove.

## Layout

|Directory|Contents|
|---|---|
|`src/registry/`|Contribution points, tool proxying, widget and host-view declarations, schema conversion|
|`src/loader/`|Plugin discovery, manifest parsing, the installed registry, the marketplace client, load failure|
|`src/session/`|The session spine: entries, storage, persistence, migrations, listing, retry policy, compaction policy, machine budget|

`src/settings/` and `src/log/` are named in the target architecture and are not populated yet; the
settings schema and the log sinks still live in `packages/coding-agent`.
