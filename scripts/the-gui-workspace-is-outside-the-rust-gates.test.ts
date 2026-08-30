// WHY THIS EXISTS.
//
// `gui/` is a separate Cargo workspace so that gpui — and the slice of the zed
// dependency graph behind it — never enters `check:rs`, `lint:rs` or `test:rs`.
// Those gates run on every Rust change, for every contributor and every CI job,
// and one member glob widened to reach `gui/` turns each of them into a gpui
// build. Nothing in Cargo prevents that, and the cost of the mistake is paid by
// everyone except the person who made it.
//
// THE CLASS IT CLOSES. Any route by which a root Rust gate reaches the gui
// workspace: a member glob, a path dependency, a patch entry, or the change
// detector deciding a gui-only edit is Rust-affecting. Enumerated from the
// manifests and the runner at run time, so a new route fails here rather than
// showing up as a slow CI run somebody attributes to the runner.
//
// WHAT IT DOES NOT CATCH. Whether the gui workspace itself is green. That is
// `gui/gate.sh`, which this file only asserts exists and is executable.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { isRustAffectingPath, RUST_TASK_COMMANDS } from "./run-rs-task";

const repoRoot = path.join(import.meta.dir, "..");
const guiRoot = path.join(repoRoot, "gui");

/** The gui workspace's own gate, which is what covers what the root gates do not. */
const GUI_GATE = "gui/gate.sh";

/** The parts of the root manifest that decide which packages a `--workspace` gate compiles. */
type RootManifest = {
	workspace?: { members?: string[]; exclude?: string[] };
};

/** Whether a repo-relative path is the gui workspace or inside it. */
function isUnderGui(value: string): boolean {
	const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
	return normalized === "gui" || normalized.startsWith("gui/");
}

/** Every `path = "..."` value anywhere in a parsed manifest, however deeply nested. */
function pathKeys(value: unknown): string[] {
	if (value === null || typeof value !== "object") {
		return [];
	}
	const found: string[] = [];
	for (const [key, nested] of Object.entries(value)) {
		if (key === "path" && typeof nested === "string") {
			found.push(nested);
		} else {
			found.push(...pathKeys(nested));
		}
	}
	return found;
}

describe("the gui workspace is outside the root rust gates", () => {
	test("the gui workspace exists and declares its own workspace root", () => {
		const manifest = readFileSync(path.join(guiRoot, "Cargo.toml"), "utf8");
		expect(manifest).toContain("[workspace]");
	});

	// Every root Rust gate is `--workspace`, so what the root workspace reaches
	// is the whole question. The member globs are expanded rather than compared
	// as text, because a widened glob (`crates/*`, `**`) reaches the gui without
	// naming it; the path keys are swept as well, because a path dependency or a
	// patch entry pulls a package in without touching `members`.
	//
	// Read from the manifest rather than from `cargo metadata`: the TS test
	// bucket runs in a sandbox with no Rust toolchain, and a check that skips
	// itself where it runs is not a check.
	test("no root workspace path reaches the gui workspace", () => {
		// Bun.TOML: node has no TOML parser and neither does the DOM. The
		// alternative is a dependency for one manifest read.
		const manifest = Bun.TOML.parse(readFileSync(path.join(repoRoot, "Cargo.toml"), "utf8")) as RootManifest;
		const globs = [...(manifest.workspace?.members ?? []), ...(manifest.workspace?.exclude ?? [])];
		expect(globs.length).toBeGreaterThan(0);

		const members: string[] = [];
		for (const glob of globs) {
			for (const hit of new Bun.Glob(`${glob}/Cargo.toml`).scanSync({ cwd: repoRoot })) {
				members.push(path.dirname(hit.replace(/\\/g, "/")));
			}
		}
		expect(members.length).toBeGreaterThan(0);
		expect(members.filter(isUnderGui)).toEqual([]);
		expect(pathKeys(manifest).filter(isUnderGui)).toEqual([]);
	});

	// The failure this catches is silent: the gate runs, compiles nothing new,
	// and burns a full clippy pass to discover that. It cost nothing to notice
	// and everything to leave in place once the gui workspace grows.
	test("a gui-only change does not make the root rust gate run", () => {
		for (const changed of [
			"gui/Cargo.toml",
			"gui/Cargo.lock",
			"gui/gate.sh",
			"gui/apps/veyyon-gui/src/main.rs",
			"gui/crates/veyyon-theme/build.rs",
			"gui/crates/veyyon-theme/src/palette.rs",
		]) {
			expect(isRustAffectingPath(changed)).toBe(false);
		}
	});

	// The exclusion is a prefix, and a prefix is exactly the kind of check that
	// swallows more than it means to. A crate named after the gui, or a path
	// merely containing the segment, still gates.
	test("the exclusion covers gui/ and nothing else", () => {
		for (const changed of [
			"crates/veyyon-natives/src/lib.rs",
			"crates/veyyon-gui-adjacent/src/lib.rs",
			"packages/coding-agent/gui/thing.rs",
			"Cargo.toml",
			"rustfmt.toml",
			".cargo/config.toml",
			"guitar/src/lib.rs",
		]) {
			expect(isRustAffectingPath(changed)).toBe(true);
		}
	});

	// Pinned by exact equality: a task added without a decision about the gui
	// workspace turns this red rather than inheriting whichever behaviour the
	// glob happens to give it.
	test("every root rust task is workspace-scoped", () => {
		expect(Object.keys(RUST_TASK_COMMANDS).sort()).toEqual(["check:rs", "fix:rs", "fmt:rs", "lint:rs", "test:rs"]);

		for (const [task, commands] of Object.entries(RUST_TASK_COMMANDS)) {
			for (const command of commands) {
				const scoped = command.includes("--workspace") || command.includes("--all");
				expect(scoped, `${task}: ${command.join(" ")} is neither --workspace nor --all`).toBe(true);
				expect(command.some(argument => argument.includes("gui"))).toBe(false);
			}
		}
	});

	// Existence and the execute bit, then a parse. A gate that does not exist,
	// cannot be run, or does not parse is a gate nobody is running, and this
	// workspace has no other coverage. What it contains is not asserted here:
	// the gate's own run is what proves that.
	test("the gui workspace carries its own runnable gate", () => {
		const gate = path.join(repoRoot, GUI_GATE);
		expect(existsSync(gate)).toBe(true);
		accessSync(gate, constants.X_OK);

		const parsed = spawnSync("bash", ["-n", gate], { encoding: "utf8" });
		expect(parsed.status, parsed.stderr).toBe(0);
	});
});
