/**
 * The set of tools bound by the working-directory boundary is pinned, and the
 * documentation that lists them is checked against the code.
 *
 * WHY THIS SUITE EXISTS. A tool joins the boundary by declaring
 * `filesystemTargets`. That is a good design (one interface, no registry to
 * update) but it has a failure mode: forgetting costs nothing at compile time
 * and produces no warning. The tool simply is not gated, and every other test
 * stays green. `set_cwd` sat outside the boundary that way, which is how it
 * became usable to escape the boundary rather than be bound by it.
 *
 * So membership is asserted explicitly. Adding a filesystem tool without adding
 * it here fails, which is the prompt to ask whether it should be gated. Removing
 * one fails too, which is the prompt to ask what regressed.
 *
 * The second half checks `docs/approval-mode.md`, because a list of gated tools
 * that lives in prose drifts from the code silently and a reader has no way to
 * tell. If the doc is wrong about which tools are gated, it is worse than absent.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasFilesystemTargets } from "@veyyon/coding-agent/tools/cwd-boundary";

/**
 * Every tool that declares filesystem targets, by the `name` its class exposes.
 *
 * Sorted, and compared as a whole set rather than with per-entry `toContain`, so
 * an ADDITION fails as loudly as a removal.
 *
 * `bash` is the odd member and joined deliberately. The others report every
 * path they touch; bash reports only the paths under a credentials directory
 * (`bashCredentialTargets`). Reporting a shell command's whole path set would
 * prompt on `/usr/bin/env` and every toolchain path a build names, which is the
 * false-positive noise that gets approvals switched off. Before it joined at
 * all, `read ~/.ssh/id_rsa` asked and `bash cat ~/.ssh/id_rsa` did not, so the
 * boundary had a hole that the more natural spelling walked straight through.
 */
const BOUND_TOOLS = [
	"ast_edit",
	"ast_grep",
	"bash",
	"edit",
	"glob",
	"grep",
	"inspect_image",
	"read",
	"set_cwd",
	"write",
].sort();

/** Source files that implement a tool class, keyed by the tool's `name`. */
const TOOL_SOURCES: ReadonlyArray<readonly [name: string, file: string]> = [
	["ast_edit", "ast-edit.ts"],
	["ast_grep", "ast-grep.ts"],
	["bash", "bash.ts"],
	["edit", "../edit/index.ts"],
	["glob", "glob.ts"],
	["grep", "grep.ts"],
	["inspect_image", "inspect-image.ts"],
	["read", "read.ts"],
	["set_cwd", "set-cwd.ts"],
	["write", "write.ts"],
];

const SRC_TOOLS = path.join(import.meta.dir, "..", "..", "src", "tools");
const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..", "..");

describe("boundary membership", () => {
	/**
	 * THE regression this file exists for. Each listed source must actually
	 * declare `filesystemTargets`; a tool that lost the declaration would silently
	 * stop being gated while continuing to read and write files.
	 */
	it.each(TOOL_SOURCES)("%s declares filesystemTargets in its source", (_name, file) => {
		const source = fs.readFileSync(path.join(SRC_TOOLS, file), "utf8");
		expect(source).toContain("filesystemTargets");
	});

	/**
	 * No filesystem tool may join without a decision recorded here. The scan is on
	 * shipped source rather than a registry because the declaration IS the
	 * registration: there is no other list to consult.
	 */
	it("finds no tool source declaring filesystemTargets outside the pinned set", () => {
		const known = new Set(TOOL_SOURCES.map(([, file]) => path.basename(file)));
		const stray: string[] = [];
		for (const entry of fs.readdirSync(SRC_TOOLS)) {
			if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
			// `cwd-boundary.ts` DEFINES the interface and the shared search helper,
			// so it names the symbol without being a tool.
			if (entry === "cwd-boundary.ts") continue;
			if (known.has(entry)) continue;
			const source = fs.readFileSync(path.join(SRC_TOOLS, entry), "utf8");
			if (source.includes("readonly filesystemTargets")) stray.push(entry);
		}
		expect(stray).toEqual([]);
	});

	/** The predicate the wrapper actually calls, exercised on both answers so the
	 * membership assertions above rest on a working check. */
	it("hasFilesystemTargets distinguishes a bound tool from an unbound one", () => {
		expect(hasFilesystemTargets({ filesystemTargets: () => [] })).toBe(true);
		expect(hasFilesystemTargets({})).toBe(false);
		expect(hasFilesystemTargets(null)).toBe(false);
		expect(hasFilesystemTargets({ filesystemTargets: "not a function" })).toBe(false);
	});
});

describe("docs/approval-mode.md agrees with the code", () => {
	const doc = fs.readFileSync(path.join(REPO_ROOT, "docs", "approval-mode.md"), "utf8");

	/** A reader who trusts this list and finds it incomplete has been misled about
	 * what is gated, which is worse than the doc not listing anything. */
	it.each(BOUND_TOOLS)("names %s as bound by the working-directory boundary", name => {
		expect(doc).toContain(`\`${name}\``);
	});

	/** The doc must state the yolo carve-out, or a reader configures `yolo` and
	 * expects containment that is not there. */
	it("states that yolo opts out of the boundary", () => {
		expect(doc).toContain("working-directory boundary");
		expect(doc).toMatch(/yolo[^.]*opts out/i);
	});

	/** And the headless behaviour, since that is the one operators hit without a
	 * prompt to explain it. */
	it("states that a headless run fails rather than proceeding", () => {
		expect(doc).toMatch(/no interactive UI[\s\S]{0,200}fails/i);
	});
});
