import { describe, expect, it } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { buildCursorRules, handleServerMessage } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	type CursorRule,
	ExecServerMessageSchema,
	RequestContextArgsSchema,
	type RequestContextSuccess,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

const SYSTEM_PROMPT = "You are veyyon. NEVER guess file contents.";
const APPEND_SECTION = "DELIVERY CONTRACT: prove changes before yielding.";
const HOME_AGENTS = "/home/operator/.veyyon/AGENTS.md";
const HOME_CONTENT = "# Global rules\nAlways run the gates before committing.";
const PROFILE_AGENTS = "/home/operator/.veyyon/profiles/work/agent/AGENTS.md";
const PROFILE_CONTENT = "# Profile rules\nThis profile prefers small diffs.";

function requestContextAsk() {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 3,
				execId: "exec-ctx",
				message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
			}),
		},
	});
}

/** Drive one requestContextArgs ask through the handler and decode the rules answered on the wire. */
async function answerRules(rules: CursorRule[]): Promise<CursorRule[]> {
	const frames: Buffer[] = [];
	const h2 = { write: (buf: Buffer) => frames.push(Buffer.from(buf)) } as never;
	const output = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;

	await handleServerMessage(
		requestContextAsk(),
		output,
		new AssistantMessageEventStream(),
		{} as never,
		new Map(),
		h2,
		undefined,
		undefined,
		[],
		rules,
	);

	expect(frames).toHaveLength(1);
	// Strip the 5-byte Connect envelope before decoding.
	const message = fromBinary(AgentClientMessageSchema, new Uint8Array(frames[0].subarray(5)));
	if (message.message.case !== "execClientMessage") throw new Error(`unexpected case: ${message.message.case}`);
	const exec = message.message.value;
	if (exec.message.case !== "requestContextResult") throw new Error(`unexpected exec case: ${exec.message.case}`);
	const result = exec.message.value.result;
	if (result.case !== "success") throw new Error(`requestContext failed: ${result.case}`);
	return (result.value as RequestContextSuccess).requestContext?.rules ?? [];
}

describe("buildCursorRules", () => {
	it("composes the whole instruction payload as one always-apply rule", () => {
		const rules = buildCursorRules([SYSTEM_PROMPT, APPEND_SECTION]);

		expect(rules).toHaveLength(1);
		const [systemRule] = rules;
		// The prompt is compiled, not file-backed: a stable synthetic path.
		expect(systemRule.fullPath).toBe("veyyon://system-prompt.mdc");
		expect(systemRule.content).toBe(`${SYSTEM_PROMPT}\n\n${APPEND_SECTION}`);
		// Always-apply with the default source, cursor-agent's own AGENTS.md shape.
		expect(systemRule.type?.type.case).toBe("global");
		expect(systemRule.source).toBe(0);
	});

	it("carries the caller's context files, because they are part of the prompt it is given", () => {
		// The composer takes ONE argument. A second, separately filtered list of file units is
		// exactly what let a scope be dropped from the wire while the prompt on every other api
		// carried it, so the instruction layers arrive here already assembled.
		const rules = buildCursorRules([SYSTEM_PROMPT, `<file path="${HOME_AGENTS}">\n${HOME_CONTENT}\n</file>`]);

		expect(rules).toHaveLength(1);
		expect(rules[0].content).toContain(HOME_CONTENT);
		expect(rules[0].content).toContain(HOME_AGENTS);
	});

	it("emits no rule for an empty prompt", () => {
		expect(buildCursorRules(undefined)).toEqual([]);
		expect(buildCursorRules([])).toEqual([]);
		expect(buildCursorRules(["", "   "])).toEqual([]);
	});
});

describe("Cursor requestContext rules on the wire", () => {
	it("answers requestContextArgs with the assembled prompt, and nothing else", async () => {
		const composed = buildCursorRules([
			SYSTEM_PROMPT,
			`<file path="${PROFILE_AGENTS}">\n${PROFILE_CONTENT}\n</file>`,
		]);

		const answered = await answerRules(composed);

		// One rule reaches the server, and it is the payload the caller assembled. The provider
		// reads no filesystem, so nothing can join it between here and the wire.
		expect(answered.map(rule => rule.fullPath)).toEqual(["veyyon://system-prompt.mdc"]);
		expect(answered[0].content).toContain(SYSTEM_PROMPT);
		expect(answered[0].content).toContain(PROFILE_CONTENT);
		expect(answered[0].type?.type.case).toBe("global");
	});

	it("answers with no rules when the caller has no instructions", async () => {
		const answered = await answerRules(buildCursorRules(undefined));
		expect(answered).toEqual([]);
	});
});
