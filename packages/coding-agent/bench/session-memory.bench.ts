/**
 * Benchmark: resident memory of loading a large session through the real
 * pipeline.
 *
 * Measures, per phase, the heap AFTER a forced synchronous GC plus the
 * process high-water RSS, so steady-state retention and transient peaks are
 * reported separately:
 *
 *   1. module baseline      — heap before any session work
 *   2. entries loaded       — retention of the parsed entry graph
 *   3. context build        — buildSessionContext over the loaded branch
 *
 * The synthetic transcript mirrors real sessions: alternating user /
 * assistant turns with multi-KB text blocks and periodic large tool outputs.
 *
 * Run: bun packages/coding-agent/bench/session-memory.bench.ts
 *   SESSION_MB=80 bun ... to size the synthetic transcript.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../src/session/session-manager";

const TARGET_MB = Number(process.env.SESSION_MB ?? "32");
const TOOL_OUTPUT_EVERY = 10;
const TEXT_KB = 4;

function makeEntry(i: number, big: string): string {
	const timestamp = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
	const base = { type: "message", id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, timestamp };
	if (i % TOOL_OUTPUT_EVERY === TOOL_OUTPUT_EVERY - 1) {
		return JSON.stringify({
			...base,
			message: { role: "toolResult", toolCallId: `tc${i}`, toolName: "bash", output: big },
		});
	}
	if (i % 2 === 0) {
		return JSON.stringify({
			...base,
			message: { role: "user", content: [{ type: "text", text: `Task step ${i}: ${big.slice(0, 400)}` }] },
		});
	}
	return JSON.stringify({
		...base,
		message: {
			role: "assistant",
			content: [{ type: "text", text: `Analysis ${i}: ${big}` }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-test",
			usage: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0, totalTokens: 3000, cost: { total: 0.01 } },
			stopReason: "stop",
		},
	});
}

function writeSyntheticSession(dir: string): { file: string; bytes: number; count: number } {
	const file = path.join(dir, "memory-bench.jsonl");
	const big = "x".repeat(TEXT_KB * 1024);
	let written = 0;
	let count = 0;
	const fd = fs.openSync(file, "w");
	fs.writeSync(
		fd,
		`${JSON.stringify({ type: "session", version: 3, id: "membench0000000000000000000000", timestamp: new Date().toISOString(), cwd: dir })}\n`,
	);
	while (written < TARGET_MB * 1024 * 1024) {
		const line = `${makeEntry(count++, big)}\n`;
		fs.writeSync(fd, line);
		written += Buffer.byteLength(line);
	}
	fs.closeSync(fd);
	return { file, bytes: written, count };
}

/** High-water RSS in MiB. Linux reads the kernel's own VmHWM accounting;
 * other platforms fall back to the current RSS sampling. */
function peakRssMiB(): number {
	try {
		const status = fs.readFileSync("/proc/self/status", "utf8");
		const m = /VmHWM:\s+(\d+) kB/.exec(status);
		if (m) return Number(m[1]) / 1024;
	} catch {
		// not Linux
	}
	return process.memoryUsage().rss / 1048576;
}

function gcAndReport(label: string): void {
	Bun.gc(true);
	const heap = process.memoryUsage().heapUsed / 1048576;
	const rss = process.memoryUsage().rss / 1048576;
	console.log(`${label.padEnd(24)} heap ${heap.toFixed(0).padStart(5)} MiB   rss ${rss.toFixed(0).padStart(5)} MiB`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-memory-"));
const { file, bytes, count } = writeSyntheticSession(dir);
console.log(`synthetic session: ${(bytes / 1048576).toFixed(1)} MiB, ${count} entries (${TARGET_MB} MiB target)`);
gcAndReport("module baseline");

const t0 = performance.now();
const sm = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
const loadMs = performance.now() - t0;
gcAndReport(`entries loaded (${loadMs.toFixed(0)}ms)`);

const entries = sm.getEntries();
let contextChars = 0;
for (const entry of entries) {
	if (entry.type === "message") {
		const content = entry.message.content;
		if (typeof content === "string") contextChars += content.length;
		else if (Array.isArray(content))
			for (const block of content) if (block.type === "text") contextChars += block.text.length;
	}
}
console.log(`context text volume  ${((contextChars * 2) / 1048576).toFixed(1)} MiB (UTF-16)`);
console.log(`peak RSS             ${peakRssMiB().toFixed(0)} MiB`);

fs.rmSync(dir, { recursive: true, force: true });
