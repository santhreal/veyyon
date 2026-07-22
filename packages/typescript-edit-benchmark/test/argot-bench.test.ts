/**
 * The Argot live adoption bench. Two layers:
 *
 *  1. DETERMINISTIC seams (always run): the fixtures load into real tasks, and a
 *     task's working directory is prepared as an argot project that arms a
 *     vocabulary. These need no model and certify that the live runner's setup is
 *     sound — if the fixtures did not load or the workdir did not arm, the live
 *     bench could never measure anything.
 *
 *  2. The LIVE certifier (opt-in): runs a real model over the tasks with argot on
 *     and off and asserts the four truths (adoption > 0, net output tokens < 0,
 *     task-pass parity, zero lossy expansions). It requires a model id in
 *     `ARGOT_BENCH_MODEL`; without it the test SKIPS LOUDLY (a console line), it
 *     never passes silently. Set e.g.
 *     `ARGOT_BENCH_MODEL=google-antigravity/gemini-2.5-flash` to run it. Today it
 *     is expected to be RED (the gate fires but adoption is ~zero) until the
 *     upstream dict-quality and sigil work lands; that red is the whole point.
 *
 * Cache isolation: arming writes a generated dict under the argot cache dir. Bun
 * caches `os.homedir()`, so these tests redirect the cache with `XDG_CACHE_HOME`
 * + `setProfile` (see argot-cache.test.ts for the same lever) and restore after,
 * so nothing touches the developer's real cache.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { APP_NAME, __resetDirsFromEnvForTests, getArgotCacheDir, setProfile } from "@veyyon/utils";
import {
	type ArgotBenchOutcome,
	extractBenchmarkFixtures,
	measureForcedAdoption,
	measureSigilEmission,
	prepareArgotWorkdir,
	runArgotBench,
	runContentReproBench,
} from "../src/argot-bench";
import { assembleRunMeasurement, assertArgotCertified } from "../src/argot-certify";
import { loadTasksFromDir } from "../src/tasks";
import { verifyExpectedFileSubset } from "../src/verify";

const BENCH_MODEL = process.env.ARGOT_BENCH_MODEL;
const TEST_PROFILE = "argot-bench-test";

let cacheRoot = "";
let originalXdgCache: string | undefined;

beforeAll(() => {
	cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argot-bench-xdg-"));
	originalXdgCache = process.env.XDG_CACHE_HOME;
	process.env.XDG_CACHE_HOME = path.join(cacheRoot, "cache");
	fs.mkdirSync(path.join(process.env.XDG_CACHE_HOME, APP_NAME, "profiles", TEST_PROFILE), { recursive: true });
	setProfile(TEST_PROFILE);
	if (!getArgotCacheDir().startsWith(cacheRoot)) {
		throw new Error(`cache root not isolated: ${getArgotCacheDir()}`);
	}
});

afterAll(() => {
	if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = originalXdgCache;
	__resetDirsFromEnvForTests();
	if (cacheRoot) fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe("argot bench — deterministic setup seams", () => {
	it("extracts the bundled fixtures into loadable edit tasks", async () => {
		const fixtures = await extractBenchmarkFixtures();
		try {
			const tasks = await loadTasksFromDir(fixtures.dir);
			expect(tasks.length).toBeGreaterThan(0);
			const first = tasks[0]!;
			expect(first.prompt.length).toBeGreaterThan(0);
			expect(fs.existsSync(first.inputDir)).toBe(true);
			expect(fs.existsSync(first.expectedDir)).toBe(true);
		} finally {
			await fixtures.cleanup();
		}
	});

	it("prepares a task workdir as an armed argot project (files copied, marker dropped)", async () => {
		const fixtures = await extractBenchmarkFixtures();
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-bench-prep-"));
		try {
			const tasks = await loadTasksFromDir(fixtures.dir);
			const task = tasks[0]!;
			const { cwd, vocab } = await prepareArgotWorkdir(task, path.join(workDir, "wd"));
			// The input fixtures were copied and the project marker was dropped.
			expect(fs.existsSync(path.join(cwd, ".argot"))).toBe(true);
			for (const rel of task.files) {
				expect(fs.existsSync(path.join(cwd, rel))).toBe(true);
			}
			// A vocabulary object is produced (possibly empty for a thin fixture); its
			// sigil is the codec default so measurement lines up with decode.
			expect(vocab.sigil.length).toBeGreaterThan(0);
			expect(vocab.handles instanceof Map).toBe(true);
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
			await fixtures.cleanup();
		}
	});

	it("verifies against the task's target files only, ignoring the .argot marker scaffolding", async () => {
		// Regression: the bench arms a task workdir by dropping a bare `.argot` marker
		// so the project resolves without a git repo. A whole-directory verification
		// (`files` undefined) counts that marker as an "unexpected file" and fails the
		// task — every task, argot on AND off — which zeroes the pass counts and makes
		// the certification meaningless (you cannot measure adoption on runs that all
		// "fail" for a reason unrelated to the edit). The bench must scope verification
		// to `task.files`. This test proves both halves: scoped passes, unscoped fails
		// on the very same directory, purely because of the marker.
		const fixtures = await extractBenchmarkFixtures();
		const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-bench-marker-"));
		try {
			const tasks = await loadTasksFromDir(fixtures.dir);
			const task = tasks[0]!;
			const cwd = path.join(workDir, "wd");
			// Copy the EXPECTED (already-correct) files in so the target file matches,
			// then drop the marker exactly as prepareArgotWorkdir does.
			fs.cpSync(task.expectedDir, cwd, { recursive: true });
			fs.writeFileSync(path.join(cwd, ".argot"), "");

			const scoped = await verifyExpectedFileSubset(task.expectedDir, cwd, task.files);
			expect(scoped.success).toBe(true);

			// The same directory fails a whole-directory check, and it is the marker
			// that trips it — proving the scoping is load-bearing, not incidental.
			const unscoped = await verifyExpectedFileSubset(task.expectedDir, cwd);
			expect(unscoped.success).toBe(false);
			expect(unscoped.error ?? "").toContain(".argot");
		} finally {
			fs.rmSync(workDir, { recursive: true, force: true });
			await fixtures.cleanup();
		}
	});

	it("measures a synthetic transcript end-to-end through the assembly seam", () => {
		// No model: prove the run-assembly wiring the live loop depends on is correct.
		const vocab = { version: 1, sigil: "§", handles: new Map([["p", "packages/app/src/x.ts"]]), meta: new Map() };
		const messages = [{ role: "assistant", content: [{ type: "text", text: "edit §p now" }] }];
		const m = assembleRunMeasurement({
			taskId: "synthetic",
			argotEnabled: true,
			passed: true,
			outputTokens: 10,
			vocab,
			messages,
		});
		expect(m.transcript.handleEmissions).toBe(1);
		expect(m.transcript.unknownSigils).toBe(0);
	});
});

describe("argot bench — live certification (opt-in via ARGOT_BENCH_MODEL)", () => {
	it.skipIf(!BENCH_MODEL)(
		`certifies adoption + savings on the built-in edit tasks with ${BENCH_MODEL ?? "<unset>"}`,
		async () => {
			const outcome: ArgotBenchOutcome = await runArgotBench({ model: BENCH_MODEL!, taskLimit: 8 });
			// Surface the measured numbers so a red run explains itself.
			console.log("[argot-bench] certification:", JSON.stringify(outcome.certification, null, 2));
			// The four truths, or a precise failure naming which ones are unmet.
			assertArgotCertified(outcome.certification);
		},
		600_000,
	);

	it.skipIf(!BENCH_MODEL)(
		`certifies adoption + net savings on the content-reproduction tasks with ${BENCH_MODEL ?? "<unset>"}`,
		async () => {
			// The edit fixtures certify parity + zero-leak; adoption + net-savings are
			// certified HERE, on tasks where the agent reproduces the project's
			// recurring strings and so has real handles to adopt. This is argot's
			// intended workload.
			const outcome: ArgotBenchOutcome = await runContentReproBench({ model: BENCH_MODEL! });
			console.log("[argot-bench] repro certification:", JSON.stringify(outcome.certification, null, 2));
			assertArgotCertified(outcome.certification);
		},
		600_000,
	);

	it.skipIf(!BENCH_MODEL)(
		`probe: ${BENCH_MODEL ?? "<unset>"} adopts a taught handle when forced to reproduce its expansion`,
		async () => {
			// Isolates model compliance from task structure: teach the exact preamble +
			// a 3-handle table, force reproduction, count handles used. A non-zero
			// result proves the model DOES adopt; a zero result on the edit fixtures is
			// then a task-structure limit, not a model or codec failure.
			const result = await measureForcedAdoption(BENCH_MODEL!);
			console.log("[argot-bench] forced adoption:", JSON.stringify(result, null, 2));
			expect(result.opportunities).toBe(3);
			expect(result.handleEmissions).toBeGreaterThan(0);
			expect(result.adopted).toBe(true);
		},
		300_000,
	);

	it.skipIf(!BENCH_MODEL)(
		`canary: measures whether ${BENCH_MODEL ?? "<unset>"} emits the § sigil vs ASCII candidates`,
		async () => {
			// Isolates the mechanical question behind zero adoption: does the model
			// reproduce the sigil byte-for-byte? Argot off, echo a handle-shaped token,
			// count exact survivors. If § dies while an ASCII candidate survives, that
			// is the evidence to change the default sigil (ARG-SIGIL).
			const results = await measureSigilEmission(BENCH_MODEL!, ["§", "~", "#", "@"], 5);
			console.log("[argot-bench] sigil canary:", JSON.stringify(results, null, 2));
			// The canary asserts nothing about which sigil wins (that is a finding to
			// record, not a contract); it asserts the measurement ran and produced a
			// verdict per candidate so a human can read the rate.
			expect(results.length).toBe(4);
			for (const r of results) {
				expect(typeof r.survived).toBe("boolean");
				expect(r.emitted).toBeGreaterThanOrEqual(0);
			}
		},
		300_000,
	);

	it("announces when the live certifier is skipped for lack of a model", () => {
		if (!BENCH_MODEL) {
			console.warn(
				"[argot-bench] LIVE CERTIFIER SKIPPED: set ARGOT_BENCH_MODEL (e.g. google-antigravity/gemini-2.5-flash) to run the adoption bench. The deterministic seams above still ran.",
			);
		}
		expect(true).toBe(true);
	});
});
