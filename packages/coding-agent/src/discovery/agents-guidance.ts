/**
 * Managed guidance headers for veyyon's own AGENTS.md files.
 *
 * veyyon loads three instruction layers, and only three: the compiled system
 * prompt, the global `~/.veyyon/AGENTS.md` (rules that hold across every
 * profile), and the active profile's own `AGENTS.md` (rules for that profile).
 * It does NOT ambiently load foreign tool files (CLAUDE.md, GEMINI.md, and the
 * like) unless the operator opts in via `discovery.importForeignConfig`.
 *
 * When veyyon first creates the global file it writes a short note telling the
 * human editing it where profile-specific rules belong, so the two layers do
 * not drift into duplicated guidance. That note is wrapped in sentinel markers
 * so {@link stripManagedGuidance} can remove it before the file reaches the
 * model — it is guidance for the human, not an instruction for the agent. The
 * same mechanism covers the per-profile file's header.
 *
 * This is the ONE home for both the header text and the strip logic; the
 * loader, the scaffolder, and the tests all import from here so the marker can
 * never drift between writer and reader.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Subpath import, not the `@veyyon/utils` barrel: this module is in cli.ts's
// static import graph (via discovery/builtin.ts), and the barrel eagerly parses
// dotenv at import time, which must not happen before setProfile runs (see
// profile-cli.test.ts "loads no agent .env before setProfile"). dirs.ts pulls no
// env.ts, so it is safe to import eagerly.
import { getAgentDir, getGlobalConfigRootDir } from "@veyyon/utils/dirs";
// Subpath imports (not the barrel) for the same dotenv reason noted above:
// fs-error and logger pull no env.ts, so they are safe in cli.ts's eager graph.
import { isEexist } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";

/** Opening sentinel of a veyyon-managed guidance block. */
const GUIDANCE_OPEN = "<!-- veyyon:guidance";
/** Closing sentinel of a veyyon-managed guidance block. */
const GUIDANCE_CLOSE = "veyyon:end -->";

/**
 * Header seeded into a freshly created global `~/.veyyon/AGENTS.md`.
 *
 * An HTML comment (not `//`, which is not valid Markdown and would render as
 * literal text and still reach the model): invisible when the file is rendered,
 * visible to whoever edits the raw file, and stripped before load.
 */
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

/**
 * Remove veyyon-managed guidance blocks from AGENTS.md content so they never
 * reach the model.
 *
 * Only the exact `veyyon:guidance … veyyon:end` sentinel block is removed; a
 * user's own HTML comments are left untouched. Content with no managed block is
 * returned unchanged apart from a leading-whitespace trim left where the header
 * used to sit. Every managed block is stripped, not just the first, so a header
 * copied lower in the file is handled too.
 */
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

/**
 * Candidate paths for a profile's instruction file (AGENTS.md / agent.md), in
 * priority order. Defaults to the active profile so existing callers are
 * unchanged; pass `agentDir` explicitly when a caller must resolve the ladder
 * for a specific agent directory rather than the process-global one.
 */
export function getProfileAgentsCandidates(agentDir: string = getAgentDir()): string[] {
	const profileDir = path.dirname(agentDir);
	return [
		path.join(agentDir, "AGENTS.md"),
		path.join(profileDir, "AGENTS.md"),
		path.join(agentDir, "agent.md"),
		path.join(profileDir, "agent.md"),
	];
}

/**
 * Create `filePath` with `header` as its only content if it does not already
 * exist. Idempotent and race-safe: the write uses the `wx` flag (fail if
 * present), so a concurrent creator never clobbers an existing file and a later
 * boot never re-seeds the header. Any pre-existing file, including one the user
 * has since filled with real instructions, is left exactly as it is.
 */
async function ensureManagedAgentsFile(filePath: string, header: string): Promise<void> {
	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		// `wx` = O_CREAT | O_EXCL: create-or-fail, never truncate an existing file,
		// so first run seeds the header and every later boot is a no-op.
		await fs.writeFile(filePath, header, { flag: "wx", mode: 0o644 });
	} catch (err) {
		// EEXIST (the file already exists) is the expected steady state after the
		// first run — swallow it silently. Any OTHER error (read-only home,
		// permissions, no space) means the profile silently has NO instruction
		// file and the user has no way to know why their AGENTS.md never appeared.
		// Surface it loudly rather than swallow (no silent fallback); seeding is
		// still non-fatal, so we warn and let the boot path continue.
		if (!isEexist(err)) {
			logger.warn("agents-guidance: could not seed managed AGENTS.md; profile will have no seeded instructions", {
				filePath,
				error: String(err),
			});
		}
	}
}

/**
 * Seed the global `~/.veyyon/AGENTS.md` with its guidance header on first run.
 * Safe to call on every boot; a no-op once the file exists.
 */
export async function ensureGlobalAgentsFile(): Promise<void> {
	await ensureManagedAgentsFile(getGlobalAgentsPath(), GLOBAL_AGENTS_GUIDANCE);
}

/**
 * Seed `<agentDir>/AGENTS.md` with the per-profile guidance header if absent.
 * Called when a profile is created (against the new profile's agent dir) so a
 * fresh profile starts with the header that explains the global/profile split.
 * A no-op when the profile already carries an AGENTS.md (e.g. copied from a seed
 * profile), so an existing file is never clobbered.
 */
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

/**
 * Seed a profile's `AGENTS.md` on startup when that profile carries no
 * instruction file at all. Defaults to the active profile.
 *
 * {@link ensureProfileAgentsFileAt} runs only at profile *creation*, so a
 * profile that predates that code (or the implicit `default`) would never get a
 * persistent, update-proof file to edit. That gap is what pushed a user to edit
 * an AGENTS.md *inside* the `~/.veyyon/src` checkout, which every source update
 * reset away. Back-filling on startup gives every profile a real file outside
 * the checkout.
 *
 * `agentDir` names WHICH profile. It used to be hardwired to the process-global
 * active profile, so a prompt built for another agent dir back-filled a file into
 * the booted profile and left the profile it was actually loading unseeded: the
 * one profile guaranteed to have nothing to edit was the one being used.
 *
 * Only seeds when NONE of the four ladder candidates
 * ({@link getProfileAgentsCandidates}) exist. Seeding the top-priority
 * `<agentDir>/AGENTS.md` while the user keeps real instructions in a
 * lower-priority `agent.md` would silently shadow them (the loader reads the
 * first candidate that exists), so an existing lower-priority file suppresses
 * the seed instead.
 */
export async function ensureProfileAgentsFile(agentDir: string = getAgentDir()): Promise<void> {
	for (const candidate of getProfileAgentsCandidates(agentDir)) {
		if (await pathPresent(candidate)) return;
	}
	await ensureProfileAgentsFileAt(agentDir);
}

/**
 * Seed both managed instruction files veyyon owns at startup: the global
 * cross-profile `~/.veyyon/AGENTS.md` and the loading profile's `AGENTS.md`. One
 * call so the boot path (system-prompt.ts) can never drift into seeding one and
 * forgetting the other. Both are no-ops once their files exist.
 */
export async function ensureManagedAgentsFilesOnStartup(agentDir?: string): Promise<void> {
	await ensureGlobalAgentsFile();
	await ensureProfileAgentsFile(agentDir);
}
