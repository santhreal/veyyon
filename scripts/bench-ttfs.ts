/**
 * Cross-harness time-to-first-stream benchmark.
 *
 * Answers one question: when the SAME model is driven through veyyon and
 * through its vendor's own CLI, which one puts the first token on screen first?
 * TTFS is what a user actually feels; everything after it is the model's speed,
 * not the harness's.
 *
 * Parity is the whole point, so the arms are held identical where a harness
 * lets us: same model id, same prompt, same working directory, same machine,
 * and the runs are interleaved rather than batched so a network drift or a
 * provider-side warmup cannot land entirely on one arm.
 *
 * TTFS is measured from process spawn, not from the first HTTP byte. Startup is
 * part of what the user waits through, and excluding it would flatter whichever
 * harness is slowest to boot.
 *
 * Usage:
 *   bun scripts/bench-ttfs.ts --suite cursor --runs 5
 *   bun scripts/bench-ttfs.ts --suite devin --runs 5
 *   bun scripts/bench-ttfs.ts --suite cursor --json results.json
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Kept trivial on purpose: a long answer measures the model, not the harness. */
const PROMPT = "Reply with exactly: OK";

interface Arm {
	name: string;
	command: string;
	args: string[];
	/**
	 * True when a stdout line is the first streamed MODEL output. Session
	 * banners, echoed user messages and init frames must not count, or the arm
	 * that prints a header first wins on nothing.
	 */
	isFirstModelOutput(line: string): boolean;
}

interface RunResult {
	arm: string;
	ttfsMs: number | undefined;
	totalMs: number;
	exitCode: number | null;
	error?: string;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** veyyon: the first thinking/text delta inside a `message_update` envelope. */
function veyyonFirstOutput(line: string): boolean {
	const event = parseJsonLine(line);
	if (event?.type !== "message_update") return false;
	const inner = event.assistantMessageEvent as { type?: string } | undefined;
	return inner?.type === "thinking_delta" || inner?.type === "text_delta";
}

/** cursor-agent: a streamed thinking delta, or the assistant message itself. */
function cursorFirstOutput(line: string): boolean {
	const event = parseJsonLine(line);
	if (!event) return false;
	if (event.type === "thinking" && event.subtype === "delta") return true;
	return event.type === "assistant";
}

function veyyonArm(model: string): Arm {
	return {
		name: `veyyon (${model})`,
		command: "vey",
		args: ["-p", PROMPT, "--model", model, "--mode", "json"],
		isFirstModelOutput: veyyonFirstOutput,
	};
}

function cursorAgentArm(binary: string, model: string): Arm {
	return {
		name: `cursor-agent (${model})`,
		command: binary,
		args: [
			"-p",
			PROMPT,
			"--model",
			model,
			"--output-format",
			"stream-json",
			"--stream-partial-output",
			// Non-interactive runs abort on an untrusted directory; the bench dir
			// is one we created, and this only affects the trust prompt.
			"--trust",
		],
		isFirstModelOutput: cursorFirstOutput,
	};
}

function devinArm(model: string): Arm {
	return {
		name: `devin (${model})`,
		command: "devin",
		args: ["--model", model, "--print", PROMPT],
		// The devin CLI's print mode is plain text, so the first non-empty,
		// non-banner line is the first thing the user sees.
		isFirstModelOutput: line => line.trim().length > 0 && !line.trim().startsWith("["),
	};
}

/**
 * Run one arm once and time the gap between spawn and its first model output.
 *
 * The child is killed as soon as that first output lands: TTFS is the whole
 * measurement, and letting a paid agent run to completion on every repetition
 * costs money and wall time without improving the number.
 */
async function runOnce(arm: Arm, cwd: string, timeoutMs: number): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	const started = performance.now();
	let ttfsMs: number | undefined;
	let settled = false;
	let stderr = "";

	const child = spawn(arm.command, arm.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

	const finish = (exitCode: number | null, error?: string): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve({ arm: arm.name, ttfsMs, totalMs: performance.now() - started, exitCode, error });
	};

	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		finish(null, `timed out after ${timeoutMs}ms`);
	}, timeoutMs);

	let pending = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		if (ttfsMs !== undefined) return;
		pending += chunk;
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			if (!arm.isFirstModelOutput(line)) continue;
			ttfsMs = performance.now() - started;
			// The number is captured; nothing after this is measured.
			child.kill("SIGTERM");
			return;
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	child.on("error", err => finish(null, err.message));
	child.on("close", code =>
		finish(code, ttfsMs === undefined ? stderr.trim().slice(0, 300) || "no model output" : undefined),
	);

	return promise;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface ArmSummary {
	arm: string;
	samples: number[];
	failures: string[];
}

