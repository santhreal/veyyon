/**
 * WHY THIS SUITE EXISTS:
 *
 * The `!` command and the `$` Python run are transcript roles the shell domain records, and the
 * conversion of a transcript into a provider request used to reach them through two cases in
 * `session/messages.ts`, which imported the shell's exit-code and output-spill wording into the
 * session spine. Each domain now declares its roles on its manifest as message kinds, the tool
 * registry registers every manifest's kinds, and `convertToLlm` reads the kind by role. That seam
 * can fail four ways a type check does not see:
 *
 *   1. A role a domain declares is not registered — a manifest that stops reaching the registry,
 *      or a registration loop that skips one — so a transcript with a `!` command cannot be sent.
 *   2. A role nobody declared is dropped from the request instead of refused, so the model answers
 *      against a conversation with a hole in it.
 *   3. Two domains claim one role and load order picks the wording.
 *   4. The conversion changes — the kind's text drifts from what the case in the spine produced,
 *      or it stops memoising, so an unchanged prefix is re-transformed and the prompt cache missed.
 *
 * The declared-role set is pinned by exact equality: a domain that adds a role turns this red until
 * the decision is recorded here.
 *
 * WHAT IT DOES NOT CATCH: a host that renders a role it does not know. The transcript builders and
 * the history formatter still switch on the role by name; this suite is about the request the model
 * reads, not the card the operator sees.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessageKind } from "@veyyon/kernel/registry/message-kind";
import {
	agentMessageKind,
	registerAgentMessageKinds,
	registeredAgentMessageRoles,
} from "@veyyon/kernel/session/message-kinds";
import type { AgentMessage } from "@veyyon/session";
import { convertToLlm } from "../src/session/messages";
import { BUILTIN_TOOL_DOMAINS } from "../src/tools/index";
import {
	type BashExecutionMessage,
	bashExecutionKind,
	bashExecutionToText,
	type PythonExecutionMessage,
	pythonExecutionKind,
	pythonExecutionToText,
} from "../src/tools/shell/execution-messages";
import { shellDomain } from "../src/tools/shell/manifest";

const bash: BashExecutionMessage = {
	role: "bashExecution",
	command: "ls",
	output: "a\nb",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	timestamp: 7,
};

const python: PythonExecutionMessage = {
	role: "pythonExecution",
	code: "print(1)",
	output: "1",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	timestamp: 9,
};

describe("a message role a domain adds converts through its manifest", () => {
	it("registers every role every domain declares, and only those, once the tool registry loads", () => {
		const declared = BUILTIN_TOOL_DOMAINS.flatMap(domain => (domain.messageKinds ?? []).map(kind => kind.role));
		expect(declared).toEqual(["bashExecution", "pythonExecution"]);
		expect(registeredAgentMessageRoles()).toEqual(declared);
		expect(shellDomain.messageKinds).toEqual([bashExecutionKind, pythonExecutionKind]);
		for (const kind of shellDomain.messageKinds) {
			expect(agentMessageKind(kind.role)).toBe(kind);
		}
	});

	it("converts a shell run to the user turn the spine's case produced, and memoises it by message", () => {
		const [first] = convertToLlm([bash]);
		expect(first).toEqual({
			role: "user",
			content: [{ type: "text", text: "Ran `ls`\n```\na\nb\n```" }],
			attribution: "user",
			timestamp: 7,
		});
		expect(convertToLlm([bash])[0]).toBe(first);
		expect(convertToLlm([{ ...bash, output: "c" }])[0]).not.toBe(first);

		const [py] = convertToLlm([python]);
		expect(py).toEqual({
			role: "user",
			content: [{ type: "text", text: "Ran Python:\n```python\nprint(1)\n```\nOutput:\n```\n1\n```" }],
			attribution: "user",
			timestamp: 9,
		});
		expect(convertToLlm([python])[0]).toBe(py);
	});

	it("excludes a run the operator marked out of context, contributing no message at all", () => {
		expect(convertToLlm([{ ...bash, excludeFromContext: true }])).toEqual([]);
		expect(convertToLlm([{ ...python, excludeFromContext: true }])).toEqual([]);
	});

	it("refuses a role nobody declared rather than dropping the message", () => {
		const orphan = { role: "orphanRole", timestamp: 1 } as unknown as AgentMessage;
		expect(() => convertToLlm([orphan])).toThrow(/no message kind for role "orphanRole".*messageKinds/);
	});

	it("takes one kind per role: the same kind twice is a no-op, a second kind for the role throws", () => {
		expect(() => registerAgentMessageKinds(shellDomain.messageKinds)).not.toThrow();
		const rival: AgentMessageKind<BashExecutionMessage> = {
			role: "bashExecution",
			toLlm: () => [],
			toText: () => "",
		};
		expect(() => registerAgentMessageKinds([rival])).toThrow(/"bashExecution" already has a kind/);
		expect(agentMessageKind("bashExecution")).toBe(bashExecutionKind);
	});
});

/**
 * pythonExecutionToText renders a user-initiated `$` Python run into the text the LLM sees. A
 * regression would feed the model malformed context (a missing output block, a lost error line).
 * These pin the code fence, the output-vs-"(no output)" branch, and the terminal status line: a
 * cancelled run reads "(execution cancelled)", a nonzero exit reads "Execution failed with code N",
 * and cancellation wins over exit code (they share one else-if). A zero, null, or undefined exit
 * code appends nothing.
 */
