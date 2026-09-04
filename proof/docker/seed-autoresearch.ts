/**
 * Seed a finished autoresearch or autoswarm session, so a scene can photograph
 * the surfaces that read one.
 *
 *   bun proof/docker/seed-autoresearch.ts <repo-dir> <swarm|serial>
 *
 * The run screen, the status row and the widget they replaced all render from a
 * session and its logged runs. Producing those by running the loop needs a
 * harness in the tree and a model willing to spend an hour in it, which is why
 * the setup-console scene stops at the console: a capture cannot wait for it.
 *
 * This writes the session through the product's own storage API rather than
 * through SQL, so the fixture cannot drift from the schema, and it goes to the
 * path the CLI resolves from the same HOME the session runs under. The command
 * the scene types then reaches it the way a user reaches yesterday's run: the
 * tree is already on the session's `autoresearch/*` branch, so
 * `ensureAutoresearchBranch` keeps it and `getActiveSessionForBranch` finds the
 * session.
 *
 * Nothing here fakes a surface. Every value is one the loop itself writes:
 * statuses through `markRunLogged`, an arm and its reviewer through the same
 * call, a flag through `flagRun`.
 */
import { execFileSync } from "node:child_process";
import { openAutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import type { ExperimentStatus } from "@veyyon/coding-agent/autoresearch/types";

const [repoDir, kind] = process.argv.slice(2);
if (!repoDir || (kind !== "swarm" && kind !== "serial")) {
	throw new Error("usage: seed-autoresearch.ts <repo-dir> <swarm|serial>");
}

const git = (...args: string[]): string =>
	execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();

/**
 * One arm's run: measured, logged, and attributed the way the loop leaves it.
 *
 * `status` is the product's own `ExperimentStatus`, imported rather than spelled
 * out here: the first fixture wrote `revert`, which is not one of them, so
 * `parseStatus` read it back as null and the screen dropped those two runs
 * without a word. The set is swept below so every status a run can carry appears
 * in a frame.
 */
interface SeedRun {
	segment: number;
	arm: string | null;
	/** `provider/id` the run was measured on, as `run_experiment` records it. */
	model?: string;
	metric: number;
	status: ExperimentStatus;
	description: string;
	certifiedBy?: string;
	flaggedReason?: string;
	confidence?: number;
	justification?: string;
}

const SWARM_RUNS: readonly SeedRun[] = [
	{
		segment: 0,
		arm: null,
		model: "anthropic/claude-sonnet-4-5",
		metric: 240.1,
		status: "keep",
		description: "Baseline: tokenize 64 MB of source with the shipped scanner",
		justification: "First measurement of the segment, so it stands as the bar the arms have to clear.",
	},
	{
		segment: 0,
		arm: "b",
		model: "openai/gpt-5",
		metric: 251.42,
		status: "discard",
		description: "Batch the codepoint classifier behind a 4 KB lookahead",
		certifiedBy: "c",
		justification: "Slower than the baseline on the same corpus, so the arm is discarded rather than kept.",
	},
	{
		segment: 0,
		arm: "c",
		model: "anthropic/claude-sonnet-4-5",
		metric: 214.83,
		status: "keep",
		description: "Replace the per-token allocation with one arena per chunk",
		certifiedBy: "d",
		confidence: 2.4,
	},
	{
		segment: 0,
		arm: "d",
		model: "zai/glm-4.6",
		metric: 180.24,
		status: "keep",
		description: "Skip the classifier for pure-ASCII runs",
		certifiedBy: "b",
		flaggedReason: "Reviewer b: the benchmark corpus was regenerated inside the run, so the input shrank.",
	},
	{
		segment: 1,
		arm: "b",
		model: "openai/gpt-5",
		metric: 244.51,
		status: "checks_failed",
		description: "Fold the classifier table into the scanner and widen the lookahead",
		certifiedBy: "a",
		justification: "Two tokenizer tests fail on multi-byte input, so the measurement does not count.",
	},
	{
		segment: 1,
		arm: "d",
		model: "zai/glm-4.6",
		metric: 0,
		status: "crash",
		description: "Reuse one arena across chunks without resetting it",
		justification: "Segfault in the scanner after the first chunk; no metric was produced.",
	},
	{
		segment: 1,
		arm: "a",
		model: "google/gemini-2.5-pro",
		metric: 205.94,
		status: "keep",
		description: "Arena per chunk, plus a branchless ASCII fast path",
		certifiedBy: "c",
		confidence: 3.1,
	},
	{
		segment: 1,
		arm: "c",
		model: "anthropic/claude-sonnet-4-5",
		metric: 192.78,
		status: "keep",
		description: "Arena per chunk with the classifier table folded into the scanner",
		certifiedBy: "a",
		confidence: 4.2,
		justification: "Fastest measured arm of the segment, certified by a against the same corpus.",
	},
];

const SERIAL_RUNS: readonly SeedRun[] = [
	{
		segment: 0,
		arm: null,
		model: "anthropic/claude-sonnet-4-5",
		metric: 96.4,
		status: "keep",
		description: "Baseline: parse the 12 MB fixture with the shipped recursive descent",
	},
	{
		segment: 0,
		arm: null,
		model: "anthropic/claude-sonnet-4-5",
		metric: 101.2,
		status: "discard",
		description: "Memoize the token lookahead in a Map",
		justification: "The map cost more than the re-scan it saved.",
	},
	{
		segment: 0,
		arm: null,
		model: "anthropic/claude-sonnet-4-5",
		metric: 94.8,
		status: "checks_failed",
		description: "Parse numbers with a hand-rolled scanner",
		justification: "Three parser tests disagree on exponent forms, so the measurement does not count.",
	},
	{
		segment: 0,
		arm: null,
		model: "anthropic/claude-sonnet-4-5",
		metric: 88.71,
		status: "keep",
		description: "Reuse one token buffer across nodes",
		confidence: 1.9,
	},
];

const FIXTURES = {
	swarm: {
		branch: "autoresearch/tokenizer-throughput",
		name: "tokenizer-throughput",
		goal: "make the tokenizer faster",
		metric: "wall time",
		unit: "ms",
		breadth: 4,
		attempts: 2,
		certify: true,
		runs: SWARM_RUNS,
		notes: [
			"The corpus is fixed: 64 MB of vendored source, regenerated never.",
			"An arm that touches the benchmark harness is flagged, not kept.",
			"The arena allocator is the only change that held across both segments.",
			"Lookahead wider than 4 KB has lost twice; stop proposing it.",
		].join("\n"),
		scopePaths: ["src/tokenizer", "src/scanner"],
		offLimits: ["bench/corpus", "bench/harness.ts"],
		constraints: ["No new dependency", "Output tokens must stay byte-identical"],
	},
	serial: {
		branch: "autoresearch/parser-allocations",
		name: "parser-allocations",
		goal: "cut parser wall time without changing its output",
		metric: "wall time",
		unit: "ms",
		breadth: 1,
		attempts: 1,
		certify: false,
		runs: SERIAL_RUNS,
		notes: [
			"Measure with the 12 MB fixture; the small one is inside the noise floor.",
			"Memoization has lost once — the map costs more than the re-scan.",
		].join("\n"),
		scopePaths: ["src/parser"],
		offLimits: ["test/fixtures"],
		constraints: ["Parse tree must stay identical"],
	},
}[kind];

// The session's branch has to be the branch the tree is on: `/autoresearch` keeps
// an `autoresearch/*` branch it finds rather than allocating a new one, and the
// session is looked up by exactly that name.
const branches = git("branch", "--list", FIXTURES.branch);
if (branches.length === 0) git("checkout", "-q", "-b", FIXTURES.branch);
else git("checkout", "-q", FIXTURES.branch);
const baselineCommit = git("rev-parse", "HEAD");

const storage = await openAutoresearchStorage(repoDir);
const session = storage.openSession({
	name: FIXTURES.name,
	goal: FIXTURES.goal,
	primaryMetric: FIXTURES.metric,
	metricUnit: FIXTURES.unit,
	direction: "lower",
	preferredCommand: "bun bench/tokenize.ts --corpus bench/corpus",
	branch: FIXTURES.branch,
	baselineCommit,
	maxIterations: 12,
	scopePaths: FIXTURES.scopePaths,
	offLimits: FIXTURES.offLimits,
	constraints: FIXTURES.constraints,
	secondaryMetrics: ["peak rss"],
	breadth: FIXTURES.breadth,
	attempts: FIXTURES.attempts,
	maxParallel: FIXTURES.breadth,
	certify: FIXTURES.certify,
});
storage.updateSession(session.id, { notes: FIXTURES.notes });

// Timestamps walk backwards from a fixed distance before now, so elapsed and
// "logged" ages read as a session someone left this morning rather than as a
// wall of identical instants.
const started = Date.now() - 1000 * 60 * 214;
let clock = started;
for (const seed of FIXTURES.runs) {
	clock += 1000 * 60 * 7;
	// A crashed command produces no parseable output, so the harness parses no
	// primary and no secondaries, and the log call that records the outcome has
	// no numbers to declare. Seeding it with the zero the run row carries would
	// state that the harness measured zero, which is the reading the screen now
	// distinguishes from an unmeasured run.
	const measured = seed.status !== "crash";
	const metrics: Record<string, number> = measured
		? { "wall time": seed.metric, "peak rss": 128 + seed.segment * 4 }
		: {};
	const run = storage.insertRun({
		sessionId: session.id,
		segment: seed.segment,
		command: "bun bench/tokenize.ts --corpus bench/corpus",
		logPath: `${repoDir}/.veyyon-autoresearch/run-${seed.segment}-${seed.arm ?? "serial"}.log`,
		preRunDirtyPaths: [],
		startedAt: clock,
		arm: seed.arm,
		model: seed.model ?? null,
	});
	storage.markRunCompleted({
		runId: run.id,
		completedAt: clock + Math.round(seed.metric * 1000),
		durationMs: Math.round(seed.metric * 1000),
		exitCode: measured ? 0 : 139,
		timedOut: false,
		parsedPrimary: measured ? seed.metric : null,
		parsedMetrics: metrics,
		parsedAsi: null,
	});
	storage.markRunLogged({
		runId: run.id,
		status: seed.status,
		description: seed.description,
		metric: seed.metric,
		metrics,
		asi: null,
		commitHash: baselineCommit,
		confidence: seed.confidence ?? null,
		modifiedPaths: seed.arm ? [`src/tokenizer/arm-${seed.arm}.ts`] : ["src/parser/parse.ts"],
		scopeDeviations: [],
		justification: seed.justification ?? null,
		loggedAt: clock + Math.round(seed.metric * 1000) + 1000 * 30,
		arm: seed.arm,
		certifiedBy: seed.certifiedBy ?? null,
	});
	if (seed.flaggedReason) storage.flagRun(run.id, seed.flaggedReason);
}

// The screen groups by segment and the status row reports the CURRENT one, so the
// session has to sit on the segment its newest runs belong to.
const lastSegment = FIXTURES.runs[FIXTURES.runs.length - 1].segment;
for (let segment = 0; segment < lastSegment; segment += 1) storage.bumpSegment(session.id);

storage.close();
process.stdout.write(`seeded ${kind} session ${session.id} on ${FIXTURES.branch} with ${FIXTURES.runs.length} runs\n`);
