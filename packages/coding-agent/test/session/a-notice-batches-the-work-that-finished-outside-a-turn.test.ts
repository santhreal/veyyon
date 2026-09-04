/**
 * WHY: these four notices are the only way a session reports work that finished
 * while no turn was running. Each one is injected into the conversation, so an
 * empty batch that still returns a message injects a turn about nothing, and a
 * duplicate MCP notification asks the model to re-read the same resource. The
 * secret-protection notice is a fail-closed message: it has to name the key path
 * and the one command that starts without protection, or the operator is left
 * with a fatal error and no way out.
 *
 * Closes the class: every builder is asserted to return `null` on an empty
 * batch, to carry each entry's identity into its details, and — for the MCP
 * batch — to dedupe on the (server, uri) pair rather than on either half.
 *
 * Does NOT catch: when the session flushes a batch, nor the rendered wording of
 * the async-result and late-diagnostics templates beyond the values they carry.
 */

import { describe, expect, it } from "bun:test";
import type { AsyncJob } from "../../src/async";
import type { AsyncResultEntry } from "../../src/session/agent-session-types";
import {
	buildAsyncResultBatchMessage,
	buildLateDiagnosticsBatchMessage,
	buildMcpNotificationBatchMessage,
	secretProtectionUnavailableMessage,
} from "../../src/session/factory-notices";
import type { DeferredDiagnosticsEntry } from "../../src/tools";

function asyncEntry(jobId: string, label: string): AsyncResultEntry {
	return {
		jobId,
		result: `${jobId} finished`,
		job: { id: jobId, type: "bash", label } as unknown as AsyncJob,
		durationMs: 1200,
	};
}

function diagnosticsEntry(path: string, errored: boolean): DeferredDiagnosticsEntry {
	return {
		path,
		summary: errored ? "2 errors" : "1 warning",
		messages: [`${path}:1 something`],
		errored,
		isStale: () => false,
	};
}

describe("a notice batches the work that finished outside a turn", () => {
	it("injects nothing for an empty batch, on every notice that batches", () => {
		expect(buildAsyncResultBatchMessage([])).toBeNull();
		expect(buildLateDiagnosticsBatchMessage([])).toBeNull();
		expect(buildMcpNotificationBatchMessage([])).toBeNull();
	});

	it("carries every finished job's identity into the async-result details", () => {
		const message = buildAsyncResultBatchMessage([asyncEntry("job-1", "build"), asyncEntry("job-2", "test")]);

		expect(message).not.toBeNull();
		if (!message) return;
		expect(message.role).toBe("custom");
		expect(message.customType).toBe("async-result");
		expect(message.display).toBe(true);
		expect(message.attribution).toBe("agent");
		expect(message.details?.jobs).toEqual([
			{ jobId: "job-1", type: "bash", label: "build", durationMs: 1200 },
			{ jobId: "job-2", type: "bash", label: "test", durationMs: 1200 },
		]);
	});

	it("renders each job's result into the async-result body", () => {
		const message = buildAsyncResultBatchMessage([asyncEntry("job-1", "build")]);

		expect(typeof message?.content).toBe("string");
		expect(message?.content).toContain("job-1 finished");
	});

	it("keeps a job whose type and label are unknown, without inventing either", () => {
		const message = buildAsyncResultBatchMessage([
			{ jobId: "job-3", result: "done", job: undefined, durationMs: undefined },
		]);

		expect(message?.details?.jobs).toEqual([
			{ jobId: "job-3", type: undefined, label: undefined, durationMs: undefined },
		]);
	});

	it("carries each late-diagnostics file and whether it errored", () => {
		const message = buildLateDiagnosticsBatchMessage([
			diagnosticsEntry("/repo/src/a.ts", true),
			diagnosticsEntry("/repo/src/b.ts", false),
		]);

		expect(message?.display).toBe(true);
		expect(message?.attribution).toBe("agent");
		expect(message?.details?.files).toEqual([
			{ path: "/repo/src/a.ts", summary: "2 errors", errored: true, messages: ["/repo/src/a.ts:1 something"] },
			{ path: "/repo/src/b.ts", summary: "1 warning", errored: false, messages: ["/repo/src/b.ts:1 something"] },
		]);
	});

	it("names every updated MCP resource once, keyed on the server and the uri together", () => {
		const message = buildMcpNotificationBatchMessage([
			{ serverName: "docs", uri: "file:///a" },
			{ serverName: "docs", uri: "file:///a" },
			{ serverName: "docs", uri: "file:///b" },
			{ serverName: "other", uri: "file:///a" },
		]);

		expect(message).not.toBeNull();
		if (!message) return;
		expect(message.role).toBe("user");
		if (message.role !== "user") return;
		const text = JSON.stringify(message.content);
		expect(text).toContain("3 resource(s) updated");
		expect(text.split("file:///a").length - 1).toBe(2);
		expect(text).toContain('server=\\"docs\\" uri=file:///b');
		expect(text).toContain('read(path=\\"mcp://<uri>\\")');
	});

	it("names the key path, the directory to check and the opt-out command when protection cannot start", () => {
		const notice = secretProtectionUnavailableMessage("/repo/.veyyon");

		expect(notice).toContain("/repo/.veyyon");
		expect(notice).toContain("veyyon config set secrets.enabled false");
		expect(notice).toContain("cannot redact or expand secrets");
	});
});
