/**
 * Which skills the running session has active. One slot, imports nothing but the type. Split from
 * `skills.ts` (365 modules — discovers, parses, loads) so `skill-protocol.ts` and `tools/read.ts` don't
 * pull in the skill loader. `skills.ts` re-exports all three names. Empty snapshot is not a failure.
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
