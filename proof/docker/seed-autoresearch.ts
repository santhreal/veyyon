/**
 * Seed one autoresearch session with logged runs, so a scene can photograph the
 * dashboard holding real data.
 *
 * Everything here goes through the product's own storage API — `openSession`,
 * `insertRun`, `markRunCompleted`, `markRunLogged` — against the database the
 * running session will open. Nothing about the surface under capture is faked:
 * the rows are the rows a session writes, and the dashboard reads them the way
 * it always does. A hand-built frame would prove nothing, which is why this
 * drives the real writer rather than printing a picture of one.
 *
 * The numbers describe a plausible tokenizer investigation: a baseline, two
 * kept improvements, a crash, a run whose checks failed, and a flagged run whose
 * metric moved for the wrong reason. That spread exists so the dashboard has to
 * render every status it supports rather than the happy one.
 *
 * Run inside the recorder before veyyon starts:
 *   bun /repo/proof/docker/seed-autoresearch.ts /sandbox/home/demo
 */
import { openAutoresearchStorage } from "../../packages/coding-agent/src/autoresearch/storage";

const cwd = process.argv[2] ?? "/sandbox/home/demo";
const branch = process.argv[3] ?? "autoresearch/tokenizer";

interface Seed {
	description: string;
	status: "keep" | "revert" | "crash" | "checks_failed";
	metric: number;
	cold: number;
	durationMs: number;
	exitCode: number | null;
	confidence: number | null;
	flagged?: boolean;
	justification?: string;
}

// A baseline, two real wins, a crash, a failed check, and a flagged arm whose
// number moved because work left the timed region rather than because anything
// got faster.
const SEEDS: Seed[] = [
	{
		description: "baseline",
		status: "keep",
		metric: 412.6,
		cold: 508.1,
		durationMs: 21_400,
		exitCode: 0,
		confidence: 3.0,
	},
	{
		description: "reuse the compiled charset table across calls",
		status: "keep",
		metric: 351.2,
		cold: 511.9,
		durationMs: 20_910,
		exitCode: 0,
		confidence: 2.6,
	},
	{
		description: "widen the token buffer so short inputs stop reallocating",
		status: "keep",
		metric: 318.7,
		cold: 509.4,
		durationMs: 19_880,
		exitCode: 0,
		confidence: 2.1,
	},
	{
		description: "index the lookahead table by codepoint",
		status: "crash",
		metric: 0,
		cold: 0,
		durationMs: 3_120,
		exitCode: 134,
		confidence: null,
	},
	{
		description: "skip normalization for ascii-only input",
		status: "checks_failed",
		metric: 274.3,
		cold: 507.7,
		durationMs: 18_240,
		exitCode: 1,
		confidence: null,
	},
	{
		description: "precompile the table at import time",
		status: "revert",
		metric: 96.4,
		cold: 1_042.8,
		durationMs: 17_990,
		exitCode: 0,
		confidence: 0.4,
		flagged: true,
		justification: "cold_ms grew 534ms against the baseline: the work moved out of the timed region.",
	},
];

const storage = await openAutoresearchStorage(cwd);
const session = storage.openSession({
	name: "tokenizer throughput",
	goal: "make the tokenizer faster",
	primaryMetric: "ms",
	metricUnit: "ms",
	direction: "lower",
	preferredCommand: "./autoresearch.sh",
	branch,
	baselineCommit: null,
	maxIterations: null,
	scopePaths: ["src/tokenizer.ts"],
	offLimits: ["bench/"],
	constraints: ["the public API does not change"],
	secondaryMetrics: ["cold_ms"],
	breadth: 3,
	attempts: 2,
	maxParallel: 3,
	certify: true,
});

let startedAt = Date.now() - 46 * 60_000;
for (const [index, seed] of SEEDS.entries()) {
	const run = storage.insertRun({
		sessionId: session.id,
		// The session row opens at segment 0; a run written to any other segment counts
		// as archived and the dashboard shows an empty current segment with "+N archived".
		segment: session.currentSegment,
		command: "./autoresearch.sh",
		logPath: `/sandbox/home/demo/.autoresearch/run-${index + 1}.log`,
		preRunDirtyPaths: [],
		startedAt,
		arm: index === 0 ? null : `arm-${((index - 1) % 3) + 1}`,
	});
	const crashed = seed.status === "crash";
	const metrics = crashed ? {} : { cold_ms: seed.cold, ms: seed.metric };
	storage.markRunCompleted({
		runId: run.id,
		completedAt: startedAt + seed.durationMs,
		durationMs: seed.durationMs,
		exitCode: seed.exitCode,
		timedOut: false,
		parsedPrimary: crashed ? null : seed.metric,
		parsedMetrics: crashed ? null : metrics,
		parsedAsi: null,
	});
	storage.markRunLogged({
		runId: run.id,
		status: seed.status,
		description: seed.description,
		metric: seed.metric,
		metrics,
		asi: null,
		commitHash: null,
		confidence: seed.confidence,
		modifiedPaths: index === 0 ? [] : ["src/tokenizer.ts"],
		scopeDeviations: [],
		justification: seed.justification ?? null,
		loggedAt: startedAt + seed.durationMs + 400,
	});
	startedAt += seed.durationMs + 5 * 60_000;
}

console.log(`seeded autoresearch session ${session.id} with ${SEEDS.length} runs on ${branch}`);
