/**
 * A type that means one thing is declared once, in one package, repo-wide.
 *
 * WHY THIS SUITE EXISTS. Counting exported type declarations by name across `packages/`
 * turned up dozens of names declared several times, and the pattern had already produced
 * two real defects rather than a style complaint:
 *
 *  - `PromptEntry` was declared in two prompt registries, and the copies had DIVERGED:
 *    `@veyyon/agent-core`'s had no `sections` field, so whether a prompt could describe
 *    how it divides depended on which registry happened to hold it.
 *  - `PromptSection` was exported from two sibling modules of `@veyyon/coding-agent`
 *    meaning two different things, the base row shape and the template-or-runtime union.
 *    An editor's auto-import picked whichever it offered first, and they are not
 *    interchangeable: one carries `source`, the other does not.
 *
 * Byte-identical copies are the dangerous state, not the safe one. Nothing tells you the
 * others exist, so a fix lands in one of them, and the two that had already drifted show
 * what that costs. `JsonValue` was written out five times, four of them identical, with
 * the scalar spelled `JsonScalar` in one place and `JsonPrimitive` in three others for
 * the same type, so a reader comparing two modules had to read both definitions to learn
 * that they agreed.
 *
 * WHAT THIS SUITE DOES NOT CLAIM. Not every repeated name is a duplicate. A vendor's
 * generated wire types legitimately each have a `Metadata`, and those are distinct
 * concepts that happen to share a word. The table below is the names that have been
 * RESOLVED, each with the resolution recorded, and the assertion is that the resolution
 * holds. New names get added as they are triaged; the open list lives in BACKLOG.md.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { SessionEntry as HostSessionEntry } from "@veyyon/agent-core/compaction/entries";
import type { ManifestExtension } from "@veyyon/coding-agent/capability/extension";
import type { LoadedExtension } from "@veyyon/coding-agent/extensibility/extensions/types";
import type { ExtensionRow } from "@veyyon/coding-agent/modes/components/extensions/types";
import { PROMPTS } from "@veyyon/coding-agent/prompts/registry";
import type { DenseVector, Vector } from "@veyyon/mnemopi/types";
import type { SessionEntry as DeprecatedStatsSessionEntry, SessionLogEntry } from "@veyyon/stats/types";
import type { JsonPrimitive, JsonValue, PromptEntry, PromptSection } from "@veyyon/utils";
import type { SessionEntry as DeprecatedWireSessionEntry, WireSessionEntry } from "@veyyon/wire";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

/**
 * A name that has been unified, its one owner, and how it was resolved.
 *
 * `owner` is the file allowed to DECLARE it. Re-exports are fine anywhere and are not
 * declarations: `export type { JsonValue } from "@veyyon/utils"` puts the name in a
 * second module's surface without giving it a second definition, which is how a package
 * keeps its own vocabulary without owning the type.
 */
