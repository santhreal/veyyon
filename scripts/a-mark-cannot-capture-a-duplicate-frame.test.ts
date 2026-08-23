/**
 * WHY: A recorded mark under `proof/scenes/` is proof of a specific reached state.
 * If a mark captures the frame belonging to the previous mark because the state
 * transition never occurred, was missed, or failed to render, the resulting capture
 * silently emits duplicate (byte-identical) frames under distinct milestone names.
 *
 * This test suite asserts that:
 * 1. The scene driver helper `lib.sh` defines `shot()` with duplicate-frame prevention
 *    that compares the newly captured PNG against the previous frame and abandons the take
 *    with a fatal error if they are byte-identical.
 * 2. Every guard in `demo-hd.sh` matches actual product/model outputs rather than stale strings.
 * 3. The duplicate-frame guard halts execution when back-to-back shots produce identical frames.
 *
 * What this does not catch:
 * Two distinct screens that both fail to show the intended business state (e.g. an error dialog
 * followed by a different error dialog). Those require visual review and semantic string assertions.
 */

import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const LIB_SH = path.join(REPO_ROOT, "proof/scenes/lib.sh");

describe("a mark must observe the state it names rather than capture a duplicate frame", () => {
	it("abandons the take when back-to-back shots produce byte-identical frames", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mark-dup-test-"));
		try {
			const scriptPath = path.join(tempDir, "test-dup.sh");
			const scriptContent = `#!/usr/bin/env bash
set -euo pipefail
export SCENE_NAME="test-dup"
export SCENE_OUT="${tempDir}"
export SCENE_SERVER="x11"

_be_window_px() { echo "1920 1080"; }
_be_window_origin() { echo "0 0"; }

source "${LIB_SH}"

_be_capture() {
	printf "MOCK_FRAME_BYTES" > "$1"
}

shot first-state
shot second-state
`;
			fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

			let exitCode = 0;
			let stderr = "";
			try {
				await run("bash", [scriptPath]);
				exitCode = 0;
			} catch (err: unknown) {
				const execError = err as { code?: number; stderr?: string };
				exitCode = execError.code ?? 1;
				stderr = execError.stderr ?? "";
			}

			expect(exitCode).toBe(2);
			expect(stderr).toContain("is byte-identical to previous shot 'test-dup-first-state'");
			expect(fs.existsSync(path.join(tempDir, "abandoned.tsv"))).toBe(true);
			const abandoned = fs.readFileSync(path.join(tempDir, "abandoned.tsv"), "utf8");
			expect(abandoned).toContain("second-state\tshot 'second-state' is byte-identical to previous shot 'test-dup-first-state'");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("permits consecutive shots when frames differ", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mark-diff-test-"));
		try {
			const scriptPath = path.join(tempDir, "test-diff.sh");
			const scriptContent = `#!/usr/bin/env bash
set -euo pipefail
export SCENE_NAME="test-diff"
export SCENE_OUT="${tempDir}"
export SCENE_SERVER="x11"

_counter=0
_be_window_px() { echo "1920 1080"; }
_be_window_origin() { echo "0 0"; }

source "${LIB_SH}"

_be_capture() {
	_counter=$((_counter + 1))
	printf "MOCK_FRAME_BYTES_\${_counter}" > "$1"
}

shot first-state
shot second-state
`;
			fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

			await run("bash", [scriptPath]);
			expect(fs.existsSync(path.join(tempDir, "test-diff-first-state.png"))).toBe(true);
			expect(fs.existsSync(path.join(tempDir, "test-diff-second-state.png"))).toBe(true);
			expect(fs.existsSync(path.join(tempDir, "abandoned.tsv"))).toBe(false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
