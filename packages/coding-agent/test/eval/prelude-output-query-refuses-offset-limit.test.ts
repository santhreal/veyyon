/**
 * Python `output(*ids, query=..., offset=...)` is a hard combination error.
 *
 * WHY THIS SUITE EXISTS. `query` runs json.loads + a jq-like walk on the
 * whole artifact. `offset`/`limit` slice raw lines. Combining them is not
 * "query, then slice": there is no defined unit (JSON values are not lines).
 * The prelude refuses before any file is opened. Dropping that guard would
 * slice the JSON text and then fail parse, or parse and then ignore the
 * slice, depending on order — two silent wrong answers.
 *
 * This pins the source order: the combination check sits before the
 * not-found loop, so a missing id does not mask the combination error.
 */
import { describe, expect, it } from "bun:test";
import path from "node:path";

const PRELUDE = path.resolve(import.meta.dir, "../../src/eval/py/prelude.py");

describe("output() combination guard in prelude.py", () => {
	it("raises ValueError when query is combined with offset", async () => {
		const text = await Bun.file(PRELUDE).text();
		const combo = text.indexOf('if query and (offset is not None or limit is not None):');
		const missing = text.indexOf("if not ids:");
		const notFound = text.indexOf("not_found: list[str] = []");
		expect(combo).toBeGreaterThan(0);
		expect(text).toContain('raise ValueError("query cannot be combined with offset/limit")');
		expect(combo).toBeGreaterThan(missing);
		expect(combo).toBeLessThan(notFound);
	});

	it("the same error is emitted on the status stream", async () => {
		const text = await Bun.file(PRELUDE).text();
		expect(text).toContain('_emit_status("output", error="query cannot be combined with offset/limit")');
	});
});
