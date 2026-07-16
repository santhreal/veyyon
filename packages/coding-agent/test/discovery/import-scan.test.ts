/**
 * Onboarding import scan: user-level foreign skills and CLAUDE.md files are
 * discovered and copy cleanly into a profile agent dir (idempotently).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { importForeignItems, scanForeignConfig } from "../../src/discovery/import-scan";

describe("import-scan", () => {
	let tempHome = "";
	let agentDir = "";
	let cwd = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-import-scan-"));
		process.env.HOME = tempHome;
		agentDir = path.join(tempHome, "target-agent");
		cwd = path.join(tempHome, "project");
		await fs.mkdir(cwd, { recursive: true });

		await fs.mkdir(path.join(tempHome, ".claude", "skills", "review"), { recursive: true });
		await Bun.write(
			path.join(tempHome, ".claude", "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Review code\n---\nReview the diff.\n",
		);
		await Bun.write(path.join(tempHome, ".claude", "CLAUDE.md"), "# Global rules\nAlways be terse.\n");
	});

	afterEach(async () => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await fs.rm(tempHome, { recursive: true, force: true });
	});

	it("finds user-level Claude skills and CLAUDE.md as candidates", async () => {
		const candidates = await scanForeignConfig(cwd, tempHome);
		const skill = candidates.find(candidate => candidate.kind === "skill" && candidate.name === "review");
		const instructions = candidates.find(candidate => candidate.kind === "instructions");
		expect(skill?.sourcePath).toBe(path.join(tempHome, ".claude", "skills", "review", "SKILL.md"));
		expect(skill?.providerName).toBe("Claude Code");
		expect(instructions?.sourcePath).toBe(path.join(tempHome, ".claude", "CLAUDE.md"));
	});

	it("imports a skill dir and appends instructions to AGENTS.md; re-import skips", async () => {
		const candidates = await scanForeignConfig(cwd, tempHome);
		const chosen = candidates.filter(
			candidate =>
				candidate.sourcePath === path.join(tempHome, ".claude", "skills", "review", "SKILL.md") ||
				candidate.sourcePath === path.join(tempHome, ".claude", "CLAUDE.md"),
		);
		expect(chosen.length).toBe(2);

		const first = await importForeignItems(agentDir, chosen);
		expect(first.imported.length).toBe(2);
		expect(first.skipped.length).toBe(0);

		const skillText = await Bun.file(path.join(agentDir, "skills", "review", "SKILL.md")).text();
		expect(skillText).toContain("Review the diff.");
		const agentsText = await Bun.file(path.join(agentDir, "AGENTS.md")).text();
		expect(agentsText).toContain("Always be terse.");
		expect(agentsText).toContain(`<!-- imported from ${path.join(tempHome, ".claude", "CLAUDE.md")} -->`);

		const second = await importForeignItems(agentDir, chosen);
		expect(second.imported.length).toBe(0);
		expect(second.skipped.length).toBe(2);
		// The append is idempotent — content appears exactly once.
		const agentsAfter = await Bun.file(path.join(agentDir, "AGENTS.md")).text();
		expect(agentsAfter.split("Always be terse.").length - 1).toBe(1);
	});

	it("does not offer project-level files as import candidates", async () => {
		await fs.mkdir(path.join(cwd, ".claude"), { recursive: true });
		await Bun.write(path.join(cwd, ".claude", "CLAUDE.md"), "# Project rules\n");
		const candidates = await scanForeignConfig(cwd, tempHome);
		expect(candidates.some(candidate => candidate.sourcePath === path.join(cwd, ".claude", "CLAUDE.md"))).toBe(false);
	});
});