const UNIFIED = [
	{
		name: "JsonValue",
		owner: "packages/utils/src/json.ts",
		resolution: "one concept, five declarations; moved to the package that owns the JSON helpers",
	},
	{
		name: "JsonPrimitive",
		owner: "packages/utils/src/json.ts",
		resolution: "the same, and `JsonScalar` in @veyyon/mnemopi is kept as an alias because it is published",
	},
	{
		name: "PromptEntry",
		owner: "packages/utils/src/prompt-registry.ts",
		resolution: "one concept, two diverging declarations; moved to the package every registry depends on",
	},
	{
		name: "PromptSection",
		owner: "packages/utils/src/prompt-registry.ts",
		resolution: "two concepts under one name; the union was renamed `SystemPromptSection`",
	},
	{
		name: "Vector",
		owner: "packages/mnemopi/src/types.ts",
		resolution:
			"four declarations in one package with three meanings; the two `Float32Array` copies now re-export `DenseVector` under their old name and the unused `number[]` alias was spelled out",
	},
	{
		name: "DenseVector",
		owner: "packages/mnemopi/src/types.ts",
		resolution: "the name the two `Vector = Float32Array` copies collapsed into, beside the wide `Vector` it is not",
	},
	{
		name: "Veracity",
		owner: "packages/mnemopi/src/core/veracity.ts",
		resolution:
			'five declarations with DIFFERENT value sets, and the narrowest validated writes: `clampVeracity("false")` returned `"unknown"`, so a memory recorded as known-wrong was scored 0.8 by recall instead of 0. The vocabulary is now derived from the weight table, so a value cannot exist without a weight',
	},
	{
		name: "StoredVeracity",
		owner: "packages/mnemopi/src/types.ts",
		resolution:
			"the wide read-row spelling beside the closed vocabulary, because the column has no CHECK constraint; the old `| string` in `core/beam/types.ts` collapsed the union to `string` and checked nothing",
	},
	{
		name: "SessionHeader",
		owner: "packages/coding-agent/src/session/session-entries.ts",
		resolution:
			"three headers under one name; the wire one became `WireSessionHeader` and the stats parser's `SessionLogHeader`, and the host now PROJECTS onto the wire shape instead of sending its own verbatim",
	},
	{
		name: "WireSessionHeader",
		owner: "packages/wire/src/index.ts",
		resolution: "the four fields a guest receives, which the host was overshooting by three",
	},
	{
		name: "SessionLogHeader",
		owner: "packages/stats/src/types.ts",
		resolution: "the parser's view, whose `version` was required while the writer's is absent on v1 sessions",
	},
	{
		name: "WireUserMessage",
		owner: "packages/wire/src/index.ts",
		resolution:
			"the four fields a guest renders, keeping `UserMessage` as a renamed export because wire is published",
	},
	{
		name: "WireAssistantMessage",
		owner: "packages/wire/src/index.ts",
		resolution:
			"the widest gap of the four: the host's `AssistantMessage` carries `providerPayload`, `request`, `contextSnapshot`, `retryRecovery`, `responseId`, `turnMetrics` and `errorId`, and this one carries content, model, usage, stop reason, timestamp, and nothing else",
	},
	{
		name: "WireDeveloperMessage",
		owner: "packages/wire/src/index.ts",
		resolution: "renamed with the rest of the vocabulary so no message shape here answers to a bare name",
	},
	{
		name: "WireToolResultMessage",
		owner: "packages/wire/src/index.ts",
		resolution: "renamed with the rest of the vocabulary so no message shape here answers to a bare name",
	},
	{
		name: "StopReason",
		owner: "packages/ai/src/types.ts",
		resolution:
			"three declarations: the host's five literals, wire's identical-today copy (now `WireStopReason`, spelled separately because wire must stay dependency-free for the browser), and Anthropic's own wire vocabulary in `providers/anthropic-wire.ts`",
	},
	{
		name: "WireStopReason",
		owner: "packages/wire/src/index.ts",
		resolution:
			"prefixed even though it matches today, because two identical unions under one name are how they drift apart later without either side noticing",
	},
	{
		name: "AnthropicWireStopReason",
		owner: "packages/ai/src/providers/anthropic-wire.ts",
		resolution:
			"Anthropic's own eight `stop_reason` literals, which are not the harness's five; `mapStopReason` is the single crossing point",
	},
	{
		name: "AnthropicWireUsage",
		owner: "packages/ai/src/providers/anthropic-wire.ts",
		resolution:
			"snake_case nullable token counts off the wire, not the harness's camelCase `Usage` with cost; `anthropic.ts` already had to import it under this alias to say which it meant",
	},
	{
		name: "SessionEntry",
		owner: "packages/agent/src/compaction/entries.ts",
		resolution:
			"three unions with three widths under one name; the wire subset became `WireSessionEntry` and the stats parser's tolerant one `SessionLogEntry`, both keeping the old name as a renamed export because the packages are published",
	},
	{
		name: "WireSessionEntry",
		owner: "packages/wire/src/index.ts",
		resolution: "the guest-renderable subset, which is six variants of the host's dozen-plus",
	},
	{
		name: "SessionLogEntry",
		owner: "packages/stats/src/types.ts",
		resolution: "the widest of the three: its `{ type: string }` arm admits any object with a `type` at all",
	},
	{
		name: "ManifestExtension",
		owner: "packages/coding-agent/src/capability/extension.ts",
		resolution: "one of three `Extension` declarations; this one is a Gemini-style extension directory on disk",
	},
	{
		name: "LoadedExtension",
		owner: "packages/coding-agent/src/extensibility/extensions/types.ts",
		resolution: "the second; an extension module that has been executed and registered handlers and tools",
	},
	{
		name: "ExtensionRow",
		owner: "packages/coding-agent/src/modes/components/extensions/types.ts",
		resolution: "the third; a Control Center row, most of which are skills and rules rather than extensions",
	},
	{
		name: "DiscoveredCustomTool",
		owner: "packages/coding-agent/src/capability/tool.ts",
		resolution:
			"the same shape of bug as Extension: a tool-definition file on disk, renamed off the runtime `CustomTool` an extension registers",
	},
	{
		name: "EvalWorkerTransport",
		owner: "packages/coding-agent/src/eval/js/worker-protocol.ts",
		resolution:
			"two worker protocols each declared `Transport`, `WorkerInbound`, `WorkerOutbound` and `RunErrorPayload`",
	},
	{
		name: "TabWorkerTransport",
		owner: "packages/coding-agent/src/tools/browser/tab-protocol.ts",
		resolution: "the other one; its `send` also takes a transfer list, so the two were never interchangeable",
	},
	{
		name: "EvalWorkerOutbound",
		owner: "packages/coding-agent/src/eval/js/worker-protocol.ts",
		resolution: "the eval worker's outbound union, prefixed off the browser tab's",
	},
	{
		name: "TabWorkerOutbound",
		owner: "packages/coding-agent/src/tools/browser/tab-protocol.ts",
		resolution:
			"the tab worker's outbound union, which carries `tool-call` and `init-failed` the eval one has no idea about",
	},
	{
		name: "WorkerLogPayload",
		owner: "packages/coding-agent/src/subprocess/worker-log.ts",
		resolution: 'the log line\'s CONTENT; `WorkerLogMessage` beside it is this plus the `type: "log"` discriminator',
	},
	{
		name: "CommitValidationResult",
		owner: "packages/coding-agent/src/commit/analysis/validation.ts",
		resolution:
			"reports an `errors` array; the plugin one reports a single `error`, so reading the wrong one saw no errors",
	},
	{
		name: "PluginSettingValidationResult",
		owner: "packages/coding-agent/src/extensibility/plugins/manager.ts",
		resolution: "the single-`error` half of the same collision",
	},
	{
		name: "TodoPhase",
		owner: "packages/coding-agent/src/tools/todo.ts",
		resolution:
			"the todo vocabulary was declared twice in ONE package; `modes/types.ts`'s `TodoItem` carried `details?` and `notes?`, which the tool's arktype schema has no concept of and nothing ever wrote, so the HUD's superscript note count was unreachable code. The writer owns the shape and `modes/types.ts` re-exports it. `TodoItem` itself is not listed here because generated Cursor protobuf declares that name too",
	},
	{
		name: "TodoStatus",
		owner: "packages/wire/src/index.ts",
		resolution:
			"byte-identical in both copies, which is how the two `TodoItem`s looked interchangeable. The union then moved OUT of the coding agent entirely: it is derived from `TODO_STATUS_IS_TERMINAL` in `@veyyon/wire`, so a new status cannot join it without a terminality decision landing beside it, and both renderers of a todo board read the same vocabulary. `tools/todo.ts` and `modes/types.ts` re-export the name and declare nothing",
	},
	{
		name: "Usage",
		owner: "packages/catalog/src/types.ts",
		resolution:
			"`@veyyon/stats` declared its own with the same five counters and the same `cost`, and nothing else -- so `orchestration`, `reasoningTokens`, `cttl` and `server` were present in the sessions it parses and invisible to every reader. Stats already depends on catalog, so it re-exports the writer's type",
	},
	{
		name: "RecallResult",
		owner: "packages/mnemopi/src/core/beam/types.ts",
		resolution:
			"three declarations. Hindsight's (a different memory SERVICE, keyed on `text` rather than `content`) became `HindsightRecallResult`; mnemopi's second copy in `src/types.ts` was DEAD -- nothing imported it, inside the package or out -- and it would have typechecked while missing `truncated`/`full_length`, the fields a caller must check before trusting `content`",
	},
	{
		name: "HindsightRecallResult",
		owner: "packages/coding-agent/src/hindsight/client.ts",
		resolution:
			"the memory backend is switchable, so both were in play at once and the index signature on this one meant handing it to mnemopi-shaped code typechecked",
	},
	{
		name: "JsonRpcResponse",
		owner: "packages/coding-agent/src/mcp/types.ts",
		resolution:
			"three declarations; `mcp/json-rpc.ts` had a generic copy ONE DIRECTORY over with the error object inline instead of naming `JsonRpcError`, and mnemopi's server-side one became `McpServerJsonRpcResponse` because its `id` admits `null` and the client's does not",
	},
	{
		name: "McpServerJsonRpcResponse",
		owner: "packages/mnemopi/src/mcp-server.ts",
		resolution:
			"what a server SENDS, including the `id: null` the JSON-RPC 2.0 spec requires for an error it cannot attribute to a request",
	},
	{
		name: "McpServerJsonRpcRequest",
		owner: "packages/mnemopi/src/mcp-server.ts",
		resolution:
			"what a server PARSES: every field optional, because a client can send anything. The client-side `JsonRpcRequest` requires all three, which is right for a request you build and wrong for one you receive",
	},
	{
		name: "KernelExecuteOptions",
		owner: "packages/coding-agent/src/eval/kernel-base.ts",
		resolution:
			"three declarations that disagreed about `env`; Ruby could not say 'leave alone' and Julia could not say 'clear', and both crashed on a null",
	},
];

