/**
 * Locks the shape of the Rust gate commands (scripts/run-rs-task.ts).
 *
 * The gate decides what CI and the pre-push hook actually compile, and a flag missing from one of
 * these argv lists is invisible: the command still succeeds, it just checks less. That happened.
 * `cargo clippy --workspace` builds libs and bins only, so nineteen `ScopeIo` literals across the
 * vendored uutils sat un-compilable after the struct gained a field while `lint:rs` and `check:rs`
 * both reported green; the break only surfaced in `test:rs`, as a build error rather than a lint one.
 * These assert the argv lists directly, because that is the whole interface: what a task runs.
 */

import { describe, expect, it } from "bun:test";
import { RUST_TASK_COMMANDS } from "./run-rs-task";

describe("Rust gate commands", () => {
	it("declares exactly the five tasks package.json calls", () => {
		expect(Object.keys(RUST_TASK_COMMANDS).sort()).toEqual(["check:rs", "fix:rs", "fmt:rs", "lint:rs", "test:rs"]);
	});

	it("passes --all-targets to every clippy run, so tests and benches are compiled too", () => {
		const clippyRuns = Object.entries(RUST_TASK_COMMANDS).flatMap(([task, commands]) =>
			commands.filter(command => command[1] === "clippy").map(command => [task, command] as const),
		);
		// Three of them: check:rs, fix:rs, lint:rs. If a fourth appears it must carry the flag too.
		expect(clippyRuns.map(([task]) => task)).toEqual(["check:rs", "fix:rs", "lint:rs"]);
		for (const [task, command] of clippyRuns) {
			expect(command).toContain("--all-targets");
			expect(`${task}: ${command.join(" ")}`).toContain("--workspace");
		}
	});

	it("runs the linting tasks with -D warnings, so a warning is a failure and not a note", () => {
		expect(RUST_TASK_COMMANDS["lint:rs"]).toEqual([
			["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
		]);
		expect(RUST_TASK_COMMANDS["check:rs"][1]).toEqual([
			"cargo",
			"clippy",
			"--workspace",
			"--all-targets",
			"--",
			"-D",
			"warnings",
		]);
	});

	it("checks formatting before linting in check:rs, so a format diff is not reported as lint noise", () => {
		expect(RUST_TASK_COMMANDS["check:rs"][0]).toEqual(["cargo", "fmt", "--all", "--", "--check"]);
	});

	it("runs the whole workspace under nextest and reports only failures", () => {
		expect(RUST_TASK_COMMANDS["test:rs"]).toEqual([
			["cargo", "nextest", "run", "--workspace", "--status-level=fail", "--final-status-level=fail"],
		]);
	});

	it("never mutates the tree from a checking task", () => {
		// `fix:rs` and `fmt:rs` write; the three gates must not, or a green CI run could be green
		// because it edited the code it was judging.
		for (const task of ["check:rs", "lint:rs", "test:rs"] as const) {
			for (const command of RUST_TASK_COMMANDS[task]) {
				expect(command).not.toContain("--fix");
			}
		}
	});
});
