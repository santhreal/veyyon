import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
	clampTimeout,
	describeTimeoutParam,
	formatTimeoutClampNotice,
	TOOL_TIMEOUTS,
	type ToolWithTimeout,
} from "@veyyon/coding-agent/tools/tool-timeouts";

// Every tool's timeout is derived through `clampTimeout`, which is the single
// guard between an agent-supplied (or defaulted) timeout and the abort that
// actually fires. A miss here is a robustness bug in both directions: a ceiling
// that does not clamp lets a tool hang far past its budget (`bash` for days),
// and a floor that does not hold lets a 0/negative timeout abort a tool the
// instant it starts. None of this behavior had a test before this suite, so
// each case below pins one concrete contract with real values.

const ALL_TOOLS = Object.keys(TOOL_TIMEOUTS) as ToolWithTimeout[];

describe("TOOL_TIMEOUTS config integrity", () => {
	// A config where `default` sits outside `[min, max]` would be silently
	// clamped away the moment it is used, so the declared default would be a
	// lie. `min > max` would make every timeout collapse to `min`. These
	// structural invariants catch a fat-fingered edit to the table before it
	// ships, which is exactly how the fetch `default: 20` / hardcoded-`30`
	// divergence slipped in unnoticed.
	it("keeps min >= 1, min <= default <= max for every tool", () => {
		for (const tool of ALL_TOOLS) {
			const { min, default: def, max } = TOOL_TIMEOUTS[tool];
			expect(min, `${tool}.min must be a positive whole second`).toBeGreaterThanOrEqual(1);
			expect(min, `${tool}.min must not exceed max`).toBeLessThanOrEqual(max);
			expect(def, `${tool}.default must not be below min`).toBeGreaterThanOrEqual(min);
			expect(def, `${tool}.default must not exceed max`).toBeLessThanOrEqual(max);
		}
	});

	// The default is the value a tool uses when the agent omits the field, so it
	// must survive its own clamp untouched. If it did not, `clampTimeout(tool)`
	// would return something other than the declared default.
	it("returns each tool's declared default unchanged when no override is given", () => {
		for (const tool of ALL_TOOLS) {
			expect(clampTimeout(tool)).toBe(TOOL_TIMEOUTS[tool].default);
			expect(clampTimeout(tool, undefined)).toBe(TOOL_TIMEOUTS[tool].default);
		}
	});

	// Lock the exact shipped numbers. A silent change to any of these (a shorter
	// bash ceiling, a longer fetch budget) is an observable behavior change and
	// should have to update this test on purpose, not slip through.
	it("pins the exact per-tool timeout table", () => {
		expect(TOOL_TIMEOUTS).toMatchObject({
			bash: { default: 300, min: 1, max: 3600 },
			eval: { default: 30, min: 1, max: 3600 },
			browser: { default: 30, min: 1, max: 300 },
			ssh: { default: 60, min: 1, max: 3600 },
			fetch: { default: 30, min: 1, max: 45 },
			lsp: { default: 20, min: 5, max: 60 },
			debug: { default: 30, min: 5, max: 300 },
		});
	});
});

describe("clampTimeout ceiling (prevents runaway hangs)", () => {
	// The whole point of `max` is that an agent cannot ask a tool to run longer
	// than its ceiling. `bash` max is 3600s; a request for a full day must come
	// back as 3600, not the requested value.
	it("clamps an over-ceiling request down to max", () => {
		expect(clampTimeout("bash", 86_400)).toBe(3600);
		expect(clampTimeout("fetch", 1_000)).toBe(45);
		expect(clampTimeout("browser", 999)).toBe(300);
	});

	// A request exactly at the ceiling is honored, not bumped.
	it("passes a request exactly at max through unchanged", () => {
		expect(clampTimeout("bash", 3600)).toBe(3600);
		expect(clampTimeout("fetch", 45)).toBe(45);
		expect(clampTimeout("lsp", 60)).toBe(60);
	});
});

