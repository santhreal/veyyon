/**
 * The one owner of JavaScriptCore's sampling profiler in this process.
 *
 * The loop watchdog detects that the event loop stopped answering, and it names a cause only when
 * one of the few instrumented spans covered the block. Everything else — a promise continuation, a
 * stream parser, a session write, a transcript rebuild — was reported as `phase: "unknown"`, which
 * across months of local logs was every one of the stalls that froze the terminal for more than a
 * few seconds. The sampler records the JavaScript stack from its own thread at a fixed interval, so
 * it keeps sampling while the loop is held, and the watchdog reads the samples inside a block's
 * window after the loop comes back.
 *
 * JSC has a single sampling profiler per process: a second inspector session that stops profiling
 * stops it for every session. So nothing else starts or stops it directly; `stallSampler.borrow()`
 * hands it to another caller (the `/debug` CPU report) and takes it back when that caller is done.
 *
 * Cost. JSC records a sample only while JavaScript is executing, so an idle process accumulates no
 * samples. At a 10ms interval a mixed JSON/string workload measured 842,667 ops/s against 844,667
 * with the profiler off (medians of five interleaved runs pinned to one core), and a rotation —
 * stopping the profile, discarding it and starting the next — costs 2ms. A rotation runs on a tick
 * the watchdog saw as quiet, so a stall's own samples are never the ones a rotation throws away.
 *
 * Idle cost. The profiler's thread wakes at the sampling interval whether or not JavaScript runs,
 * and each restart wakes the collector's helper threads. Over 30s of an idle process, a 10ms
 * interval measured 2,981 wakeups of the profiler's thread, and a rotation every 10s added 2,514
 * wakeups of the helper threads. So a profile is replaced once it could hold 1,000 samples — after
 * 10s at the 10ms interval and 100s at the 100ms interval — and the first rotation after 10s
 * without a busy tick restarts the profile at 100ms, which measured 300 wakeups per 30s. The first
 * busy tick restarts it at 10ms. A stall that begins while the process is idle is sampled at 100ms:
 * a 3s stall records 30 samples. While the loop watchdog is parked the profile runs at 1s, so the
 * thread wakes once a second, and a stall that begins then records one sample a second until the
 * watchdog's next quiet tick restores the shorter interval.
 *
 * `node:inspector` costs 4.3ms of module evaluation and the first frame must not wait on it, so it
 * is reached through a deferred `require` on the first quiet tick rather than imported.
 */
import type * as inspectorModule from "node:inspector";
import { performance } from "node:perf_hooks";
import * as logger from "./logger";
import { errorMessage, isRecord } from "./type-guards";

/** One function the samples were executing, with how many landed in it. */
export interface StallFrame {
	frame: string;
	samples: number;
}

/** What JavaScript the process ran across a window. */
export interface StallStacks {
	/** Samples recorded inside the window. Zero means no JavaScript ran in it. */
	samples: number;
	/** The functions the samples were executing (self time), most samples first. */
	self: StallFrame[];
	/** The call path the most samples shared, outermost frame first. */
	stack: string[];
}

/** The part of the sampler the loop watchdog drives. */
export interface StallStackSource {
	/**
	 * Called on every tick the watchdog did not see as blocked. `busy` is whether the process spent
	 * more than an idle share of CPU across the interval the tick ended.
	 */
	quiet(nowMs: number, busy: boolean): void;
	/** The samples recorded between two `performance.now()` readings. */
	stacksBetween(fromMs: number, toMs: number): Promise<StallStacks | undefined>;
	/** Called when the watchdog parks: no tick runs until work is reported. */
	park(): void;
}

interface ProfileNode {
	parent: number | undefined;
	frame: string;
}

interface ParsedProfile {
	/** Epoch microseconds of the first sample's base, the clock `timeDeltas` accumulate on. */
	startUs: number;
	samples: number[];
	timeDeltas: number[];
	nodes: Map<number, ProfileNode>;
}

/** Sampling interval in microseconds while the process works. */
const BUSY_INTERVAL_US = 10_000;
/** Sampling interval in microseconds once the process has been idle for `IDLE_AFTER_MS`. */
const IDLE_INTERVAL_US = 100_000;
/** Sampling interval in microseconds while the watchdog is parked. */
const PARKED_INTERVAL_US = 1_000_000;
/** Quiet time after the last busy tick before the next rotation restarts at the idle interval. */
const IDLE_AFTER_MS = 10_000;
/** The most samples one profile accumulates before a quiet tick replaces it. */
const ROTATE_AFTER_SAMPLES = 1_000;
/** How many self frames a report lists. */
const SELF_FRAMES = 8;
/** How many frames of the hottest path a report keeps, innermost last. */
const STACK_FRAMES = 24;

function numberArray(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	for (const item of value) if (typeof item !== "number") return undefined;
	return value;
}

