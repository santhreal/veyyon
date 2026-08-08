/**
 * A tool called from an eval cell is validated against its own schema, exactly
 * as one the model calls through the agent loop is.
 *
 * WHY THIS SUITE EXISTS. `agent-loop.ts` runs `validateToolArguments` before
 * `tool.execute`, so a model that omits a required argument gets a tool result
 * naming the field. The eval bridge called `execute` directly, which made a
 * cell the one caller in the process that could hand a tool a shape its schema
 * rejects. That is not a cosmetic gap: `tool.ask({ questions: [{ id, options
 * }] })` reached the ask dialog with no question text, `replaceTabs(undefined)`
 * threw inside a render pass, and an uncaught exception in the render loop took
 * down the session and every subagent under it.
 *
 * WHAT CLASS THIS CLOSES. For every tool the bridge can reach that declares a
 * required argument, a call missing that argument is refused before `execute`
 * runs, on every transport that carries a cell's tool call. The tool list is
 * enumerated from `BUILTIN_TOOLS` / `HIDDEN_TOOLS` at run time and the required
 * arguments come from each tool's own schema, so a new tool, or a new required
 * field on an existing one, is covered the day it lands. The sweep pins the
 * whole partition of the registry by exact equality (checked, no required
 * arguments, not registered for this session, opted out, unconstructable), so a
 * tool that lands in any bucket turns this suite red until someone records
 * which bucket it belongs in. The eval languages are read from the eval tool's
 * own wire schema at run time and each one is mapped to the transport that
 * carries it, so a fifth runtime is red until its transport is named and
 * driven.
 *
 * WHAT IT DOES NOT CATCH. A tool whose schema declares nothing required
 * validates nothing: validation cannot invent a contract the tool never
 * stated. A cross-field rule expressed in code rather than in the schema is
 * likewise still the tool's own business. The browser tab worker transport
 * needs a live Chromium, so it is pinned as undriven with its reason rather
 * than silently skipped: a regression reachable only through that worker and
 * through no other transport would not be caught here. And a bridge added later
 * that calls `tool.execute` itself instead of `callSessionTool` is a new caller
 * rather than a regression of this one; the transport table below is where that
 * decision has to be recorded.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai/types";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import { executeJs } from "@veyyon/coding-agent/eval/js/executor";
import { JsRuntime } from "@veyyon/coding-agent/eval/js/shared/runtime";
import { callSessionTool } from "@veyyon/coding-agent/eval/js/tool-bridge";
import {
	disposeKernelToolBridge,
	ensureKernelToolBridge,
	registerKernelToolBridge,
} from "@veyyon/coding-agent/eval/kernel-tool-bridge";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { AskTool } from "@veyyon/coding-agent/tools/ask";
import { type CmuxTab, runCmuxCode } from "@veyyon/coding-agent/tools/browser/cmux/cmux-tab";
import type { SessionSnapshot } from "@veyyon/coding-agent/tools/browser/tab-protocol";
import { evalSchema } from "@veyyon/coding-agent/tools/eval";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools/index";
import { TempDir } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { ArgotSession } from "argot";
import { type } from "arktype";
import { makeToolSession } from "../helpers/tool-session";

// The JS worker cold-starts a Bun worker, and three of the transport cases pay
// that cost. Bun's 5s default is below the worker-init floor on a loaded box.
setDefaultTimeout(30_000);

/**
 * The parts of a tool this suite reads. A concrete tool class narrows
 * `execute` to its own schema, so `AskTool` is not assignable to the erased
 * `AgentTool`; naming the members actually used keeps the real classes usable
 * without a cast.
 */
interface ToolUnderTest {
	name: string;
	label?: string;
	description: string;
	parameters: TSchema;
	lenientArgValidation?: boolean;
}

/** Thrown by every stand-in `execute`, so "the call got through" is observable. */
const EXECUTED = "the tool executed";

/** The ask payload that killed a session: every field but the one the dialog renders. */
const ASK_WITHOUT_QUESTION_TEXT = {
	questions: [{ id: "dest", header: "Skill dest", options: [{ label: "packages/argot" }], multi: false }],
};

