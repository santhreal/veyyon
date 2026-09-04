/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/3238.
 *
 * On macOS x64 (Intel), `veyyon stats` builds only the `modern`
 * (`veyyon_natives.darwin-x64-modern.node`) variant when the host has AVX2,
 * because `scripts/host-detect.ts` uses `Bun.spawnSync("sysctl", …)` from a
 * normal shell context and correctly resolves AVX2 → modern.
 *
 * The runtime loader then re-detects from inside Bun worker threads. There
 * the old detector hit two failure modes at once:
 *   - `child_process.spawnSync` returned non-zero/null on darwin under Bun's
 *     worker shim while `Bun.spawnSync` would have worked.
 *   - It looked up `sysctl` via PATH, which can lack `/usr/sbin` in
 *     non-shell-derived spawn contexts.
 *
 * `detectAvx2Support` returned `false`, `resolveCpuVariant` selected
 * `baseline`, and `getAddonFilenames("baseline")` searched only
 * `veyyon_natives.darwin-x64-baseline.node` + `veyyon_natives.darwin-x64.node` —
 * neither of which exists on a modern-only on-disk build. The main thread,
 * which ran the same detector before spawning the worker, picked `modern`
 * fine; only the worker failed.
 *
 * The contract pinned here:
 *   1. Once any context resolves the variant (the main thread does first),
 *      it is cached via a private env key. Bun workers and child
 *      subprocesses inherit `process.env` at spawn, so they read the cache
 *      and skip detection entirely — sidestepping the worker-context spawn
 *      flakiness.
 *   2. The user-facing `VEYYON_NATIVE_VARIANT` override always wins, including
 *      over a stale cache value.
 *   3. Non-x64 architectures still return `null` and never poison the cache.
 *   4. The `darwin-x64` candidate list always carries `modern` ahead of
 *      `baseline` when the resolved variant is `modern`, so the failing
 *      "baseline-only file list" from the report cannot reappear under that
 *      verdict.
 */
import { describe, expect, it } from "bun:test";
import { getAddonFilenames, selectCpuVariant } from "../native/loader-state.js";

const VARIANT_CACHE_ENV_KEY = "__PI_NATIVE_VARIANT_CACHE";

describe("issue 3238: variant resolution across worker contexts", () => {
	it("returns the cached variant from env without re-detecting", () => {
		let detectorCalls = 0;
		const result = selectCpuVariant({
			arch: "x64",
			override: null,
			env: { [VARIANT_CACHE_ENV_KEY]: "modern" },
			detectAvx2: () => {
				detectorCalls += 1;
				return "unsupported";
			},
		});
		expect(result.variant).toBe("modern");
		expect(result.source).toBe("cache");
		expect(detectorCalls).toBe(0);
		expect(result.cacheEnvKey).toBeUndefined();
		expect(result.cacheEnvValue).toBeUndefined();
	});

	it("surfaces a fresh detection so the caller can cache it for workers", () => {
		const result = selectCpuVariant({
			arch: "x64",
			override: null,
			env: {},
			detectAvx2: () => "supported",
		});
		expect(result.variant).toBe("modern");
		expect(result.source).toBe("detect");
		// The caller must persist these so spawned Bun workers and child
		// subprocesses (which inherit process.env at spawn time) read the
		// resolved variant instead of re-running `sysctl` from contexts where
		// the spawn is unreliable.
		expect(result.cacheEnvKey).toBe(VARIANT_CACHE_ENV_KEY);
		expect(result.cacheEnvValue).toBe("modern");
	});

	it("caches baseline when the CPU GENUINELY lacks AVX2 (probe ran, said no)", () => {
		// A real non-AVX2 CPU: the probe executed and reported absent. Caching
		// baseline is correct here — re-detecting on every worker is wasted work
		// because the answer cannot change for this hardware.
		const result = selectCpuVariant({
			arch: "x64",
			override: null,
			env: {},
			detectAvx2: () => "unsupported",
		});
		expect(result.variant).toBe("baseline");
		expect(result.source).toBe("detect");
		expect(result.cacheEnvKey).toBe(VARIANT_CACHE_ENV_KEY);
		expect(result.cacheEnvValue).toBe("baseline");
		expect(result.detectionFailed).toBeUndefined();
	});

	it("honors VEYYON_NATIVE_VARIANT override above both cache and detection", () => {
		let detectorCalls = 0;
		const result = selectCpuVariant({
			arch: "x64",
			override: "baseline",
			env: { [VARIANT_CACHE_ENV_KEY]: "modern" },
			detectAvx2: () => {
				detectorCalls += 1;
				return "supported";
			},
		});
		expect(result.variant).toBe("baseline");
		expect(result.source).toBe("override");
		expect(detectorCalls).toBe(0);
		// Override path must NOT poison the cache: the user may toggle it
		// per-invocation, and child processes should still re-evaluate the
		// override env var themselves.
		expect(result.cacheEnvKey).toBeUndefined();
	});

	it("ignores garbage values in VEYYON_NATIVE_VARIANT and in the cache", () => {
		const result = selectCpuVariant({
			arch: "x64",
			override: "garbage" as unknown as "modern",
			env: { [VARIANT_CACHE_ENV_KEY]: "also-garbage" },
			detectAvx2: () => "supported",
		});
		expect(result.variant).toBe("modern");
		expect(result.source).toBe("detect");
	});

	it("returns variant=null for non-x64 architectures and never emits a cache entry", () => {
		for (const arch of ["arm64", "ia32", "ppc64"]) {
			const result = selectCpuVariant({
				arch,
				override: null,
				env: {},
				detectAvx2: () => "supported",
			});
			expect(result.variant).toBeNull();
			expect(result.source).toBe("non-x64");
			expect(result.cacheEnvKey).toBeUndefined();
		}
	});

	it("places modern ahead of baseline when the resolved verdict is modern (issue #3238 root file-search list)", () => {
		// The bug surfaced because the worker resolved variant=baseline and
		// then searched only [baseline, default]. With the cache populated by
		// the main thread, the worker resolves modern and the candidate list
		// regains the modern filename — the same on-disk artifact the build
		// just produced. `detectAvx2: () => "unknown"` models the worker whose
		// sysctl spawn failed; the cache hit must win over that failed probe.
		const variant = selectCpuVariant({
			arch: "x64",
			override: null,
			env: { [VARIANT_CACHE_ENV_KEY]: "modern" },
			detectAvx2: () => "unknown", // failing worker detector: could not run the probe
		}).variant;
		expect(variant).toBe("modern");
		const filenames = getAddonFilenames({ tag: "darwin-x64", arch: "x64", variant });
		expect(filenames[0]).toBe("veyyon_natives.darwin-x64-modern.node");
		expect(filenames).toContain("veyyon_natives.darwin-x64-baseline.node");
	});
});

