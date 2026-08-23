/**
 * A tool call the model sent through the provider is refused by name before the
 * tool runs, not by a crash from inside it.
 *
 * WHY THIS SUITE EXISTS. Two recorded sessions carry a tool result whose whole
 * text is a JavaScript type error from inside the product:
 *
 *   launch -> `undefined is not an object (evaluating 'operation.op')`
 *   edit   -> `A.startsWith is not a function. (In 'A.startsWith("\uFEFF")', ...)`
 *
 * Both calls arrived with `arguments: {}`. Neither message names the argument
 * that was missing, so the model cannot tell "you omitted `op`" from "the
 * launch subsystem is broken", and the second is what a type error reads as:
 * one of them was retried four times in a row.
 *
 * WHAT CLASS THIS CLOSES. The caller is the agent loop, which is a different
 * caller from the eval bridge closed by
 * `test/eval/a-cell-cannot-run-a-tool-with-arguments-its-schema-rejects.test.ts`.
 * That suite drives `callSessionTool`; this one drives `agentLoop` with a mock
 * provider, through the real `repairToolCallArguments` the product wires, for
 * every tool the registry builds. A tool whose schema declares a required
 * argument must refuse `{}` with a message naming the field, and `execute` must
 * never be entered. A tool added later is swept the day it lands, and a tool
 * that starts accepting `{}` and dereferencing the field anyway lands in
 * `reachedTheTool`, which is pinned empty.
 *
 * The repair pipeline is part of the contract, not scenery: it renames a single
 * plausible donor key onto a missing required field, so the sweep also pins
 * that an empty object has no donor to rename and that two donors are refused
 * as ambiguous rather than guessed at.
 *
 * WHAT THE MUTATIONS SAID. Passing the raw arguments straight to `execute`
 * instead of validating them reddens all three refusal arms; marking `launch`
 * `lenientArgValidation` reddens its own arm with the recorded
 * `operation.op` crash text and moves it into the pinned exemption list;
 * dropping the alias rename reddens the repair arm. The two-donor half of that
 * arm is defended twice over — the alias planner and the required-string
 * ambiguity check each refuse it on their own — so it goes red only when both
 * guards are removed, which is redundancy rather than a hole, and is written
 * down here so the next reader does not mistake one green mutation for one.
 *
 * WHAT IT DOES NOT CATCH. A tool whose schema declares nothing required
 * (`glob`, `job`, `todo`) has no contract to enforce; validation cannot invent
 * one. A cross-field rule expressed in code rather than in the schema is still
 * the tool's own business. `yield` opts out through `lenientArgValidation` and
 * validates its own payload inside `execute`, so it is pinned as an exemption
 * rather than swept. And this drives the loop's dispatch path only: a caller
 * that reaches `execute` without going through either the loop or the bridge
 * would be a third caller, not a regression of these two.
 */

import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool } from "@veyyon/agent-core/types";
import type { Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import type { TSchema } from "@veyyon/ai/types";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { createRepairToolCallArgumentsHook } from "@veyyon/coding-agent/repair/agent-hook";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools/index";
import { TempDir } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { ArgotSession } from "argot";
import { makeToolSession } from "../helpers/tool-session";

// Every tool in the registry is constructed once and driven through a full loop
// turn; the default 5s budget is below that on a loaded box.
setDefaultTimeout(60_000);

/** Thrown by every stand-in `execute`, so "the call got through" is observable. */
const EXECUTED = "the tool executed";

interface ToolUnderTest {
	name: string;
	label?: string;
	description: string;
	parameters: TSchema;
	lenientArgValidation?: boolean;
}

/**
 * The real tool's name and schema without its behaviour. `parameters` is
 * delegated through a getter because `edit`, `eval` and `task` compute theirs
 * inside a getter that reads `#private` fields: a spread clone loses the schema
 * and the sweep would pass for the wrong reason.
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

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/**
 * One turn of the real loop: the provider answers with a single tool call
 * carrying `args`, the loop dispatches it, and the tool result text is what the
 * model would read next. The repair hook is the very one `sdk.ts` wires, so the
 * alias and ambiguity paths are exercised rather than bypassed.
 */
async function dispatch(tool: AgentTool, args: Record<string, unknown>): Promise<string> {
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "call-1", name: tool.name, arguments: args }] },
			{ content: ["done"] },
		],
	});
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[{ role: "user", content: "call it" } as AgentMessage],
		context,
		{
			model: mock.model,
			convertToLlm: identityConverter,
			repairToolCallArguments: createRepairToolCallArgumentsHook(Settings.isolated(), () => mock.model),
		},
		undefined,
		mock.stream,
	);
	for await (const event of stream) events.push(event);
	for (const event of events) {
		if (event.type !== "message_end") continue;
		const message = event.message;
		if (message.role !== "toolResult") continue;
		return message.content
			.map(part => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim();
	}
	return "no tool result";
}

