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
		{} as never,
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
	it("composes the system prompt as one global rule followed by one rule per file", () => {
		const rules = buildCursorRules(
			[SYSTEM_PROMPT, APPEND_SECTION],
			[
				{ fullPath: PROFILE_AGENTS, content: PROFILE_CONTENT },
				{ fullPath: HOME_AGENTS, content: HOME_CONTENT },
			],
		);

		expect(rules).toHaveLength(3);
		const [systemRule, profileRule, homeRule] = rules;
		// The system prompt is compiled, not file-backed: a stable synthetic path.
		expect(systemRule.fullPath).toBe("veyyon://system-prompt.mdc");
		expect(systemRule.content).toBe(`${SYSTEM_PROMPT}\n\n${APPEND_SECTION}`);
		// File units keep their real path and full content, in caller (ascending-authority) order.
		expect(profileRule.fullPath).toBe(PROFILE_AGENTS);
		expect(profileRule.content).toBe(PROFILE_CONTENT);
		expect(homeRule.fullPath).toBe(HOME_AGENTS);
		expect(homeRule.content).toBe(HOME_CONTENT);
		// Every rule is always-apply with the default source, cursor-agent's own AGENTS.md shape.
		for (const rule of rules) {
			expect(rule.type?.type.case).toBe("global");
			expect(rule.source).toBe(0);
		}
	});

	it("emits no system rule for an empty prompt and skips empty files", () => {
		expect(buildCursorRules(undefined, undefined)).toEqual([]);
		expect(buildCursorRules(["", "   "], undefined)).toEqual([]);
		const rules = buildCursorRules(undefined, [
			{ fullPath: "/empty/AGENTS.md", content: "  \n" },
			{ fullPath: HOME_AGENTS, content: HOME_CONTENT },
		]);
		expect(rules.map(rule => rule.fullPath)).toEqual([HOME_AGENTS]);
	});
});

describe("Cursor requestContext rules on the wire", () => {
	it("answers requestContextArgs with the system prompt and the operator's files, and nothing else", async () => {
		const composed = buildCursorRules(
			[SYSTEM_PROMPT, APPEND_SECTION],
			[
				{ fullPath: PROFILE_AGENTS, content: PROFILE_CONTENT },
				{ fullPath: HOME_AGENTS, content: HOME_CONTENT },
			],
		);

		const answered = await answerRules(composed);

		// Exactly the composed set reaches the server: the system prompt and the
		// operator's home/profile context, one rule each. The provider reads no
		// filesystem, so no repository file can appear beside them.
		expect(answered.map(rule => rule.fullPath)).toEqual(["veyyon://system-prompt.mdc", PROFILE_AGENTS, HOME_AGENTS]);
		expect(answered[0].content).toContain(SYSTEM_PROMPT);
		expect(answered[0].content).toContain(APPEND_SECTION);
		expect(answered[1].content).toBe(PROFILE_CONTENT);
		expect(answered[2].content).toBe(HOME_CONTENT);
		for (const rule of answered) {
			expect(rule.type?.type.case).toBe("global");
		}
	});

	it("answers with no rules when the caller has no instructions", async () => {
		const answered = await answerRules(buildCursorRules(undefined, undefined));
		expect(answered).toEqual([]);
	});
});