describe("clampTimeout floor (prevents instant aborts)", () => {
	// A 0, negative, or below-min request must not become a timeout that fires
	// before the tool can do anything. It floors to `min`.
	it("clamps a below-floor request up to min", () => {
		expect(clampTimeout("bash", 0)).toBe(1);
		expect(clampTimeout("bash", -50)).toBe(1);
		expect(clampTimeout("lsp", 2)).toBe(5); // lsp min is 5, not 1
		expect(clampTimeout("debug", 1)).toBe(5); // debug min is 5
	});

	// A request exactly at the floor is honored.
	it("passes a request exactly at min through unchanged", () => {
		expect(clampTimeout("bash", 1)).toBe(1);
		expect(clampTimeout("lsp", 5)).toBe(5);
		expect(clampTimeout("debug", 5)).toBe(5);
	});
});

describe("clampTimeout in-range and fractional values", () => {
	// An in-range request is returned verbatim, including a fractional second
	// (the value is a raw number of seconds; callers that need integers round
	// downstream). This documents that clamp does not silently truncate.
	it("returns an in-range request verbatim", () => {
		expect(clampTimeout("bash", 120)).toBe(120);
		expect(clampTimeout("eval", 15)).toBe(15);
		expect(clampTimeout("bash", 1.5)).toBe(1.5);
	});
});

describe("clampTimeout non-finite inputs (fail-safe to floor)", () => {
	// NaN and the infinities are not valid timeouts. `clampLow` treats any
	// non-finite value as unusable and returns the tool's `min`, so a garbage
	// timeout fails safe to the shortest budget rather than disabling the
	// ceiling or hanging forever. This pins that deliberate choice: `Infinity`
	// does NOT mean "run forever", it means "min".
	it("returns min for NaN", () => {
		expect(clampTimeout("bash", Number.NaN)).toBe(1);
		expect(clampTimeout("lsp", Number.NaN)).toBe(5);
	});

	it("returns min for +Infinity and -Infinity", () => {
		expect(clampTimeout("bash", Number.POSITIVE_INFINITY)).toBe(1);
		expect(clampTimeout("bash", Number.NEGATIVE_INFINITY)).toBe(1);
		expect(clampTimeout("debug", Number.POSITIVE_INFINITY)).toBe(5);
	});
});