function ok(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

/**
 * A stand-in carrying the real tool's name and schema but not its behaviour.
 * Validation is the thing under test, so a call that gets past it must be
 * observable without running `bash`, writing a file, or opening a dialog.
 *
 * `parameters` is delegated through a getter rather than copied: `edit`, `eval`
 * and `task` compute theirs from session state inside a getter that reads
 * `#private` fields, so a spread or an `Object.create` clone loses the schema
 * (or throws reading it) and the sweep would pass for the wrong reason.
 */
function refusingClone(real: ToolUnderTest): AgentTool {
	return {
		name: real.name,
		label: real.label ?? real.name,
		description: real.description,
		get parameters() {
			return real.parameters;
		},
		lenientArgValidation: real.lenientArgValidation,
		execute: async () => {
			throw new Error(EXECUTED);
		},
	};
}

/** The argument names a tool's own schema declares mandatory. */
function requiredArguments(tool: ToolUnderTest): string[] {
	const schema = toolWireSchema(tool);
	const required = schema.required;
	if (!Array.isArray(required)) return [];
	return required.filter((key): key is string => typeof key === "string" && key !== INTENT_FIELD);
}

/**
 * The language tokens the eval tool advertises, read from its own wire schema
 * rather than from a list here. `evalSchema` carries the full union; the
 * per-session schema narrows it to the backends that session enables, which
 * would let a runtime that is merely disabled in the sandbox slip the table
 * below.
 */
function advertisedLanguages(): string[] {
	const wire = toolWireSchema({
		name: "eval",
		description: "eval",
		parameters: evalSchema,
	});
	const tokens = new Set<string>();
	const walk = (node: unknown): void => {
		if (node === null || typeof node !== "object") return;
		const obj = node as Record<string, unknown>;
		if (typeof obj.const === "string") tokens.add(obj.const);
		if (Array.isArray(obj.enum)) {
			for (const value of obj.enum) if (typeof value === "string") tokens.add(value);
		}
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			const branch = obj[key];
			if (Array.isArray(branch)) for (const item of branch) walk(item);
		}
	};
	walk((wire.properties as Record<string, unknown> | undefined)?.language);
	return [...tokens].sort();
}

/**
 * Drives one transport for real and reports what the cell saw: the refusal
 * text, or `accepted` when the call got through. Every driver reaches
 * `callSessionTool` the way the product does, so a transport that stopped
 * routing through the shared bridge fails here instead of passing on the
 * strength of a helper being named "shared".
 */
type TransportDriver = (session: ToolSession, name: string, args: Record<string, unknown>) => Promise<string>;

const SNAPSHOT = { cwd: process.cwd() } as unknown as SessionSnapshot;

