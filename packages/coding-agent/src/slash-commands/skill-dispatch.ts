import { buildSkillPromptMessage, parseSkillInvocation } from "../extensibility/skills";
import type { AgentSession } from "../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";

/**
 * Running a skill invocation, for every client that dispatches a command line.
 *
 * A skill command is not a builtin and not an extension contribution: it is a
 * prompt the skill builds, submitted as a custom message the session records.
 * Each non-TUI client used to carry its own copy of the same six lines, and a
 * fourth client would have been a fourth place for the attribution, the
 * message type or the display flag to drift.
 */
export type SkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;

/**
 * Run `text` as a skill invocation when it names a skill the session has and
 * skill commands are on, and report whether it did.
 *
 * `streamingBehavior` decides how the submission lands while a turn runs;
 * a session that is idle starts the turn either way.
 */
export async function runSkillCommand(
	session: SkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<boolean> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
	return true;
}