/**
 * The recorded crashes, verbatim enough to recognise. A refusal that quotes one
 * of these fragments is the tool failing from the inside again, whatever else
 * the message says.
 */
const CRASH_FRAGMENTS = ["operation.op", "startsWith is not a function", "is not an object", "is not a function"];

function looksLikeACrash(text: string): boolean {
	return CRASH_FRAGMENTS.some(fragment => text.includes(fragment));
}

/**
 * Settings the sweep session answers, so a tool gated behind a feature flag is
 * swept rather than skipped.
 */
const SWEEP_SETTINGS: Record<string, unknown> = {
	"argot.enabled": true,
	"autolearn.enabled": true,
	"debug.enabled": true,
	"memory.backend": "mnemopi",
	"tools.discoveryMode": "all",
};

const argotSession = new ArgotSession();
const sweepAgentDir = TempDir.createSync("@loop-arg-validation-profile-");

describe("a tool call the model sent without its required argument", () => {
	beforeAll(async () => {
		await fs.writeFile(
			path.join(sweepAgentDir.path(), "ssh.json"),
			JSON.stringify({ hosts: { probe: { host: "127.0.0.1" } } }),
		);
	});

	afterAll(() => {
		sweepAgentDir.removeSync();
	});

	it("names the missing argument instead of crashing inside launch", async () => {
		const session = makeToolSession({ hasUI: true });
		const launch = await BUILTIN_TOOLS.launch?.(session);
		expect(launch).toBeTruthy();
		if (!launch) return;

		const text = await dispatch(launch, {});

		expect(text).toContain("op");
		expect(looksLikeACrash(text)).toBe(false);
	});

	it("names the missing argument instead of crashing inside edit", async () => {
		const session = makeToolSession({ hasUI: true });
		const edit = await BUILTIN_TOOLS.edit?.(session);
		expect(edit).toBeTruthy();
		if (!edit) return;

		const text = await dispatch(edit, {});

		expect(text).toContain("input");
		expect(looksLikeACrash(text)).toBe(false);
	});

	it("refuses every tool in the registry that declares a required argument", async () => {
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

		const checked: string[] = [];
		const reachedTheTool: string[] = [];
		const silentAboutTheField: string[] = [];
		const optedOut: string[] = [];
		const noRequiredArguments: string[] = [];
		const unconstructable: string[] = [];
		const notRegistered: string[] = [];

		for (const [name, factory] of Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS })) {
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
			const required = requiredArguments(real);
			if (required.length === 0) {
				noRequiredArguments.push(real.name);
				continue;
			}
			if (real.lenientArgValidation) {
				optedOut.push(real.name);
				continue;
			}

			const text = await dispatch(refusingClone(real), {});
			checked.push(real.name);
			if (text.includes(EXECUTED)) {
				reachedTheTool.push(`${real.name}: ${text}`);
				continue;
			}
			// The point of refusing early is that the model is told what to send
			// next, so a refusal that names no field is only half the fix.
			if (!required.some(field => text.includes(field))) {
				silentAboutTheField.push(`${real.name}: ${text}`);
			}
		}

		// A call that got into `execute` with no arguments is the recorded defect.
		expect(reachedTheTool).toEqual([]);
		expect(silentAboutTheField).toEqual([]);
		// A tool the sweep cannot build is a hole in it, not a tool that is safe.
		expect(unconstructable).toEqual([]);
		expect(notRegistered).toEqual([]);
		// Pinned by exact equality, both of them: `yield` is the one tool that
		// opts out of loop-side validation, and these two declare nothing
		// mandatory. A second name in either list is a tool that stopped being
		// validated by anyone, and this is where that decision gets recorded.
		expect(optedOut).toEqual(["yield"]);
		expect(noRequiredArguments.sort()).toEqual(["job", "todo"]);
		// And the sweep did drive something: an empty `checked` would satisfy
		// every assertion above.
		expect(checked.length).toBeGreaterThan(20);
	});

	it("renames a single plausible donor onto the missing field, and refuses two", async () => {
		const session = makeToolSession({ hasUI: true });
		const write = await BUILTIN_TOOLS.write?.(session);
		expect(write).toBeTruthy();
		if (!write) return;

		// One donor: repair is allowed to rename it, so the call reaches the tool.
		// This is the behaviour that makes an empty object a different case from a
		// misnamed one — there is nothing to rename.
		const renamed = await dispatch(refusingClone(write), { path: "a.txt", text: "hello", i: "writing" });
		expect(renamed).toContain(EXECUTED);

		// Two donors for one missing field: guessing between them would write the
		// wrong bytes to disk, so the loop refuses and says so.
		const ambiguous = await dispatch(refusingClone(write), {
			path: "a.txt",
			text: "hello",
			body: "hello",
			i: "writing",
		});
		expect(ambiguous).not.toContain(EXECUTED);
		expect(ambiguous.toLowerCase()).toContain("ambiguous");
	});
});
