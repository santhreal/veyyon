/** Which skills the running session has active. One slot, and it imports nothing but the type. parser, the filesystem walk, the bundled skill definitions, 365 modules. Reading the slot therefore */

import type { Skill } from "./skills";

let activeSkills: readonly Skill[] = [];

/** Process-global snapshot of skills the active session loaded. Read by internal URL protocol handlers (skill://). */
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
