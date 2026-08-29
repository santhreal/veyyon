/** Managed guidance headers for veyyon's own AGENTS.md files. veyyon loads three instruction layers, and only three: the compiled system */
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Subpath import, not the `@veyyon/utils` barrel: this module is in cli.ts's static import graph (via discovery/builtin.ts), and the barrel eagerly parses
import { getAgentDir, getGlobalConfigRootDir } from "@veyyon/utils/dirs";
// Subpath imports (not the barrel) for the same dotenv reason noted above:
// fs-error and logger pull no env.ts, so they are safe in cli.ts's eager graph.
import { isEexist } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";

/** Opening sentinel of a veyyon-managed guidance block. */
const GUIDANCE_OPEN = "<!-- veyyon:guidance";
/** Closing sentinel of a veyyon-managed guidance block. */
const GUIDANCE_CLOSE = "veyyon:end -->";

/** Header seeded into a freshly created global `~/.veyyon/AGENTS.md`. An HTML comment (not `//`, which is not valid Markdown and would render as */
export const GLOBAL_AGENTS_GUIDANCE = `${GUIDANCE_OPEN}
# GLOBAL CROSS-PROFILE AGENTS.md

Instructions written here apply to EVERY profile across all workspaces.

DO NOT DUPLICATE INSTRUCTIONS BETWEEN THIS GLOBAL FILE AND PER-PROFILE FILES.

Instruction Layers (Only 2 user-level layers exist):
1. Global (\`~/.veyyon/AGENTS.md\`): Rules that hold across ALL profiles.
2. Active Profile (\`~/.veyyon/profiles/<profile_name>/\`): Profile-specific rules.
   Scanned in descending priority order (first match wins, zero per-profile duplication):
   - ~/.veyyon/profiles/<profile_name>/agent/AGENTS.md (Highest)
   - ~/.veyyon/profiles/<profile_name>/AGENTS.md
   - ~/.veyyon/profiles/<profile_name>/agent/agent.md
   - ~/.veyyon/profiles/<profile_name>/agent.md (Lowest)

(Veyyon strips this guidance header automatically before sending to the model.)
${GUIDANCE_CLOSE}
`;

/**
 * Header seeded into a freshly created per-profile `AGENTS.md`.
 */
export const PROFILE_AGENTS_GUIDANCE = `${GUIDANCE_OPEN}
# PROFILE-SPECIFIC AGENTS.md

Instructions written here apply ONLY to this active profile.

DO NOT DUPLICATE INSTRUCTIONS BETWEEN THIS PROFILE FILE AND THE GLOBAL FILE (~/.veyyon/AGENTS.md).

Priority Ladder (First match wins; only 1 file is loaded per profile):
1. ~/.veyyon/profiles/<profile_name>/agent/AGENTS.md (Highest)
2. ~/.veyyon/profiles/<profile_name>/AGENTS.md
3. ~/.veyyon/profiles/<profile_name>/agent/agent.md
4. ~/.veyyon/profiles/<profile_name>/agent.md (Lowest)

(Veyyon strips this guidance header automatically before sending to the model.)
${GUIDANCE_CLOSE}
`;

/** Remove veyyon-managed guidance blocks from AGENTS.md content so they never reach the model. */
export function stripManagedGuidance(content: string): string {
	let result = content;
	for (;;) {
		const open = result.indexOf(GUIDANCE_OPEN);
		if (open === -1) break;
		const close = result.indexOf(GUIDANCE_CLOSE, open + GUIDANCE_OPEN.length);
		if (close === -1) break;
		// Consume the block's own trailing newline so removing a header mid-file
		// does not leave a stray blank line between the surrounding instructions.
		let end = close + GUIDANCE_CLOSE.length;
		if (result[end] === "\r") end++;
		if (result[end] === "\n") end++;
		result = result.slice(0, open) + result.slice(end);
	}
	// Drop the blank line the leading header left behind, but keep interior text.
	return result.replace(/^\s+/, "");
}

/** Absolute path of the global cross-profile AGENTS.md (`~/.veyyon/AGENTS.md`). */
export function getGlobalAgentsPath(): string {
	return path.join(getGlobalConfigRootDir(), "AGENTS.md");
}

/** Candidate paths for a profile's instruction file (AGENTS.md / agent.md), in priority order. Defaults to the active profile so existing callers are */
export function getProfileAgentsCandidates(agentDir: string = getAgentDir()): string[] {
	const profileDir = path.dirname(agentDir);
	return [
		path.join(agentDir, "AGENTS.md"),
		path.join(profileDir, "AGENTS.md"),
		path.join(agentDir, "agent.md"),
		path.join(profileDir, "agent.md"),
	];
}

/** Create `filePath` with `header` as its only content if it does not already exist. Idempotent and race-safe: the write uses the `wx` flag (fail if */
async function ensureManagedAgentsFile(filePath: string, header: string): Promise<void> {
	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		// `wx` = O_CREAT | O_EXCL: create-or-fail, never truncate an existing file,
		// so first run seeds the header and every later boot is a no-op.
		await fs.writeFile(filePath, header, { flag: "wx", mode: 0o644 });
	} catch (err) {
		// EEXIST (the file already exists) is the expected steady state after the first run — swallow it silently. Any OTHER error (read-only home,
		if (!isEexist(err)) {
			logger.warn("agents-guidance: could not seed managed AGENTS.md; profile will have no seeded instructions", {
				filePath,
				error: String(err),
			});
		}
	}
}

/** Seed the global `~/.veyyon/AGENTS.md` with its guidance header on first run. Safe to call on every boot; a no-op once the file exists. */
async function ensureGlobalAgentsFile(): Promise<void> {
	await ensureManagedAgentsFile(getGlobalAgentsPath(), GLOBAL_AGENTS_GUIDANCE);
}

/** Seed `<agentDir>/AGENTS.md` with the per-profile guidance header if absent. Called when a profile is created (against the new profile's agent dir) so a */
export async function ensureProfileAgentsFileAt(agentDir: string): Promise<void> {
	await ensureManagedAgentsFile(path.join(agentDir, "AGENTS.md"), PROFILE_AGENTS_GUIDANCE);
}

/** True if anything (a file, or even a broken symlink) already sits at `p`. */
async function pathPresent(p: string): Promise<boolean> {
	try {
		// lstat, not stat: a symlink at this path counts as present even when its
		// target is missing, matching the `wx` seed (which fails EEXIST on any
		// existing link). So a user's symlinked AGENTS.md is never seeded over.
		await fs.lstat(p);
		return true;
	} catch {
		return false;
	}
}

/** Seed a profile's `AGENTS.md` on startup when that profile carries no instruction file at all. Defaults to the active profile. */
export async function ensureProfileAgentsFile(agentDir: string = getAgentDir()): Promise<void> {
	for (const candidate of getProfileAgentsCandidates(agentDir)) {
		if (await pathPresent(candidate)) return;
	}
	await ensureProfileAgentsFileAt(agentDir);
}

/** Seed both managed instruction files veyyon owns at startup: the global cross-profile `~/.veyyon/AGENTS.md` and the loading profile's `AGENTS.md`. One */
export async function ensureManagedAgentsFilesOnStartup(agentDir?: string): Promise<void> {
	await ensureGlobalAgentsFile();
	await ensureProfileAgentsFile(agentDir);
}
