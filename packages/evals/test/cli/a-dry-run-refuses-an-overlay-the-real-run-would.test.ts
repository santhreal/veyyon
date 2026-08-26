/**
 * WHY THIS SUITE EXISTS. `--dry-run` is what an operator runs before spending a night of
 * quota, so its answer has to be the answer the real run gives. It was not: the dry-run
 * path built the plan and then called the backend's preflight with a context carrying no
 * variants, so every overlay check the backend performs — a missing file, an unknown
 * setting key, a prompt id no registry holds — validated nothing at all. A typo passed
 * the dry run and was refused hours later by the run it was supposed to protect.
 *
 * THE CLASS: two paths to one verdict, one of which builds a poorer context. Every
 * overlay refusal is swept here through the CLI's dry run, so a check that only
 * `executeRun` reaches is a failure rather than a silent pass, and the accepting case is
 * asserted beside each refusal so a preflight that refuses everything cannot pass either.
 *
 * WHAT IT DOES NOT CATCH: the wording of each refusal, which belongs to the loader
 * (`test/backends/in-process/overlays.test.ts`), and whether an accepted overlay changes
 * what the model receives (`test/run/overlays/`).
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { main } from "../../src/cli";

/** Captures what the CLI wrote to a stream, without letting it reach the terminal. */
function capture(stream: "stdout" | "stderr"): { text: () => string } {
	const chunks: string[] = [];
	const spy = spyOn(process[stream], "write").mockImplementation(chunk => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	return { text: () => (spy.mock.calls.length === 0 ? "" : chunks.join("")) };
}

afterEach(() => {
	spyOn(process.stdout, "write").mockRestore();
	spyOn(process.stderr, "write").mockRestore();
});

const SUITE = "typescript-edit";
const MODEL = "anthropic/claude-sonnet-4-6";

interface OverlayRefusal {
	/** Names the mistake in the test title. */
	readonly what: string;
	readonly flag: "--config" | "--prompts";
	readonly file: string;
	/** `null` writes no file at all, which is the missing-overlay case. */
	readonly body: string | null;
	/** A fragment the refusal must state, so a silent pass cannot look like a refusal. */
	readonly says: string;
}

/** Every overlay mistake the backend refuses, and the flag that carries it. */
const REFUSALS: OverlayRefusal[] = [
	{
		what: "a prompt id no registry holds",
		flag: "--prompts",
		file: "bad-id.prompts.yml",
		body: "tools/does-not-exist-at-all: |\n  replacement\n",
		says: "no registry holds",
	},
	{
		what: "a prompt overlay file that is not there",
		flag: "--prompts",
		file: "absent.prompts.yml",
		body: null,
		says: "Prompt overlay file not found",
	},
	{
		what: "a setting key no schema holds",
		flag: "--config",
		file: "bad-key.yml",
		body: "invalidNamespace:\n  unknownKey777: true\n",
		says: "invalidNamespace.unknownKey777",
	},
	{
		what: "a config overlay file that is not there",
		flag: "--config",
		file: "absent.yml",
		body: null,
		says: "Config overlay file not found",
	},
];

describe("a dry run", () => {
	it.each(REFUSALS)("refuses $what and earns exit 1", async ({ flag, file, body, says }) => {
		const tempDir = await TempDir.create("@evals-test-dryrun-overlay-");
		try {
			const overlay = tempDir.join(file);
			if (body !== null) await fs.writeFile(overlay, body);
			const stdout = capture("stdout");

			const code = await main(["--suite", SUITE, "--model", MODEL, flag, overlay, "--dry-run"]);

			expect(code).toBe(1);
			expect(stdout.text()).toContain("backend    REFUSED");
			expect(stdout.text()).toContain(says);
			expect(stdout.text()).not.toContain("DRY RUN — nothing was executed.");
		} finally {
			await tempDir.remove();
		}
	});

	it("accepts overlays whose every key exists, and executes nothing", async () => {
		const tempDir = await TempDir.create("@evals-test-dryrun-overlay-ok-");
		try {
			const prompts = tempDir.join("good.prompts.yml");
			await fs.writeFile(prompts, "tools/bash: |\n  Custom bash instructions\n");
			const config = tempDir.join("good.yml");
			await fs.writeFile(config, "edit:\n  mode: diff\n");
			const stdout = capture("stdout");

			const code = await main([
				"--suite",
				SUITE,
				"--model",
				MODEL,
				"--prompts",
				prompts,
				"--config",
				config,
				"--dry-run",
			]);

			expect(code).toBe(0);
			expect(stdout.text()).toContain("backend    ok");
			expect(stdout.text()).toContain("DRY RUN — nothing was executed.");
		} finally {
			await tempDir.remove();
		}
	});
});