/**
 * Paths that are not this repository's source.
 *
 * `repo-cache` holds third-party repositories checked out as benchmark fixtures, and one
 * of them declares its own `JsonPrimitive`. That is somebody else's code and none of our
 * business: including it would make the check fail for a reason nobody here can fix, and
 * "delete a name from a vendored library" is not the resolution. `vendor` is the same
 * situation for a copied dependency, and `dist` is our own output rather than our source.
 */
const NOT_OUR_SOURCE = ["node_modules", "/dist/", "/vendor/", "/repo-cache/"];

/** Every `.ts` under `packages/` that this repository actually maintains, with its text. */
async function ourSources(): Promise<Array<{ file: string; text: string }>> {
	const glob = new Bun.Glob("packages/**/*.ts");
	const paths: string[] = [];
	for await (const relative of glob.scan({ cwd: REPO_ROOT, onlyFiles: true })) {
		const file = relative.replace(/\\/g, "/");
		if (NOT_OUR_SOURCE.some(excluded => file.includes(excluded))) continue;
		paths.push(file);
	}
	return await Promise.all(
		paths.map(async file => ({ file, text: await Bun.file(path.join(REPO_ROOT, file)).text() })),
	);
}

/** Read once. The scan is the expensive part and every check below asks the same question. */
const SOURCES = ourSources();

