/**
 * No two unrelated constants share a name, and no shared value is retyped.
 *
 * A repo-wide scan for same-name constants turned up five pairs where one name
 * meant two different things, plus two places where one thing was typed under
 * two names. Both are the same defect wearing different clothes: a reader who
 * has seen the name once believes they know what it means the next time.
 *
 *   `MAX_LOG_BYTES`      2 MB in debug/report-bundle (how much log tail a bug
 *                        report may READ) vs 25 MB in launch/broker (when a log
 *                        ROTATES). Neither number is wrong; the shared name
 *                        made them look like a disagreement about one policy.
 *   `MAX_OUTPUT_BYTES`   128 KB in dap/session (an in-memory ring) vs 500 KB in
 *                        task/types (what a subagent may return, user-tunable
 *                        via an env var the name has to match).
 *   `STARTUP_TIMEOUT_MS` 250 ms in mcp/manager vs 10 s in the eval kernels. The
 *                        worst of the set: the MCP one is not a timeout at all
 *                        but a grace window after which cached tools are served
 *                        while connections keep running, so the name claimed a
 *                        server got 250 ms to start or was dropped.
 *   the eval kernels     Python and Ruby each typed the same 10 s default, and
 *                        Julia typed 15 s, so raising the shared floor meant
 *                        three edits and nothing failed if you made two.
 *
 * The fix in each case is the same shape: the genuinely shared value gets one
 * owner that the others import, and the genuinely distinct values get names
 * that say what they bound. These tests hold both halves down. They read
 * source rather than importing, because a file-local `const` is exactly the
 * kind that has no import to assert on, and that is where these collisions
 * live.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_KERNEL_STARTUP_TIMEOUT_MS } from "../src/eval/kernel-base";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const sourceOf = (file: string): string => readFileSync(join(SRC, file), "utf8");

/** Declarations only. A comment naming an old constant is documentation, not a collision. */
const declaresConstant = (file: string, name: string): boolean =>
	new RegExp(`^(export )?const ${name}\\b`, "m").test(sourceOf(file));

/**
 * The renamed constants, paired with the file that must NOT still declare the
 * old name. Written as data so adding a future collision is one row.
 */
const RENAMED = [
	{
		file: "launch/broker.ts",
		was: "MAX_LOG_BYTES",
		now: "LOG_ROTATE_BYTES",
		because: "it is a rotation threshold, not a cap on bytes kept",
	},
	{
		file: "debug/report-bundle.ts",
		was: "MAX_LOG_BYTES",
		now: "MAX_BUNDLED_LOG_TAIL_BYTES",
		because: "it bounds what a bug report reads, not how large a log may grow",
	},
	{
		file: "dap/session.ts",
		was: "MAX_OUTPUT_BYTES",
		now: "MAX_BUFFERED_OUTPUT_BYTES",
		because: "the task tool owns MAX_OUTPUT_BYTES, which matches its env var",
	},
	{
		file: "mcp/manager.ts",
		was: "STARTUP_TIMEOUT_MS",
		now: "STARTUP_TOOL_WAIT_MS",
		because: "nothing is aborted when it elapses; cached tools are served instead",
	},
	{
		file: "launch/client.ts",
		was: "CONNECT_TIMEOUT_MS",
		now: "BROKER_CONNECT_TIMEOUT_MS",
		because: "it is a loopback unix-socket budget, not a network one",
	},
	{
		file: "collab/host.ts",
		was: "CONNECT_TIMEOUT_MS",
		now: "RELAY_CONNECT_TIMEOUT_MS",
		because: "it crosses the network, which is why it is the more generous of the two",
	},
] as const;

describe("constants renamed out of a name collision", () => {
	for (const { file, was, now, because } of RENAMED) {
		it(`${file} declares ${now}, ${because}`, () => {
			expect(declaresConstant(file, now)).toBe(true);
		});

		it(`${file} no longer declares ${was}`, () => {
			expect(declaresConstant(file, was)).toBe(false);
		});
	}

	it("leaves MAX_OUTPUT_BYTES to its one legitimate owner", () => {
		// The task tool keeps the plain name because VEYYON_TASK_MAX_OUTPUT_BYTES
		// is user-facing and the constant has to match it. That is the reason the
		// dap ring moved instead.
		expect(declaresConstant("task/types.ts", "MAX_OUTPUT_BYTES")).toBe(true);
		expect(declaresConstant("dap/session.ts", "MAX_OUTPUT_BYTES")).toBe(false);
	});

	it("keeps the relay budget more generous than the loopback one", () => {
		// The pair whose different values were always correct. Pinning the ordering
		// records WHY they differ, so a future reader does not "unify" a network
		// timeout with a unix-socket one on the strength of a shared name.
		const broker = Number(
			sourceOf("launch/client.ts")
				.match(/BROKER_CONNECT_TIMEOUT_MS = ([\d_]+)/)?.[1]
				?.replace(/_/g, ""),
		);
		const relay = Number(
			sourceOf("collab/host.ts")
				.match(/RELAY_CONNECT_TIMEOUT_MS = ([\d_]+)/)?.[1]
				?.replace(/_/g, ""),
		);

		expect(broker).toBe(10_000);
		expect(relay).toBe(15_000);
		expect(relay).toBeGreaterThan(broker);
	});

	it("keeps the MCP wait far shorter than a kernel startup timeout", () => {
		// The values were never the problem, the shared name was. Pinning the gap
		// makes the distinction the rename encodes fail loudly if someone later
		// "unifies" the two numbers on the strength of their old shared name.
		expect(sourceOf("mcp/manager.ts")).toContain("const STARTUP_TOOL_WAIT_MS = 250;");
		expect(DEFAULT_KERNEL_STARTUP_TIMEOUT_MS).toBeGreaterThan(250 * 10);
	});
});

describe("the eval kernel startup timeout has one owner", () => {
	const KERNELS = ["py", "rb", "jl"] as const;

	it("is ten seconds", () => {
		expect(DEFAULT_KERNEL_STARTUP_TIMEOUT_MS).toBe(10_000);
	});

	for (const lang of KERNELS) {
		it(`the ${lang} kernel derives its timeout from the shared default`, () => {
			expect(sourceOf(`eval/${lang}/kernel.ts`)).toMatch(
				/const STARTUP_TIMEOUT_MS = DEFAULT_KERNEL_STARTUP_TIMEOUT_MS/,
			);
		});

		it(`the ${lang} kernel does not retype the timeout as a literal`, () => {
			const declaration = sourceOf(`eval/${lang}/kernel.ts`).match(/const STARTUP_TIMEOUT_MS = .*/)?.[0] ?? "";

			expect(declaration).not.toMatch(/= \d/);
		});
	}

	it("lets Julia extend the shared default rather than replace it", () => {
		// Julia legitimately needs longer (it compiles its runner on first load).
		// Expressed as base-plus-margin so raising the shared floor raises Julia's
		// too, which is the whole point of having one owner.
		expect(sourceOf("eval/jl/kernel.ts")).toContain("DEFAULT_KERNEL_STARTUP_TIMEOUT_MS + 5_000");
	});
});
