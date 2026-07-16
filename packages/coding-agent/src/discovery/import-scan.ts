/**
 * Onboarding import scan: discover computer-wide foreign config (skills and
 * CLAUDE.md/AGENTS.md instruction files authored for other AI tools) and copy
 * the items the user picks into the active profile's agent dir, making them
 * veyyon-native and profile-scoped. Only user-level (machine-wide) items are
 * offered — project files stay with their projects and keep loading ambiently.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Provider registrations are side effects of the discovery barrel.
import "./index";
import { FOREIGN_PROVIDER_IDS, loadCapability } from "../capability";
import type { ContextFile } from "../capability/context-file";
import { contextFileCapability } from "../capability/context-file";
import type { Skill } from "../capability/skill";
import { skillCapability } from "../capability/skill";

export interface ImportCandidate {
	kind: "skill" | "instructions";
	/** Skill name or instruction file basename. */
	name: string;
	/** Provider display name, e.g. "Claude Code". */
	providerName: string;
	/** Absolute path to the source file. */
	sourcePath: string;
}

export interface ImportOutcome {
	imported: ImportCandidate[];
	/** Candidates skipped because the target already exists in the profile. */
	skipped: ImportCandidate[];
}

/**
 * Enumerate importable user-level foreign config. Ambient loading of these
 * items is unaffected by importing — an import creates a profile-owned copy.
 */
export async function scanForeignConfig(cwd?: string, home?: string): Promise<ImportCandidate[]> {
	const options = { ...(cwd ? { cwd } : {}), ...(home ? { home } : {}) };
	const [skills, contextFiles] = await Promise.all([
		loadCapability<Skill>(skillCapability.id, options),
		loadCapability<ContextFile>(contextFileCapability.id, options),
	]);
	const candidates: ImportCandidate[] = [];
	for (const skill of skills.items) {
		if (skill.level !== "user" || !FOREIGN_PROVIDER_IDS.has(skill._source.provider)) continue;
		candidates.push({
			kind: "skill",
			name: skill.name,
			providerName: skill._source.providerName,
			sourcePath: skill.path,
		});
	}
	for (const file of contextFiles.items) {
		if (file.level !== "user" || !FOREIGN_PROVIDER_IDS.has(file._source.provider)) continue;
		candidates.push({
			kind: "instructions",
			name: path.basename(file.path),
			providerName: file._source.providerName,
			sourcePath: file.path,
		});
	}
	return candidates;
}

function importMarker(sourcePath: string): string {
	return `<!-- imported from ${sourcePath} -->`;
}

async function importSkill(agentDir: string, candidate: ImportCandidate): Promise<"imported" | "skipped"> {
	const skillsDir = path.join(agentDir, "skills");
	if (path.basename(candidate.sourcePath) === "SKILL.md") {
		// Directory-style skill: copy the whole skill dir (assets included).
		const sourceDir = path.dirname(candidate.sourcePath);
		const targetDir = path.join(skillsDir, path.basename(sourceDir));
		const exists = await fs.access(targetDir).then(
			() => true,
			() => false,
		);
		if (exists) return "skipped";
		await fs.mkdir(skillsDir, { recursive: true });
		await fs.cp(sourceDir, targetDir, { recursive: true });
		return "imported";
	}
	const targetFile = path.join(skillsDir, `${candidate.name}.md`);
	const exists = await fs.access(targetFile).then(
		() => true,
		() => false,
	);
	if (exists) return "skipped";
	await fs.mkdir(skillsDir, { recursive: true });
	await fs.copyFile(candidate.sourcePath, targetFile);
	return "imported";
}

async function importInstructions(agentDir: string, candidate: ImportCandidate): Promise<"imported" | "skipped"> {
	const targetFile = path.join(agentDir, "AGENTS.md");
	const marker = importMarker(candidate.sourcePath);
	const existing = await Bun.file(targetFile)
		.text()
		.catch(() => "");
	if (existing.includes(marker)) return "skipped";
	const content = await Bun.file(candidate.sourcePath).text();
	const section = `${marker}\n${content.trimEnd()}\n`;
	const merged = existing.trimEnd().length > 0 ? `${existing.trimEnd()}\n\n${section}` : section;
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(targetFile, merged);
	return "imported";
}

/**
 * Copy the chosen candidates into `agentDir`. Skills copy into `skills/`
 * (existing names are never clobbered); instruction files append to the
 * profile `AGENTS.md` under a source marker, so re-imports are idempotent.
 */
export async function importForeignItems(agentDir: string, candidates: ImportCandidate[]): Promise<ImportOutcome> {
	const outcome: ImportOutcome = { imported: [], skipped: [] };
	for (const candidate of candidates) {
		const result =
			candidate.kind === "skill"
				? await importSkill(agentDir, candidate)
				: await importInstructions(agentDir, candidate);
		outcome[result === "imported" ? "imported" : "skipped"].push(candidate);
	}
	return outcome;
}
