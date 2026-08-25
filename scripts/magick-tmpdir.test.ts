/**
 * WHY / ImageMagick Pixel-Cache Scoping and Lifecycle Tests
 *
 * ImageMagick 6 and 7 (convert / magick) spill pixel-cache files (`magick-*`)
 * to disk when operations exceed memory or map resource limits (e.g. large
 * blurred backdrops, high-resolution textures). On clean exit, ImageMagick
 * unlinks these files; on ungraceful termination (such as SIGKILL or crashes),
 * the process cannot run its cleanup handlers, leaving orphaned files behind.
 *
 * Without scoping, these files default to system /tmp, leading to disk and
 * inode exhaustion. proof/docker/magick-tmpdir.sh isolates all temporary files
 * into a dedicated caller-owned directory (`MAGICK_SCOPED_TMPDIR`), exported
 * via `MAGICK_TMPDIR` and `MAGICK_TEMPORARY_PATH`.
 *
 * Gap and regression contracts defended by this suite:
 * 1. SIGKILL leaves orphaned `magick-*` files strictly inside the scoped directory,
 *    never leaking to parent directories or system /tmp.
 * 2. `magick_tmpdir_release` completely removes the scoped directory and unsets
 *    all related environment variables (`MAGICK_SCOPED_TMPDIR`, `MAGICK_TMPDIR`,
 *    `MAGICK_TEMPORARY_PATH`).
 * 3. Idempotence: subsequent calls within the same shell reuse the active directory.
 * 4. Parent/child inherited reuse: a child inheriting a valid scoped directory and its private
 *    `.veyyon-magick-scope` token reuses it without reallocating.
 * 5. Stale/dead inherited environment recovery: if `MAGICK_SCOPED_TMPDIR` points to
 *    a non-existent path or a directory without the matching token, a fresh valid directory is created.
 * 6. Whitespace and special character safety in parent paths.
 * 7. Concurrent non-colliding acquisitions across parallel subshells.
 * 8. Sibling scope preservation: releasing one scope in a shared parent leaves concurrent
 *    sibling scopes untouched.
 * 9. Signal trap execution: SIGTERM triggers trap cleanup; parent EXIT trap cleans up
 *    after child SIGKILL.
 * 10. Release safety: `magick_tmpdir_release` requires a `veyyon-magick.*` basename and the
 *     private token exported by its allocator, refusing to delete arbitrary directories.
 * 11. Creation failures fail closed without exporting empty paths.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { $which } from "@veyyon/utils";

const CONVERT = $which("convert") ?? $which("magick");
const HELPER = path.resolve(import.meta.dirname, "../proof/docker/magick-tmpdir.sh");
const PARENT = path.resolve(import.meta.dirname, "../.internal/magick-tmp/test-run");

function magickNames(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter(name => name.startsWith("magick-"));
}

async function killConvertInto(scopedDir: string): Promise<void> {
	const bin = CONVERT!;
	const prefix = path.basename(bin) === "magick" ? ["convert"] : [];
	const child = spawn(
		bin,
		[
			...prefix,
			"-limit",
			"memory",
			"8MB",
			"-limit",
			"map",
			"8MB",
			"-size",
			"4000x4000",
			"xc:red",
			"-blur",
			"0x20",
			"png:-",
		],
		{
			env: {
				...process.env,
				MAGICK_TMPDIR: scopedDir,
				MAGICK_TEMPORARY_PATH: scopedDir,
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);

	// Wait for either the first spill file or process termination, with a hard bound.
	if (magickNames(scopedDir).length === 0 && child.exitCode === null) {
		const { promise, resolve } = Promise.withResolvers<void>();
		const settle = (): void => resolve();
		const watcher = fs.watch(scopedDir, (_eventType, filename) => {
			if (filename?.startsWith("magick-") || magickNames(scopedDir).length > 0) settle();
		});
		child.once("exit", settle);
		child.once("error", settle);
		await Promise.race([promise, delay(4_000)]);
		watcher.close();
		child.off("exit", settle);
		child.off("error", settle);
	}

	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
	}
	if (child.exitCode === null && child.signalCode === null) {
		const exited = once(child, "exit").then(() => true);
		if (!(await Promise.race([exited, delay(4_000, false)]))) {
			throw new Error("ImageMagick did not exit within 4 seconds after SIGKILL");
		}
	}
}

describe("ImageMagick magick-* temp files", () => {
	afterEach(() => {
		fs.rmSync(PARENT, { recursive: true, force: true });
	});

	it("leaves named magick-* files strictly inside the scoped directory when convert is killed mid-blur via SIGKILL", async () => {
		if (!CONVERT) return;
		fs.mkdirSync(PARENT, { recursive: true });
		const scoped = fs.mkdtempSync(path.join(PARENT, "leak-"));
		await killConvertInto(scoped);
		const leaked = magickNames(scoped);
		expect(leaked.length).toBeGreaterThan(0);
		// Ensure parent root did not receive the spill files
		expect(magickNames(PARENT)).toHaveLength(0);
		// Ensure system tmpdir did not receive this specific scoped spill file
		expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("magick-"))).not.toContain(leaked[0]);
	});

	it("magick_tmpdir_release removes the scoped directory and unsets environment variables", async () => {
		if (!CONVERT) return;
		fs.mkdirSync(PARENT, { recursive: true });
		const script = `
set -euo pipefail
# shellcheck source=proof/docker/magick-tmpdir.sh
source "${HELPER}"
magick_tmpdir_scope "${PARENT}"
printf '%s\\t%s\\n' "\${MAGICK_SCOPED_TMPDIR}" "\${MAGICK_SCOPED_TMPDIR_TOKEN}"
`;
		const scoped = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(scoped.status, scoped.stderr).toBe(0);
		const [dir = "", token = ""] = scoped.stdout.trim().split("\t");
		expect(dir.length).toBeGreaterThan(0);
		expect(token.length).toBeGreaterThan(0);
		expect(fs.existsSync(dir)).toBe(true);
		await killConvertInto(dir);
		expect(magickNames(dir).length).toBeGreaterThan(0);
		const release = spawnSync(
			"bash",
			[
				"-lc",
				`set -euo pipefail
source "${HELPER}"
MAGICK_SCOPED_TMPDIR="${dir}"
MAGICK_SCOPED_TMPDIR_TOKEN="${token}"
magick_tmpdir_release
test ! -e "${dir}"
[ -z "\${MAGICK_SCOPED_TMPDIR:-}" ]
[ -z "\${MAGICK_SCOPED_TMPDIR_TOKEN:-}" ]
[ -z "\${MAGICK_TMPDIR:-}" ]
[ -z "\${MAGICK_TEMPORARY_PATH:-}" ]
`,
			],
			{ encoding: "utf-8" },
		);
		expect(release.status, release.stderr).toBe(0);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("magick_tmpdir_scope is idempotent within the same shell", () => {
		fs.mkdirSync(PARENT, { recursive: true });
		const script = `
set -euo pipefail
source "${HELPER}"
magick_tmpdir_scope "${PARENT}"
first="\${MAGICK_SCOPED_TMPDIR}"
magick_tmpdir_scope "${PARENT}"
second="\${MAGICK_SCOPED_TMPDIR}"
[ "\${first}" = "\${second}" ]
printf '%s\\n' "\${first}"
`;
		const res = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(res.status, res.stderr).toBe(0);
		const dir = res.stdout.trim();
		expect(fs.existsSync(dir)).toBe(true);
		const entries = fs.readdirSync(PARENT);
		expect(entries).toHaveLength(1);
	});

	it("a child process inheriting the scoped directory and private token reuses it", () => {
		fs.mkdirSync(PARENT, { recursive: true });
		const script = `
set -euo pipefail
source "${HELPER}"
magick_tmpdir_scope "${PARENT}"
parent_dir="\${MAGICK_SCOPED_TMPDIR}"

# Child subshell inheriting exported variables
child_dir="$(
    source "${HELPER}"
    magick_tmpdir_scope "${PARENT}"
    printf '%s' "\${MAGICK_SCOPED_TMPDIR}"
)"

[ "\${parent_dir}" = "\${child_dir}" ]
printf '%s\\n' "\${parent_dir}"
`;
		const res = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(res.status, res.stderr).toBe(0);
		const dir = res.stdout.trim();
		expect(fs.existsSync(dir)).toBe(true);
		const entries = fs.readdirSync(PARENT);
		expect(entries).toHaveLength(1);
	});

	it("magick_tmpdir_scope recovers and creates a new directory if inherited MAGICK_SCOPED_TMPDIR does not exist or lacks sentinel", () => {
		fs.mkdirSync(PARENT, { recursive: true });
		const nonExistent = path.join(PARENT, "ghost-dir");
		const unmaskedDir = path.join(PARENT, "unmasked-dir");
		fs.mkdirSync(unmaskedDir);

		const script = `
set -euo pipefail
source "${HELPER}"

# Case A: non-existent path
export MAGICK_SCOPED_TMPDIR="${nonExistent}"
magick_tmpdir_scope "${PARENT}"
dir_a="\${MAGICK_SCOPED_TMPDIR}"
[ "\${dir_a}" != "${nonExistent}" ]
[ -d "\${dir_a}" ]
[ -f "\${dir_a}/.veyyon-magick-scope" ]

# Case B: existing dir lacking sentinel
export MAGICK_SCOPED_TMPDIR="${unmaskedDir}"
magick_tmpdir_scope "${PARENT}"
dir_b="\${MAGICK_SCOPED_TMPDIR}"
[ "\${dir_b}" != "${unmaskedDir}" ]
[ -d "\${dir_b}" ]
[ -f "\${dir_b}/.veyyon-magick-scope" ]
`;
		const res = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(res.status, res.stderr).toBe(0);
		expect(fs.existsSync(unmaskedDir)).toBe(true);
	});

	it("magick_tmpdir_scope safely handles whitespace, special characters, and trailing slashes in parent path", () => {
		const parentWithSpaces = path.join(PARENT, "parent dir with spaces and # special/");
		fs.mkdirSync(parentWithSpaces, { recursive: true });
		const script = `
set -euo pipefail
source "${HELPER}"
magick_tmpdir_scope "${parentWithSpaces}"
[ -d "\${MAGICK_SCOPED_TMPDIR}" ]
printf '%s\\n' "\${MAGICK_SCOPED_TMPDIR}"
magick_tmpdir_release
test ! -e "\${MAGICK_SCOPED_TMPDIR:-}"
`;
		const res = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(res.status, res.stderr).toBe(0);
		const dir = res.stdout.trim();
		expect(dir).toContain("parent dir with spaces and # special");
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("concurrent acquisitions across parallel subshells allocate distinct non-colliding directories", async () => {
		fs.mkdirSync(PARENT, { recursive: true });
		const concurrency = 8;
		const script = `
set -euo pipefail
source "${HELPER}"
magick_tmpdir_scope "${PARENT}"
printf '%s\\n' "\${MAGICK_SCOPED_TMPDIR}"
`;
		const runs = await Promise.all(
			Array.from({ length: concurrency }, () => {
				return new Promise<{ status: number | null; dir: string }>((resolve, reject) => {
					const proc = spawn("bash", ["-lc", script], { stdio: ["ignore", "pipe", "pipe"] });
					let stdout = "";
					let stderr = "";
					proc.stdout.on("data", d => (stdout += d.toString()));
					proc.stderr.on("data", d => (stderr += d.toString()));
					proc.on("close", code => {
						if (code !== 0) reject(new Error(`Exit ${code}: ${stderr}`));
						else resolve({ status: code, dir: stdout.trim() });
					});
				});
			}),
		);

		const dirs = runs.map(r => r.dir);
		expect(dirs).toHaveLength(concurrency);
		const uniqueDirs = new Set(dirs);
		expect(uniqueDirs.size).toBe(concurrency);
		for (const dir of uniqueDirs) {
			expect(fs.existsSync(dir)).toBe(true);
		}
	});

	it("concurrent sibling scope preservation: releasing one scope leaves sibling scopes intact", () => {
		fs.mkdirSync(PARENT, { recursive: true });
		const script = `
set -euo pipefail
source "${HELPER}"

# Scope A
magick_tmpdir_scope "${PARENT}"
scope_a="\${MAGICK_SCOPED_TMPDIR}"
token_a="\${MAGICK_SCOPED_TMPDIR_TOKEN}"
unset MAGICK_SCOPED_TMPDIR MAGICK_SCOPED_TMPDIR_TOKEN

# Scope B
magick_tmpdir_scope "${PARENT}"
scope_b="\${MAGICK_SCOPED_TMPDIR}"
token_b="\${MAGICK_SCOPED_TMPDIR_TOKEN}"

[ "\${scope_a}" != "\${scope_b}" ]
[ -d "\${scope_a}" ]
[ -d "\${scope_b}" ]

# Release Scope A
MAGICK_SCOPED_TMPDIR="\${scope_a}"
MAGICK_SCOPED_TMPDIR_TOKEN="\${token_a}"
magick_tmpdir_release

# Scope A is deleted; Scope B MUST still exist
test ! -e "\${scope_a}"
test -d "\${scope_b}"

# Release Scope B
MAGICK_SCOPED_TMPDIR="\${scope_b}"
MAGICK_SCOPED_TMPDIR_TOKEN="\${token_b}"
magick_tmpdir_release
test ! -e "\${scope_b}"
`;
		const res = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(res.status, res.stderr).toBe(0);
	});

	it("a trapped shell executes magick_tmpdir_release on SIGTERM", async () => {
		fs.mkdirSync(PARENT, { recursive: true });
		const script = `
set -euo pipefail
source "${HELPER}"
magick_tmpdir_scope "${PARENT}"
trap magick_tmpdir_release EXIT
printf '%s\\n' "\${MAGICK_SCOPED_TMPDIR}"
while true; do sleep 0.1; done
`;
		const child = spawn("bash", ["-lc", script], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", d => (stdout += d.toString()));

		// Wait until MAGICK_SCOPED_TMPDIR is printed
		for (let i = 0; i < 40; i++) {
			if (stdout.trim().length > 0) break;
			await delay(100);
		}
		const dir = stdout.trim();
		expect(dir.length).toBeGreaterThan(0);
		expect(fs.existsSync(dir)).toBe(true);

		// Send SIGTERM to the trapped shell
		child.kill("SIGTERM");
		const exited = once(child, "exit").then(() => true);
		const finished = await Promise.race([exited, delay(4_000, false)]);
		expect(finished).toBe(true);

		// Verify the trap cleaned up the directory
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("parent cleanup removes scoped directory even when child convert is killed by SIGKILL", async () => {
		if (!CONVERT) return;
		fs.mkdirSync(PARENT, { recursive: true });
		const script = `
set -euo pipefail
source "${HELPER}"
magick_tmpdir_scope "${PARENT}"
trap magick_tmpdir_release EXIT
printf '%s\\n' "\${MAGICK_SCOPED_TMPDIR}"

# Spawn convert in background that spills
bin="${CONVERT}"
[ "$(basename "\${bin}")" = "magick" ] && prefix="convert" || prefix=""
"\${bin}" \${prefix} -limit memory 8MB -limit map 8MB -size 4000x4000 xc:red -blur 0x20 png:- >/dev/null 2>&1 &
CPID=$!

# Wait briefly for spill then SIGKILL child
for _ in $(seq 1 40); do
    if [ -d "\${MAGICK_SCOPED_TMPDIR}" ] && [ "$(ls -A "\${MAGICK_SCOPED_TMPDIR}" 2>/dev/null)" != "" ]; then
        break
    fi
    sleep 0.1
done
kill -9 "\${CPID}" 2>/dev/null || true
wait "\${CPID}" 2>/dev/null || true
exit 0
`;
		const res = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(res.status, res.stderr).toBe(0);
		const dir = res.stdout.trim();
		expect(dir.length).toBeGreaterThan(0);
		// Parent's EXIT trap should have released the directory completely
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("magick_tmpdir_release requires the allocator's private token before deleting a directory", () => {
		fs.mkdirSync(PARENT, { recursive: true });
		const userDir = path.join(PARENT, "my-important-data");
		const fakePatternDir = path.join(PARENT, "veyyon-magick.fake-no-sentinel");
		const forgedPatternDir = path.join(PARENT, "veyyon-magick.forged-sentinel");
		fs.mkdirSync(userDir);
		fs.mkdirSync(fakePatternDir);
		fs.mkdirSync(forgedPatternDir);
		fs.writeFileSync(path.join(userDir, "file.txt"), "important");
		fs.writeFileSync(path.join(fakePatternDir, "file.txt"), "important");
		fs.writeFileSync(path.join(forgedPatternDir, ".veyyon-magick-scope"), "different-token\n");

		for (const target of ["/", "/tmp", userDir, fakePatternDir, forgedPatternDir]) {
			const script = `
set -euo pipefail
source "${HELPER}"
export MAGICK_SCOPED_TMPDIR="${target}"
export MAGICK_SCOPED_TMPDIR_TOKEN="wrong-token"
magick_tmpdir_release
[ -z "\${MAGICK_SCOPED_TMPDIR:-}" ]
[ -z "\${MAGICK_SCOPED_TMPDIR_TOKEN:-}" ]
[ -z "\${MAGICK_TMPDIR:-}" ]
[ -z "\${MAGICK_TEMPORARY_PATH:-}" ]
`;
			const res = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
			expect(res.status, res.stderr).toBe(0);
			expect(fs.existsSync(target)).toBe(true);
		}
	});

	it("magick_tmpdir_scope returns non-zero when directory creation fails and does not export empty paths", () => {
		// Use an impossible path under /dev/null
		const script = `
set -euo pipefail
source "${HELPER}"
if magick_tmpdir_scope "/dev/null/impossible" 2>/dev/null; then
    echo "UNEXPECTED_SUCCESS"
    exit 1
fi
[ -z "\${MAGICK_SCOPED_TMPDIR:-}" ]
[ -z "\${MAGICK_TMPDIR:-}" ]
[ -z "\${MAGICK_TEMPORARY_PATH:-}" ]
`;
		const res = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(res.status, res.stderr).toBe(0);
	});
});
