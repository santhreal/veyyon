/**
 * The rollout-summary section handed to the consolidation model must never say summaries do not exist
 * when they exist and could not be read.
 *
 * WHY THIS SUITE EXISTS. `readRolloutSummaries` builds a block of text that is interpolated into the
 * consolidation prompt, so every sentence it returns is read by the model as a statement of fact. Two
 * swallows used to make it lie. `fs.readdir(dir).catch(() => [])` turned a permission error on the
 * summaries directory into an empty listing, and `Bun.file(...).text().catch(() => "")` turned an
 * unreadable summary into an empty one. Either path ended at the literal string
 * "No rollout summaries yet.", so a run whose summaries were all present but unreadable told the model
 * that nothing had ever been summarised. Consolidation then rewrote long-term memory from a premise it
 * had been told was true, which is memory loss with no operator-visible cause.
 *
 * The distinction this suite pins is between "asked and there are none" and "could not ask". A missing
 * directory is the first and must keep its concise answer, because that is the ordinary first-run state.
 * Anything else is the second and must (a) reach the log with the failing path and the reason, and
 * (b) be described in the returned text as unknown rather than empty.
 *
 * The tests assert the exact sentences, not their shape, because the sentence is what the model reads.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { readRolloutSummaries } from "../../src/memories";

/** One captured `logger.warn` call: the message and its structured fields. */
interface Warning {
	message: string;
	meta: Record<string, unknown>;
}

/** Collect every `logger.warn` emitted while `body` runs, and keep it off the test output. */
async function warningsFrom(body: () => Promise<string>): Promise<{ text: string; warnings: Warning[] }> {
	const warnings: Warning[] = [];
	const spy = spyOn(logger, "warn").mockImplementation((message: string, meta?: Record<string, unknown>) => {
		warnings.push({ message, meta: meta ?? {} });
	});
	try {
		const text = await body();
		return { text, warnings };
	} finally {
		spy.mockRestore();
	}
}

const roots: string[] = [];

/** A fresh memory root; the `rollout_summaries` directory is created only when `withDir` is set. */
async function memoryRoot(withDir: boolean): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-rollout-summaries-"));
	roots.push(root);
	if (withDir) await fs.mkdir(path.join(root, "rollout_summaries"));
	return root;
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		// Restore any mode this suite cleared, or the recursive remove cannot descend.
		await fs.chmod(path.join(root, "rollout_summaries"), 0o700).catch(() => {});
		await fs.rm(root, { recursive: true, force: true });
	}
});

describe("when there genuinely are no summaries", () => {
	/**
	 * First run: the directory has not been created yet. ENOENT is the one failure that really does mean
	 * "none", and it must keep the short answer so the prompt does not describe a problem that is absent.
	 */
	it("says none yet when the directory does not exist", async () => {
		const root = await memoryRoot(false);

		const { text, warnings } = await warningsFrom(() => readRolloutSummaries(root));

		expect(text).toBe("No rollout summaries yet.");
		expect(warnings).toEqual([]);
	});

	/** An existing but empty directory is the same fact, and equally not worth a warning. */
	it("says none yet when the directory is empty", async () => {
		const root = await memoryRoot(true);

		const { text, warnings } = await warningsFrom(() => readRolloutSummaries(root));

		expect(text).toBe("No rollout summaries yet.");
		expect(warnings).toEqual([]);
	});

	/** Files that are not summaries are not summaries. Only `.md` entries are read. */
	it("ignores non-markdown entries", async () => {
		const root = await memoryRoot(true);
		await Bun.write(path.join(root, "rollout_summaries", "index.json"), "{}");

		const { text } = await warningsFrom(() => readRolloutSummaries(root));

		expect(text).toBe("No rollout summaries yet.");
	});
});

