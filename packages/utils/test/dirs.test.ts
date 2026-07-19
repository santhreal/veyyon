import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import {
	getWorktreeDir,
	getWorktreesDir,
	hashPath,
	normalizePathForComparison,
	normalizeProfileName,
	pathIsWithin,
	relativePathWithinRoot,
	resolveEquivalentPath,
	resolveProfileEnv,
	setWorktreesDir,
} from "../src/dirs";

// dirs.ts owns veyyon's on-disk layout: profile-name validation, path
// containment checks, the short path hash used to name worktree dirs, and the
// worktree base resolution (env -> override -> default). The functions tested
// here are pure or drive only the process-global worktree override, which
// every test restores. Path helpers run against real mkdtemp dirs so
// realpath resolves consistently for root and candidate on every platform.

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterAll(async () => {
	await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })));
});

describe("normalizeProfileName", () => {
	it("returns undefined for the implicit default forms", () => {
		expect(normalizeProfileName(undefined)).toBeUndefined();
		expect(normalizeProfileName("")).toBeUndefined();
		expect(normalizeProfileName("   ")).toBeUndefined();
		expect(normalizeProfileName("default")).toBeUndefined();
		expect(normalizeProfileName("  default  ")).toBeUndefined();
	});

	it("trims and passes through a valid lowercase name", () => {
		expect(normalizeProfileName("work")).toBe("work");
		expect(normalizeProfileName("  team-a.v2_1  ")).toBe("team-a.v2_1");
		expect(normalizeProfileName("0")).toBe("0");
	});

	it("accepts a name exactly 64 chars long and rejects 65", () => {
		const ok = `a${"b".repeat(63)}`;
		expect(ok.length).toBe(64);
		expect(normalizeProfileName(ok)).toBe(ok);
		const tooLong = `a${"b".repeat(64)}`;
		expect(tooLong.length).toBe(65);
		expect(() => normalizeProfileName(tooLong)).toThrow(/Invalid profile/);
	});

	it("rejects names whose first character is not alphanumeric", () => {
		expect(() => normalizeProfileName(".hidden")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("-lead")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("_lead")).toThrow(/Invalid profile/);
	});

	it("rejects uppercase, whitespace, and out-of-charset characters", () => {
		expect(() => normalizeProfileName("MyProfile")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("has space")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("has/slash")).toThrow(/Invalid profile/);
	});

	it("rejects the . and .. traversal names and any name ending in a dot", () => {
		expect(() => normalizeProfileName(".")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("..")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("trailing.")).toThrow(/Invalid profile/);
	});

	it("rejects Windows reserved device names case-insensitively, including with an extension", () => {
		expect(() => normalizeProfileName("con")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("nul")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("com1")).toThrow(/Invalid profile/);
		expect(() => normalizeProfileName("lpt9")).toThrow(/Invalid profile/);
		// PROFILE_NAME_RE only permits lowercase, but the reserved match is
		// case-insensitive so the extension form is still caught.
		expect(() => normalizeProfileName("con.txt")).toThrow(/Invalid profile/);
	});

	it("allows names that merely start with reserved letters but are not reserved words", () => {
		expect(normalizeProfileName("console")).toBe("console");
		expect(normalizeProfileName("com10")).toBe("com10");
		expect(normalizeProfileName("nulls")).toBe("nulls");
	});

	it("resolveProfileEnv delegates to normalizeProfileName", () => {
		expect(resolveProfileEnv("")).toBeUndefined();
		expect(resolveProfileEnv("staging")).toBe("staging");
		expect(() => resolveProfileEnv("Bad Name")).toThrow(/Invalid profile/);
	});
});

describe("resolveEquivalentPath & normalizePathForComparison", () => {
	it("resolves a relative path against cwd to an absolute path", () => {
		const resolved = resolveEquivalentPath("some/rel/path");
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(resolved).toBe(path.resolve("some/rel/path"));
	});

	it("falls back to the resolved path when realpath fails on a nonexistent target", () => {
		const missing = path.join(tmpdir(), "veyyon-does-not-exist-xyz", "child");
		expect(resolveEquivalentPath(missing)).toBe(path.resolve(missing));
	});

	it("returns the real path for an existing directory", async () => {
		const dir = await tempRoot("dirs-real-");
		// realpath of a freshly created dir round-trips (modulo platform symlinks
		// like macOS /var -> /private/var, which realpath itself normalizes).
		expect(resolveEquivalentPath(dir)).toBe(resolveEquivalentPath(dir));
		expect(path.isAbsolute(resolveEquivalentPath(dir))).toBe(true);
	});

	it("normalizePathForComparison lowercases only on win32, otherwise matches resolveEquivalentPath", () => {
		const input = "Some/Mixed/Case";
		const expected =
			process.platform === "win32" ? resolveEquivalentPath(input).toLowerCase() : resolveEquivalentPath(input);
		expect(normalizePathForComparison(input)).toBe(expected);
	});
});

