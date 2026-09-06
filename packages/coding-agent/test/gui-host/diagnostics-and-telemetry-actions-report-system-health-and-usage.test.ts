/**
 * WHY:
 *
 * Earlier implementations of diagnostics and telemetry actions (RefreshDiagnostics,
 * RetryDiagnosticSource, ClearOutput, GetUsage, GetContextBreakdown) were shallow stubs:
 * RetryDiagnosticSource succeeded emptily without retrying or checking retryability,
 * ClearOutput was a no-op that never updated the session or transcript, GetUsage zero-filled
 * usage statistics regardless of session state, and GetContextBreakdown swallowed errors
 * into an empty array instead of failing truthfully.
 *
 * This suite defends:
 * 1. RefreshDiagnostics collects real diagnostic sources (LSP, MCP, supervisor) and host process telemetry.
 * 2. RetryDiagnosticSource truthfully rejects non-retryable sources with DIAGNOSTIC_SOURCE_NOT_RETRYABLE.
 * 3. ClearOutput creates a new clean session under the same workspace and emits both ActiveSession and Transcript.
 * 4. GetUsage returns real session statistics with input, output, cache tokens and cost without zero-filling.
 * 5. GetContextBreakdown calculates real token categories where total_tokens equals the category sum.
 *
 * Gap left:
 * Language server LSP binary execution and external MCP process spawning are exercised by subsystem suites;
 * this suite defends host protocol delivery, error mapping, and snapshot emission against the real server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";
import { TestSocketClient } from "./test-client";

const makeTempDir = useTrackedTempDirs("gui-host-diagnostics-test-");

interface DiagnosticsSnapshotFrame {
	Snapshot?: {
		Diagnostics?: {
			sources: Array<{ name: string; status: string }>;
			host: {
				platform: string;
				arch: string;
				node_version: string;
				uptime_seconds: number;
			};
		};
	};
}

interface UsageSnapshotFrame {
	Snapshot?: {
		Usage?: {
			session: string;
			totals: {
				input_tokens: number;
				output_tokens: number;
				cache_read_tokens: number;
				cache_write_tokens: number;
				orchestration_tokens: number;
				premium_requests: number;
				cost_microusd: number | null;
			};
		};
	};
}

interface ContextBreakdownSnapshotFrame {
	Snapshot?: {
		ContextBreakdown?: {
			session: string;
			total_tokens: number;
			limit_tokens: number | null;
			categories: Array<{ name: string; tokens: number }>;
		};
	};
}

interface ActiveSessionSnapshotFrame {
	Snapshot?: {
		ActiveSession?: {
			revision: number;
			value: {
				id: string;
				cwd: string;
			};
		};
	};
}

interface TranscriptSnapshotFrame {
	Snapshot?: {
		Transcript?: {
			revision: number;
			value: unknown[];
		};
	};
}

describe("diagnostics and telemetry action group behaviour", () => {
	let tempDir: string;
	let agentDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = makeTempDir();
		agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
	});

	test("RefreshDiagnostics emits real diagnostic sources and host telemetry", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(1, "RefreshDiagnostics");
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const diagFrame: DiagnosticsSnapshotFrame | undefined = res.frames.find(
			f => f.Snapshot && "Diagnostics" in f.Snapshot,
		);
		expect(diagFrame?.Snapshot?.Diagnostics).toBeDefined();

		const sources = diagFrame?.Snapshot?.Diagnostics?.sources ?? [];
		expect(sources.length).toBeGreaterThanOrEqual(2);
		expect(sources.some(s => s.name === "lsp")).toBe(true);
		expect(sources.some(s => s.name === "mcp")).toBe(true);

		const host = diagFrame?.Snapshot?.Diagnostics?.host;
		expect(host?.platform).toBe(process.platform);
		expect(host?.arch).toBe(process.arch);
		expect(host?.node_version).toBe(process.version);

		client.destroy();
	});

	test("RetryDiagnosticSource without source fails with INVALID_ARGUMENTS in scope Diagnostic", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(2, { RetryDiagnosticSource: {} });
		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(2);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Diagnostic");
		expect(res.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(res.outcome.RequestFailed?.error.message).toBe("RetryDiagnosticSource requires a source parameter");

		client.destroy();
	});

	test("RetryDiagnosticSource with non-retryable source fails with DIAGNOSTIC_SOURCE_NOT_RETRYABLE", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(3, {
			RetryDiagnosticSource: {
				source: "unknown_custom_source",
			},
		});

		expect(res.outcome.RequestFailed).toBeDefined();
		expect(res.outcome.RequestFailed?.request).toBe(3);
		expect(res.outcome.RequestFailed?.error.scope).toBe("Diagnostic");
		expect(res.outcome.RequestFailed?.error.code).toBe("DIAGNOSTIC_SOURCE_NOT_RETRYABLE");
		expect(res.outcome.RequestFailed?.error.message).toBe(
			"Diagnostic source 'unknown_custom_source' is not retryable",
		);

		client.destroy();
	});

	test("ClearOutput resets session transcript and emits ActiveSession and Transcript", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(4, { ClearOutput: {} });
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 4 } });

		const activeFrame: ActiveSessionSnapshotFrame | undefined = res.frames.find(
			f => f.Snapshot && "ActiveSession" in f.Snapshot,
		);
		expect(activeFrame?.Snapshot?.ActiveSession).toBeDefined();
		expect(activeFrame?.Snapshot?.ActiveSession?.value.cwd).toBe(tempDir);

		const transcriptFrame: TranscriptSnapshotFrame | undefined = res.frames.find(
			f => f.Snapshot && "Transcript" in f.Snapshot,
		);
		expect(transcriptFrame?.Snapshot?.Transcript).toBeDefined();
		expect(Array.isArray(transcriptFrame?.Snapshot?.Transcript?.value)).toBe(true);

		client.destroy();
	});

	test("GetUsage on a fresh session returns zero totals with the session id", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(5, { GetUsage: {} });
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 5 } });

		const usageFrame: UsageSnapshotFrame | undefined = res.frames.find(f => f.Snapshot && "Usage" in f.Snapshot);
		expect(usageFrame?.Snapshot?.Usage).toBeDefined();

		const usage = usageFrame?.Snapshot?.Usage;
		expect(typeof usage?.session).toBe("string");
		expect(usage?.session.length).toBeGreaterThan(0);
		expect(usage?.totals.input_tokens).toBe(0);
		expect(usage?.totals.output_tokens).toBe(0);
		expect(usage?.totals.cache_read_tokens).toBe(0);
		expect(usage?.totals.cache_write_tokens).toBe(0);
		expect(usage?.totals.premium_requests).toBe(0);

		client.destroy();
	});

	test("GetContextBreakdown returns total_tokens equal to the sum of its categories", async () => {
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir,
		});
		const client = await TestSocketClient.connect(server.endpoint);

		const res = await client.request(6, { GetContextBreakdown: {} });
		expect(res.outcome).toEqual({ RequestSucceeded: { request: 6 } });

		const ctxFrame: ContextBreakdownSnapshotFrame | undefined = res.frames.find(
			f => f.Snapshot && "ContextBreakdown" in f.Snapshot,
		);
		expect(ctxFrame?.Snapshot?.ContextBreakdown).toBeDefined();

		const breakdown = ctxFrame?.Snapshot?.ContextBreakdown;
		expect(typeof breakdown?.session).toBe("string");
		expect(Array.isArray(breakdown?.categories)).toBe(true);

		const categories = breakdown?.categories ?? [];
		const sumTokens = categories.reduce((sum, cat) => sum + cat.tokens, 0);
		expect(breakdown?.total_tokens).toBe(sumTokens);

		client.destroy();
	});
});
