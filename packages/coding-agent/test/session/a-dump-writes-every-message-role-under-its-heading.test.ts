/**
 * WHY. `/dump` and `/advisor dump raw` write a session as markdown: a heading per message and the
 * message's text under it, in the shape each role defines. The writer is one branch per role, and a
 * role it has no branch for is dropped from the dump without a trace, so a reader of the dump sees a
 * conversation with a hole in it.
 *
 * CLASS. For every role `AgentMessage` defines, a dump of one such message is exactly that role's
 * section, and a dump of every role in sequence is those sections in order, so the spacing between
 * messages is pinned too. `SECTIONS` is a `Record<AgentMessage["role"], …>`, so adding a role fails the
 * type check until its section is written down. The variants each branch reads are pinned beside it:
 * image parts, an error result, an intent with no other argument, thinking that is only ellipsis, an
 * execution kept out of context, and a mention whose body a collab guest never received.
 *
 * DOES NOT CATCH. The text of a shell execution is the shell domain's `toText`, embedded as it
 * returns it; this suite pins where it goes, not what it says. A role a host injects at runtime
 * without a type is outside the record.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent, ToolCall } from "@veyyon/ai";
import { agentMessageKind, registerAgentMessageKinds } from "@veyyon/kernel/session/message-kinds";
import { INTENT_FIELD } from "@veyyon/wire";
import { formatSessionDumpText } from "../../src/session/session-dump-format";
import type { BashExecutionMessage, PythonExecutionMessage } from "../../src/tools/shell/execution-messages";
import { shellDomain } from "../../src/tools/shell/manifest";

registerAgentMessageKinds(shellDomain.messageKinds);

/** What a dump with no system prompt, model, thinking level or tools opens with. */
const HEADER = "## Configuration\n\nModel: (not selected)\nThinking Level: \n\n\n";

const IMAGE: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

const BASH: BashExecutionMessage = {
	role: "bashExecution",
	command: "ls",
	output: "a.ts\nb.ts",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	timestamp: 1,
};

const PYTHON: PythonExecutionMessage = {
	role: "pythonExecution",
	code: "print(1)",
	output: "1",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	timestamp: 1,
};

interface Section {
	message: AgentMessage;
	/** The section's lines; the dump joins every line of every section with a newline. */
	lines: string[];
}

const SECTIONS: Record<AgentMessage["role"], Section> = {
	user: {
		message: { role: "user", content: [{ type: "text", text: "Look at this" }, IMAGE], timestamp: 1 },
		lines: ["## User\n", "Look at this", "[Image]", "\n"],
	},
	developer: {
		message: { role: "developer", content: "Follow the rules.", timestamp: 1 },
		lines: ["## Developer\n", "Follow the rules.", "\n"],
	},
	assistant: {
		message: assistant([
			{ type: "text", text: "Reading." },
			{ type: "thinking", thinking: "  plan the read  " },
			{ type: "thinking", thinking: "..." },
			{
				type: "toolCall",
				id: "c1",
				name: "read",
				arguments: { [INTENT_FIELD]: "Reading the file\nfor the header", path: "a.ts" },
			},
			{ type: "toolCall", id: "c2", name: "yield", arguments: { [INTENT_FIELD]: "Done" } },
		]),
		lines: [
			"## Assistant\n",
			"Reading.",
			"<thinking>\nplan the read\n</thinking>\n",
			"### Tool Call: read",
			"// Reading the file",
			"// for the header",
			"```yaml",
			"path: a.ts",
			"```\n",
			"### Tool Call: yield",
			"// Done",
			"",
		],
	},
	toolResult: {
		message: {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: "missing file" }, IMAGE],
			isError: true,
			timestamp: 1,
		},
		lines: ["### Tool Result: read", "(error)", "```", "missing file", "```", "[Image output]", ""],
	},
	bashExecution: {
		message: BASH,
		lines: ["## Bash Execution\n", agentMessageKind<BashExecutionMessage>("bashExecution").toText(BASH), "\n"],
	},
	pythonExecution: {
		message: PYTHON,
		lines: [
			"## Python Execution\n",
			agentMessageKind<PythonExecutionMessage>("pythonExecution").toText(PYTHON),
			"\n",
		],
	},
	custom: {
		message: {
			role: "custom",
			customType: "note",
			content: [{ type: "text", text: "Remember" }, IMAGE],
			display: true,
			timestamp: 1,
		},
		lines: ["## note\n", "Remember", "[Image]", "\n"],
	},
	hookMessage: {
		message: { role: "hookMessage", customType: "hook", content: "Hooked.", display: true, timestamp: 1 },
		lines: ["## hook\n", "Hooked.", "\n"],
	},
	branchSummary: {
		message: { role: "branchSummary", summary: "Went left.", fromId: "entry-1", timestamp: 1 },
		lines: ["## Branch Summary\n", "(from branch: entry-1)\n", "Went left.", "\n"],
	},
	compactionSummary: {
		message: { role: "compactionSummary", summary: "Kept the plan.", tokensBefore: 10_000, timestamp: 1 },
		lines: ["## Compaction Summary\n", "(10000 tokens before compaction)\n", "Kept the plan.", "\n"],
	},
	fileMention: {
		message: {
			role: "fileMention",
			files: [
				{ path: "a.md", content: "alpha" },
				{ path: "b.png", content: "", image: IMAGE },
				{ path: "c.md", content: "", contentNotReplicated: true },
			],
			timestamp: 1,
		},
		lines: [
			"## File Mention\n",
			'<file path="a.md">',
			"alpha",
			"</file>\n",
			'<file path="b.png">',
			"[Image attached]",
			"</file>\n",
			'<file path="c.md">',
			"[body not replicated to this collab guest]",
			"</file>\n",
			"\n",
		],
	},
};

