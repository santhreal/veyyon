import { dlopen, FFIType } from "bun:ffi";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { spawnSync } from "node:child_process";
import { logger } from "@veyyon/utils";
import { IdleTrim } from "@veyyon/utils/idle-trim";

/**
 * Contract: `IdleTrim` runs its trim once the process has spent `quietMs` without a busy sampling
 * window, runs it once per quiet stretch, and runs it again only after the process has worked. Its
 * `release` runs on the first quiet window after work and right after each trim, once per quiet
 * stretch, and a release that throws is dropped without stopping the trim.
 *
 * The defect class this closes is a trim or release that fires at the wrong time or at the wrong
 * rate: during work (a busy window not resetting the quiet period, the boundary read the wrong way),
 * repeatedly while idle (a trim or release re-arming itself, or the trim's own collection counted as
 * work), or after stop() (a stale armed window, two sampling chains after a restart). Each is driven
 * through the real class with an injected clock, CPU counter and timer, so every window is chosen,
 * not slept.
 *
 * The engine end is checked in a child process: the default trim must discard compiled code, must
 * return the pages freed in the C allocator's heap, which `Bun.shrink()` leaves resident, and a
 * started trim must never keep a process alive. Those fail if Bun turns `shrink()` into a no-op, the
 * trim stops releasing the C heap, or a regression drops the `unref`. The C heap is read on glibc
 * only; the release in its worker-thread arenas is checked by the addon's own test.
 *
 * Not caught: whether 30 s and 5 % are the right numbers for a given host. They are measured
 * defaults, recorded on the class.
 */

const QUIET_MS = 30_000;
const SAMPLE_MS = 5_000;
const RATIO = 0.05;
/** CPU at the threshold: the most a quiet window may use. */
const LIMIT_MS = SAMPLE_MS * RATIO;