describe("when the summaries can be read", () => {
	/** The ordinary case: each summary arrives under its own filename header, in sorted order. */
	it("returns every summary keyed by its filename", async () => {
		const root = await memoryRoot(true);
		await Bun.write(path.join(root, "rollout_summaries", "b.md"), "second body\n");
		await Bun.write(path.join(root, "rollout_summaries", "a.md"), "first body\n");

		const { text, warnings } = await warningsFrom(() => readRolloutSummaries(root));

		expect(text).toBe("--- a.md ---\nfirst body\n\n--- b.md ---\nsecond body");
		expect(warnings).toEqual([]);
	});

	/**
	 * A summary file that is present and empty contributes nothing, and that is not a failure: it is a
	 * summary that was written with no content. It must not be reported as unreadable.
	 */
	it("skips an empty summary without reporting a failure", async () => {
		const root = await memoryRoot(true);
		await Bun.write(path.join(root, "rollout_summaries", "a.md"), "   \n");
		await Bun.write(path.join(root, "rollout_summaries", "b.md"), "real body\n");

		const { text, warnings } = await warningsFrom(() => readRolloutSummaries(root));

		expect(text).toBe("--- b.md ---\nreal body");
		expect(warnings).toEqual([]);
	});
});

describe("when the directory listing fails", () => {
	/**
	 * The regression on the directory swallow. A summaries directory that cannot be listed used to become
	 * "No rollout summaries yet."; the text must instead tell the model the section is unknown.
	 */
	it("describes the section as unknown rather than empty", async () => {
		const root = await memoryRoot(true);
		await Bun.write(path.join(root, "rollout_summaries", "a.md"), "body\n");
		await fs.chmod(path.join(root, "rollout_summaries"), 0o000);

		const { text } = await warningsFrom(() => readRolloutSummaries(root));

		expect(text).toBe("Rollout summaries exist but could not be read; treat this section as unknown, not empty.");
		expect(text).not.toContain("No rollout summaries yet.");
	});

	/** And the operator gets the failing directory and the underlying reason, not a bare notice. */
	it("logs the directory and the reason", async () => {
		const root = await memoryRoot(true);
		await fs.chmod(path.join(root, "rollout_summaries"), 0o000);

		const { warnings } = await warningsFrom(() => readRolloutSummaries(root));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Memory rollout summaries could not be listed");
		expect(warnings[0]?.meta.dir).toBe(path.join(root, "rollout_summaries"));
		expect(String(warnings[0]?.meta.error)).toContain("EACCES");
	});
});

describe("when individual summaries cannot be read", () => {
	/**
	 * The regression on the per-file swallow, in its worst form: every summary is unreadable, so the old
	 * code produced exactly the same sentence as a first run with no memory at all.
	 */
	it("does not claim there are none when all of them are unreadable", async () => {
		const root = await memoryRoot(true);
		for (const name of ["a.md", "b.md"]) {
			const file = path.join(root, "rollout_summaries", name);
			await Bun.write(file, "body\n");
			await fs.chmod(file, 0o000);
		}

		const { text } = await warningsFrom(() => readRolloutSummaries(root));

		expect(text).toBe("2 rollout summaries exist but could not be read; treat this section as unknown, not empty.");
	});

	/**
	 * The mixed case is the likely one, and it is where a silent skip is hardest to notice: the section
	 * looks populated. The readable summaries are still delivered, and the gap is named in the same text.
	 */
	it("delivers the readable ones and names the gap", async () => {
		const root = await memoryRoot(true);
		await Bun.write(path.join(root, "rollout_summaries", "a.md"), "kept body\n");
		const blocked = path.join(root, "rollout_summaries", "b.md");
		await Bun.write(blocked, "lost body\n");
		await fs.chmod(blocked, 0o000);

		const { text } = await warningsFrom(() => readRolloutSummaries(root));

		expect(text).toBe("--- a.md ---\nkept body\n\n--- unreadable ---\n1 further summaries could not be read: b.md");
	});

	/** Each unreadable summary is logged by name, so an operator can fix the specific file. */
	it("logs each unreadable summary by name with its reason", async () => {
		const root = await memoryRoot(true);
		const blocked = path.join(root, "rollout_summaries", "b.md");
		await Bun.write(blocked, "lost body\n");
		await fs.chmod(blocked, 0o000);

		const { warnings } = await warningsFrom(() => readRolloutSummaries(root));

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Memory rollout summary could not be read");
		expect(warnings[0]?.meta.file).toBe("b.md");
		expect(String(warnings[0]?.meta.error)).toContain("EACCES");
	});
});
