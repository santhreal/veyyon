/**
 * WHY: the streaming-edit guard stops a turn while a patch-mode `edit` call is still streaming,
 * once a removed line is known to be absent from the target file. It scans each diff line once as
 * the stream grows, so the defects this suite closes are the ones an incremental scan invites:
 * a verdict that lands late or never (a line skipped between deltas, the final line dropped when
 * the call ends without a newline), a verdict read against file contents a completed edit already
 * replaced, and a scan that aborts on, or silently skips past, a secret placeholder it cannot
 * expand yet.
 *
 * It drives the real `StreamingEditGuard` against a real file, with the session reduced to the
 * host interface the guard declares. It does not cover the session wiring (the interceptor, the
 * turn-start reset, the post-edit invalidation hook), which `streaming-edit-abort.test.ts` drives
 * end to end through `AgentSession`, nor the auto-generated-file check, which
 * `edit-auto-generated-regressions.test.ts` owns.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@veyyon/ai";
import { StreamingEditGuard } from "@veyyon/coding-agent/session/runtime/streaming-edit-guard";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

const SECRET = "#SECRET#";
const SECRET_VALUE = "hunter2";

interface Harness {
	guard: StreamingEditGuard;
	/** Turns the host stopped. */
	aborts(): number;
	/** Whether a live placeholder can be expanded; while false, expansion yields `undefined`. */
	setSecretsFresh(fresh: boolean): void;
	setStreamingAbort(enabled: boolean): void;
}

function createHarness(cwd: string): Harness {
	let aborts = 0;
	let fresh = true;
	let streamingAbort = true;
	const guard = new StreamingEditGuard({
		abortTurn: () => {
			aborts++;
		},
		streamingAbortEnabled: () => streamingAbort,
		fuzzyMatch: () => ({ allowFuzzy: false, fuzzyThreshold: 1 }),
		cwd: () => cwd,
		localProtocol: () => ({}),
		expandSecretsForDiskComparison: text => {
			if (!text.includes(SECRET)) return text;
			return fresh ? text.replaceAll(SECRET, SECRET_VALUE) : undefined;
		},
		redactForLog: text => text.replaceAll(SECRET_VALUE, SECRET),
	});
	return {
		guard,
		aborts: () => aborts,
		setSecretsFresh: value => {
			fresh = value;
		},
		setStreamingAbort: value => {
			streamingAbort = value;
		},
	};
}

function messageWith(toolCall: ToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
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
		timestamp: 0,
	};
}