/**
 * Files that DECLARE the given type name.
 *
 * `export type X =` and `export interface X` only. A re-export (`export type { X } from`)
 * and a local import both mention the name without defining it, and treating either as a
 * declaration would make the check unusable: the whole point of one owner is that other
 * modules name the type freely.
 */
function declarationsOf(name: string, files: ReadonlyArray<{ file: string; text: string }>): string[] {
	const declaration = new RegExp(`^export (?:type ${name} =|interface ${name}\\b)`, "m");
	return files.filter(({ text }) => declaration.test(text)).map(({ file }) => file);
}

describe("a unified type name", () => {
	it("reads the sources the rest of these checks depend on", async () => {
		// Stated as its own check so a scan that silently found nothing cannot make every
		// assertion below pass by having nothing to look at.
		const files = await SOURCES;

		expect(files.length).toBeGreaterThan(2000);
		expect(files.some(({ file }) => file === "packages/utils/src/json.ts")).toBe(true);
	});

	it.each(UNIFIED)("is declared in exactly one file: $name ($resolution)", async ({ name, owner }) => {
		const declared = declarationsOf(name, await SOURCES);

		// Listed rather than counted, so a failure names the file that redeclared it.
		expect(declared.sort()).toEqual([owner]);
	});

	it("finds a name that really is declared several times, so the pattern still works", async () => {
		// The anti-vacuity check, and it is not hypothetical: `Metadata` is declared six
		// times across `packages/`, in three vendors' generated wire types plus a protobuf
		// module and this repository's own memory metadata. The regex has to see several of
		// those, or the per-name assertions above pass because the pattern stopped matching
		// rather than because the names are unified.
		const declared = declarationsOf("Metadata", await SOURCES);

		expect(declared.length).toBeGreaterThan(2);
	});

	/**
	 * The ambiguous name is retired, not merely reduced to one owner.
	 *
	 * `Extension` was three unrelated types in ONE package: a manifest directory found on
	 * disk, a module that had been executed, and a dashboard row for things that are mostly
	 * not extensions. Leaving one of them holding the bare name would keep the trap open --
	 * the next reader still could not tell from `ext: Extension` which of the three they had,
	 * and an auto-import would still resolve to whichever module the editor offered. So all
	 * three were renamed and none inherited it. This fails if any of them is renamed back.
	 */
	it("leaves no declaration of the ambiguous name the three Extension types shared", async () => {
		expect(declarationsOf("Extension", await SOURCES)).toEqual([]);
	});

	/**
	 * The generic protocol nouns are retired too, for the same reason the bare
	 * `Extension` was.
	 *
	 * `eval/js/worker-protocol.ts` and `tools/browser/tab-protocol.ts` each declared
	 * `Transport`, `WorkerInbound`, `WorkerOutbound` and `RunErrorPayload` -- four names,
	 * two files, eight declarations, and near-identical shapes that are NOT substitutable:
	 * the tab transport's `send` takes a transfer list and its outbound union carries
	 * `tool-call` and `init-failed`. Near-identical is worse than different, because the
	 * wrong import often typechecks. Both vocabularies are now prefixed and neither kept
	 * the generic noun.
	 */
	it.each(["Transport", "WorkerInbound", "WorkerOutbound", "RunErrorPayload", "ValidationResult"])(
		"leaves no declaration of the generic name two protocols fought over: %s",
		async name => {
			expect(declarationsOf(name, await SOURCES)).toEqual([]);
		},
	);

	it("does not count a re-export as a declaration", async () => {
		// The rule the whole check rests on. `@veyyon/mnemopi` re-exports `JsonValue` from
		// three modules so its own consumers keep importing from `./types`, and treating
		// that as a second definition would leave a package no way to name a shared type.
		const files = await SOURCES;
		const reExporters = files.filter(({ text }) => /^export type \{[^}]*\bJsonValue\b/m.test(text));

		expect(reExporters.length).toBeGreaterThan(1);
		expect(declarationsOf("JsonValue", files)).toEqual(["packages/utils/src/json.ts"]);
	});
});

