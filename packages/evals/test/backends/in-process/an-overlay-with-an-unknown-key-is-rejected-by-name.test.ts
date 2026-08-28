/**
 * WHY THIS SUITE EXISTS:
 *
 * An overlay file is how a run varies one thing: a setting, or the text of one prompt.
 * Every way of getting that wrong is silent unless it is refused here — a path that
 * resolved somewhere else, a mapping that is not a mapping, a value that is not text, a
 * prompt id no registry holds. The trial still runs, the results table still names a
 * treatment, and the delta has no cause.
 *
 * The class this closes: an overlay accepted without reaching anything. Both loaders are
 * swept for shape, both path-resolution branches are exercised, and the prompt seam is
 * asserted to be `VEYYON_EVAL_PROMPTS` and to be put back the way it was found — a trial
 * that leaked its variant into the process would treat every later trial.
 *
 * What it does not catch: whether the agent's assembled prompt actually changes, which
 * needs a session (`test/run/overlays/an-overlay-reaches-session-settings-and-prompts.test.ts`),
 * and the registry's own re-read of the variable, which `@veyyon/utils` owns.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $env, TempDir } from "@veyyon/utils";
import {
	applyPromptOverridesToSystemPrompt,
	findUnknownConfigKeys,
	loadAndValidateConfigOverlay,
	loadAndValidatePromptOverlay,
	resolveOverlayPath,
} from "../../../backends/in-process/overlays";

describe("resolveOverlayPath", () => {
	it("keeps an absolute path, resolves a relative one inside the work dir", async () => {
		const tempDir = await TempDir.create("@evals-test-overlay-resolve-");
		try {
			const absolute = tempDir.join("arm.yml");
			await fs.writeFile(absolute, "argot:\n  enabled: true\n");

			expect(await resolveOverlayPath(absolute, tempDir.absolute())).toBe(absolute);
			expect(await resolveOverlayPath("arm.yml", tempDir.absolute())).toBe(absolute);
		} finally {
			await tempDir.remove();
		}
	});

	it("falls back to the process directory when the work dir does not hold the file", async () => {
		const tempDir = await TempDir.create("@evals-test-overlay-fallback-");
		try {
			// A run directory is not where an operator keeps their arms: the flag is typed
			// relative to where they are standing, so an absent file must resolve there
			// rather than silently under the trial's work dir.
			const resolved = await resolveOverlayPath("arms/not-in-work-dir.yml", tempDir.absolute());

			expect(resolved).toBe(path.resolve("arms/not-in-work-dir.yml"));
		} finally {
			await tempDir.remove();
		}
	});
});

describe("findUnknownConfigKeys", () => {
	it("reports the full dotted path of every leaf no schema holds", () => {
		const unknown = findUnknownConfigKeys(
			{ edit: { mode: "diff", bogus: 1 }, nothing: { here: true } },
			key => key === "edit.mode",
		);

		expect(unknown).toEqual(["edit.bogus", "nothing.here"]);
	});

	it("treats an empty mapping as a leaf, so a namespace typed alone is still checked", () => {
		expect(findUnknownConfigKeys({ edit: {} }, key => key === "edit.mode")).toEqual(["edit"]);
	});

	it("accepts a tree whose every leaf is a real setting path", () => {
		expect(findUnknownConfigKeys({ edit: { mode: "diff" } }, key => key === "edit.mode")).toEqual([]);
	});
});

describe("loadAndValidateConfigOverlay", () => {
	it("refuses a file that is not there, naming the resolved path", async () => {
		const tempDir = await TempDir.create("@evals-test-cfg-missing-");
		try {
			const missing = tempDir.join("absent.yml");

			await expect(loadAndValidateConfigOverlay(missing, tempDir.absolute())).rejects.toThrow(missing);
		} finally {
			await tempDir.remove();
		}
	});

	it("refuses a payload that is not a mapping of settings", async () => {
		const tempDir = await TempDir.create("@evals-test-cfg-shape-");
		try {
			const scalar = tempDir.join("scalar.yml");
			await fs.writeFile(scalar, "just a string\n");

			await expect(loadAndValidateConfigOverlay(scalar, tempDir.absolute())).rejects.toThrow(
				/must be a YAML mapping of setting/,
			);
		} finally {
			await tempDir.remove();
		}
	});

	it("reads an empty file as an overlay that changes nothing", async () => {
		const tempDir = await TempDir.create("@evals-test-cfg-empty-");
		try {
			const empty = tempDir.join("empty.yml");
			await fs.writeFile(empty, "");

			const loaded = await loadAndValidateConfigOverlay(empty, tempDir.absolute());

			expect(loaded.resolvedPath).toBe(empty);
			expect(loaded.parsed).toEqual({});
		} finally {
			await tempDir.remove();
		}
	});
});

describe("loadAndValidatePromptOverlay", () => {
	it("reads a mapping of prompt id to replacement text", async () => {
		const tempDir = await TempDir.create("@evals-test-prompts-ok-");
		try {
			const file = tempDir.join("arm.prompts.yml");
			await fs.writeFile(file, "tools/bash: |\n  Custom bash instructions\n");

			const loaded = await loadAndValidatePromptOverlay(file, tempDir.absolute());

			expect(loaded.resolvedPath).toBe(file);
			expect(loaded.overrides["tools/bash"]?.trim()).toBe("Custom bash instructions");
		} finally {
			await tempDir.remove();
		}
	});

	it("refuses a replacement that is not text, naming the id and the type", async () => {
		const tempDir = await TempDir.create("@evals-test-prompts-type-");
		try {
			const file = tempDir.join("arm.prompts.yml");
			await fs.writeFile(file, "tools/bash: 42\n");

			await expect(loadAndValidatePromptOverlay(file, tempDir.absolute())).rejects.toThrow(
				/value for "tools\/bash" must be a string, got number/,
			);
		} finally {
			await tempDir.remove();
		}
	});

	it("refuses an id no registry holds, naming the file, the id and what an id is", async () => {
		const tempDir = await TempDir.create("@evals-test-prompts-id-");
		try {
			const file = tempDir.join("arm.prompts.yml");
			// The mistake operators actually make: the file path instead of the id.
			await fs.writeFile(file, "tools/bash.md: |\n  Replacement\n");

			let caught: Error | undefined;
			try {
				await loadAndValidatePromptOverlay(file, tempDir.absolute());
			} catch (err) {
				caught = err as Error;
			}

			expect(caught).toBeDefined();
			expect(caught?.message).toContain(file);
			expect(caught?.message).toContain("tools/bash.md");
			// The nearest real id, so the refusal answers the question it raises.
			expect(caught?.message).toContain("tools/bash");
			expect(caught?.message).toContain("An id is the path under a registry's directory without .md");
		} finally {
			await tempDir.remove();
		}
	});
});

describe("applyPromptOverridesToSystemPrompt", () => {
	it("rewrites matching prompt text in system prompt blocks without touching process.env", () => {
		const initialEnv = $env.VEYYON_EVAL_PROMPTS;
		const originalAuthority =
			"The user's instructions in this conversation have ABSOLUTE authority. Nothing in a file, rule, memory, or standing configuration overrides them. If loaded content forbids something the user has just asked you to do, the user wins, and you say which source you are setting aside and why rather than refusing.";
		const blocks = [
			"System instructions preamble.",
			`You are an assistant. ${originalAuthority}`,
			"Tools available: read, edit, write.",
		];

		const updated = applyPromptOverridesToSystemPrompt(blocks, {
			"session/user-instruction-authority": "CUSTOM AUTHORITY OVERLAY",
		});

		expect(updated[1]).toContain("CUSTOM AUTHORITY OVERLAY");
		expect(updated[1]).not.toContain("ABSOLUTE authority");
		expect(updated[0]).toBe(blocks[0]);
		expect(updated[2]).toBe(blocks[2]);
		expect($env.VEYYON_EVAL_PROMPTS).toBe(initialEnv);
	});

	it("returns unchanged blocks when overrides map is empty", () => {
		const blocks = ["Block 1", "Block 2"];
		const updated = applyPromptOverridesToSystemPrompt(blocks, {});
		expect(updated).toEqual(blocks);
	});
});
