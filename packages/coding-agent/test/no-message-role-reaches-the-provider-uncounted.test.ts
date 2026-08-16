/**
 * WHY. Every role a session can hold is turned into provider messages by
 * `convertToLlm`, and every role's token cost is measured by `estimateTokens`.
 * The two switches are written separately, and a role present in the first and
 * missing from the second is content the session believes is FREE: it is billed
 * by the provider, counted against the model's window, and invisible to the
 * compaction trigger, the pruning budgets and the operator's context gauge.
 *
 * THE DEFECT THIS CLOSES. `walkCountedFragments` had no `fileMention` and no
 * `pythonExecution` arm, so both fell through `default: return 0`. A `@file`
 * mention carries up to 50KB of file body per turn and a `$` cell carries its
 * code and its output. Measured on a real session against a 32k-context server:
 * the gauge read "61% left" while the request the same session had just sent was
 * 40459 tokens, and the provider refused it. The estimate was short by about
 * 15k tokens — the entire mention.
 *
 * It is the fourth member of one class. `developer` messages counted zero until
 * 2026-07-22, user-message images counted zero after that, and both are recorded
 * in the estimator beside these two. So this suite does not test the two roles
 * that were broken; it tests the RULE, at the choke point every role passes
 * through, with the expectation derived from what the wire actually carries:
 *
 *   for every role: estimateTokens(message) must account for the tokens
 *   convertToLlm(message) puts on the wire.
 *
 * FAIL BY DEFAULT. `SAMPLES` is a `Record<AgentMessage["role"], …>`, so adding a
 * role to `CustomAgentMessages` fails the type check until a sample exists, and
 * `convertToLlm` already ends in `m satisfies never` for the same reason. A role
 * whose wire form carries text and whose estimate is zero fails here.
 *
 * WHAT IT DOES NOT CATCH. It does not audit the accuracy of the number: an arm
 * that counted half a message's fragments would pass the ratio floor below.
 * It cannot see a host that injects an untyped role at runtime. And it says
 * nothing about images beyond the fixed per-image charge, which is a provider
 * billing guess rather than a measurement.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { ImageContent } from "@veyyon/ai";
import type { FileMentionMessage } from "../src/session/messages";
import { convertToLlm } from "../src/session/messages";

/** Matches the estimator's fixed per-image charge. */
const IMAGE_TOKEN_ESTIMATE = 1200;

const BODY = "export function summarize(input: string): string {\n\treturn input.trim();\n}\n".repeat(60);
const IMAGE: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

const SAMPLES: Record<AgentMessage["role"], AgentMessage> = {
	user: { role: "user", content: BODY, timestamp: 1 },
	developer: { role: "developer", content: BODY, timestamp: 1 },
	assistant: {
		role: "assistant",
		content: [{ type: "text", text: BODY }],
		api: "openai-completions",
		provider: "local",
		model: "qwen2.5-1.5b",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	} as AgentMessage,
	toolResult: {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: BODY }],
		isError: false,
		timestamp: 1,
	},
	custom: { role: "custom", customType: "note", content: BODY, display: true, timestamp: 1 },
	hookMessage: { role: "hookMessage", customType: "note", content: BODY, display: true, timestamp: 1 },
	branchSummary: { role: "branchSummary", summary: BODY, fromId: "entry-1", timestamp: 1 },
	compactionSummary: { role: "compactionSummary", summary: BODY, tokensBefore: 10_000, timestamp: 1 },
	bashExecution: {
		role: "bashExecution",
		command: "rg summarize",
		output: BODY,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	},
	pythonExecution: {
		role: "pythonExecution",
		code: "print(summarize(text))",
		output: BODY,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	},
	fileMention: { role: "fileMention", files: [{ path: "notes.md", content: BODY }], timestamp: 1 },
};

function wireTokens(message: AgentMessage): number {
	return convertToLlm([message]).reduce((total, sent) => total + estimateTokens(sent as AgentMessage), 0);
}

function mention(files: FileMentionMessage["files"]): FileMentionMessage {
	return { role: "fileMention", files, timestamp: 1 };
}

describe("a message role that reaches the provider is counted", () => {
	const roles = Object.keys(SAMPLES) as Array<AgentMessage["role"]>;

	it("puts every role on the wire, so every role has a cost to account for", () => {
		const silent = roles.filter(role => wireTokens(SAMPLES[role]) === 0);
		// Nothing here is display-only: `convertToLlm` ends in `m satisfies never`,
		// so a role that sends nothing is a decision someone has to record.
		expect(silent).toEqual([]);
	});

	for (const role of roles) {
		it(`${role}: the estimate accounts for what the wire carries`, () => {
			const message = SAMPLES[role];
			const sent = wireTokens(message);
			const estimated = estimateTokens(message);
			// The wire form wraps content (a `<file>` element, a "Ran Python:" preamble),
			// so the two numbers are never equal; a role that is not walked at all reads
			// exactly 0, which is what this floor separates from wrapper slack.
			expect(estimated).toBeGreaterThanOrEqual(sent * 0.5);
			expect(estimated).toBeGreaterThan(100);
		});

		it(`${role}: an empty message of the same role costs nothing`, () => {
			const emptied = emptyOf(role);
			expect(estimateTokens(emptied)).toBe(0);
		});
	}

	it("scales with content rather than with message count", () => {
		for (const role of roles) {
			const one = estimateTokens(SAMPLES[role]);
			const twice = estimateTokens(doubledOf(role));
			expect(twice).toBeGreaterThan(one * 1.5);
		}
	});
});

