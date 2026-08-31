/**
 * WHY: three dashboard components imported `errorMessage` and `formatCount` from the
 * `@veyyon/utils` barrel, which re-exports modules that import `bun` and `bun:ffi`. Nothing
 * in the type check or the test suite reads the browser graph, so the failure surfaced only
 * as the served page: `GET /` returned 500 with Bun's "Build Failed" screen naming
 * `stderr-guard.ts`, `config-parse.ts`, `glob.ts` and `frontmatter.ts`. The manager server
 * started, its REST routes answered, and the dashboard did not exist.
 *
 * The class this closes: any module reachable from the dashboard entry that a browser
 * cannot load. The bundle is built here the way the server builds it, so a bun: or node:
 * builtin pulled in through any depth of re-export turns this red — not only the three
 * imports that caused it, and not only through `@veyyon/utils`. That is why this builds the
 * real entry instead of asserting on import lines.
 *
 * What it does not catch: a runtime error once the bundle loads (a component that reads
 * `document` at module scope still bundles), and a browser API the target build accepts but
 * an older browser lacks.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

// Absolute: a relative entrypoint resolves against this file's directory, and the module
// graph it pulls in then resolves from the wrong root.
const webEntry = path.resolve(import.meta.dirname, "..", "..", "dashboard", "index.html");

describe("the dashboard bundle", () => {
	it("builds for the browser target, so the server can serve the page", async () => {
		const result = await Bun.build({ entrypoints: [webEntry], target: "browser", throw: false });

		// Every log line, because the first is the only one Bun's error screen makes obvious.
		const failures = result.logs.filter(log => log.level === "error").map(log => String(log));
		expect(failures).toEqual([]);
		expect(result.success).toBe(true);

		// The html entry plus the module graph it names: an entry that resolved to nothing
		// would otherwise "build" with no output at all.
		expect(result.outputs.length).toBeGreaterThan(1);
		const kinds = result.outputs.map(output => output.kind);
		expect(kinds).toContain("entry-point");
	}, 120_000);
});
