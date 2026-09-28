/**
 * WHY: the terminal draws a tool call from the view registry, and the host
 * builds the window's presentation from the `view` on the tool instance,
 * falling back to the generic row when the instance has none. A tool whose
 * card exists only in the registry is drawn as a card in the terminal and as
 * raw arguments in the window, and nothing recorded which tools those were.
 *
 * THE CLASS THIS CLOSES: an undecided tool, and a decision that disagrees
 * with what the host builds. The sweep reads `BUILTIN_TOOL_NAMES`,
 * `HIDDEN_TOOL_NAMES` and every name the terminal has a renderer for at run
 * time, builds each tool the way a session does, and observes both hosts'
 * call presentation. A new tool or renderer turns this red until
 * `TOOL_PRESENTATIONS` records it; a recorded card the window does not receive,
 * or a recorded gap the window has since closed, turns it red too. Opt-outs and
 * gaps are pinned by exact equality.
 *
 * WHAT IT DOES NOT CATCH: a view that draws the call alike on both hosts and
 * the result differently, since the call view stands for both here; and how
 * the desktop app draws a `ToolView` kind, which its own suites drive.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import type { ArgotSession } from "argot/session";
import { carrierKind, membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import { TOOL_PRESENTATIONS } from "../../../src/gui-host/desktop-parity/tools";
import { buildToolCallPresentation, formatGenericCallView } from "../../../src/gui-host/presentation";
import { buildToolExecutionDisplay } from "../../../src/presentation/tool-execution";
import { AgentRegistry } from "../../../src/registry/agent-registry";
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type Tool, type ToolFactory, type ToolSession } from "../../../src/tools";
import { createVibeTools } from "../../../src/tools/agent/vibe";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } from "../../../src/tools/core/builtin-names";
import { toolRenderers, toolViewDefinitions } from "../../../src/tools/renderers";
import { DebugTool } from "../../../src/tools/shell/debug";
import { SshTool } from "../../../src/tools/shell/ssh";
import { makeToolSession } from "../../helpers/tool-session";

const RECORDED_GAPS = [
	"ask",
	"ast_edit",
	"browser",
	"github",
	"irc",
	"launch",
	"read",
	"search",
	"todo",
	"web_search",
	"write",
];

const RECORDED_OPT_OUTS = [
	"argot_load",
	"argot_unload",
	"checkpoint",
	"learn",
	"manage_skill",
	"memory_edit",
	"report_tool_issue",
	"rewind",
	"yield",
];

/** The settings that make every optional builtin construct, each at its non-default value. */
const ENABLED: Record<string, unknown> = {
	"lsp.enabled": true,
	"lsp.tool": true,
	"memory.backend": "mnemopi",
	"autolearn.enabled": true,
	"argot.enabled": true,
	"tools.discoveryMode": "all",
};

/**
 * Tools whose factory also reads the machine: `debug` constructs only where a
 * debugger adapter is installed and `ssh` only where hosts are configured. Their
 * presentation is the class's, so the sweep builds them the same on every host.
 */
const GATED_BY_THE_MACHINE: Record<string, (session: ToolSession) => Tool> = {
	debug: session => new DebugTool(session),
	ssh: session => new SshTool(session, [], new Map(), ""),
};

const SWEPT = [...new Set<string>([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES, ...Object.keys(toolRenderers)])].sort();

const instances = new Map<string, Tool>();

beforeAll(async () => {
	const session = makeToolSession({
		cwd: import.meta.dirname,
		hasUI: true,
		settings: { get: path => ENABLED[path] },
		enableLsp: true,
		taskDepth: 0,
		agentRegistry: new AgentRegistry(),
		getAgentId: () => "Main",
		// The folder tools construct when a codec is present and read it only when they run.
		getArgotSession: () => ({}) as ArgotSession,
		isToolDiscoveryEnabled: () => true,
		getSelectedDiscoveredToolNames: () => [],
		activateDiscoveredTools: async () => [],
	});
	const factories: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	for (const [name, factory] of Object.entries(factories)) {
		const tool = await (GATED_BY_THE_MACHINE[name] ?? factory)(session);
		if (tool) instances.set(name, tool);
	}
	for (const tool of createVibeTools(session)) instances.set(tool.name, tool);
});

/**
 * The instance the session registry holds a call under. A renderer-only name
 * that shares its view definition with a constructed tool is that tool's wire
 * spelling, and the registry holds the call under the tool.
 */
function instanceFor(name: string): Tool | undefined {
	const own = instances.get(name);
	if (own) return own;
	const definition = toolViewDefinitions[name];
	const sibling = Object.keys(toolViewDefinitions).find(
		other => other !== name && toolViewDefinitions[other] === definition && instances.has(other),
	);
	return sibling === undefined ? undefined : instances.get(sibling);
}

interface Observed {
	kind: "host" | "optOut" | "gap";
	matchesTerminal: boolean;
}

/** Both hosts' presentation of a call with no arguments yet, as a streaming call first appears. */
function observe(name: string): Observed {
	const tool = instanceFor(name);
	const context = { expanded: false, partial: true };
	const terminal = buildToolExecutionDisplay({ toolName: name, args: {}, tool, isPartial: true }).callView;
	const desktop = buildToolCallPresentation(name, {}, tool, context).view;
	if (!isDeepStrictEqual(desktop, formatGenericCallView(name, {}, context))) {
		return { kind: "host", matchesTerminal: isDeepStrictEqual(desktop, terminal) };
	}
	return { kind: terminal ? "gap" : "optOut", matchesTerminal: terminal === undefined };
}

describe("every tool the terminal renders has a desktop presentation", () => {
	test("each builtin, hidden and renderer-backed tool has a presentation, and only those do", () => {
		expect(Object.keys(TOOL_PRESENTATIONS).sort()).toEqual(SWEPT);
	});

	test("every swept tool constructs, so no tool is decided without being observed", () => {
		expect(SWEPT.filter(name => instanceFor(name) === undefined)).toEqual([]);
	});

	test("each recorded presentation is the one the host builds", () => {
		const disagreeing = SWEPT.flatMap(name => {
			const recorded = Object.hasOwn(TOOL_PRESENTATIONS, name) ? carrierKind(TOOL_PRESENTATIONS[name]) : "undecided";
			const observed = observe(name).kind;
			return recorded === observed ? [] : [`${name}: recorded ${recorded}, observed ${observed}`];
		});
		expect(disagreeing).toEqual([]);
	});

	test("a tool the window draws a card for receives the card the terminal draws", () => {
		const carried = membersCarriedBy(TOOL_PRESENTATIONS, "host");
		expect(carried.filter(name => !observe(name).matchesTerminal)).toEqual([]);
	});

	test("the tools drawn generically on both hosts are exactly the recorded opt-outs", () => {
		expect(membersCarriedBy(TOOL_PRESENTATIONS, "optOut")).toEqual(RECORDED_OPT_OUTS);
	});

	test("the tools the window draws generically while the terminal draws a card are exactly the recorded gaps", () => {
		expect(membersCarriedBy(TOOL_PRESENTATIONS, "gap")).toEqual(RECORDED_GAPS);
	});
});