describe("a file mention costs what it carries", () => {
	it("counts a second mentioned file, not just the first", () => {
		const single = estimateTokens(mention([{ path: "a.ts", content: BODY }]));
		const double = estimateTokens(
			mention([
				{ path: "a.ts", content: BODY },
				{ path: "b.ts", content: BODY },
			]),
		);
		expect(double).toBeGreaterThan(single * 1.9);
	});

	it("charges a mentioned image exactly the image estimate over the same mention without one", () => {
		const textOnly = mention([{ path: "shot.png", content: "(image)" }]);
		const withImage = mention([{ path: "shot.png", content: "(image)", image: IMAGE }]);
		expect(estimateTokens(withImage) - estimateTokens(textOnly)).toBe(IMAGE_TOKEN_ESTIMATE);
	});

	it("counts only the path when a collab replica was never sent the body", () => {
		const replica = estimateTokens(mention([{ path: "notes.md", content: "", contentNotReplicated: true }]));
		expect(replica).toBeGreaterThan(0);
		expect(replica).toBeLessThan(20);
	});

	it("counts the skip notice a too-large file carries instead of its body", () => {
		const skipped = estimateTokens(
			mention([{ path: "huge.bin", content: "(skipped auto-read: too large, 12MB)", skippedReason: "tooLarge" }]),
		);
		expect(skipped).toBeGreaterThan(0);
		expect(skipped).toBeLessThan(40);
	});

	it("sees a body that shrank in place, because the shape digest walks the files", () => {
		// The estimate is memoized per message identity and validated by a digest of
		// the fragments it counts. A role counted outside that walk would keep
		// answering with the size the message had before a rewrite touched it — the
		// failure the digest exists for.
		const message = mention([{ path: "notes.md", content: BODY }]);
		const before = estimateTokens(message);
		message.files[0]!.content = "elided";
		const after = estimateTokens(message);
		expect(after).toBeLessThan(before / 10);
	});
});

describe("a python cell costs its code and its output", () => {
	it("counts the code when the cell printed nothing", () => {
		const quiet = estimateTokens({
			role: "pythonExecution",
			code: BODY,
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		} as AgentMessage);
		expect(quiet).toBeGreaterThan(100);
	});

	it("counts the output on top of the code", () => {
		const codeOnly = estimateTokens({
			role: "pythonExecution",
			code: BODY,
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		} as AgentMessage);
		const both = estimateTokens({
			role: "pythonExecution",
			code: BODY,
			output: BODY,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 1,
		} as AgentMessage);
		expect(both).toBeGreaterThan(codeOnly * 1.9);
	});

	it("still counts a cell excluded from the request, exactly as a bash cell is", () => {
		// Deliberate: `excludeFromContext` drops the cell from the outbound request,
		// and over-counting it only makes compaction keener. Under-counting is the
		// defect this suite exists for, so both roles read the same way.
		const excludedPython = estimateTokens({
			role: "pythonExecution",
			code: BODY,
			output: BODY,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 1,
		} as AgentMessage);
		const excludedBash = estimateTokens({
			role: "bashExecution",
			command: BODY,
			output: BODY,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 1,
		} as AgentMessage);
		expect(excludedPython).toBeGreaterThan(100);
		expect(excludedBash).toBeGreaterThan(100);
	});
});

/** The same role carrying no content at all. */
function emptyOf(role: AgentMessage["role"]): AgentMessage {
	switch (role) {
		case "user":
			return { role: "user", content: "", timestamp: 1 };
		case "developer":
			return { role: "developer", content: "", timestamp: 1 };
		case "assistant":
			return { ...(SAMPLES.assistant as AgentMessage), content: [] } as AgentMessage;
		case "toolResult":
			return { ...SAMPLES.toolResult, content: [] } as AgentMessage;
		case "custom":
			return { ...SAMPLES.custom, content: "" } as AgentMessage;
		case "hookMessage":
			return { ...SAMPLES.hookMessage, content: "" } as AgentMessage;
		case "branchSummary":
			return { ...SAMPLES.branchSummary, summary: "" } as AgentMessage;
		case "compactionSummary":
			return { ...SAMPLES.compactionSummary, summary: "" } as AgentMessage;
		case "bashExecution":
			return { ...SAMPLES.bashExecution, command: "", output: "" } as AgentMessage;
		case "pythonExecution":
			return { ...SAMPLES.pythonExecution, code: "", output: "" } as AgentMessage;
		case "fileMention":
			return mention([]);
	}
}

/** The same role carrying twice the content. */
function doubledOf(role: AgentMessage["role"]): AgentMessage {
	const twice = BODY + BODY;
	switch (role) {
		case "user":
			return { role: "user", content: twice, timestamp: 1 };
		case "developer":
			return { role: "developer", content: twice, timestamp: 1 };
		case "assistant":
			return { ...(SAMPLES.assistant as AgentMessage), content: [{ type: "text", text: twice }] } as AgentMessage;
		case "toolResult":
			return { ...SAMPLES.toolResult, content: [{ type: "text", text: twice }] } as AgentMessage;
		case "custom":
			return { ...SAMPLES.custom, content: twice } as AgentMessage;
		case "hookMessage":
			return { ...SAMPLES.hookMessage, content: twice } as AgentMessage;
		case "branchSummary":
			return { ...SAMPLES.branchSummary, summary: twice } as AgentMessage;
		case "compactionSummary":
			return { ...SAMPLES.compactionSummary, summary: twice } as AgentMessage;
		case "bashExecution":
			return { ...SAMPLES.bashExecution, output: twice } as AgentMessage;
		case "pythonExecution":
			return { ...SAMPLES.pythonExecution, output: twice } as AgentMessage;
		case "fileMention":
			return mention([{ path: "notes.md", content: twice }]);
	}
}
