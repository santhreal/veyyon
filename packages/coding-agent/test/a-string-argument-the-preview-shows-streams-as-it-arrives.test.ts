/**
 * A string argument a tool's pending preview shows is decoded as it streams, on the live path, and the
 * live preview agrees with the rebuilt transcript.
 *
 * WHY THIS SUITE EXISTS. `STREAMING_STRING_KEYS_BY_TOOL` named `write`, `edit`, `apply_patch`, `eval` and
 * `launch`. Every other tool previewed its arguments from the throttled full parse, which re-runs only after
 * STREAMING_JSON_PARSE_MIN_GROWTH new bytes: an `ssh` command, a `browser` script, a `read` path past that
 * window advanced in steps of that size, and a short argument arriving after a long one waited for the next
 * step. The table is keyed by hand, so the defect class is a tool whose preview shows a string argument the
 * table does not list.
 *
 * WHAT IT DOES. Builds every tool the registry builds (`BUILTIN_TOOLS`, `HIDDEN_TOOLS`, the vibe-mode tools)
 * against a session that turns every feature flag on, reads each tool's wire schema for top-level string
 * arguments, and renders the real `ToolExecutionComponent` pending preview with a sentinel in each one, once
 * per value of each enum argument so an op-dependent preview is reached. For every argument the preview shows,
 * it streams a value past the throttle window through `ToolArgsRevealController` exactly as the event
 * controller does, grows it by fewer bytes than the throttle, and requires the fresh value, then requires
 * `decodeStreamedToolArgs` (the transcript rebuild) to produce the same value. A new tool, or a new argument a
 * preview shows, is red until the table lists it. There is no opt-out today: `NOT_DECODED` is pinned empty.
 *
 * WHAT IT DOES NOT CATCH. An argument shown only under a combination of two enum values, a nested argument
 * (`edits[].diff`), which the extractor never reads, and an MCP or extension tool, which the registry does not
 * build. A preview that shows an argument only after transforming it beyond recognition (hashing, counting)
 * does not register as showing it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core/types";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import {
	decodeStreamedToolArgs,
	STREAMING_STRING_KEYS_BY_TOOL,
	streamingStringKeysForTool,
	ToolArgsRevealController,
} from "@veyyon/coding-agent/modes/terminal/controllers/tool-args-reveal";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { createVibeModeTools } from "@veyyon/coding-agent/tools/agent/manifest";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools/index";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import type { TUI } from "@veyyon/tui";
import { STREAMING_JSON_PARSE_MIN_GROWTH, stripAnsi, TempDir } from "@veyyon/utils";
import { ArgotSession } from "argot";
import { createToolExecution } from "./helpers/tool-execution";
import { makeToolSession } from "./helpers/tool-session";

setDefaultTimeout(120_000);

/** Arguments a preview shows that the table leaves to the throttled parse, as `<tool>.<argument>`. */
const NOT_DECODED: readonly string[] = [];

/** Settings that turn on every tool gated behind a flag, so the sweep builds it rather than skipping it. */
const SWEEP_SETTINGS: Record<string, unknown> = {
	"argot.enabled": true,
	"autolearn.enabled": true,
	"debug.enabled": true,
	"memory.backend": "mnemopi",
	"tools.discoveryMode": "all",
	"lsp.enabled": true,
	"lsp.tool": true,
};

type SchemaNode = Record<string, unknown>;

/** Top-level properties of a wire schema, across every `anyOf`/`oneOf`/`allOf` branch. */
function topLevelProperties(schema: SchemaNode, out: Record<string, SchemaNode> = {}): Record<string, SchemaNode> {
	for (const branch of ["anyOf", "oneOf", "allOf"]) {
		const list = schema[branch];
		if (Array.isArray(list)) for (const sub of list) topLevelProperties(sub as SchemaNode, out);
	}
	const properties = schema.properties as Record<string, SchemaNode> | undefined;
	if (properties) for (const [key, node] of Object.entries(properties)) out[key] ??= node;
	return out;
}

