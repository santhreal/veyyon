/**
 * A symlink inside the workspace must not become a silent way out of it.
 *
 * WHY THIS SUITE EXISTS. The cwd boundary decides whether a tool call is
 * auto-approved or has to ask. `isPathWithinCwd` is purely LEXICAL, so a target
 * spelled entirely inside cwd (`./link/secrets.env`) reads as inside even when
 * `link` is a symlink to `/etc`. Judged lexically, that call auto-approves and
 * then writes outside the workspace, which is the whole boundary defeated by one
 * `ln -s`.
 *
 * `cwdEscapingTargets` therefore resolves the PHYSICAL destination before
 * deciding. Two details carry the weight, and each is asserted below:
 *
 *   - A write target usually does not exist yet, so realpath on it would throw
 *     ENOENT. It walks up to the nearest existing ancestor, resolves that, and
 *     re-appends the missing tail. A component that does not exist cannot
 *     introduce a new symlink, so ancestor-plus-tail is the true destination.
 *
 *   - Anything it cannot resolve for a reason other than "does not exist" (an
 *     unreadable ancestor, say) FAILS CLOSED and is reported as escaping. The
 *     alternative, trusting an under-resolved lexical path, is how an unreadable
 *     directory would become an auto-approved one.
 *
 * These build the symlinks on a real filesystem rather than mocking, because the
 * property being tested is exactly what the kernel does with them. No agent
 * session is constructed: the boundary is a pure function of tool, args and cwd.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdEscapingTargets } from "@veyyon/coding-agent/tools/cwd-boundary";

/** A minimal tool whose filesystem targets are just the paths handed to it. */
const pathTool = { filesystemTargets: (args: unknown) => (args as { paths: string[] }).paths };
const escaping = (cwd: string, ...paths: string[]) => cwdEscapingTargets(pathTool, { paths }, cwd);

let root: string;
let workspace: string;
let outside: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "veyyon-symlink-boundary-"));
	workspace = join(root, "workspace");
	outside = join(root, "outside");
	mkdirSync(join(workspace, "src"), { recursive: true });
	mkdirSync(join(outside, "secrets"), { recursive: true });
	writeFileSync(join(workspace, "src", "real.ts"), "inside");
	writeFileSync(join(outside, "secrets", "creds.env"), "TOKEN=1");

	// A directory symlink inside the workspace pointing out of it: the escape.
	symlinkSync(outside, join(workspace, "escape-dir"));
	// A file symlink inside the workspace pointing at a file outside it.
	symlinkSync(join(outside, "secrets", "creds.env"), join(workspace, "escape-file.env"));
	// A symlink that stays inside; it must NOT be treated as an escape.
	symlinkSync(join(workspace, "src"), join(workspace, "inside-link"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("a symlink pointing out of the workspace is reported as escaping", () => {
	/**
	 * THE defect this exists to prevent. Every component of the spelled path sits
	 * under cwd, so a lexical check auto-approves it, and the write lands in
	 * `outside/secrets`.
	 */
	it("catches a read through a directory symlink that leaves cwd", () => {
		expect(escaping(workspace, "escape-dir/secrets/creds.env")).toHaveLength(1);
	});

	/** The same escape spelled with a leading `./`, which is how a model most
	 * often writes a workspace-relative path. */
	it("catches the same escape spelled with a leading ./", () => {
		expect(escaping(workspace, "./escape-dir/secrets/creds.env")).toHaveLength(1);
	});

	/** A file symlink, not just a directory one. */
	it("catches a file symlink whose target is outside cwd", () => {
		expect(escaping(workspace, "escape-file.env")).toHaveLength(1);
	});

	/**
	 * THE write case, and the reason the resolver walks up to an existing
	 * ancestor. The file does not exist yet, so realpath on the target itself
	 * throws ENOENT; resolving only the ancestor is what still catches it.
	 */
	it("catches a write to a not-yet-created file through an escaping symlink", () => {
		expect(escaping(workspace, "escape-dir/secrets/brand-new.txt")).toHaveLength(1);
	});

	/** Several missing components deep, so the walk-up runs more than one level
	 * before it finds something that exists. */
	it("catches a write several non-existent levels below the symlink", () => {
		expect(escaping(workspace, "escape-dir/a/b/c/new.txt")).toHaveLength(1);
	});

	/** A plainly outside path still escapes; this is the lexical branch, kept
	 * honest so the symlink work above is not the only thing being measured. */
	it("still catches a plainly absolute path outside cwd", () => {
		expect(escaping(workspace, join(outside, "secrets", "creds.env"))).toHaveLength(1);
	});

	/** `..` traversal, the other classic, must not be rescued by resolution. */
	it("catches a parent-directory traversal", () => {
		expect(escaping(workspace, "../outside/secrets/creds.env")).toHaveLength(1);
	});
});

describe("paths that stay inside are not reported", () => {
	/**
	 * The false-positive half, and it matters as much as the catch: a boundary
	 * that flags ordinary edits trains the operator to approve without reading,
	 * which costs more than it protects.
	 */
	it("allows an ordinary file inside cwd", () => {
		expect(escaping(workspace, "src/real.ts")).toEqual([]);
	});

	/** A symlink that resolves back INSIDE the workspace is not an escape. This
	 * is the case a naive "any symlink is suspicious" rule would get wrong. */
	it("allows a symlink whose target stays inside cwd", () => {
		expect(escaping(workspace, "inside-link/real.ts")).toEqual([]);
	});

	/** A new file in a real directory: the common write, and the walk-up must not
	 * turn it into an escape. */
	it("allows a not-yet-created file inside cwd", () => {
		expect(escaping(workspace, "src/brand-new.ts")).toEqual([]);
	});

	/** cwd itself. */
	it("allows the working directory itself", () => {
		expect(escaping(workspace, ".")).toEqual([]);
	});
});

describe("mixed and multiple targets", () => {
	/** One escaping path among several must be reported, and reported alone, so
	 * the prompt names what actually crosses the line. */
	it("reports only the escaping target from a mixed list", () => {
		const result = escaping(workspace, "src/real.ts", "escape-dir/secrets/creds.env", "src/brand-new.ts");
		expect(result).toHaveLength(1);
		expect(result[0]).toContain("escape-dir");
	});

	/** Every escaping target is reported, not just the first, or a prompt would
	 * understate what a call is about to touch. */
	it("reports every escaping target", () => {
		expect(escaping(workspace, "escape-dir/secrets/creds.env", "escape-file.env")).toHaveLength(2);
	});
});

describe("an unresolvable path fails closed", () => {
	/**
	 * THE fail-closed rule, and the one branch a symlink fixture cannot reach.
	 * When an ancestor cannot be traversed, the physical destination is UNKNOWN.
	 * Unknown must be treated as escaping: the alternative is trusting the
	 * lexical path, which is precisely the under-resolved judgement the physical
	 * check exists to replace, and it would turn an unreadable directory into an
	 * auto-approved one.
	 *
	 * Root bypasses directory permissions, so this asserts nothing when the suite
	 * runs as root and is skipped rather than passing vacuously.
	 */
	it("reports a target under an untraversable directory as escaping", () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return;
		const locked = join(workspace, "locked");
		mkdirSync(locked, { recursive: true });
		writeFileSync(join(locked, "inner.txt"), "x");
		chmodSync(locked, 0o000);
		try {
			expect(escaping(workspace, "locked/inner.txt")).toHaveLength(1);
		} finally {
			// Restore before cleanup, or the rmSync in afterAll cannot descend.
			chmodSync(locked, 0o755);
		}
	});
});