/** The narrowest tab `runCmuxCode` touches, with a real `JsRuntime` behind it. */
function stubTab(): CmuxTab {
	let runtime: JsRuntime | undefined;
	return {
		page: {},
		browser: {},
		setRunContext: () => {},
		clearRunContext: () => {},
		ensureRuntime: () => {
			runtime ??= new JsRuntime({ initialCwd: process.cwd(), sessionId: "eval-arg-validation-cmux" });
			return runtime;
		},
	} as unknown as CmuxTab;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const workerTemp = TempDir.createSync("@eval-arg-validation-");
const workerSessionFile = path.join(workerTemp.path(), "session.jsonl");
const workerSessionId = `session:${workerSessionFile}:cwd:${workerTemp.path()}`;

const driveJsWorker: TransportDriver = async (session, name, args) => {
	const result = await executeJs(`await tool.${name}(${JSON.stringify(args)});`, {
		sessionId: workerSessionId,
		sessionFile: workerSessionFile,
		session,
	});
	return result.exitCode === 0 ? "accepted" : result.output;
};

const driveKernelHttp: TransportDriver = async (session, name, args) => {
	const info = await ensureKernelToolBridge();
	const unregister = registerKernelToolBridge("eval-arg-validation", "run-1", { toolSession: session });
	try {
		const res = await fetch(`${info.url}/v1/tool`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.token}` },
			body: JSON.stringify({
				session: "eval-arg-validation",
				run: "run-1",
				name,
				args: { ...args, [INTENT_FIELD]: "py prelude" },
			}),
		});
		const body = (await res.json()) as { ok: boolean; error?: string };
		return body.ok ? "accepted" : (body.error ?? "refused with no message");
	} finally {
		unregister();
		await disposeKernelToolBridge();
	}
};

const driveCmux: TransportDriver = async (session, name, args) => {
	try {
		await runCmuxCode(stubTab(), {
			code: `await tool.${name}(${JSON.stringify(args)});`,
			timeoutMs: 15_000,
			snapshot: SNAPSHOT,
			session,
		});
		return "accepted";
	} catch (error) {
		return messageOf(error);
	}
};

/**
 * Every transport that carries a cell's tool call, and how this suite drives
 * it. `browser tab worker` is the one that cannot be driven here: it connects
 * to a live Chromium over a websocket endpoint, which the sandbox has no
 * browser for. It is pinned rather than omitted so the gap stays visible.
 */
const TRANSPORTS: Record<string, TransportDriver | null> = {
	"browser tab worker": null,
	"cmux in-process runtime": driveCmux,
	"js worker": driveJsWorker,
	"kernel http bridge": driveKernelHttp,
};

/**
 * The intent each transport carries. The bridge strips this field before
 * validation and puts it back on the executed arguments, so the exact value is
 * pinned rather than matched loosely: a transport that lost the round trip, or
 * that started sending someone else's intent, is a renderer reading the wrong
 * label.
 */
const INTENT_ON_THE_WIRE: Record<string, string> = {
	"cmux in-process runtime": "js prelude",
	"js worker": "js prelude",
	"kernel http bridge": "py prelude",
};

/** Which transport carries each language the eval tool advertises. */
const TRANSPORT_BY_LANGUAGE: Record<string, string> = {
	jl: "kernel http bridge",
	js: "js worker",
	py: "kernel http bridge",
	rb: "kernel http bridge",
};

/**
 * The registry partition, pinned by exact equality. Every registered tool lands
 * in exactly one of these buckets plus `optedOut` and `unconstructable`, so a
 * tool that is added, renamed, given a required argument, or stops being
 * registered for a UI session turns the sweep red until the move is recorded
 * here. Counting instead of pinning is how a tool stops being validated with
 * nobody noticing.
 */
const CHECKED_BY_THE_SWEEP: string[] = [
	"argot_load",
	"argot_unload",
	"ask",
	"ast_edit",
	"ast_grep",
	"bash",
	"browser",
	"checkpoint",
	"debug",
	"edit",
	"eval",
	"github",
	"goal",
	"grep",
	"inspect_image",
	"irc",
	"launch",
	"learn",
	"lsp",
	"manage_skill",
	"memory_edit",
	"read",
	"recall",
	"reflect",
	"report_finding",
	"report_tool_issue",
	"resolve",
	"retain",
	"rewind",
	"search_tool_bm25",
	"set_cwd",
	"ssh",
	"task",
	"web_search",
	"write",
];

/**
 * Tools whose schema declares nothing mandatory. Validation has no contract to
 * enforce for these, so the sweep cannot check them; a tool that appears here
 * after previously being checked has dropped a required argument, which is
 * exactly the change that should be looked at.
 */
const NO_REQUIRED_ARGUMENTS: string[] = ["glob", "job", "todo"];

/**
 * Tools no session can register, whatever the settings say. Empty, and it has
 * to stay empty: a factory that returns null here is a tool the sweep never
 * validated.
 */
const NOT_REGISTERED_FOR_THIS_SESSION: string[] = [];

/**
 * Settings the sweep session answers, so a tool gated behind a feature flag is
 * swept rather than skipped. Everything else falls to its own default.
 */
const SWEEP_SETTINGS: Record<string, unknown> = {
	"argot.enabled": true,
	"autolearn.enabled": true,
	"debug.enabled": true,
	"memory.backend": "mnemopi",
	// "auto" resolves to "off" below the tool-count threshold, which would drop
	// `search_tool_bm25` out of the sweep.
	"tools.discoveryMode": "all",
};

const argotSession = new ArgotSession();
const sweepAgentDir = TempDir.createSync("@eval-arg-validation-profile-");

describe("an eval cell cannot run a tool with arguments its schema rejects", () => {
	beforeAll(async () => {
		// One host is all `loadSshTool` needs to register the tool; without it the
		// factory returns null and `ssh` drops out of the sweep unswept.
		await fs.writeFile(
			path.join(sweepAgentDir.path(), "ssh.json"),
			JSON.stringify({ hosts: { probe: { host: "127.0.0.1" } } }),
		);
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		workerTemp.removeSync();
		sweepAgentDir.removeSync();
	});

	it("refuses the ask payload that killed a session: a question with no text", async () => {
		const ask = new AskTool(makeToolSession());
		const session = makeToolSession({ getToolByName: () => refusingClone(ask) });

		const call = callSessionTool("ask", ASK_WITHOUT_QUESTION_TEXT, { session });

		const error = await call.then(
			() => undefined,
			(err: unknown) => (err instanceof Error ? err : new Error(String(err))),
		);
		expect(error?.message).toContain('Validation failed for tool "ask"');
		expect(error?.message).toContain("question");
		// Never reached `execute`, so nothing rendered and nothing was recorded.
		expect(error?.message).not.toContain(EXECUTED);
	});

	it("sorts every registered tool into a pinned bucket, so a new tool is a decision", async () => {
		// A tool the sweep cannot construct is a hole, not a pass, so the session
		// below turns on every feature that gates a factory: `ask` needs a UI,
		// `debug`, the four memory tools, `learn`, `manage_skill` and the two
		// Argot tools read settings, `irc` needs a registry and an agent id,
		// `search_tool_bm25` needs the three discovery callbacks, and `ssh`
		// resolves its hosts from `ssh.json` in the profile dir, which
		// `sweepAgentDir` supplies.
		const session = makeToolSession({
			hasUI: true,
			agentRegistry: new AgentRegistry(),
			getAgentId: () => "Main",
			getArgotSession: () => argotSession,
			isToolDiscoveryEnabled: () => true,
			getSelectedDiscoveredToolNames: () => [],
			activateDiscoveredTools: async () => [],
			settings: {
				get: (key: string) => SWEEP_SETTINGS[key],
				getAgentDir: () => sweepAgentDir.path(),
			},
		});
		const factories = Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS });
		const checked: string[] = [];
		const unconstructable: string[] = [];
		const accepted: string[] = [];
		const optedOut: string[] = [];
		const noRequiredArguments: string[] = [];
		const notRegistered: string[] = [];

		for (const [name, factory] of factories) {
			let real: AgentTool | null = null;
			try {
				real = await factory(session);
			} catch {
				unconstructable.push(name);
				continue;
			}
			if (!real) {
				notRegistered.push(name);
				continue;
			}
			if (requiredArguments(real).length === 0) {
				noRequiredArguments.push(real.name);
				continue;
			}
			if (real.lenientArgValidation) {
				optedOut.push(real.name);
				continue;
			}

			const guarded = makeToolSession({ getToolByName: () => refusingClone(real) });
			const failure = await callSessionTool(real.name, {}, { session: guarded }).then(
				() => "accepted",
				(err: unknown) => messageOf(err),
			);
			checked.push(real.name);
			if (!failure.includes("Validation failed for tool") || failure.includes(EXECUTED)) {
				accepted.push(`${real.name}: ${failure}`);
			}
		}

		expect(accepted).toEqual([]);
		// A tool that cannot even be constructed here is a hole in the sweep, not
		// a tool that is safe.
		expect(unconstructable).toEqual([]);
		// `lenientArgValidation` switches this gate off for one tool, so the set
		// that opts out is pinned rather than counted. `yield` validates its own
		// structured payload against the caller's schema in `execute`; a second
		// name showing up here is a tool that stopped being validated by anyone,
		// and this assertion is where that decision gets recorded.
		expect(optedOut).toEqual(["yield"]);
		// The remaining buckets are pinned by exact equality for the same reason.
		// A new tool lands in exactly one of them and turns this red; a tool that
		// silently drops its required arguments moves between two of them and
		// turns this red as well. Counting instead of pinning is what lets a tool
		// stop being validated without anyone noticing.
		expect(checked.sort()).toEqual(CHECKED_BY_THE_SWEEP);
		expect(noRequiredArguments.sort()).toEqual(NO_REQUIRED_ARGUMENTS);
		expect(notRegistered.sort()).toEqual(NOT_REGISTERED_FOR_THIS_SESSION);
	});

	it("names a transport for every language the eval tool advertises", () => {
		// Read from the tool's own schema, so adding a fifth runtime is red here
		// until someone says which transport carries its tool calls.
		expect(advertisedLanguages()).toEqual(Object.keys(TRANSPORT_BY_LANGUAGE).sort());
		// And each of those transports is one this suite actually drives, so a
		// language cannot be mapped to a name that runs nothing.
		const unmapped = Object.entries(TRANSPORT_BY_LANGUAGE)
			.filter(([, transport]) => !TRANSPORTS[transport])
			.map(([language, transport]) => `${language} -> ${transport}`);
		expect(unmapped).toEqual([]);
		// The transports this suite cannot drive are pinned by name, so the gap is
		// a recorded decision rather than a missing case nobody counted.
		const undriven = Object.entries(TRANSPORTS)
			.filter(([, driver]) => driver === null)
			.map(([name]) => name);
		expect(undriven).toEqual(["browser tab worker"]);
	});

	const drivable = Object.entries(TRANSPORTS).filter((entry): entry is [string, TransportDriver] => entry[1] !== null);

	for (const [transport, drive] of drivable) {
		it(`refuses the unrenderable ask payload over the ${transport}`, async () => {
			const ask = new AskTool(makeToolSession());
			const session = makeToolSession({
				getToolByName: () => refusingClone(ask),
				settings: Settings.isolated(),
			});

			const outcome = await drive(session, "ask", ASK_WITHOUT_QUESTION_TEXT);

			expect(outcome).toContain('Validation failed for tool "ask"');
			expect(outcome).not.toContain(EXECUTED);
			expect(outcome).not.toBe("accepted");

			// A refusal must end, and it must leave the transport usable. A bridge
			// that dropped the reply, or left the call in its pending map, shows up
			// here as a test timeout rather than as a stalled operator.
			expect(await drive(session, "ask", ASK_WITHOUT_QUESTION_TEXT)).toContain('Validation failed for tool "ask"');
		});

		it(`repairs and forwards a well-formed call over the ${transport}`, async () => {
			let seen: unknown;
			const counter: AgentTool = {
				name: "counter",
				label: "Counter",
				description: "counter",
				parameters: type({ limit: "number" }),
				execute: async (_id: string, args: unknown) => {
					seen = args;
					return ok("counted");
				},
			};
			const session = makeToolSession({
				getToolByName: () => counter,
				settings: Settings.isolated(),
			});

			// A numeric string is what a schema repair exists for. Validation must
			// not become a refusal of everything it touches, and the repaired value
			// has to be what `execute` receives rather than the raw one.
			expect(await drive(session, "counter", { limit: "3" })).toBe("accepted");
			expect(seen).toEqual({ limit: 3, [INTENT_FIELD]: INTENT_ON_THE_WIRE[transport] });
		});

		it(`keeps the injected intent out of a closed schema over the ${transport}`, async () => {
			let seen: unknown;
			// The shape an MCP server publishes. Validating the harness-injected
			// intent against it would reject every single call from a cell.
			const closed: AgentTool = {
				name: "closed",
				label: "Closed",
				description: "closed",
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
					additionalProperties: false,
				},
				execute: async (_id: string, args: unknown) => {
					seen = args;
					return ok("read");
				},
			};
			const session = makeToolSession({
				getToolByName: () => closed,
				settings: Settings.isolated(),
			});

			expect(await drive(session, "closed", { path: "src/foo.ts" })).toBe("accepted");
			expect(seen).toEqual({ path: "src/foo.ts", [INTENT_FIELD]: INTENT_ON_THE_WIRE[transport] });

			// The same closed schema still enforces itself on this transport.
			expect(await drive(session, "closed", {})).toContain('Validation failed for tool "closed"');
		});
	}

	it("refuses arguments that are not an object at all", async () => {
		const tool: AgentTool = {
			name: "reader",
			label: "Reader",
			description: "reader",
			parameters: type({ path: "string" }),
			execute: async () => ok("read"),
		};
		const session = makeToolSession({ getToolByName: () => tool });

		await expect(callSessionTool("reader", "src/foo.ts", { session })).rejects.toThrow(
			/expects an object of arguments, received string/,
		);
		await expect(callSessionTool("reader", 7, { session })).rejects.toThrow(
			/expects an object of arguments, received number/,
		);
		await expect(callSessionTool("reader", null, { session })).rejects.toThrow(
			/expects an object of arguments, received null/,
		);
		await expect(callSessionTool("reader", ["src/foo.ts"], { session })).rejects.toThrow(
			/expects an object of arguments, received/,
		);
	});

	it("honors a tool that opts out of validation", async () => {
		let seen: unknown;
		const tool: AgentTool = {
			name: "lenient",
			label: "Lenient",
			description: "lenient",
			parameters: type({ path: "string" }),
			lenientArgValidation: true,
			execute: async (_id: string, args: unknown) => {
				seen = args;
				return ok("ran");
			},
		};
		const session = makeToolSession({ getToolByName: () => tool });

		expect(await callSessionTool("lenient", {}, { session })).toBe("ran");
		expect(seen).toEqual({ [INTENT_FIELD]: "js prelude" });

		// The opt-out covers the shape check too. A tool that asked for no
		// validation must not be handed a refusal the object branch invented.
		expect(await callSessionTool("lenient", "a bare string", { session })).toBe("ran");
		expect(seen).toBe("a bare string");
	});

	it("passes a well-formed call through unchanged", async () => {
		let seen: unknown;
		const tool: AgentTool = {
			name: "reader",
			label: "Reader",
			description: "reader",
			parameters: type({ path: "string", "offset?": "number" }),
			execute: async (_id: string, args: unknown) => {
				seen = args;
				return ok("contents");
			},
		};
		const session = makeToolSession({ getToolByName: () => tool });

		expect(
			await callSessionTool("reader", { path: "src/foo.ts", offset: 12, i: "reading a file" }, { session }),
		).toBe("contents");
		expect(seen).toEqual({ path: "src/foo.ts", offset: 12, [INTENT_FIELD]: "reading a file" });
	});
});