function acceptsString(node: SchemaNode): boolean {
	const type = node.type;
	if (type === "string" || (Array.isArray(type) && type.includes("string"))) return true;
	const alternatives = node.anyOf ?? node.oneOf;
	return Array.isArray(alternatives) && alternatives.some(alt => (alt as SchemaNode).type === "string");
}

interface ToolArguments {
	/** Free-text string arguments: no enum, no const. */
	readonly free: string[];
	/** One argument object per enum value, plus the empty one, so an op-dependent preview is reached. */
	readonly variants: Record<string, unknown>[];
	/** Every top-level property the schema declares. */
	readonly declared: string[];
}

function argumentsOf(tool: AgentTool): ToolArguments {
	const properties = topLevelProperties(toolWireSchema(tool) as SchemaNode);
	const free = Object.keys(properties).filter(key => {
		const node = properties[key]!;
		return acceptsString(node) && !Array.isArray(node.enum) && node.const === undefined;
	});
	const variants: Record<string, unknown>[] = [{}];
	for (const [key, node] of Object.entries(properties)) {
		if (Array.isArray(node.enum)) for (const value of node.enum) variants.push({ [key]: value });
	}
	return { free, variants, declared: Object.keys(properties) };
}

const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;

/** The free-text arguments the pending preview draws, found by the sentinel each one carries. */
function shownArguments(tool: AgentTool, args: ToolArguments): string[] {
	const sentinel = (key: string): string => `zq${key}zq`;
	const shown = new Set<string>();
	for (const variant of args.variants) {
		const values: Record<string, unknown> = { ...variant };
		for (const key of args.free) values[key] = sentinel(key);
		const component = createToolExecution(
			tool.name,
			{ ...values, __partialJson: JSON.stringify(values).slice(0, -1) },
			{},
			tool,
			ui,
			process.cwd(),
			"call-shown",
		);
		component.setExpanded(true);
		const text = stripAnsi(component.render(500).join("\n"));
		component.stopAnimation();
		for (const key of args.free) if (text.includes(sentinel(key))) shown.add(key);
	}
	return [...shown];
}

/**
 * Stream `key` past the throttle window, grow it by less than the throttle, and return the value the live
 * reveal hands the preview and the value the transcript rebuild decodes from the same buffer.
 */
function streamPastTheThrottle(toolName: string, key: string): { live: unknown; rebuilt: unknown; expected: string } {
	const body = "x".repeat(STREAMING_JSON_PARSE_MIN_GROWTH + 24);
	const seed = `{${JSON.stringify(key)}:"${body}`;
	const grown = `${seed}tail`;
	const streamingStringKeys = streamingStringKeysForTool(toolName, false);
	const target = { rawInput: false, exposeRawPartialJson: false, streamingStringKeys };
	const controller = new ToolArgsRevealController({ getSmoothStreaming: () => false, requestRender: () => {} });
	controller.setTarget("call-stream", seed, target);
	const live = controller.setTarget("call-stream", grown, target)[key];
	controller.finish("call-stream");
	const rebuilt = decodeStreamedToolArgs(grown, { rawInput: false, fullArgs: { [key]: body }, streamingStringKeys })[
		key
	];
	return { live, rebuilt, expected: `${body}tail` };
}

interface Sweep {
	readonly unconstructable: string[];
	readonly notRegistered: string[];
	readonly built: Map<string, { tool: AgentTool; args: ToolArguments }>;
}

const agentDir = TempDir.createSync("@streamed-keys-profile-");

