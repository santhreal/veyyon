/**
 * Python prelude `read(path, offset, limit)` line-selector formula.
 *
 * WHY THIS SUITE EXISTS. Delegated reads (internal URLs, `skill://`, …) do
 * not slice in Python. They append `:start-end` onto the path and hand it to
 * the host `read` tool. The selector is `_read_line_selector`:
 *
 *   - offset<=1 and limit is None → no selector (read the whole resource)
 *   - limit is None → `"{start}-"` (open tail)
 *   - otherwise → `"{start}-{start+limit-1}"` with start = max(1, offset)
 *
 * A delegated `limit<=0` returns "" BEFORE building a selector. The local-
 * filesystem arm does not: `limit=0` becomes an empty slice (`end = start+0`),
 * and a delegated-style inverted range (`start-(start-1)`) is never built.
 * Those two arms disagree on `limit=0` if the early return is ever dropped
 * from only one of them.
 *
 * This file execs the helper out of `prelude.py` rather than re-coding the
 * formula, so a change to the source is a change to the test.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PRELUDE = path.resolve(import.meta.dir, "../../src/eval/py/prelude.py");

function py(script: string): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("python3", ["-c", script], { encoding: "utf-8" });
	return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? 1 };
}

function evalSelector(offset: number, limit: number | null): string | null {
	const script = `
import pathlib, re, json
src = pathlib.Path(${JSON.stringify(PRELUDE)}).read_text()
m = re.search(r"def _read_line_selector\\(offset: int, limit: int \\| None\\) -> str \\| None:\\n(?:        .*\\n)+", src)
if not m:
    raise SystemExit("could not extract _read_line_selector")
ns = {}
exec(m.group(0), ns)
print(json.dumps(ns["_read_line_selector"](${offset}, ${limit === null ? "None" : String(limit)})))
`;
	const { stdout, stderr, status } = py(script);
	if (status !== 0) throw new Error(stderr || stdout || `python exited ${status}`);
	return JSON.parse(stdout) as string | null;
}

describe("_read_line_selector extracted from prelude.py", () => {
	it("offset 1 / no limit means the whole resource (no selector)", () => {
		expect(evalSelector(1, null)).toBeNull();
	});

	it("offset 0 / no limit is also no selector — start is not forced to 1 unless a limit exists", () => {
		expect(evalSelector(0, null)).toBeNull();
	});

	it("negative offset / no limit is also no selector", () => {
		expect(evalSelector(-4, null)).toBeNull();
	});

	it("offset 2 / no limit is an open tail from line 2", () => {
		expect(evalSelector(2, null)).toBe("2-");
	});

	it("offset 10 / no limit is an open tail from line 10", () => {
		expect(evalSelector(10, null)).toBe("10-");
	});

	it("offset 1 / limit 1 is the single line 1-1", () => {
		expect(evalSelector(1, 1)).toBe("1-1");
	});

	it("offset 10 / limit 3 is 10-12 inclusive", () => {
		expect(evalSelector(10, 3)).toBe("10-12");
	});

	it("offset 0 / limit 5 clamps start to 1, so 1-5", () => {
		expect(evalSelector(0, 5)).toBe("1-5");
	});

	it("negative offset / limit 2 clamps start to 1, so 1-2", () => {
		expect(evalSelector(-3, 2)).toBe("1-2");
	});

	it("offset 10 / limit 0 currently emits the inverted range 10-9 (delegated read never asks this — it returns empty first)", () => {
		expect(evalSelector(10, 0)).toBe("10-9");
	});
});

describe("delegated read short-circuits limit<=0 before building a selector", () => {
	it("the prelude source still has the limit<=0 empty return immediately above the selector call", () => {
		const src = Bun.file(PRELUDE);
		return src.text().then(text => {
			expect(text).toContain("if limit is not None and limit <= 0:");
			expect(text).toContain("return \"\"");
			expect(text).toContain("selector = _read_line_selector(offset, limit)");
			const early = text.indexOf("if limit is not None and limit <= 0:");
			const call = text.indexOf("selector = _read_line_selector(offset, limit)");
			expect(early).toBeGreaterThan(0);
			expect(call).toBeGreaterThan(early);
		});
	});
});
