/**
 * SYSPROMPT-4, end to end: a file on disk must reach the assembled prompt.
 *
 * The unit suite in `prompt-section-overrides.test.ts` proves the folding rules
 * and the discovery rules with an injected filesystem. Neither proves the part
 * a user actually depends on: that writing a file into `.veyyon/PROMPT_SECTIONS/`
 * changes the prompt the model is sent. Every step between those two ends can
 * fail silently — the directory could be looked for in the wrong place, the
 * overrides could be computed and then dropped before assembly, or the eval
 * suppression could swallow them — and each of those failures looks exactly
 * like "the feature does nothing", which is the failure mode this whole item
 * exists to eliminate.
 *
 * So these tests write real files into a real temporary project and read the
 * real assembled prompt back out through the inspection surface.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { inspectSystemPrompt } from "@veyyon/coding-agent/system-prompt-builder/prompt-inspect";
import { removeWithRetries } from "@veyyon/utils";

const ADDED_LINE = "Always cite the exact command you ran when reporting a test result.";

let projectDir = "";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-sections-e2e-"));
	await fs.mkdir(path.join(projectDir, ".veyyon", "PROMPT_SECTIONS"), { recursive: true });
});

afterAll(async () => {
	if (projectDir) await removeWithRetries(projectDir);
});

/** Write an override file into the temporary project and reassemble. */
async function withOverride(filename: string, content: string) {
	const file = path.join(projectDir, ".veyyon", "PROMPT_SECTIONS", filename);
	await fs.writeFile(file, content);
	try {
		return await inspectSystemPrompt({ toolNames: ["read", "bash"], cwd: projectDir });
	} finally {
		await fs.rm(file, { force: true });
	}
}

describe("an append file written into a project", () => {
	it("reaches the assembled prompt", async () => {
		// The end-to-end claim, stated as plainly as it can be: the file exists,
		// therefore the text is in the prompt.
		const inspection = await withOverride("delivery-contract.append.md", `${ADDED_LINE}\n`);

		expect(inspection.blocks.join("\n")).toContain(ADDED_LINE);
	});

	it("lands inside the section it names, not somewhere else in the prompt", async () => {
		// Appending to the END of the whole prompt would satisfy the test above
		// while ignoring the section entirely, which is precisely what the older
		// `APPEND_SYSTEM.md` path does and what this is not.
		const inspection = await withOverride("delivery-contract.append.md", `${ADDED_LINE}\n`);
		const section = inspection.sections.find(s => s.id === "delivery-contract");

		expect(section?.text).toContain(ADDED_LINE);
	});

	it("leaves every other section byte-identical", async () => {
		// CONTAINMENT, measured on the real assembly rather than on the override
		// map. Sections are compared individually so a failure names the one that
		// moved.
		const before = await inspectSystemPrompt({ toolNames: ["read", "bash"], cwd: projectDir });
		const after = await withOverride("delivery-contract.append.md", `${ADDED_LINE}\n`);

		for (const section of before.sections) {
			if (section.id === "delivery-contract") continue;
			const counterpart = after.sections.find(s => s.id === section.id && s.blockIndex === section.blockIndex);
			expect(counterpart?.text).toBe(section.text);
		}
	});

	it("is gone once the file is removed", async () => {
		// Proves the earlier assertions were not passing on something cached or
		// baked in at module load, which a template read once at import time would
		// do.
		await withOverride("delivery-contract.append.md", `${ADDED_LINE}\n`);
		const after = await inspectSystemPrompt({ toolNames: ["read", "bash"], cwd: projectDir });

		expect(after.blocks.join("\n")).not.toContain(ADDED_LINE);
	});
});

describe("a bad override file written into a project", () => {
	it("fails the build loudly rather than assembling without it", async () => {
		// The silent-failure case, end to end. An operator who mistypes a section
		// name must be told, not left running the shipped prompt while believing
		// otherwise.
		const file = path.join(projectDir, ".veyyon", "PROMPT_SECTIONS", "delivery_contract.md");
		await fs.writeFile(file, "whatever");
		try {
			await expect(inspectSystemPrompt({ toolNames: ["read"], cwd: projectDir })).rejects.toThrow(
				/unknown prompt section/,
			);
		} finally {
			await fs.rm(file, { force: true });
		}
	});

	it("rejects a replacement that drops its banner", async () => {
		const file = path.join(projectDir, ".veyyon", "PROMPT_SECTIONS", "role.md");
		await fs.writeFile(file, "You are a pirate.");
		try {
			await expect(inspectSystemPrompt({ toolNames: ["read"], cwd: projectDir })).rejects.toThrow(/banner/);
		} finally {
			await fs.rm(file, { force: true });
		}
	});
});
