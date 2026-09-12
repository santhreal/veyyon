/**
 * WHY THIS SUITE EXISTS
 *
 * Recorder sessions on X11 and Wayland allocate temporary work products
 * (bootstrap scripts, geometry handoffs, terminal logs, compositor logs,
 * socket paths, and ImageMagick pixel caches) while recording a scene.
 *
 * Previously, work products touched host /tmp or shared unvalidated paths,
 * creating collision hazards between concurrent captures, potential disk
 * exhaustion, and leakage of scratch files across takes.
 *
 * proof/docker/session-scratch.sh defines the shared helper for workspace
 * scratch directory allocation under the output root.
 *
 * THE CLASS THIS CLOSES. Specific directory allocation and cleanup invariants:
 *   1. Rejection of scratch parent paths outside the output workspace before
 *      any directory creation, including path traversal (..) and symlink escapes.
 *   2. Allocation of unique per-invocation child directories via mktemp -d.
 *   3. Export of TMPDIR and KITTY_SOCKET matched to the owned child.
 *   4. Scoped cleanup that deletes only the owned child, preserving pre-existing
 *      parent directories and sibling capture artifacts.
 *   5. Cleanup invocation from EXIT traps when subsequent commands fail.
 *
 * WHAT IT DOES NOT CATCH. It tests only the filesystem and environment contract
 * of the shell helper in isolation. It does not verify process lifecycle management
 * (killing Xvfb, kitty, picom, ffmpeg, or sway), unprivileged UID/GID mapping,
 * DRM node permissions, or container mount behavior.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const BASH = "bash";
const HELPER = path.join(REPO_ROOT, "proof", "docker", "session-scratch.sh");
const CONFIG = path.join(REPO_ROOT, "proof", "docker", "scene-config.sh");
const CAPTURES_DIR = path.join(REPO_ROOT, ".captures");

interface ScriptResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function makeFixtureDir(prefix: string): Promise<string> {
	await mkdir(CAPTURES_DIR, { recursive: true });
	return await mkdtemp(path.join(CAPTURES_DIR, prefix));
}

async function runBash(script: string, env?: NodeJS.ProcessEnv): Promise<ScriptResult> {
	try {
		const { stdout, stderr } = await run(BASH, ["-c", script], {
			env: { ...process.env, ...env },
			timeout: 15_000,
		});
		return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
	} catch (error: unknown) {
		const e = error as {
			code?: number | string;
			signal?: string;
			killed?: boolean;
			stdout?: string;
			stderr?: string;
		};
		if (e.killed || e.signal) {
			throw new Error(`bash command timed out or was terminated by signal: ${e.signal ?? "unknown"}`);
		}
		if (typeof e.code !== "number") {
			throw error;
		}
		return {
			code: e.code,
			stdout: (e.stdout ?? "").trim(),
			stderr: (e.stderr ?? "").trim(),
		};
	}
}

describe("a session allocates and cleans an isolated workspace scratch directory", () => {
	it("allocates a unique owned child under the workspace and exports TMPDIR and KITTY_SOCKET", async () => {
		const root = await makeFixtureDir("scratch-alloc-");
		try {
			const script = `
set -euo pipefail
source "${CONFIG}"
source "${HELPER}"
export SCENE_SCRATCH_DIR="${root}/scratch"
session_scratch_init "${root}" "demo"
printf "OWNED=%s\\n" "\${SESSION_OWNED_SCRATCH}"
printf "TMPDIR=%s\\n" "\${TMPDIR}"
printf "SOCKET=%s\\n" "\${KITTY_SOCKET}"
`;
			const res = await runBash(script);
			expect(res.code).toBe(0);

			const ownedMatch = res.stdout.match(/OWNED=(.*)/);
			const tmpdirMatch = res.stdout.match(/TMPDIR=(.*)/);
			const socketMatch = res.stdout.match(/SOCKET=(.*)/);

			expect(ownedMatch).not.toBeNull();
			expect(tmpdirMatch).not.toBeNull();
			expect(socketMatch).not.toBeNull();

			const owned = ownedMatch![1];
			const tmp = tmpdirMatch![1];
			const sock = socketMatch![1];

			expect(owned.startsWith(`${root}/scratch/session-demo-`)).toBe(true);
			expect(tmp).toBe(owned);
			expect(sock).toBe(`unix:${owned}/kitty.sock`);
			expect((await stat(owned)).isDirectory()).toBe(true);

			// A second invocation produces a distinct unique directory
			const script2 = `
set -euo pipefail
source "${CONFIG}"
source "${HELPER}"
export SCENE_SCRATCH_DIR="${root}/scratch"
session_scratch_init "${root}" "demo"
printf "OWNED2=%s\\n" "\${SESSION_OWNED_SCRATCH}"
`;
			const res2 = await runBash(script2);
			expect(res2.code).toBe(0);
			const owned2Match = res2.stdout.match(/OWNED2=(.*)/);
			expect(owned2Match).not.toBeNull();
			expect(owned2Match![1]).not.toBe(owned);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves pre-existing parent and sibling files when cleaning up the owned child", async () => {
		const root = await makeFixtureDir("scratch-preserve-");
		try {
			const parent = path.join(root, "scratch");
			await mkdir(parent, { recursive: true });
			const siblingFile = path.join(parent, "sibling-artifact.png");
			await writeFile(siblingFile, "PRESERVED_PIXELS");
			const siblingDir = path.join(parent, "session-other-123456");
			await mkdir(siblingDir, { recursive: true });
			const siblingDirFile = path.join(siblingDir, "take.mp4");
			await writeFile(siblingDirFile, "PRESERVED_VIDEO");

			const script = `
set -euo pipefail
source "${CONFIG}"
source "${HELPER}"
export SCENE_SCRATCH_DIR="${parent}"
session_scratch_init "${root}" "current"
CHILD="\${SESSION_OWNED_SCRATCH}"
echo "WORK_DATA" > "\${CHILD}/scratch.log"
printf "CHILD=%s\\n" "\${CHILD}"
session_scratch_cleanup
`;
			const res = await runBash(script);
			expect(res.code).toBe(0);

			const childMatch = res.stdout.match(/CHILD=(.*)/);
			expect(childMatch).not.toBeNull();
			const child = childMatch![1];

			// Owned child directory and its log were deleted
			await expect(access(child)).rejects.toThrow();
			await expect(access(path.join(child, "scratch.log"))).rejects.toThrow();

			// Pre-existing sibling files and directories remain intact with exact byte content
			expect((await stat(siblingFile)).isFile()).toBe(true);
			expect(await readFile(siblingFile, "utf8")).toBe("PRESERVED_PIXELS");
			expect((await stat(siblingDirFile)).isFile()).toBe(true);
			expect(await readFile(siblingDirFile, "utf8")).toBe("PRESERVED_VIDEO");
			expect((await stat(parent)).isDirectory()).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("resolves the default scratch parent relative to the output directory", async () => {
		const root = await makeFixtureDir("scratch-default-");
		try {
			const res = await runBash(`
set -euo pipefail
unset SCENE_SCRATCH_DIR
source "${CONFIG}"
source "${HELPER}"
session_scratch_init "${root}" "default" || exit 1
printf "%s" "\${TMPDIR}"
`);
			expect(res.code).toBe(0);
			expect(path.dirname(res.stdout)).toBe(path.join(root, ".scratch"));
			expect((await stat(res.stdout)).isDirectory()).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stops allocation when the output directory cannot be created", async () => {
		const root = await makeFixtureDir("scratch-output-error-");
		try {
			const out = path.join(root, "out");
			const scratch = path.join(root, "scratch");
			await writeFile(out, "existing output file");
			const res = await runBash(`
set -euo pipefail
source "${CONFIG}"
source "${HELPER}"
export SCENE_SCRATCH_DIR="${scratch}"
session_scratch_init "${out}" "output-error" || exit 1
`);
			expect(res.code).toBe(1);
			expect(await readFile(out, "utf8")).toBe("existing output file");
			await expect(access(scratch)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects scratch parents outside the output workspace before creating directories", async () => {
		const root = await makeFixtureDir("scratch-reject-");
		const outside = path.join(root, "outside-workspace");
		try {
			const script = `
set -euo pipefail
source "${CONFIG}"
source "${HELPER}"
export SCENE_SCRATCH_DIR="${outside}/nested/scratch"
session_scratch_init "${root}/out" "escape"
`;
			const res = await runBash(script);
			expect(res.code).toBe(1);
			expect(res.stderr).toContain("must be located under");

			// The forbidden outside directory must NOT have been created
			await expect(access(outside)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects path traversal and symlink escapes targeting outside the workspace", async () => {
		const root = await makeFixtureDir("scratch-traversal-");
		const out = path.join(root, "out");
		await mkdir(out, { recursive: true });
		const outsideTarget = path.join(root, "forbidden-escape");
		const symlinkParent = path.join(out, "symlink-escape");
		await symlink(outsideTarget, symlinkParent);

		try {
			// 1. Path traversal escape via ..
			const scriptTraversal = `
set -euo pipefail
source "${CONFIG}"
source "${HELPER}"
export SCENE_SCRATCH_DIR="${out}/subdir/../../forbidden-traversal"
session_scratch_init "${out}" "traversal"
`;
			const resTraversal = await runBash(scriptTraversal);
			expect(resTraversal.code).toBe(1);
			expect(resTraversal.stderr).toContain("must be located under");
			await expect(access(path.join(root, "forbidden-traversal"))).rejects.toThrow();

			// 2. Symlink escape resolving outside out
			const scriptSymlink = `
set -euo pipefail
source "${CONFIG}"
source "${HELPER}"
export SCENE_SCRATCH_DIR="${symlinkParent}/child"
session_scratch_init "${out}" "symlink"
`;
			const resSymlink = await runBash(scriptSymlink);
			expect(resSymlink.code).toBe(1);
			expect(resSymlink.stderr).toContain("must be located under");
			await expect(access(path.join(outsideTarget, "child"))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("executes cleanup via EXIT trap after a subsequent failing command", async () => {
		const root = await makeFixtureDir("scratch-trap-");
		try {
			const script = `
set -euo pipefail
source "${CONFIG}"
source "${HELPER}"
export SCENE_SCRATCH_DIR="${root}/scratch"
session_scratch_init "${root}" "failing-job"
trap session_scratch_cleanup EXIT
echo "SOME_LOG_CONTENT" > "\${TMPDIR}/error.log"
printf "ALLOCATED=%s\\n" "\${TMPDIR}"
# Simulate subsequent failure in session setup
false
`;
			const res = await runBash(script);
			expect(res.code).toBe(1);

			const match = res.stdout.match(/ALLOCATED=(.*)/);
			expect(match).not.toBeNull();
			const allocated = match![1];

			// Trap must have cleaned up the allocated directory
			await expect(access(allocated)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