function summarize(summary: ArmSummary): string {
	const { arm, samples, failures } = summary;
	if (samples.length === 0) return `${arm}: no successful samples (${failures.length} failed)`;
	const med = median(samples);
	const min = Math.min(...samples);
	const max = Math.max(...samples);
	const failed = failures.length > 0 ? `, ${failures.length} failed` : "";
	return `${arm}: median ${med.toFixed(0)}ms (min ${min.toFixed(0)}, max ${max.toFixed(0)}, n=${samples.length}${failed})`;
}

function parseArgs(argv: string[]): { suite: string; runs: number; json?: string; timeoutMs: number } {
	let suite = "cursor";
	let runs = 5;
	let json: string | undefined;
	let timeoutMs = 180_000;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--suite") suite = argv[++i];
		else if (arg === "--runs") runs = Number(argv[++i]);
		else if (arg === "--json") json = argv[++i];
		else if (arg === "--timeout") timeoutMs = Number(argv[++i]) * 1000;
	}
	if (!Number.isFinite(runs) || runs < 1) throw new Error("--runs must be a positive integer");
	return { suite, runs, json, timeoutMs };
}

async function resolveCursorAgentBinary(): Promise<string> {
	const explicit = process.env.CURSOR_AGENT_BIN;
	if (explicit) return explicit;
	const versionsDir = path.join(os.homedir(), ".local/share/cursor-agent/versions");
	const entries = await fs.readdir(versionsDir);
	// Version directories sort lexicographically by date prefix, so the last is newest.
	const newest = entries.sort().at(-1);
	if (!newest) throw new Error(`no cursor-agent versions under ${versionsDir}`);
	return path.join(versionsDir, newest, "cursor-agent");
}

async function buildSuite(suite: string): Promise<Arm[]> {
	switch (suite) {
		case "cursor": {
			// The same model id on both sides, and deliberately NOT the `-fast`
			// variant: fast mode is a different, pricier product tier, and
			// comparing it against a standard tier would measure the tier.
			const model = "cursor-grok-4.5-medium";
			return [veyyonArm(`cursor/${model}`), cursorAgentArm(await resolveCursorAgentBinary(), model)];
		}
		case "devin": {
			const model = process.env.DEVIN_BENCH_MODEL ?? "swe-1-6-slow";
			return [veyyonArm(`devin/${model}`), devinArm(model)];
		}
		case "kimi": {
			// Kimi for Coding speaks `openai-completions` at api.kimi.com/coding/v1.
			// It ships no CLI of its own, so this suite has a single arm: it is an
			// absolute TTFS number for the model, not a head-to-head.
			const model = process.env.KIMI_BENCH_MODEL ?? "kimi-for-coding";
			return [veyyonArm(`kimi-code/${model}`)];
		}
		default:
			throw new Error(`unknown suite: ${suite} (expected "cursor", "devin", or "kimi")`);
	}
}

async function main(): Promise<void> {
	const { suite, runs, json, timeoutMs } = parseArgs(process.argv.slice(2));
	const arms = await buildSuite(suite);
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-ttfs-"));

	const summaries = new Map<string, ArmSummary>();
	for (const arm of arms) summaries.set(arm.name, { arm: arm.name, samples: [], failures: [] });

	console.log(`suite=${suite} runs=${runs} cwd=${cwd}`);
	console.log(`prompt=${JSON.stringify(PROMPT)}\n`);

	const results: RunResult[] = [];
	// Interleaved, not batched: a provider warming up or a network dip would
	// otherwise land entirely on whichever arm ran first.
	for (let run = 1; run <= runs; run++) {
		for (const arm of arms) {
			const result = await runOnce(arm, cwd, timeoutMs);
			results.push(result);
			const summary = summaries.get(arm.name)!;
			if (result.ttfsMs !== undefined) summary.samples.push(result.ttfsMs);
			else summary.failures.push(result.error ?? "unknown failure");
			const shown = result.ttfsMs !== undefined ? `${result.ttfsMs.toFixed(0)}ms` : `FAILED (${result.error})`;
			console.log(`  run ${run} ${arm.name}: ${shown}`);
		}
	}

	console.log("");
	const ordered = [...summaries.values()].sort((a, b) => {
		if (a.samples.length === 0) return 1;
		if (b.samples.length === 0) return -1;
		return median(a.samples) - median(b.samples);
	});
	for (const summary of ordered) console.log(summarize(summary));

	const [fastest, next] = ordered;
	if (fastest?.samples.length && next?.samples.length) {
		const delta = median(next.samples) - median(fastest.samples);
		const pct = (delta / median(next.samples)) * 100;
		console.log(`\n${fastest.arm} is faster by ${delta.toFixed(0)}ms (${pct.toFixed(1)}%) at the median.`);
	}

	if (json) {
		await fs.writeFile(json, `${JSON.stringify({ suite, runs, prompt: PROMPT, results }, null, 2)}\n`);
		console.log(`\nwrote ${json}`);
	}
}

await main();