function frameName(callFrame: unknown): string {
	if (!isRecord(callFrame)) return "(unknown)";
	const name = typeof callFrame.functionName === "string" && callFrame.functionName ? callFrame.functionName : "";
	const url = typeof callFrame.url === "string" ? callFrame.url : "";
	const line = typeof callFrame.lineNumber === "number" && callFrame.lineNumber >= 0 ? callFrame.lineNumber + 1 : 0;
	const file = url ? url.slice(url.lastIndexOf("/") + 1) : "";
	const where = file ? (line ? `${file}:${line}` : file) : "";
	if (!name) return where ? `(anonymous) ${where}` : "(anonymous)";
	return where ? `${name} ${where}` : name;
}

/** Reads the `Profiler.stop` result. Anything that is not a well-formed profile reads as none. */
export function parseProfile(result: unknown): ParsedProfile | undefined {
	if (!isRecord(result) || !isRecord(result.profile)) return undefined;
	const { startTime, nodes: rawNodes } = result.profile;
	const samples = numberArray(result.profile.samples);
	const timeDeltas = numberArray(result.profile.timeDeltas);
	if (typeof startTime !== "number" || !samples || !timeDeltas || !Array.isArray(rawNodes)) return undefined;
	if (samples.length !== timeDeltas.length) return undefined;
	const nodes = new Map<number, ProfileNode>();
	const parents = new Map<number, number>();
	for (const raw of rawNodes) {
		if (!isRecord(raw) || typeof raw.id !== "number") return undefined;
		nodes.set(raw.id, { parent: undefined, frame: frameName(raw.callFrame) });
		const children = numberArray(raw.children);
		if (children) for (const child of children) parents.set(child, raw.id);
	}
	for (const [child, parent] of parents) {
		const node = nodes.get(child);
		if (node) node.parent = parent;
	}
	return { startUs: startTime, samples, timeDeltas, nodes };
}

/**
 * The samples of `profile` that fall inside `[fromMs, toMs]`, both `performance.now()` readings.
 * The profiler stamps samples in epoch microseconds, which is `performance.timeOrigin` plus the
 * monotonic reading, so the window converts without aligning two clocks.
 */
export function summarizeWindow(profile: ParsedProfile, fromMs: number, toMs: number): StallStacks {
	const fromUs = (performance.timeOrigin + fromMs) * 1000;
	const toUs = (performance.timeOrigin + toMs) * 1000;
	const perNode = new Map<number, number>();
	let at = profile.startUs;
	let total = 0;
	for (let i = 0; i < profile.samples.length; i++) {
		at += profile.timeDeltas[i]!;
		if (at < fromUs || at > toUs) continue;
		const id = profile.samples[i]!;
		perNode.set(id, (perNode.get(id) ?? 0) + 1);
		total++;
	}
	const perFrame = new Map<string, number>();
	let hottest: number | undefined;
	let hottestCount = 0;
	for (const [id, count] of perNode) {
		const frame = profile.nodes.get(id)?.frame ?? "(unknown)";
		perFrame.set(frame, (perFrame.get(frame) ?? 0) + count);
		if (count > hottestCount) {
			hottest = id;
			hottestCount = count;
		}
	}
	const self = [...perFrame]
		.sort((a, b) => b[1] - a[1])
		.slice(0, SELF_FRAMES)
		.map(([frame, samples]) => ({ frame, samples }));
	const stack: string[] = [];
	for (let id = hottest; id !== undefined; id = profile.nodes.get(id)?.parent) {
		const node = profile.nodes.get(id);
		if (!node) break;
		stack.push(node.frame);
	}
	stack.reverse();
	// The root and the program node are the profiler's own framing, not code.
	while (stack.length > 0 && (stack[0] === "(root)" || stack[0] === "(program)")) stack.shift();
	return { samples: total, self, stack: stack.slice(-STACK_FRAMES) };
}

/**
 * `starting` covers the queued first start: a borrow queued ahead of it must not see a running
 * profiler it cannot stop, and a start that finds the profiler lent gives up and waits for the
 * next quiet tick.
 */
type SamplerState = "off" | "starting" | "running" | "lent" | "failed";

export class StallSampler implements StallStackSource {
	#session: inspectorModule.Session | undefined;
	#state: SamplerState = "off";
	#startedAtMs = 0;
	/** Interval of the running profile, or of the profile a queued restart begins. */
	#intervalUs = BUSY_INTERVAL_US;
	/** The last tick the watchdog reported busy. The tick that starts the sampler counts as one. */
	#busyAtMs = 0;
	/** Every profiler command runs after the previous one settles; the profiler is process-global. */
	#chain: Promise<unknown> = Promise.resolve();

