/**
 * WHY: a trial registered a listener on the run's cancellation signal and never removed it.
 *
 * One `AbortSignal` is created per run and passed to every trial in it. The in-process backend added
 * an `abort` listener per trial whose closure captured that trial's client and session state, and
 * removed it nowhere. `{ once: true }` bounds how often a listener fires, not how long it is
 * registered: a 500-trial run therefore held 500 clients and 500 transcripts until it ended, and the
 * signal accumulated 500 listeners that all fired on one cancel.
 *
 * THE CLASS THIS CLOSES: per-trial state kept alive by the run-scoped signal. Every backend in the
 * registry is swept at run time, so a new backend is a decision someone has to record here rather
 * than a silent hole, and the sweep asserts both that a completed trial left nothing behind and that
 * a cancelled one did not either. The listener count is read off the signal itself through a
 * recorder, not off the backend.
 *
 * WHAT IT DOES NOT CATCH: retention through anything other than the signal — a timer, a module-level
 * array, a pool that keeps finished clients. It also does not measure heap growth; it asserts the
 * reference that caused it is gone.
 */

import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import { InProcessBackend } from "../../backends/in-process/main";
import type {
	EvalSuite,
	RunContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialScore,
	Variant,
} from "../../engine/contracts";
import { backends, harnesses } from "../../engine/loaded-members";

/**
 * Backends whose trials are not driven here, and why. Pinned by exact equality: a backend added to
 * the registry turns this red until someone drives it or records it.
 *
 * `pier` and `harbor` spawn their own binaries, which the test sandbox does not have. Both wait on a
 * trial through `awaitTrialProcessOutput`, whose listener pairing is proven in
 * `test/core/a-cancelled-trial-stops-waiting-on-the-pipes-its-tree-held-open.test.ts`.
 */
const NOT_DRIVEN_HERE = ["harbor", "pier"];

interface ListenerLedger {
	readonly signal: AbortSignal;
	readonly events: string[];
	registered(): number;
}

/** A signal that records its own listener traffic, so retention is observed on the run's object. */
function recordingSignal(controller: AbortController): ListenerLedger {
	const signal = controller.signal;
	const events: string[] = [];
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	Object.assign(signal, {
		addEventListener: (type: string, listener: EventListener, opts?: AddEventListenerOptions) => {
			events.push(`add:${type}`);
			add(type, listener, opts);
		},
		removeEventListener: (type: string, listener: EventListener) => {
			events.push(`remove:${type}`);
			remove(type, listener);
		},
	});
	return {
		signal,
		events,
		registered: () => events.filter(e => e === "add:abort").length - events.filter(e => e === "remove:abort").length,
	};
}

function probeSuite(): EvalSuite {
	return {
		id: "listener-probe-suite",
		version: "1.0.0",
		displayName: "Listener Probe Suite",
		description: "Drives trials that carry a run-scoped cancellation signal",
		backend: "in-process",
		async discoverTasks() {
			return ["probe-task"];
		},
		async describeTask(taskId: string): Promise<TaskDescriptor> {
			return {
				id: taskId,
				path: null,
				timeBudgetSec: 30,
				instructionPath: null,
				metadata: { prompt: "Perform task", files: [] },
			};
		},
		async provenance(): Promise<SuiteProvenance> {
			return { suite: "listener-probe-suite", version: "1.0.0" };
		},
		async scoreTrial(_cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
			return {
				reward: artifacts.extra?.error ? null : 1,
				partial: null,
				error: artifacts.extra?.error ? String(artifacts.extra.error) : null,
				usage: null,
				extra: {},
			};
		},
		async preflight() {
			return { ok: true };
		},
	};
}

const VARIANTS: readonly Variant[] = [
	{
		name: "default",
		harness: "veyyon",
		configPath: null,
		promptVariantPath: null,
		model: "anthropic/claude-sonnet-4-6",
		attachments: [],
	},
];

