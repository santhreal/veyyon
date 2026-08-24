/**
 * ImageMagick 6 writes named magick-* pixel-cache files and leaves them behind
 * when convert is killed mid-operation. Unscoped they land in /tmp and exhaust
 * inodes. proof/docker/magick-tmpdir.sh scopes MAGICK_TMPDIR to a directory the
 * caller deletes, so a leak cannot grow unbounded.
 *
 * The first row is the leak: a bounded convert+SIGKILL leaves magick-* names.
 * The second row is the fix: magick_tmpdir_release removes the whole directory.
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

	it("leaves named magick-* files when convert is killed mid-blur", async () => {
		if (!CONVERT) return;
		fs.mkdirSync(PARENT, { recursive: true });
		const scoped = fs.mkdtempSync(path.join(PARENT, "leak-"));
		await killConvertInto(scoped);
		expect(magickNames(scoped).length).toBeGreaterThan(0);
		expect(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("magick-"))).not.toContain(
			magickNames(scoped)[0],
		);
	});

	it("magick_tmpdir_release removes the scoped directory after a leak", async () => {
		if (!CONVERT) return;
		fs.mkdirSync(PARENT, { recursive: true });
		const script = `
set -euo pipefail
# shellcheck source=proof/docker/magick-tmpdir.sh
source "${HELPER}"
magick_tmpdir_scope "${PARENT}"
printf '%s\\n' "\${MAGICK_SCOPED_TMPDIR}"
`;
		const scoped = spawnSync("bash", ["-lc", script], { encoding: "utf-8" });
		expect(scoped.status, scoped.stderr).toBe(0);
		const dir = scoped.stdout.trim();
		expect(dir.length).toBeGreaterThan(0);
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
magick_tmpdir_release
test ! -e "${dir}"
[ -z "\${MAGICK_SCOPED_TMPDIR:-}" ]
[ -z "\${MAGICK_TMPDIR:-}" ]
[ -z "\${MAGICK_TEMPORARY_PATH:-}" ]
`,
			],
			{ encoding: "utf-8" },
		);
		expect(release.status, release.stderr).toBe(0);
		expect(fs.existsSync(dir)).toBe(false);
	});
});
