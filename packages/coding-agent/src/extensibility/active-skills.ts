/**
 * Which skills the running session has active. One slot, and it imports nothing but the type.
 *
 * WHY THE SLOT IS NOT IN `skills.ts`. It was, and that module DISCOVERS and loads skills: the frontmatter
 * parser, the filesystem walk, the bundled skill definitions, 365 modules. Reading the slot therefore
 * meant importing all of that, and `internal-urls/skill-protocol.ts` reads the slot and nothing else. The
 * router constructs that handler, `tools/read.ts` consults the router (a `read` of `skill://…` is a real
 * feature), and 54 test files import `read`, so a local file read pulled in the skill loader.
 *
 * `skills.ts` re-exports all three names, so no existing caller changed.
 *
 * AN EMPTY SNAPSHOT IS NOT A FAILURE and is not silent about anything: it is the state of a process with
 * no skills configured, and the `skill://` handler already answers "no skill named X" with the list of
 * active skills, which is empty. The slot is filled once per top-level session by the code that loaded
 * the skills, never as a side effect of importing a module.
 */

import type { Skill } from "./skills";

let activeSkills: readonly Skill[] = [];

/**
 * Process-global snapshot of skills the active session loaded.
 * Read by internal URL protocol handlers (skill://).
 */
export function getActiveSkills(): readonly Skill[] {
	return activeSkills;
}

/** Replace the active skill snapshot. Called once per top-level session. */
export function setActiveSkills(value: readonly Skill[]): void {
	activeSkills = value;
}

/** Reset the active skill snapshot. Test-only. */
export function resetActiveSkillsForTests(): void {
	activeSkills = [];
}