/**
 * The Law-10 core of the #3238 fix: a probe that COULD NOT RUN ("unknown") must
 * never be silently equated with "the CPU has no AVX2" ("unsupported"). The old
 * boolean detector returned `false` for both, so an AVX2 machine whose sysctl
 * spawn failed in a worker got the slower `baseline` binary — a correct-but-
 * slower fallback (Law 10 speed bound) — AND that guessed verdict was cached
 * into `process.env`, poisoning every child process. These tests pin the
 * distinction on the pure selector.
 */
describe("AVX2 detection tri-state: unknown never poisons the cache", () => {
	it("does NOT cache when detection failed, so a later context can still detect", () => {
		// The critical property: an "unknown" probe picks the ABI-safe baseline
		// but leaves no cache entry. If it cached baseline here, a Bun worker or
		// subprocess that inherits process.env would be permanently pinned to the
		// slow variant even on a genuine AVX2 CPU.
		const result = selectCpuVariant({
			arch: "x64",
			override: null,
			env: {},
			detectAvx2: () => "unknown",
		});
		expect(result.variant).toBe("baseline"); // ABI-safe: never SIGILL a non-AVX2 CPU
		expect(result.source).toBe("detect-unknown");
		expect(result.detectionFailed).toBe(true);
		expect(result.cacheEnvKey).toBeUndefined(); // <-- must not persist the guess
		expect(result.cacheEnvValue).toBeUndefined();
	});

	it("distinguishes genuine-absent (cached) from probe-failed (uncached) at the verdict level", () => {
		const genuine = selectCpuVariant({ arch: "x64", override: null, env: {}, detectAvx2: () => "unsupported" });
		const failed = selectCpuVariant({ arch: "x64", override: null, env: {}, detectAvx2: () => "unknown" });
		// Both land on baseline, but only the genuine verdict is authoritative
		// enough to cache and inherit; the failed probe is flagged, not cached.
		expect(genuine.variant).toBe("baseline");
		expect(failed.variant).toBe("baseline");
		expect(genuine.cacheEnvKey).toBe(VARIANT_CACHE_ENV_KEY);
		expect(failed.cacheEnvKey).toBeUndefined();
		expect(genuine.detectionFailed).toBeUndefined();
		expect(failed.detectionFailed).toBe(true);
	});

	it("a genuine 'supported' verdict still yields modern and caches it", () => {
		const result = selectCpuVariant({ arch: "x64", override: null, env: {}, detectAvx2: () => "supported" });
		expect(result.variant).toBe("modern");
		expect(result.detectionFailed).toBeUndefined();
		expect(result.cacheEnvValue).toBe("modern");
	});
});