describe("formatTimeoutClampNotice (surfaces a silent clamp)", () => {
	// A clamp that changes the requested budget must be reported, not applied
	// silently (Law 10). When the request is honored unchanged there is nothing
	// to say, so the notice is undefined.
	it("returns undefined when the requested timeout was honored unchanged", () => {
		expect(formatTimeoutClampNotice("bash", 120, 120)).toBeUndefined();
		expect(formatTimeoutClampNotice("browser", 30, 30)).toBeUndefined();
	});

	// The message states the effective value, the requested value, and the
	// tool's actual allowed range, so the range shown always matches the range
	// that clamped. This is why the generator lives beside TOOL_TIMEOUTS: bash's
	// range is 1-3600, browser's is 1-300, and each notice reflects its own.
	it("reports the effective value, requested value, and the tool's own range", () => {
		expect(formatTimeoutClampNotice("bash", 86_400, 3600)).toBe(
			"Timeout clamped to 3600s (requested 86400s; allowed range 1-3600s).",
		);
		expect(formatTimeoutClampNotice("browser", 999, 300)).toBe(
			"Timeout clamped to 300s (requested 999s; allowed range 1-300s).",
		);
		expect(formatTimeoutClampNotice("lsp", 2, 5)).toBe("Timeout clamped to 5s (requested 2s; allowed range 5-60s).");
	});

	// End-to-end with the clamp: whatever clampTimeout returns is exactly what
	// the notice reports, so the two can never drift.
	it("agrees with clampTimeout for an over-ceiling request", () => {
		const requested = 10_000;
		const effective = clampTimeout("fetch", requested);
		expect(effective).toBe(45);
		expect(formatTimeoutClampNotice("fetch", requested, effective)).toBe(
			"Timeout clamped to 45s (requested 10000s; allowed range 1-45s).",
		);
	});

	// Native-free lock for the exact string eval's integration test asserts (that
	// test needs the JS worker's native module and only runs in CI). If eval's
	// ceiling or the message shape changes, this fails without a worker.
	it("produces eval's over-ceiling notice string (mirrors the eval integration test)", () => {
		const requested = 99_999;
		const effective = clampTimeout("eval", requested);
		expect(effective).toBe(3600);
		expect(formatTimeoutClampNotice("eval", requested, effective)).toBe(
			"Timeout clamped to 3600s (requested 99999s; allowed range 1-3600s).",
		);
	});

	// ssh, debug, and lsp surface the same clamp through their result text/prefix,
	// but their integration tests need a live SSH host, a debug adapter, and a
	// language server respectively. These native-/host-free locks pin the exact
	// string each tool prepends, using each tool's own ceiling (ssh 3600, debug
	// 300) and floor (lsp 5), so a range or wording change fails here first.
	it("produces ssh's over-ceiling notice string", () => {
		const requested = 10_000;
		const effective = clampTimeout("ssh", requested);
		expect(effective).toBe(3600);
		expect(formatTimeoutClampNotice("ssh", requested, effective)).toBe(
			"Timeout clamped to 3600s (requested 10000s; allowed range 1-3600s).",
		);
	});

	it("produces debug's over-ceiling notice string", () => {
		const requested = 5_000;
		const effective = clampTimeout("debug", requested);
		expect(effective).toBe(300);
		expect(formatTimeoutClampNotice("debug", requested, effective)).toBe(
			"Timeout clamped to 300s (requested 5000s; allowed range 5-300s).",
		);
	});

	it("produces lsp's below-floor notice string", () => {
		const requested = 2;
		const effective = clampTimeout("lsp", requested);
		expect(effective).toBe(5);
		expect(formatTimeoutClampNotice("lsp", requested, effective)).toBe(
			"Timeout clamped to 5s (requested 2s; allowed range 5-60s).",
		);
	});

	// Regression lock for the omitted-timeout bug. When the model omits `timeout`,
	// the tool resolves it through `clampTimeout(tool, undefined)` -> the table
	// default, and the "requested" value handed to the notice is `undefined`. The
	// notice MUST treat that as "nothing was requested, nothing was clamped" and
	// return undefined. Before the fix, `undefined === effective` was false and
	// the notice rendered the garbage string "Timeout clamped to Ns (requested
	// undefineds; ...)" on every call that omitted the field. Two tools (bash,
	// ssh) only avoided this by hardcoding a `= default` destructuring default
	// that duplicated TOOL_TIMEOUTS; removing those duplicates is what makes this
	// case reachable, so it is pinned for every tool.
	it("returns undefined for an omitted timeout (requested === undefined) for every tool", () => {
		for (const tool of ALL_TOOLS) {
			const effective = clampTimeout(tool, undefined);
			expect(effective).toBe(TOOL_TIMEOUTS[tool].default);
			expect(
				formatTimeoutClampNotice(tool, undefined, effective),
				`${tool}: an omitted timeout must not render a clamp notice`,
			).toBeUndefined();
		}
	});

	// The omitted-timeout path must be quiet even when the caller passes the raw
	// value straight through (the unified idiom every tool now uses:
	// formatTimeoutClampNotice(tool, params.timeout, timeoutSec)). This is the
	// exact expression the tools evaluate, so it fails here if the signature ever
	// stops accepting `undefined`.
	it("stays quiet for the raw pass-through idiom the tools use", () => {
		const rawOmitted: number | undefined = undefined;
		for (const tool of ALL_TOOLS) {
			const timeoutSec = clampTimeout(tool, rawOmitted);
			expect(formatTimeoutClampNotice(tool, rawOmitted, timeoutSec)).toBeUndefined();
		}
	});
});