function harness(hooks: { trim?: () => void; release?: () => void } = {}) {
	let nowMs = 0;
	let cpuMs = 0;
	const armed: { cb: () => void; cancelled: boolean; unrefed: boolean }[] = [];
	const trims: number[] = [];
	const releases: number[] = [];
	/** Trims and releases in the order they ran, as `trim@<ms>` and `release@<ms>`. */
	const events: string[] = [];
	const idle = new IdleTrim({
		quietMs: QUIET_MS,
		sampleMs: SAMPLE_MS,
		busyCpuRatio: RATIO,
		now: () => nowMs,
		cpuUsage: () => ({ user: cpuMs * 1000, system: 0 }),
		schedule: cb => {
			const entry = { cb, cancelled: false, unrefed: false };
			armed.push(entry);
			return {
				unref: () => {
					entry.unrefed = true;
				},
				cancel: () => {
					entry.cancelled = true;
				},
			};
		},
		trim: () => {
			trims.push(nowMs);
			events.push(`trim@${nowMs}`);
			hooks.trim?.();
		},
		release: () => {
			releases.push(nowMs);
			events.push(`release@${nowMs}`);
			hooks.release?.();
		},
	});
	return {
		idle,
		trims,
		releases,
		events,
		armed,
		/** Let one sampling window elapse with `windowCpuMs` of CPU spent inside it. */
		window(windowCpuMs = 0): void {
			const live = armed.at(-1);
			if (!live || live.cancelled) throw new Error("no live window is armed");
			nowMs += SAMPLE_MS;
			cpuMs += windowCpuMs;
			live.cb();
		},
		windows(count: number, windowCpuMs = 0): void {
			for (let i = 0; i < count; i++) this.window(windowCpuMs);
		},
		get nowMs(): number {
			return nowMs;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("when the trim runs", () => {
	test("a quiet process trims at the first window ending at or past quietMs, and only once", () => {
		const h = harness();
		h.idle.start();
		h.windows(QUIET_MS / SAMPLE_MS - 1);
		expect(h.trims).toEqual([]);
		h.window();
		expect(h.trims).toEqual([QUIET_MS]);
		// Two hours more of silence: still the one trim.
		h.windows(1440);
		expect(h.trims).toEqual([QUIET_MS]);
	});

	test("a busy window restarts the quiet period from its own end", () => {
		const h = harness();
		h.idle.start();
		h.windows(5);
		h.window(LIMIT_MS + 1);
		const busyEnd = h.nowMs;
		h.windows(QUIET_MS / SAMPLE_MS - 1);
		expect(h.trims).toEqual([]);
		h.window();
		expect(h.trims).toEqual([busyEnd + QUIET_MS]);
	});

	test("CPU at the threshold is quiet and one millisecond over it is busy", () => {
		const atLimit = harness();
		atLimit.idle.start();
		atLimit.windows(QUIET_MS / SAMPLE_MS, LIMIT_MS);
		expect(atLimit.trims).toEqual([QUIET_MS]);

		const overLimit = harness();
		overLimit.idle.start();
		overLimit.windows(100, LIMIT_MS + 1);
		expect(overLimit.trims).toEqual([]);
	});

	test("after a trim, work re-arms it and the next quiet stretch trims again", () => {
		const h = harness();
		h.idle.start();
		h.windows(QUIET_MS / SAMPLE_MS);
		expect(h.trims).toEqual([QUIET_MS]);
		h.window(); // the window holding the trim
		h.window(LIMIT_MS * 10);
		const busyEnd = h.nowMs;
		h.windows(QUIET_MS / SAMPLE_MS);
		expect(h.trims).toEqual([QUIET_MS, busyEnd + QUIET_MS]);
	});

	test("the trim's own collection does not count as work", () => {
		const h = harness();
		h.idle.start();
		h.windows(QUIET_MS / SAMPLE_MS);
		// The window after the trim carries its full collection, well over the threshold.
		h.window(LIMIT_MS * 8);
		h.windows(1440);
		expect(h.trims).toEqual([QUIET_MS]);
	});
});

describe("when the release runs", () => {
	test("a quiet process releases at its first quiet window and right after the trim, and only then", () => {
		const h = harness();
		h.idle.start();
		h.window();
		expect(h.events).toEqual([`release@${SAMPLE_MS}`]);
		h.windows(QUIET_MS / SAMPLE_MS - 1);
		expect(h.events).toEqual([`release@${SAMPLE_MS}`, `trim@${QUIET_MS}`, `release@${QUIET_MS}`]);
		// The window after the trim carries its collection and is not judged; silence after it
		// releases nothing more.
		h.window(LIMIT_MS * 8);
		h.windows(1440);
		expect(h.events).toEqual([`release@${SAMPLE_MS}`, `trim@${QUIET_MS}`, `release@${QUIET_MS}`]);
	});

	test("each busy window re-arms the release for the next quiet window, well inside quietMs", () => {
		const h = harness();
		h.idle.start();
		h.window(LIMIT_MS + 1);
		expect(h.releases).toEqual([]);
		h.windows(2);
		expect(h.releases).toEqual([2 * SAMPLE_MS]);
		h.windows(2, LIMIT_MS + 1);
		h.window();
		expect(h.releases).toEqual([2 * SAMPLE_MS, 6 * SAMPLE_MS]);
		expect(h.trims).toEqual([]);
	});

	test("CPU at the threshold releases and one millisecond over it does not", () => {
		const atLimit = harness();
		atLimit.idle.start();
		atLimit.window(LIMIT_MS);
		expect(atLimit.releases).toEqual([SAMPLE_MS]);

		const overLimit = harness();
		overLimit.idle.start();
		overLimit.windows(100, LIMIT_MS + 1);
		expect(overLimit.releases).toEqual([]);
	});
});

describe("lifecycle", () => {
	test("every armed window is unref'd", () => {
		const h = harness();
		h.idle.start();
		h.windows(10);
		expect(h.armed.length).toBe(11);
		expect(h.armed.every(entry => entry.unrefed)).toBe(true);
	});

	test("stop cancels the armed window and a stale window does nothing", () => {
		const h = harness();
		h.idle.start();
		h.windows(QUIET_MS / SAMPLE_MS - 1);
		const stale = h.armed.at(-1)!;
		h.idle.stop();
		expect(stale.cancelled).toBe(true);
		expect(h.idle.running).toBe(false);
		const armedBefore = h.armed.length;
		stale.cb();
		expect(h.trims).toEqual([]);
		expect(h.releases).toEqual([SAMPLE_MS]);
		expect(h.armed.length).toBe(armedBefore);
	});

	test("a restart measures quiet from the restart and runs one sampling chain", () => {
		const h = harness();
		h.idle.start();
		h.windows(QUIET_MS / SAMPLE_MS - 1);
		const stale = h.armed.at(-1)!;
		h.idle.stop();
		h.idle.start();
		const restartedAt = h.nowMs;
		const armedAfterRestart = h.armed.length;
		// The pre-stop window fires anyway, as a timer that could not be cancelled would. It must
		// neither sample nor arm a second chain beside the restarted one.
		stale.cb();
		expect(h.armed.length).toBe(armedAfterRestart);
		h.windows(QUIET_MS / SAMPLE_MS - 1);
		expect(h.trims).toEqual([]);
		// The restart re-arms the release as well as the quiet period.
		expect(h.releases).toEqual([SAMPLE_MS, restartedAt + SAMPLE_MS]);
		h.window();
		expect(h.trims).toEqual([restartedAt + QUIET_MS]);
		expect(h.releases).toEqual([SAMPLE_MS, restartedAt + SAMPLE_MS, restartedAt + QUIET_MS]);
		// One chain: exactly one new window armed per window elapsed.
		expect(h.armed.length - armedAfterRestart).toBe(QUIET_MS / SAMPLE_MS);
	});

	test("a trim that throws stops sampling and says so", () => {
		const warnings: unknown[][] = [];
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			warnings.push([message, context]);
		});
		const h = harness({
			trim: () => {
				throw new Error("shrink is not a function");
			},
		});
		h.idle.start();
		h.windows(QUIET_MS / SAMPLE_MS);
		expect(h.trims).toEqual([QUIET_MS]);
		expect(h.releases).toEqual([SAMPLE_MS]);
		expect(h.idle.running).toBe(false);
		expect(h.armed.at(-1)!.cancelled).toBe(true);
		expect(warnings).toEqual([["Idle trim failed; sampling stopped", { error: "shrink is not a function" }]]);
	});

	test("a release that throws is dropped and says so, and sampling and the trim continue", () => {
		const warnings: unknown[][] = [];
		vi.spyOn(logger, "warn").mockImplementation((message, context) => {
			warnings.push([message, context]);
		});
		const h = harness({
			release: () => {
				throw new Error("pagemap unreadable");
			},
		});
		h.idle.start();
		h.windows(QUIET_MS / SAMPLE_MS);
		h.window(LIMIT_MS * 8);
		h.window(LIMIT_MS + 1);
		h.windows(QUIET_MS / SAMPLE_MS);
		const busyEnd = (QUIET_MS / SAMPLE_MS + 2) * SAMPLE_MS;
		expect(h.trims).toEqual([QUIET_MS, busyEnd + QUIET_MS]);
		// Attempted once, at the first quiet window; neither trim nor the later quiet stretch calls it.
		expect(h.releases).toEqual([SAMPLE_MS]);
		expect(h.idle.running).toBe(true);
		expect(warnings).toEqual([["Idle release failed; release stopped", { error: "pagemap unreadable" }]]);
	});
});

describe("against the engine", () => {
	const moduleUrl = import.meta.resolve("@veyyon/utils/idle-trim");

	function run(script: string): { status: number | null; stdout: string; stderr: string; ms: number } {
		const started = performance.now();
		const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: performance.now() - started };
	}

	/** The C heap test reads glibc's arenas; musl, macOS and Windows have none to retain pages in. */
	function hasGlibc(): boolean {
		if (process.platform !== "linux") return false;
		try {
			// bun:ffi is the only way to load the C library in-process; node:* has no dlopen.
			dlopen("libc.so.6", { malloc_trim: { args: [FFIType.u64], returns: FFIType.i32 } }).close();
			return true;
		} catch {
			return false;
		}
	}

	test("the default trim discards compiled code", () => {
		const { status, stdout, stderr } = run(`
			import { heapStats } from "bun:jsc";
			const { IdleTrim } = await import(${JSON.stringify(moduleUrl)});
			// Each body is distinct, so each call links its own code block. The functions stay
			// reachable: only their code is the trim's to discard.
			const keep = [];
			for (let i = 0; i < 2000; i++) {
				const f = new Function("a", "return a + " + i + ";");
				f(1);
				keep.push(f);
			}
			Bun.gc(true);
			const before = heapStats().objectTypeCounts.FunctionCodeBlock ?? 0;
			const idle = new IdleTrim({ quietMs: 100, sampleMs: 25, busyCpuRatio: 0.5 });
			idle.start();
			setTimeout(() => {
				idle.stop();
				Bun.gc(true);
				const after = heapStats().objectTypeCounts.FunctionCodeBlock ?? 0;
				console.log(JSON.stringify({ before, after, kept: keep.length }));
			}, 1500);
		`);
		expect(stderr).toBe("");
		expect(status).toBe(0);
		const { before, after } = JSON.parse(stdout) as { before: number; after: number };
		expect(before).toBeGreaterThanOrEqual(2000);
		expect(after).toBeLessThan(before / 20);
	});

	test("a started trim never keeps the process alive", () => {
		const { status, stderr, ms } = run(`
			const { IdleTrim } = await import(${JSON.stringify(moduleUrl)});
			new IdleTrim().start();
		`);
		expect(stderr).toBe("");
		expect(status).toBe(0);
		// The first window is 5 s out; a held loop would sit through it and every one after.
		expect(ms).toBeLessThan(4_000);
	});

	/**
	 * glibc keeps a freed chunk's pages mapped until the top of its heap is free, and `Bun.shrink()`
	 * releases only the engine's heaps: 512 blocks freed under a live one stay resident through it.
	 * The child allocates them with the C allocator, frees all but the pin, and reads their whole
	 * pages with `mincore` around one sample that runs the default trim.
	 */
	test.skipIf(!hasGlibc())("the default trim returns the pages freed in the C heap", () => {
		const { status, stdout, stderr } = run(`
			import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
			const { IdleTrim } = await import(${JSON.stringify(moduleUrl)});
			const libc = dlopen("libc.so.6", {
				malloc: { args: [FFIType.u64], returns: FFIType.ptr },
				free: { args: [FFIType.ptr], returns: FFIType.void },
				mincore: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
			}).symbols;
			const PAGE = 4096;
			const BLOCK = 64 * 1024;
			const filled = () => {
				const p = libc.malloc(BLOCK);
				new Uint8Array(toArrayBuffer(p, 0, BLOCK)).fill(1);
				return p;
			};
			const blocks = Array.from({ length: 512 }, filled);
			const pin = filled();
			for (const p of blocks) libc.free(p);
			const resident = () => {
				let count = 0;
				let total = 0;
				for (const start of blocks) {
					// The page holding the free chunk's header is written by free(); measure the rest.
					const first = Math.ceil((start + 1) / PAGE) * PAGE;
					const last = Math.floor((start + BLOCK) / PAGE) * PAGE;
					const vec = new Uint8Array((last - first) / PAGE);
					if (libc.mincore(first, last - first, vec) !== 0) throw new Error("mincore failed");
					for (const flags of vec) count += flags & 1;
					total += vec.length;
				}
				return { count, total };
			};
			const before = resident();
			let now = 0;
			let sample;
			const idle = new IdleTrim({
				quietMs: 1,
				sampleMs: 1,
				now: () => now,
				cpuUsage: () => ({ user: 0, system: 0 }),
				schedule: cb => {
					sample = cb;
					return {};
				},
			});
			idle.start();
			now = 10;
			sample();
			idle.stop();
			const after = resident();
			libc.free(pin);
			console.log(JSON.stringify({ before, after }));
		`);
		expect(stderr).toBe("");
		expect(status).toBe(0);
		const { before, after } = JSON.parse(stdout) as Record<"before" | "after", { count: number; total: number }>;
		expect(before.total).toBeGreaterThan(512 * 8);
		expect(before.count).toBeGreaterThanOrEqual(before.total * 0.9);
		expect(after.count).toBeLessThanOrEqual(after.total * 0.1);
	});
});
