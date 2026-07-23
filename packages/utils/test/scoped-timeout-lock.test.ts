import { describe, expect, it } from "bun:test";
import { collectPackageSources } from "./support/package-sources";

// Repo-wide source lock: bare `AbortSignal.timeout(ms)` keeps its backing timer
// armed for the full window after the guarded operation settles — under load
// that accumulates thousands of live timers and is the documented Bun
// concurrent-GC crash trigger. Production code must use the scoped owners in
// packages/utils/src/scoped-timeout.ts (scopedTimeoutSignal / raceWithTimeout /
// withScopedTimeoutSignal), which cancel the timer on settle.
//
// GRANDFATHERED lists the sites that still carry the bare form. Convert a file,
// remove its entry — a stale entry fails the lock so the list can only shrink.
const GRANDFATHERED = new Set([
	// Doc comment explaining the absolute-deadline semantics, not a live timer.
	"ai/src/utils/idle-iterator.ts",
]);

// The monorepo walk + skip-set is shared with every other source-ownership lock
// (see ./support/package-sources).
describe("scoped-timeout source lock", () => {
	it("no production source arms a bare AbortSignal.timeout outside the grandfathered set", async () => {
		const offenders: string[] = [];
		const cleared: string[] = [];
		const seen = new Set<string>();
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			// scoped-timeout.ts is the one legitimate owner of the raw call.
			if (rel === "utils/src/scoped-timeout.ts") continue;
			if (!text.includes("AbortSignal.timeout(")) continue;
			seen.add(rel);
			if (!GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		for (const entry of GRANDFATHERED) if (!seen.has(entry)) cleared.push(entry);
		// New bare sites are a regression; converted sites must leave the list.
		expect(offenders).toEqual([]);
		expect(cleared).toEqual([]);
	});
});