async function buildRegistry(): Promise<Sweep> {
	// One host registers `ssh`; one adapter command that resolves registers `debug`. Without them each
	// factory returns null and the tool drops out of the sweep.
	fs.writeFileSync(
		path.join(agentDir.path(), "ssh.json"),
		JSON.stringify({ hosts: { probe: { host: "127.0.0.1" } } }),
	);
	fs.writeFileSync(
		path.join(agentDir.path(), "dap.json"),
		JSON.stringify({ adapters: { probe: { command: process.execPath, languages: ["javascript"] } } }),
	);
	const session = makeToolSession({
		// `getAdapterConfigs` reads `dap.json` from the session cwd.
		cwd: agentDir.path(),
		hasUI: true,
		agentRegistry: new AgentRegistry(),
		getAgentId: () => "Main",
		getArgotSession: () => new ArgotSession(),
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async () => [],
		settings: { get: (key: string) => SWEEP_SETTINGS[key], getAgentDir: () => agentDir.path() },
	});
	const unconstructable: string[] = [];
	const notRegistered: string[] = [];
	const tools: AgentTool[] = [];
	for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS })) {
		try {
			const tool = await factory(session);
			if (tool) tools.push(tool as AgentTool);
			else notRegistered.push(name);
		} catch (error) {
			unconstructable.push(`${name}: ${error}`);
		}
	}
	tools.push(...((await createVibeModeTools(session)) as AgentTool[]));
	const built = new Map<string, { tool: AgentTool; args: ToolArguments }>();
	for (const tool of tools) built.set(tool.name, { tool, args: argumentsOf(tool) });
	return { unconstructable, notRegistered, built };
}

describe("a string argument the preview shows streams as it arrives", () => {
	let sweep: Sweep;
	/** `<tool>.<argument>` for every argument a pending preview shows. */
	let shown: string[];

	beforeAll(async () => {
		await initTheme();
		sweep = await buildRegistry();
		shown = [];
		for (const [name, { tool, args }] of sweep.built) {
			for (const key of shownArguments(tool, args)) shown.push(`${name}.${key}`);
		}
		shown.sort();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		agentDir.removeSync();
	});

	it("builds every tool the registry declares", () => {
		expect(sweep.unconstructable).toEqual([]);
		expect(sweep.notRegistered).toEqual([]);
	});

	/** Non-vacuity: the four arguments the defect was reported against are among the ones the sweep drives. */
	it("finds the reported arguments in the previews it renders", () => {
		expect(shown).toEqual(expect.arrayContaining(["browser.code", "debug.program", "read.path", "ssh.command"]));
	});

	it("keeps every shown argument fresh past the throttle window, identical to the rebuilt transcript", () => {
		const stale: string[] = [];
		const diverged: string[] = [];
		for (const entry of shown) {
			const [toolName, key] = entry.split(".") as [string, string];
			const { live, rebuilt, expected } = streamPastTheThrottle(toolName, key);
			if (live !== expected) stale.push(entry);
			if (live !== rebuilt) diverged.push(entry);
		}
		expect(stale).toEqual([...NOT_DECODED]);
		expect(diverged).toEqual([...NOT_DECODED]);
	});

	it("lists no tool the registry does not build and no renderer binds", () => {
		const unknown = Object.keys(STREAMING_STRING_KEYS_BY_TOOL).filter(
			name => !sweep.built.has(name) && !(name in toolRenderers),
		);
		expect(unknown).toEqual([]);
	});

	/**
	 * A listed argument the schema does not declare is dead unless a model still sends it. These are the legacy
	 * spellings the edit and write renderers read before validation coerces them; a typo lands here too.
	 */
	it("lists only declared arguments, apart from the pinned legacy spellings", () => {
		const undeclared: string[] = [];
		for (const [name, keys] of Object.entries(STREAMING_STRING_KEYS_BY_TOOL)) {
			const built = sweep.built.get(name);
			if (!built) continue;
			for (const key of keys) if (!built.args.declared.includes(key)) undeclared.push(`${name}.${key}`);
		}
		expect(undeclared.sort()).toEqual(["edit._input", "edit.file_path", "edit.path", "write.file_path"]);
	});
});