describe("pythonExecutionToText", () => {
	const base: PythonExecutionMessage = { ...python, timestamp: 0 };

	it("renders the code fence and an output block on a clean run", () => {
		expect(pythonExecutionToText(base)).toBe("Ran Python:\n```python\nprint(1)\n```\nOutput:\n```\n1\n```");
	});

	it("renders (no output) when there is no output", () => {
		expect(pythonExecutionToText({ ...base, output: "" })).toBe("Ran Python:\n```python\nprint(1)\n```\n(no output)");
	});

	it("appends the cancelled notice, taking precedence over a nonzero exit code", () => {
		expect(pythonExecutionToText({ ...base, cancelled: true, exitCode: 2 })).toBe(
			"Ran Python:\n```python\nprint(1)\n```\nOutput:\n```\n1\n```\n\n(execution cancelled)",
		);
	});

	it("appends the failure line for a nonzero exit code but nothing for zero, null, or undefined", () => {
		expect(pythonExecutionToText({ ...base, exitCode: 2 })).toBe(
			"Ran Python:\n```python\nprint(1)\n```\nOutput:\n```\n1\n```\n\nExecution failed with code 2",
		);
		const clean = "Ran Python:\n```python\nprint(1)\n```\nOutput:\n```\n1\n```";
		expect(pythonExecutionToText({ ...base, exitCode: 0 })).toBe(clean);
		expect(pythonExecutionToText({ ...base, exitCode: undefined })).toBe(clean);
	});
});

/**
 * bashExecutionToText is the LLM-context renderer for a persisted shell run (the sibling of
 * pythonExecutionToText). A regression here feeds the model a wrong picture of a command: a missing
 * exit-code line hides a failure, a swapped cancelled/exit branch reports the wrong reason, and a
 * dropped output fence corrupts the transcript. These pin the clean render, the no-output branch,
 * the cancelled-over-nonzero-exit precedence, and that exit codes 0/undefined add no failure line
 * while a nonzero code does.
 */
describe("bashExecutionToText", () => {
	const base: BashExecutionMessage = { ...bash, timestamp: 0 };

	it("renders the command line and a fenced output block on a clean run", () => {
		expect(bashExecutionToText(base)).toBe("Ran `ls`\n```\na\nb\n```");
	});

	it("renders (no output) when the command produced nothing", () => {
		expect(bashExecutionToText({ ...base, output: "" })).toBe("Ran `ls`\n(no output)");
	});

	it("appends the cancelled notice, taking precedence over a nonzero exit code", () => {
		expect(bashExecutionToText({ ...base, cancelled: true, exitCode: 2 })).toBe(
			"Ran `ls`\n```\na\nb\n```\n\n(command cancelled)",
		);
	});

	it("appends the exit-code line for a nonzero exit but nothing for zero or undefined", () => {
		expect(bashExecutionToText({ ...base, exitCode: 2 })).toBe(
			"Ran `ls`\n```\na\nb\n```\n\nCommand exited with code 2",
		);
		const clean = "Ran `ls`\n```\na\nb\n```";
		expect(bashExecutionToText({ ...base, exitCode: 0 })).toBe(clean);
		expect(bashExecutionToText({ ...base, exitCode: undefined })).toBe(clean);
	});
});
