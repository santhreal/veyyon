# @veyyon/hashline

Line-anchored patch language and application engine.

Diff format for model-driven code edits. Hunks are bound to a content hash snapshot to detect and reject stale file anchors before modifications are applied.

## Quick start

```ts
import {
	Filesystem,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patcher,
	Patch,
} from "@veyyon/hashline";

const fs = new InMemoryFilesystem();
const snapshots = new InMemorySnapshotStore();
const before = `const greeting = "hi";\nexport { greeting };\n`;
await fs.writeText("hello.ts", before);

const tag = snapshots.record("hello.ts", before);
const patcher = new Patcher({ fs, snapshots });
const patch = Patch.parse(String.raw`[hello.ts#${tag}]
SWAP 1.=1:
+const greeting = "hello";`);
const result = await patcher.apply(patch);

console.log(result.sections[0].op); // "update"
console.log(await fs.readText("hello.ts"));
```

## Format

Specifications:
- [`src/prompt.md`](./src/prompt.md): Prompt documentation.
- [`src/grammar.lark`](./src/grammar.lark): Formal Lark grammar.

Access prompt definitions programmatically:

```ts
import { HASHLINE_PROMPTS } from "@veyyon/hashline/prompts/registry";

const description = HASHLINE_PROMPTS.prompt.text;
```

Each section begins with `[PATH#TAG]`, where `TAG` is a 4-character hex snapshot identifier recorded by `SnapshotStore`.

### Operations

- `SWAP A.=B:`: Replace line range A through B with following `+TEXT` body rows.
- `SWAP.BLK A:`: Replace syntactic block beginning on line A.
- `DEL A.=B` / `DEL.BLK A`: Delete line range or syntactic block.
- `INS.PRE A:` / `INS.POST A:` / `INS.HEAD:` / `INS.TAIL:`: Insert body rows before/after line A, or at file start/end.
- `INS.BLK.POST A:`: Insert body rows after the end of syntactic block beginning on line A.
- `REM`: Delete file. Refused if current file content does not match section tag.
- `MV DEST`: Rename or move file to `DEST`. Refused if `DEST` exists as a different file.
- `+TEXT`: Literal content row (bare `+` inserts an empty line).

## Core classes

### `Filesystem`

Filesystem interface for reading and writing files. Built-in implementations:
- `InMemoryFilesystem`: In-memory `Map`-backed storage for testing.
- `NodeFilesystem`: Disk storage using atomic temporary file writes and renames.

### `SnapshotStore`

Tracks file content hashes by path to validate patch tags and support 3-way merge recovery when files diverge.

### `Patcher`

Applies parsed patches against a `Filesystem` and `SnapshotStore`. Preflights multi-section patches before writing changes.
