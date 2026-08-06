/**
 * A suite can run a program it wrote to TMPDIR, whichever rung it landed on.
 *
 * The sandbox's promise is that a suite behaves the same on every rung, so a red
 * result means the code is wrong rather than the boundary is different today. Two
 * rungs quietly broke that promise. Docker mounts a `--tmpfs` with its default
 * options, and those include `noexec`, so `chmod +x` succeeds and the exec fails
 * with `Permission denied`. The bwrap rung and the microVM guest both mount plain
 * tmpfs, which allows exec, so the same suite passed there.
 *
 * What it cost: `pre-push-hook.test.ts` writes a stub `bun` into a temp directory
 * and asserts the hook invokes it, and `link-veyyon.test.ts` does the same with a
 * stub `bun pm`. Six tests across those two files failed on the docker rung with
 * assertion errors that look exactly like the hook forgetting to run the check.
 * Nothing in either failure names the mount, so the reading is "the hook is
 * broken", and the honest conclusion, that the harness cannot run the case, takes
 * a mount table to reach.
 *
 * A stub binary on PATH is the ordinary way to test a shell script, so this is not
 * an exotic requirement. It is asserted by running one, because that is the only
 * thing that answers the question: the mount options are set in three shell files
 * on two rungs, and a suite that read them would be checking spelling.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SENTINEL = "__TMPDIR_EXEC_OK__";

describe("the sandbox TMPDIR", () => {
	it("runs a script written and marked executable inside it", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "veyyon-exec-probe-"));
		const script = path.join(dir, "probe.sh");
		writeFileSync(script, `#!/usr/bin/env bash\necho ${SENTINEL}\n`);
		chmodSync(script, 0o755);

		const run = spawnSync(script, [], { encoding: "utf8" });

		// The message is the whole value of this test: an EACCES here is a mount
		// option, not a bug in whatever suite reported it first.
		expect(run.error ? `${run.error.message} (is TMPDIR mounted noexec?)` : run.stdout.trim()).toBe(SENTINEL);
		expect(run.status).toBe(0);
	});
});