describe("the unified types are usable as one type", () => {
	/**
	 * `JsonValue` from `@veyyon/utils` accepts what JSON accepts, checked by assignment
	 * rather than by reading the declaration. A type that compiles here is a type every
	 * package can share; one that does not would push a package back to its own copy.
	 */
	it("accepts every JSON shape through the shared declaration", () => {
		const scalars: JsonPrimitive[] = ["text", 0, false, null];
		const nested: JsonValue = { list: [1, "two", null], nested: { deep: [{ deeper: true }] } };

		expect(scalars).toHaveLength(4);
		expect(nested).toEqual({ list: [1, "two", null], nested: { deep: [{ deeper: true }] } });
	});

	/**
	 * The shared `PromptEntry` is the type the coding agent's registry actually satisfies,
	 * and it carries `sections`. That field is what `@veyyon/agent-core`'s copy lacked, so
	 * asserting it survives the move is asserting the divergence is gone rather than
	 * relocated.
	 */
	/**
	 * The two vector names are not interchangeable, and that is the point of separating them.
	 *
	 * `Vector` is what a caller may HAND to mnemopi, so a plain `number[]` read back from a
	 * JSON column has to be assignable to it. `DenseVector` is what mnemopi PRODUCES, so it
	 * is a `Float32Array` and nothing else. While both were spelled `Vector` in different
	 * modules, which of the two you got depended on which module your editor imported from,
	 * and the wide one silently accepted arrays in places that went on to require the dense
	 * one. Asserting by assignment rather than by reading the declarations is what makes this
	 * a check on the types instead of on their text.
	 */
	it("keeps the wide and dense vector types distinct", () => {
		const fromJson: Vector = [0.5, -0.25, 1];
		const fromProvider: DenseVector = new Float32Array([0.5, -0.25, 1]);
		const dense: Vector = fromProvider;

		expect(Array.from(fromJson)).toEqual([0.5, -0.25, 1]);
		expect(Array.from(dense)).toEqual([0.5, -0.25, 1]);
		expect(fromProvider.byteLength).toBe(12);
	});

	/**
	 * The three former `Extension` types describe genuinely different things, proved by
	 * assignment rather than by reading their declarations.
	 *
	 * While they shared a name this was invisible: a `ManifestExtension` has a `manifest`
	 * and a `level`, a `LoadedExtension` has `handlers` and `tools` and neither of those,
	 * and an `ExtensionRow` has an `id` and a `kind` and none of the rest. Nothing overlaps
	 * enough to substitute, so every place the wrong one was imported was a type error
	 * waiting on whichever module the editor happened to offer. Constructing all three and
	 * reading the field that only that one has is what makes this a check on the types.
	 */
	it("keeps the three former Extension types distinct", () => {
		const onDisk: ManifestExtension = {
			name: "gemini-ext",
			path: "/tmp/gemini-ext",
			manifest: { name: "gemini-ext", description: "a manifest, not a module" },
			level: "project",
			_source: { provider: "gemini", providerName: "Gemini", level: "project", path: "/tmp/gemini-ext" },
		};
		const executed: LoadedExtension = {
			path: "/tmp/ext.ts",
			resolvedPath: "/tmp/ext.ts",
			handlers: new Map(),
			tools: new Map(),
			assistantThinkingRenderers: [],
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const row: ExtensionRow = {
			id: "skill:review",
			kind: "skill",
			name: "review",
			displayName: "review",
			path: "/tmp/review/SKILL.md",
			source: { provider: "native", providerName: "Veyyon", level: "project" },
			state: "active",
			raw: { name: "review" },
		};

		expect(onDisk.manifest.description).toBe("a manifest, not a module");
		expect(executed.handlers.size).toBe(0);
		expect(row.kind).toBe("skill");
		// A row's kind is the tell: most Control Center rows are not extensions at all.
		expect(row.id).toBe(`${row.kind}:${row.name}`);
	});

	/**
	 * The three former `SessionEntry` unions are three different widths, proved by assignment.
	 *
	 * They were the worst case this suite guards against: three declarations, one name, and
	 * near-identical shapes for the variants they share, so importing the wrong one usually
	 * typechecked. `host.ts` is the evidence -- it could not name both, so it imported one
	 * `as WireSessionEntry` and the other `as StoredSessionEntry`, which is a file working
	 * around a naming collision rather than reading a vocabulary.
	 *
	 * The widths are the point. The host's union carries variants no guest renders, so a
	 * `mode_change` entry is a host entry and NOT a wire entry, and sending one to a guest
	 * that switches exhaustively over its own union is the bug the separation prevents. The
	 * stats one is wider than both: its `{ type: string }` arm admits any object with a
	 * `type`, so it accepts entries the other two reject on purpose, and a value from there
	 * must not pass for either.
	 */
	it("keeps the three former SessionEntry unions at their three different widths", () => {
		const shared = { id: "e1", parentId: null, timestamp: "2026-07-25T00:00:00.000Z" };
		const modelChange: WireSessionEntry = { ...shared, type: "model_change", model: "anthropic/opus" };
		const alsoAHostEntry: HostSessionEntry = modelChange;

		// A host entry the wire union has no variant for. It is a real persisted entry, and a
		// guest asked to render it would fall through every case it knows.
		const hostOnly: HostSessionEntry = { ...shared, type: "mode_change", mode: "plan" };
		const wireVariants = new Set<WireSessionEntry["type"]>([
			"message",
			"custom_message",
			"compaction",
			"branch_summary",
			"model_change",
			"thinking_level_change",
		]);

		// The stats union admits a line neither of the others does, which is why it parses
		// logs the other two would reject.
		const unknownLine: SessionLogEntry = { type: "something-stats-does-not-model" };

		expect(alsoAHostEntry.type).toBe("model_change");
		expect(wireVariants.has(hostOnly.type as WireSessionEntry["type"])).toBe(false);
		expect(unknownLine.type).toBe("something-stats-does-not-model");
		expect(wireVariants.has(unknownLine.type as WireSessionEntry["type"])).toBe(false);
	});

	/**
	 * The deprecated old names still resolve, and to the SAME type they were renamed from.
	 *
	 * Both packages are published, so removing `SessionEntry` outright would break a consumer
	 * that never saw the rename. The aliases are written as renamed exports rather than
	 * `export type SessionEntry = WireSessionEntry`, because an alias declaration is a second
	 * declaration and would defeat the check above -- so this asserts the compatibility path
	 * survives that choice rather than being quietly dropped by it.
	 */
	it("keeps the deprecated old names pointing at the renamed types", () => {
		const viaOldWireName: DeprecatedWireSessionEntry = {
			id: "e2",
			parentId: null,
			timestamp: "2026-07-25T00:00:00.000Z",
			type: "thinking_level_change",
			thinkingLevel: "high",
		};
		const viaNewWireName: WireSessionEntry = viaOldWireName;
		const viaOldStatsName: DeprecatedStatsSessionEntry = { type: "session" };
		const viaNewStatsName: SessionLogEntry = viaOldStatsName;

		expect(viaNewWireName.type).toBe("thinking_level_change");
		expect(viaNewStatsName.type).toBe("session");
	});

	it("keeps the sections field the diverged copy was missing", () => {
		const entry: PromptEntry = PROMPTS["subagent/system-prompt"];
		const sections: readonly PromptSection[] = entry.sections ?? [];

		expect(sections.map(section => section.id)).toEqual(["role", "context", "plan", "coop", "completion"]);
		expect(sections.every(section => typeof section.optional === "boolean")).toBe(true);
	});
});