describe("describeTimeoutParam (model-facing schema text tracks the config)", () => {
	// The description the model reads must state the SAME default and range that
	// clampTimeout enforces, so the model can pick an in-range value up front
	// instead of only learning the range from a post-hoc clamp notice. Deriving
	// it from TOOL_TIMEOUTS (ONE PLACE) is the point: these pin that the derived
	// text carries each tool's own numbers.
	it("states each tool's own default and clamp range", () => {
		expect(describeTimeoutParam("ssh")).toBe("timeout in seconds; default 60, clamped to 1-3600");
		expect(describeTimeoutParam("browser")).toBe("timeout in seconds; default 30, clamped to 1-300");
		expect(describeTimeoutParam("debug")).toBe("timeout in seconds; default 30, clamped to 5-300");
		expect(describeTimeoutParam("lsp")).toBe("timeout in seconds; default 20, clamped to 5-60");
	});

	// bash and eval treat 0 as an explicit no-deadline contract, so their text
	// must say so; the others clamp 0 up to min and must NOT claim 0 disables.
	it("documents the 0-disables contract only for the tools that have one", () => {
		expect(describeTimeoutParam("bash", { zeroDisablesNoun: "command deadline" })).toBe(
			"timeout in seconds; 0 disables the command deadline; default 300, clamped to 1-3600",
		);
		expect(describeTimeoutParam("eval", { zeroDisablesNoun: "cell timeout" })).toBe(
			"timeout in seconds; 0 disables the cell timeout; default 30, clamped to 1-3600",
		);
		expect(describeTimeoutParam("ssh")).not.toContain("disables");
	});

	// The stated range must equal the numbers clampTimeout actually uses for
	// every tool, so the description can never drift from enforcement.
	it("matches TOOL_TIMEOUTS for every tool", () => {
		for (const tool of ALL_TOOLS) {
			const { default: def, min, max } = TOOL_TIMEOUTS[tool];
			expect(describeTimeoutParam(tool)).toBe(`timeout in seconds; default ${def}, clamped to ${min}-${max}`);
		}
	});
});

describe("fetch timeout single-source regression", () => {
	// Regression lock for the ONE-PLACE fix: the fetch read-url path used to
	// hardcode `clampTimeout("fetch", 30)`, which diverged from the config's
	// then-`default: 20`. The literal was removed and the default set to 30, so
	// the configured default is now the single source and must equal the value
	// the tool has always actually used (30s). If someone re-introduces a
	// divergent literal or edits the default, this catches it.
	it("resolves fetch's default to the previously-hardcoded 30 seconds", () => {
		expect(clampTimeout("fetch")).toBe(30);
		expect(TOOL_TIMEOUTS.fetch.default).toBe(30);
	});
});

describe("bash executor default single-source regression", () => {
	// Regression lock for the ONE-PLACE fix: exec/bash-executor.ts used to hardcode
	// `?? 300_000` as the fallback deadline for callers that pass no timeout (the
	// RPC `executeBash(command)` path), a second copy of the bash tool default
	// (TOOL_TIMEOUTS.bash.default = 300s) that could silently diverge if the table
	// changed. The executor now derives DEFAULT_BASH_TIMEOUT_MS from the single
	// owner. This lock reads the source and fails if the hardcoded millisecond
	// literal reappears or the derivation from TOOL_TIMEOUTS is removed.
	const executorSrc = readFileSync(path.resolve(import.meta.dir, "../../src/exec/bash-executor.ts"), "utf8");

	it("derives its fallback deadline from TOOL_TIMEOUTS, not a hardcoded 300000ms", () => {
		expect(executorSrc).toContain("TOOL_TIMEOUTS.bash.default * 1000");
		expect(executorSrc).toContain("requestedTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS");
		expect(executorSrc).not.toMatch(/\?\?\s*300_?000/);
	});

	it("keeps the effective bash default at 300 seconds", () => {
		// The value the executor's fallback resolves to (default seconds * 1000).
		expect(TOOL_TIMEOUTS.bash.default).toBe(300);
	});
});