function inProcessBackendThatFinishes(): InProcessBackend {
	return new InProcessBackend({
		clientFactory: () => ({
			async start() {},
			async prompt() {},
			async getSessionStats() {
				return { tokens: { input: 1, output: 1, total: 2 }, assistantMessages: 1, cost: 0 };
			},
			async getLastAssistantText() {
				return "done";
			},
			async dispose() {},
		}),
	});
}

describe("the listeners a trial leaves on its run's signal", () => {
	it("drives every backend the registry offers, or records why not", () => {
		const registered = backends.ids();
		const driven = registered.filter(id => !NOT_DRIVEN_HERE.includes(id));

		expect(driven).toEqual(["in-process"]);
		expect(registered.filter(id => NOT_DRIVEN_HERE.includes(id))).toEqual(NOT_DRIVEN_HERE);
	});

	it("holds nothing on the signal once a trial has finished", async () => {
		const tempDir = await TempDir.create("@evals-test-listener-finished-");
		try {
			const ledger = recordingSignal(new AbortController());
			const context: RunContext = {
				runId: "listener-run",
				suite: probeSuite(),
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
				harnesses,
				signal: ledger.signal,
				options: { variants: VARIANTS },
			};
			const backend = inProcessBackendThatFinishes();

			for (const repeat of [0, 1, 2]) {
				await backend.runTrial(
					{ suite: "listener-probe-suite", variant: "default", task: "probe-task", repeat },
					context,
				);
			}

			// Three trials, three registrations, three removals — not three survivors.
			expect(ledger.events.filter(e => e === "add:abort")).toHaveLength(3);
			expect(ledger.registered()).toBe(0);
		} finally {
			await tempDir.remove();
		}
	});

	it("holds nothing on the signal once a cancelled trial has returned", async () => {
		const tempDir = await TempDir.create("@evals-test-listener-cancelled-");
		try {
			const controller = new AbortController();
			const ledger = recordingSignal(controller);
			const { promise: promptBlocked, resolve: releasePrompt } = Promise.withResolvers<void>();
			const aborts: string[] = [];
			const backend = new InProcessBackend({
				clientFactory: () => ({
					async start() {},
					async prompt() {
						await promptBlocked;
					},
					async getSessionStats() {
						return { tokens: { input: 0, output: 0, total: 0 }, assistantMessages: 0, cost: 0 };
					},
					async getLastAssistantText() {
						return null;
					},
					abort() {
						aborts.push("abort");
						releasePrompt();
					},
					async dispose() {},
				}),
			});
			const context: RunContext = {
				runId: "listener-cancel-run",
				suite: probeSuite(),
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
				harnesses,
				signal: ledger.signal,
				options: { variants: VARIANTS },
			};

			const running = backend.runTrial(
				{ suite: "listener-probe-suite", variant: "default", task: "probe-task", repeat: 0 },
				context,
			);
			controller.abort();
			const artifacts = await running;

			expect(aborts).toEqual(["abort"]);
			expect(String(artifacts.extra?.error)).toContain("Trial aborted by context signal");
			expect(ledger.registered()).toBe(0);
		} finally {
			await tempDir.remove();
		}
	});

	it("holds nothing on a signal that was already aborted when the trial started", async () => {
		const tempDir = await TempDir.create("@evals-test-listener-prealigned-");
		try {
			const controller = new AbortController();
			const ledger = recordingSignal(controller);
			controller.abort();
			const context: RunContext = {
				runId: "listener-pre-abort-run",
				suite: probeSuite(),
				workDir: tempDir.absolute(),
				runsDir: tempDir.join("runs"),
				harnesses,
				signal: ledger.signal,
				options: { variants: VARIANTS },
			};

			const artifacts = await inProcessBackendThatFinishes().runTrial(
				{ suite: "listener-probe-suite", variant: "default", task: "probe-task", repeat: 0 },
				context,
			);

			expect(String(artifacts.extra?.error)).toContain("Trial aborted by context signal");
			expect(ledger.registered()).toBe(0);
		} finally {
			await tempDir.remove();
		}
	});
});
