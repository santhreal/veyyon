/**
 * The Mermaid render cache holds a bounded amount of text however many diagrams stream through it.
 *
 * THE DEFECT. A transcript draws a Mermaid fence that is still arriving once per frame, and each frame
 * resolves the fence text received so far. The resolver memoized every render in a `Map` keyed on the
 * source and cleared it only on a theme change, so every frame of every streamed diagram stayed for
 * the life of the session: 32.4 MiB of heap after twenty 25-edge flowcharts.
 *
 * THE CLASS. Memory the resolver keeps grows with the frames it has drawn rather than with a bound.
 * The suite streams diagrams through the real resolver in a fresh process
 * (`fixtures/streamed-diagram-growth.ts`) and bounds the string bytes left live; it also requires the
 * cache to still hold renders, so a resolver that stopped memoizing does not pass as a small one.
 * In process, it pins that eviction does not change what a diagram resolves to, and that a failed
 * render resolves to `null` on every request, not to the marker the cache holds it as.
 *
 * WHAT IT DOES NOT CATCH. The bound is on string bytes. A cache that held large non-string values per
 * entry would not be seen, and the resolver holds none. A resolver that stopped memoizing failures
 * returns the same `null` and costs a parse per frame, which nothing here observes. The frames
 * re-render the whole fence each time, so the CPU a streamed diagram costs grows with the square of
 * its length; that is unchanged and unmeasured here.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { clearMermaidCache, resolveMermaidAscii } from "@veyyon/coding-agent/theme/mermaid-cache";
import type { StreamedDiagramGrowth } from "../fixtures/streamed-diagram-growth";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "streamed-diagram-growth.ts");
/** A fresh process loads the renderer, streams the diagrams and takes six heap snapshots. */
const MEASURED_TIMEOUT_MS = 90_000;
const MIB = 1024 * 1024;

function flowchart(seed: number, edges: number): string {
	const lines = ["graph TD"];
	for (let node = 0; node < edges; node += 1) {
		lines.push(
			`    F${seed}_${node}[Stage ${node} of ${seed}] --> F${seed}_${node + 1}[Stage ${node + 1} of ${seed}]`,
		);
	}
	return lines.join("\n");
}

describe("the Mermaid render cache", () => {
	it(
		"holds a bounded amount of text after six diagrams stream through it",
		async () => {
			const { env, cleanup } = hermeticSpawnEnv();
			let growth: StreamedDiagramGrowth;
			try {
				const { stdout, stderr } = await run(process.execPath, [FIXTURE, "6"], {
					env,
					timeout: MEASURED_TIMEOUT_MS - 5_000,
					killSignal: "SIGKILL",
				});
				expect(stderr).toBe("");
				growth = JSON.parse(stdout) as StreamedDiagramGrowth;
			} finally {
				cleanup();
			}
			expect(growth.diagrams).toBe(6);
			expect(growth.frames).toBeGreaterThan(400);
			// Six diagrams left 3.2 MiB of strings when every frame was kept, and twenty left 11.4 MiB.
			expect(growth.grown).toBeLessThan(1.5 * MIB);
			// And the cache still holds renders: a resolver that memoized nothing would pass the bound.
			expect(growth.grown).toBeGreaterThan(256 * 1024);
		},
		MEASURED_TIMEOUT_MS,
	);

	it("resolves a diagram to the same rows after later diagrams turned the cache over", () => {
		clearMermaidCache();
		const kept = flowchart(0, 12);
		const first = resolveMermaidAscii(kept, { maxWidth: 100 });
		expect(first).toContain("Stage 11 of 0");

		for (let seed = 1; seed <= 2; seed += 1) {
			const streamed = flowchart(seed, 24);
			for (let end = 16; end < streamed.length + 16; end += 16) {
				resolveMermaidAscii(streamed.slice(0, end), { maxWidth: 100 });
			}
		}

		expect(resolveMermaidAscii(kept, { maxWidth: 100 })).toBe(first);
	});

	it("resolves a diagram that fails to render to null every time it is asked for", () => {
		clearMermaidCache();
		const broken = "not a diagram at all";
		expect(resolveMermaidAscii(broken)).toBeNull();
		expect(resolveMermaidAscii(broken)).toBeNull();
		expect(resolveMermaidAscii(broken, { maxWidth: 40 })).toBeNull();
	});
});