const ROLES = Object.keys(SECTIONS) as AgentMessage["role"][];

function transcript(messages: AgentMessage[]): string {
	const out = formatSessionDumpText({ messages });
	expect(out.startsWith(HEADER)).toBe(true);
	return out.slice(HEADER.length);
}

describe("a dump writes every message role under its heading", () => {
	for (const role of ROLES) {
		it(`writes a ${role} message as its section`, () => {
			const { message, lines } = SECTIONS[role];
			expect(transcript([message])).toBe(lines.join("\n").trimEnd());
		});
	}

	// Forward and reversed, so every role is followed by another section in one of the two orders
	// and its trailing separator is not hidden by the final trim.
	for (const [order, roles] of [
		["in order", ROLES],
		["in reverse", ROLES.toReversed()],
	] as const) {
		it(`writes every role in sequence ${order} as the sections in that order`, () => {
			const messages = roles.map(role => SECTIONS[role].message);
			const lines = roles.flatMap(role => SECTIONS[role].lines);
			expect(transcript(messages)).toBe(lines.join("\n").trimEnd());
		});
	}

	it("writes nothing for a shell execution kept out of context", () => {
		const empty = formatSessionDumpText({ messages: [] });
		const excluded: AgentMessage[] = [
			{ ...BASH, excludeFromContext: true },
			{ ...PYTHON, excludeFromContext: true },
		];
		expect(formatSessionDumpText({ messages: excluded })).toBe(empty);
	});

	it("writes a tool call with no arguments as its heading alone", () => {
		const message = assistant([{ type: "toolCall", id: "c3", name: "todo", arguments: {} }]);
		expect(transcript([message])).toBe("## Assistant\n\n### Tool Call: todo");
	});

	it("writes no comment for an intent that is only whitespace", () => {
		const message = assistant([
			{ type: "toolCall", id: "c4", name: "read", arguments: { [INTENT_FIELD]: "  \n ", path: "b.ts" } },
		]);
		expect(transcript([message])).toBe("## Assistant\n\n### Tool Call: read\n```yaml\npath: b.ts\n```");
	});

	it("writes a tool call whose recorded arguments are missing as its heading alone", () => {
		// A session file written by an older build can hold a call with no `arguments` key.
		const recorded = JSON.parse('{"type":"toolCall","id":"c5","name":"read"}') as ToolCall;
		expect(transcript([assistant([recorded])])).toBe("## Assistant\n\n### Tool Call: read");
	});
});