/** One streaming `edit` call: `start` opens it, each `delta` appends to its diff, `end` closes it. */
function streamCall(guard: StreamingEditGuard, id: string, filePath: string) {
	let diff = "";
	const snapshot = (): { message: AssistantMessage; toolCall: ToolCall } => {
		const toolCall: ToolCall = { type: "toolCall", id, name: "edit", arguments: { path: filePath, diff } };
		return { message: messageWith(toolCall), toolCall };
	};
	return {
		start(): void {
			const { message } = snapshot();
			guard.observe(message, { type: "toolcall_start", contentIndex: 0, partial: message });
		},
		delta(chunk: string): void {
			diff += chunk;
			const { message } = snapshot();
			const event: AssistantMessageEvent = {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: chunk,
				partial: message,
			};
			guard.observe(message, event);
		},
		end(): void {
			const { message, toolCall } = snapshot();
			guard.observe(message, { type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
		},
	};
}

let tempDir: string;
let target: string;

beforeEach(() => {
	tempDir = path.join(os.tmpdir(), `veyyon-streaming-edit-guard-${Snowflake.next()}`);
	fs.mkdirSync(tempDir, { recursive: true });
	target = path.join(tempDir, "notes.txt");
	fs.writeFileSync(target, `alpha\nbeta\ntoken=${SECRET_VALUE}\ngamma\n`);
});

afterEach(() => {
	removeSyncWithRetries(tempDir);
});

describe("a streaming edit", () => {
	it("stops the turn on the delta that completes a removed line the file lacks, and only once", () => {
		const h = createHarness(tempDir);
		const call = streamCall(h.guard, "call-1", "notes.txt");
		call.start();
		call.delta("@@\n-alpha\n");
		call.delta("-bet");
		call.delta("a\n+BETA\n-miss");
		expect(h.aborts()).toBe(0);
		call.delta("ing\n");
		expect(h.aborts()).toBe(1);
		expect(h.guard.abortTriggered).toBe(true);
		call.delta("-also missing\n");
		call.end();
		expect(h.aborts()).toBe(1);
	});

	it("streams to the end without stopping when every removed line is in the file", () => {
		const h = createHarness(tempDir);
		const call = streamCall(h.guard, "call-1", "notes.txt");
		call.start();
		for (const chunk of ["@@ alpha\n-be", "ta\n+BETA\n", " gamma\n", "-gamma"]) call.delta(chunk);
		call.end();
		expect(h.aborts()).toBe(0);
		expect(h.guard.abortTriggered).toBe(false);
	});

	it("checks the final removed line when the call ends without a trailing newline", () => {
		const h = createHarness(tempDir);
		const call = streamCall(h.guard, "call-1", "notes.txt");
		call.start();
		call.delta("@@\n-alpha\n-delta");
		expect(h.aborts()).toBe(0);
		call.end();
		expect(h.aborts()).toBe(1);
	});

	it("verifies a later call against the contents a completed edit wrote", () => {
		const h = createHarness(tempDir);
		const first = streamCall(h.guard, "call-1", "notes.txt");
		first.start();
		first.delta("@@\n-alpha\n+omega\n");
		first.end();
		fs.writeFileSync(target, `omega\nbeta\ntoken=${SECRET_VALUE}\ngamma\n`);
		h.guard.invalidate("notes.txt");

		const second = streamCall(h.guard, "call-2", "notes.txt");
		second.start();
		second.delta("@@\n-omega\n+psi\n");
		second.end();
		expect(h.aborts()).toBe(0);

		const third = streamCall(h.guard, "call-3", "notes.txt");
		third.start();
		third.delta("@@\n-alpha\n");
		expect(h.aborts()).toBe(1);
	});

	it("re-verifies a call still streaming when an edit to its file completes mid-stream", () => {
		const h = createHarness(tempDir);
		const call = streamCall(h.guard, "call-1", "notes.txt");
		call.start();
		call.delta("@@\n-alpha\n");
		expect(h.aborts()).toBe(0);
		fs.writeFileSync(target, `omega\nbeta\ntoken=${SECRET_VALUE}\ngamma\n`);
		h.guard.invalidate("notes.txt");
		call.delta("+psi\n");
		expect(h.aborts()).toBe(1);
	});

	it("pauses on a placeholder it cannot expand yet, then resumes at that line", () => {
		const h = createHarness(tempDir);
		h.setSecretsFresh(false);
		const call = streamCall(h.guard, "call-1", "notes.txt");
		call.start();
		call.delta(`@@\n-token=${SECRET}\n-missing\n`);
		// The scan stopped at the placeholder line, so the missing line after it is not judged yet.
		expect(h.aborts()).toBe(0);

		h.setSecretsFresh(true);
		call.delta("+token=rotated\n");
		expect(h.aborts()).toBe(1);
	});

	it("matches an expanded placeholder against the file's cleartext", () => {
		const h = createHarness(tempDir);
		const call = streamCall(h.guard, "call-1", "notes.txt");
		call.start();
		call.delta(`@@\n-token=${SECRET}\n+token=rotated\n`);
		call.end();
		expect(h.aborts()).toBe(0);
	});

	it("does not judge removed lines while edit.streamingAbort is off", () => {
		const h = createHarness(tempDir);
		h.setStreamingAbort(false);
		const call = streamCall(h.guard, "call-1", "notes.txt");
		call.start();
		call.delta("@@\n-missing\n");
		call.end();
		expect(h.aborts()).toBe(0);
	});

	it("skips an internal URL with no filesystem path", () => {
		const h = createHarness(tempDir);
		const call = streamCall(h.guard, "call-1", "agent://worker/notes.txt");
		call.start();
		call.delta("@@\n-missing\n");
		call.end();
		expect(h.aborts()).toBe(0);
	});

	it("judges the next turn afresh once the turn resets", () => {
		const h = createHarness(tempDir);
		const first = streamCall(h.guard, "call-1", "notes.txt");
		first.start();
		first.delta("@@\n-missing\n");
		expect(h.aborts()).toBe(1);

		h.guard.resetForTurn();
		expect(h.guard.abortTriggered).toBe(false);
		const second = streamCall(h.guard, "call-2", "notes.txt");
		second.start();
		second.delta("@@\n-also missing\n");
		expect(h.aborts()).toBe(2);
	});
});
