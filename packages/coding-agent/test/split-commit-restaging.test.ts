import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $ } from "bun";

describe("issue #966 split commit restaging", () => {
	it("recreates split commits when one commit contains a newly created file", async () => {
		const packageRoot = path.join(import.meta.dir, "..");
		const script = `
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import * as git from "./src/utils/git.ts";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-issue-966-"));
try {
	await $\`git init --initial-branch=main\`.cwd(dir).quiet();
	await $\`git config user.email tester@example.com\`.cwd(dir).quiet();
	await $\`git config user.name Tester\`.cwd(dir).quiet();
	await fs.writeFile(path.join(dir, "tracked.txt"), "base\\n");
	await $\`git add tracked.txt\`.cwd(dir).quiet();
	await $\`git commit -m baseline\`.cwd(dir).quiet();
	await fs.writeFile(path.join(dir, "tracked.txt"), "base\\ntracked change\\n");
	await fs.writeFile(path.join(dir, "new-file.txt"), "sample data\\n");
	await git.stage.files(dir);
	const originalStagedDiff = await git.diff(dir, { cached: true });
	await git.stage.reset(dir);
	await git.stage.hunks(dir, [{ path: "new-file.txt", hunks: { type: "all" } }], {
		rawDiff: originalStagedDiff,
		diffCached: true,
	});
	const firstStage = await git.diff.changedFiles(dir, { cached: true });
	if (!Bun.deepEquals(firstStage, ["new-file.txt"])) {
		throw new Error("unexpected first stage: " + JSON.stringify(firstStage));
	}
	await git.commit(dir, "feat: add new file");
	await git.stage.hunks(dir, [{ path: "tracked.txt", hunks: { type: "all" } }], {
		rawDiff: originalStagedDiff,
		diffCached: true,
	});
	const secondStage = await git.diff.changedFiles(dir, { cached: true });
	if (!Bun.deepEquals(secondStage, ["tracked.txt"])) {
		throw new Error("unexpected second stage: " + JSON.stringify(secondStage));
	}
	await git.commit(dir, "fix: update tracked file");
	const log = (await $\`git log --format=%s -2\`.cwd(dir).text()).trim().split("\\n");
	if (!Bun.deepEquals(log, ["fix: update tracked file", "feat: add new file"])) {
		throw new Error("unexpected log: " + JSON.stringify(log));
	}
	const summary = await git.status.summary(dir);
	// The three counts, field by field, rather than deep-equality against the whole
	// object: the summary grew a \`truncated\` flag and this assertion started failing
	// on a shape change while the behaviour it checks was still correct.
	const counts = { staged: summary.staged, unstaged: summary.unstaged, untracked: summary.untracked };
	if (!Bun.deepEquals(counts, { staged: 0, unstaged: 0, untracked: 0 })) {
		throw new Error("unexpected status: " + JSON.stringify(summary));
	}
} finally {
	await fs.rm(dir, { recursive: true, force: true });
}
`;
		const result = await $`bun --eval ${script}`.cwd(packageRoot).quiet().nothrow();
		// The child does the asserting, so its stderr IS the failure message. Reporting
		// only the exit code (which is what this did) turns every failure here into
		// "expected 0, received 1" and sends the reader off to re-run the script by hand.
		expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0);
	});
});
