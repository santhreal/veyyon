import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describeLegacyPromptFile, findLegacyPromptFiles } from "@veyyon/coding-agent/legacy-system-prompt-files";
import { TempDir } from "@veyyon/utils";

const temp = TempDir.createSync("legacy-system-prompt-files-");
const tempRoot = temp.absolute();
const home = path.join(tempRoot, "home");
const repoRoot = path.join(tempRoot, "repo");
const cwd = path.join(tempRoot, "repo", "packages", "app");
const agentDir = path.join(tempRoot, "home", ".veyyon", "profiles", "default", "agent");

beforeAll(async () => {
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
});

afterAll(async () => {
	await temp.remove();
});

describe("removed system prompt file notices", () => {
	/**
	 * Existing users must receive one actionable message per removed file. Exact
	 * absolute paths distinguish profile files from project files, and each file
	 * kind points at its supported replacement.
	 */
	it("finds legacy files and describes their exact migration paths", async () => {
		const systemPath = path.join(repoRoot, ".veyyon", "SYSTEM.md");
		const appendPath = path.join(cwd, ".codex", "APPEND_SYSTEM.md");
		await fs.mkdir(path.dirname(systemPath), { recursive: true });
		await fs.mkdir(path.dirname(appendPath), { recursive: true });
		await fs.writeFile(systemPath, "old custom base");
		await fs.writeFile(appendPath, "old appended instructions");

		const files = await findLegacyPromptFiles({ cwd, home, agentDir, repoRoot });
		expect(files).toEqual([
			{ kind: "system", path: systemPath },
			{ kind: "append", path: appendPath },
		]);
		expect(describeLegacyPromptFile(files[0]!)).toBe(
			`${systemPath} is no longer read. Use PROMPT_SECTIONS/ to replace an assembled prompt section.`,
		);
		expect(describeLegacyPromptFile(files[1]!)).toBe(
			`${appendPath} is no longer read. Move appended instructions to AGENTS.md.`,
		);
	});

	/**
	 * A clean installation must not receive a migration warning. This prevents a
	 * permanent startup warning after the obsolete files have been removed.
	 */
	it("returns no notice candidates when removed files are absent", async () => {
		const cleanRoot = temp.join("clean-repo");
		const cleanCwd = path.join(cleanRoot, "src");
		await fs.mkdir(cleanCwd, { recursive: true });

		await expect(
			findLegacyPromptFiles({ cwd: cleanCwd, home: temp.join("clean-home"), agentDir, repoRoot: cleanRoot }),
		).resolves.toEqual([]);
	});

	/**
	 * The retired capability also accepted Gemini's lowercase filename and the
	 * Agents-standard walk-up. Both must stay visible during migration, while a
	 * directory merely named SYSTEM.md is not reported as a readable file.
	 */
	it("covers lowercase Gemini and Agents-standard paths without directory false positives", async () => {
		const isolatedRoot = path.join(tempRoot, "foreign-repo");
		const isolatedCwd = path.join(isolatedRoot, "nested");
		const geminiPath = path.join(isolatedCwd, ".gemini", "system.md");
		const agentsPath = path.join(isolatedRoot, ".agents", "SYSTEM.md");
		const directoryPath = path.join(isolatedCwd, ".claude", "SYSTEM.md");
		await fs.mkdir(path.dirname(geminiPath), { recursive: true });
		await fs.mkdir(path.dirname(agentsPath), { recursive: true });
		await fs.mkdir(directoryPath, { recursive: true });
		await fs.writeFile(geminiPath, "gemini custom base");
		await fs.writeFile(agentsPath, "agents custom base");

		await expect(
			findLegacyPromptFiles({
				cwd: isolatedCwd,
				home: path.join(tempRoot, "foreign-home"),
				agentDir,
				repoRoot: isolatedRoot,
			}),
		).resolves.toEqual([
			{ kind: "system", path: agentsPath },
			{ kind: "system", path: geminiPath },
		]);
	});
});