	#post(method: string, params?: object): Promise<unknown> {
		const session = this.#session;
		if (!session) return Promise.reject(new Error("stall sampler has no inspector session"));
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		session.post(method, params ?? {}, (error, result) => {
			if (error) reject(error);
			else resolve(result);
		});
		return promise;
	}

	#enqueue<T>(step: () => Promise<T>): Promise<T> {
		const next = this.#chain.then(step, step);
		this.#chain = next.catch(() => undefined);
		return next;
	}

	#fail(error: unknown): void {
		this.#state = "failed";
		logger.debug("stall sampler disabled", { error: errorMessage(error) });
	}

	/** Start the next profile at `#intervalUs`. The caller holds the chain. */
	async #begin(): Promise<void> {
		await this.#post("Profiler.setSamplingInterval", { interval: this.#intervalUs });
		await this.#post("Profiler.start");
		this.#startedAtMs = performance.now();
	}

	quiet(nowMs: number, busy: boolean): void {
		if (busy) this.#busyAtMs = nowMs;
		if (this.#state === "off") {
			this.#state = "starting";
			this.#busyAtMs = nowMs;
			void this.#enqueue(async () => {
				if (this.#state !== "starting") return;
				try {
					if (!this.#session) {
						const inspector = require("node:inspector") as typeof inspectorModule;
						this.#session = new inspector.Session();
						this.#session.connect();
					}
					await this.#post("Profiler.enable");
					await this.#begin();
					this.#state = "running";
				} catch (error) {
					this.#fail(error);
				}
			});
			return;
		}
		if (this.#state !== "running") return;
		const intervalUs = nowMs - this.#busyAtMs < IDLE_AFTER_MS ? BUSY_INTERVAL_US : IDLE_INTERVAL_US;
		const full = nowMs - this.#startedAtMs >= (this.#intervalUs / 1000) * ROTATE_AFTER_SAMPLES;
		// A busy tick restarts an idle-interval profile at once. Going idle waits for the rotation,
		// which restarts the profile regardless.
		if (!full && intervalUs >= this.#intervalUs) return;
		this.#restartAt(intervalUs);
	}

	/**
	 * Restarts the profile at the parked interval, so the profiler's thread wakes once a second.
	 * Stopping the profile does not stop the thread, which keeps waking at the last interval set,
	 * and neither does `Profiler.disable` or disconnecting the session: MEASURED, a profile stopped
	 * after running at 100ms woke its thread 99 times in 10s, one stopped after running at 10s woke it
	 * once, and after `Profiler.disable` or a disconnect at 100ms the thread woke 10 times a second.
	 * The thread applies a new interval when its current wait ends, so the quiet tick after the
	 * watchdog wakes restores a shorter interval within one parked interval.
	 */
	park(): void {
		if (this.#state !== "running" || this.#intervalUs >= PARKED_INTERVAL_US) return;
		this.#restartAt(PARKED_INTERVAL_US);
	}

	/** Replaces the running profile with one sampling at `intervalUs`. */
	#restartAt(intervalUs: number): void {
		this.#intervalUs = intervalUs;
		// Hold off the next rotation until this one has restarted the profile.
		this.#startedAtMs = Number.POSITIVE_INFINITY;
		void this.#enqueue(async () => {
			if (this.#state !== "running") return;
			try {
				await this.#post("Profiler.stop");
				await this.#begin();
			} catch (error) {
				this.#fail(error);
			}
		});
	}

	stacksBetween(fromMs: number, toMs: number): Promise<StallStacks | undefined> {
		return this.#enqueue(async () => {
			if (this.#state !== "running") return undefined;
			try {
				const result = await this.#post("Profiler.stop");
				await this.#begin();
				const profile = parseProfile(result);
				return profile ? summarizeWindow(profile, fromMs, toMs) : undefined;
			} catch (error) {
				this.#fail(error);
				return undefined;
			}
		});
	}

	/**
	 * Stop sampling so another caller can run the profiler, and return the function that gives it
	 * back. While lent the sampler neither starts nor rotates, including one that has not started
	 * yet, so no quiet tick stops the borrower's profile. The borrower may change the sampling
	 * interval; the sampler sets its own again when it restarts.
	 */
	borrow(): Promise<() => void> {
		return this.#enqueue(async () => {
			const prior = this.#state === "starting" ? "off" : this.#state;
			if (prior === "failed" || prior === "lent") return () => {};
			this.#state = "lent";
			if (prior === "running") {
				try {
					await this.#post("Profiler.stop");
				} catch (error) {
					this.#fail(error);
					return () => {};
				}
			}
			let returned = false;
			return () => {
				if (returned) return;
				returned = true;
				void this.#enqueue(async () => {
					if (this.#state !== "lent") return;
					this.#state = prior;
					if (prior !== "running") return;
					try {
						await this.#begin();
					} catch (error) {
						this.#fail(error);
					}
				});
			};
		});
	}
}

/** The process's sampler. The TUI's loop watchdog drives it; `/debug` borrows the profiler from it. */
export const stallSampler = new StallSampler();