describe("pathIsWithin", () => {
	it("treats a path as within itself", async () => {
		const root = await tempRoot("dirs-within-self-");
		expect(pathIsWithin(root, root)).toBe(true);
	});

	it("returns true for a nested child and grandchild", async () => {
		const root = await tempRoot("dirs-within-child-");
		const child = path.join(root, "a");
		const grandchild = path.join(root, "a", "b");
		await mkdir(grandchild, { recursive: true });
		expect(pathIsWithin(root, child)).toBe(true);
		expect(pathIsWithin(root, grandchild)).toBe(true);
	});

	it("returns false for the parent of the root", async () => {
		const root = await tempRoot("dirs-within-parent-");
		expect(pathIsWithin(root, path.dirname(root))).toBe(false);
	});

	it("returns false for a sibling that merely shares a name prefix", async () => {
		const parent = await tempRoot("dirs-within-prefix-");
		const foo = path.join(parent, "foo");
		const foobar = path.join(parent, "foobar");
		await mkdir(foo, { recursive: true });
		await mkdir(foobar, { recursive: true });
		// The classic prefix bug: string-prefix containment would wrongly call
		// "foobar" inside "foo". path.relative keeps them distinct.
		expect(pathIsWithin(foo, foobar)).toBe(false);
	});
});

describe("relativePathWithinRoot", () => {
	it("returns the relative segment for a contained path", async () => {
		const root = await tempRoot("dirs-rel-child-");
		const child = path.join(root, "sub", "leaf");
		await mkdir(child, { recursive: true });
		expect(relativePathWithinRoot(root, child)).toBe(path.join("sub", "leaf"));
	});

	it("returns null when the candidate is the root itself (empty relative)", async () => {
		const root = await tempRoot("dirs-rel-self-");
		expect(relativePathWithinRoot(root, root)).toBeNull();
	});

	it("returns null when the candidate is outside the root", async () => {
		const root = await tempRoot("dirs-rel-out-");
		expect(relativePathWithinRoot(root, path.dirname(root))).toBeNull();
	});
});

describe("hashPath", () => {
	it("produces a 7-character lowercase hex digest", () => {
		const h = hashPath("/home/user/project");
		expect(h).toMatch(/^[0-9a-f]{7}$/);
	});

	it("is deterministic for the same absolute input", () => {
		expect(hashPath("/a/b/c")).toBe(hashPath("/a/b/c"));
	});

	it("normalizes the path before hashing so equivalent paths collapse", () => {
		expect(hashPath("/a/b/../c")).toBe(hashPath("/a/c"));
		expect(hashPath("/a//b/./c")).toBe(hashPath("/a/b/c"));
	});

	it("resolves a relative input against cwd before hashing", () => {
		expect(hashPath("rel/seg")).toBe(hashPath(path.resolve("rel/seg")));
	});

	it("gives different digests for different paths", () => {
		expect(hashPath("/one/path")).not.toBe(hashPath("/another/path"));
	});
});

describe("worktree base resolution", () => {
	let savedEnv: string | undefined;

	beforeEach(() => {
		savedEnv = process.env.VEYYON_WORKTREE_DIR;
		delete process.env.VEYYON_WORKTREE_DIR;
		setWorktreesDir(undefined);
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.VEYYON_WORKTREE_DIR;
		else process.env.VEYYON_WORKTREE_DIR = savedEnv;
		setWorktreesDir(undefined);
	});

	it("uses an absolute VEYYON_WORKTREE_DIR ahead of everything else", () => {
		const abs = path.join(tmpdir(), "wt-env-abs");
		process.env.VEYYON_WORKTREE_DIR = abs;
		setWorktreesDir(path.join(tmpdir(), "wt-override")); // env still wins
		expect(getWorktreesDir()).toBe(path.normalize(abs));
	});

	it("expands a leading ~ in VEYYON_WORKTREE_DIR", () => {
		process.env.VEYYON_WORKTREE_DIR = "~/veyyon-wt";
		expect(getWorktreesDir()).toBe(path.normalize(path.join(homedir(), "veyyon-wt")));
	});

	it("ignores a relative VEYYON_WORKTREE_DIR and falls through to the override", () => {
		process.env.VEYYON_WORKTREE_DIR = "relative/wt";
		const override = path.join(tmpdir(), "wt-override-used");
		setWorktreesDir(override);
		expect(getWorktreesDir()).toBe(path.normalize(override));
	});

	it("setWorktreesDir returns the absolute path it stored and getWorktreesDir echoes it", () => {
		const abs = path.join(tmpdir(), "wt-set");
		expect(setWorktreesDir(abs)).toBe(path.normalize(abs));
		expect(getWorktreesDir()).toBe(path.normalize(abs));
	});

	it("setWorktreesDir rejects a relative path, returns undefined, and clears the override", () => {
		expect(setWorktreesDir("relative/only")).toBeUndefined();
		// With env unset and override cleared, getWorktreesDir falls to the profile default.
		expect(path.isAbsolute(getWorktreesDir())).toBe(true);
	});

	it("getWorktreeDir joins a segment onto the resolved base", () => {
		const abs = path.join(tmpdir(), "wt-base");
		setWorktreesDir(abs);
		expect(getWorktreeDir("checkout-1")).toBe(path.join(path.normalize(abs), "checkout-1"));
	});
});
