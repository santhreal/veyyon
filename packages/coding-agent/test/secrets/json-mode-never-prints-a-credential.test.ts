/**
 * Regression: `veyyon --mode json` wrote the EXPANDED credential to stdout.
 *
 * A spend under `--mode json` put the real value in four places on the event
 * stream — `tool_execution_start.args`, the assistant tool call on `message_start`
 * and `message_end`, and the `agent_end` repeat of the same message — while the
 * session file, the audit log, and the provider request for the same turn were all
 * clean. JSON mode is what CI, wrappers, and shell pipelines consume, so those bytes
 * land in build logs and artifact stores: a credential disclosure, not a rendering
 * preference.
 *
 * The cause was that print mode subscribes to DISPLAY events. Display form is built
 * for a human at a terminal, so `displayAssistantContent` deliberately deobfuscates,
 * and `tool_execution_start` carries the arguments a tool was actually handed, which
 * are expanded by definition. Print mode now re-redacts every JSON line through the
 * session's provider redactor — the same seam that keeps the wire clean — so the
 * stream carries the placeholder.
 *
 * Every assertion below reads the real bytes written to `process.stdout`, because the
 * defect was invisible to anything that inspected the event objects instead.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { type PrintModeSession, runPrintMode } from "@veyyon/coding-agent/modes/print-mode";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

/** The stored credential. Never a substring of the placeholder, so a hit is unambiguous. */
const CREDENTIAL = "ghp_harness_9f3b2c7d1e5a4806";
const PLACEHOLDER = "#DEPLOY_TOKEN#";
const ANSWER = "done";

function assistantAnswer(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: ANSWER }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

/** An assistant message whose tool call carries the EXPANDED value, as display form does. */
function expandedToolCall(): AssistantMessage {
	return {
		...assistantAnswer(),
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "bash",
				arguments: {
					command: `curl -H "Authorization: Bearer ${CREDENTIAL}" https://api.example.com`,
				},
			},
		],
	};
}

/**
 * The four events that leaked, in the order a real spend emits them.
 *
 * Built as display form on purpose: that is what `session.subscribe` hands print
 * mode, and reproducing the defect means starting from the same input the production
 * seam produces rather than from something already redacted.
 */
function spendEvents(): AgentSessionEvent[] {
	const message = expandedToolCall();
	return [
		{ type: "message_start", message },
		{
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "bash",
			args: {
				command: `curl -H "Authorization: Bearer ${CREDENTIAL}" https://api.example.com`,
			},
		},
		{ type: "message_end", message },
		{ type: "agent_end", messages: [message] },
	] as AgentSessionEvent[];
}

/**
 * Typed as {@link PrintModeSession} with no cast, so a stub that lies about the
 * surface is a build error rather than a test that passes for the wrong reason.
 *
 * `obfuscateProviderText` is the real production redactor's contract narrowed to the
 * one secret under test: value in, placeholder out. It is deliberately NOT an
 * identity here — this is the seam whose absence was the defect.
 */
function sessionEmitting(events: readonly AgentSessionEvent[]): PrintModeSession {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	return {
		state: { messages: [assistantAnswer()] },
		sessionManager: { getHeader: () => ({ type: "session", id: "session-1" }) },
		extensionRunner: undefined,
		subscribe: handler => {
			listener = handler;
			return () => {
				listener = undefined;
			};
		},
		prompt: async () => {
			for (const event of events) listener?.(event);
			return true;
		},
		dispose: async () => {},
		displayAssistantContent: content => content,
		obfuscateProviderText: text => text.split(CREDENTIAL).join(PLACEHOLDER),
	};
}

async function runJsonMode(events: readonly AgentSessionEvent[]): Promise<string> {
	const chunks: string[] = [];
	const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: unknown, ...rest: unknown[]) => {
		if (typeof chunk === "string") chunks.push(chunk);
		const last = rest[rest.length - 1];
		if (typeof last === "function") (last as () => void)();
		return true;
	});
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		await runPrintMode(sessionEmitting(events), {
			mode: "json",
			initialMessage: "deploy it",
		});
	} finally {
		stdout.mockRestore();
		stderr.mockRestore();
	}
	return chunks.join("");
}

describe("--mode json never prints a credential", () => {
	afterEach(() => {
		spyOn(process.stdout, "write").mockRestore();
	});

	it("emits the placeholder instead of the value for a spend", async () => {
		const out = await runJsonMode(spendEvents());

		expect(out).not.toContain(CREDENTIAL);
		expect(out).toContain(PLACEHOLDER);
	});

	it("redacts every one of the four events that carried the value", async () => {
		const out = await runJsonMode(spendEvents());
		const byType = new Map<string, string>();
		for (const line of out.split("\n")) {
			if (line.trim() === "") continue;
			const event = JSON.parse(line) as { type?: string };
			if (event.type !== undefined) byType.set(event.type, line);
		}

		// Each of the four is named, so a fix that only covers the loud one fails here.
		for (const type of ["message_start", "tool_execution_start", "message_end", "agent_end"]) {
			const line = byType.get(type);
			expect(line, `${type} was never emitted`).toBeDefined();
			expect(line).not.toContain(CREDENTIAL);
			expect(line).toContain(PLACEHOLDER);
		}
	});

	it("keeps the placeholder in the exact field a consumer reads the command from", async () => {
		const out = await runJsonMode(spendEvents());
		const start = out
			.split("\n")
			.filter(line => line.trim() !== "")
			.map(line => JSON.parse(line) as { type?: string; args?: { command?: string } })
			.find(event => event.type === "tool_execution_start");

		// The whole point of the stream is that a wrapper can read this field. Asserting
		// on the parsed value, not just on the line, pins the shape as well as the bytes:
		// a fix that mangled the field into something unreadable would pass a
		// not-toContain check and still break every consumer.
		expect(start?.args?.command).toBe(`curl -H "Authorization: Bearer ${PLACEHOLDER}" https://api.example.com`);
	});
});
