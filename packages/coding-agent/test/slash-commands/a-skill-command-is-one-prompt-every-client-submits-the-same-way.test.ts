/**
 * WHY: `/skill:<name>` is dispatched by three clients — the gui host's
 * `RunCommand`, the ACP agent and rpc mode — and each carried its own copy of
 * the six lines that build the prompt and submit it. A copy that drifted on the
 * message type, the attribution or the display flag produced a skill run that
 * the session recorded as something else on one client and not the others.
 * `slash-commands/skill-dispatch.ts` is the one implementation all three call.
 *
 * THE CLASS THIS CLOSES: a skill invocation submitted as the wrong message, and
 * a text that is not a skill invocation submitted at all. Every branch that
 * returns `false` is driven here, and each asserts that nothing was submitted,
 * because a branch that returns `false` AFTER submitting would leave the caller
 * running the text a second time as a prompt. The success branch is asserted on
 * the whole payload rather than one field, so a copy that drops `display` or
 * attributes the message to the agent fails.
 *
 * WHAT IT DOES NOT CATCH: which clients call this. `runSkillCommand` takes the
 * structural `SkillCommandSession` its three callers satisfy, so this drives
 * that declared seam rather than booting a host; that a given client reaches it
 * at all is its own suite's assertion. Skill discovery is `skills.test.ts`, and
 * the parse of the invocation itself is `parseSkillInvocation`'s own cells
 * there.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@veyyon/coding-agent/session/messages";
import { runSkillCommand, type SkillCommandSession } from "@veyyon/coding-agent/slash-commands/skill-dispatch";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeSkillDir = useTrackedTempDirs("veyyon-skill-dispatch-");

interface Submission {
	message: { customType: string; content: unknown; display: boolean; attribution: string; details: unknown };
	options: { streamingBehavior?: string } | undefined;
}

/** A session holding one skill on disk, recording what was submitted to it. */
function sessionWith(options: { enabled: boolean; skills: readonly Skill[] }): {
	session: SkillCommandSession;
	submitted: Submission[];
} {
	const submitted: Submission[] = [];
	const session = {
		skills: [...options.skills],
		skillsSettings: options.enabled ? { enableSkillCommands: true } : { enableSkillCommands: false },
		promptCustomMessage: async (message: Submission["message"], opts: Submission["options"]) => {
			submitted.push({ message, options: opts });
		},
	} as unknown as SkillCommandSession;
	return { session, submitted };
}

/** A skill whose body is the text the built prompt must carry. */
function skillOnDisk(name: string, body: string): Skill {
	const baseDir = makeSkillDir();
	const filePath = path.join(baseDir, "SKILL.md");
	fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: a skill\n---\n${body}\n`);
	return { name, description: "a skill", filePath, baseDir, source: "native" };
}

describe("a skill command is one prompt every client submits the same way", () => {
	test("a known skill is submitted as a user-attributed skill prompt carrying the body", async () => {
		const skill = skillOnDisk("reviewer", "Review the diff for defects.");
		const { session, submitted } = sessionWith({ enabled: true, skills: [skill] });

		expect(await runSkillCommand(session, "/skill:reviewer focus on auth")).toBe(true);

		expect(submitted).toHaveLength(1);
		const only = submitted[0];
		// The whole payload, because a client copy that drifted on one field is
		// the defect this replaces: a hidden entry, an agent-attributed one, or
		// one the transcript renders as ordinary prose.
		expect(only?.message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(only?.message.display).toBe(true);
		expect(only?.message.attribution).toBe("user");
		expect(only?.message.details).toMatchObject({ name: "reviewer", path: skill.filePath, args: "focus on auth" });
		expect(String(only?.message.content)).toContain("Review the diff for defects.");
	});

	test("the streaming behaviour the caller chose is the one the submission carries", async () => {
		const skill = skillOnDisk("reviewer", "Review the diff.");

		const steering = sessionWith({ enabled: true, skills: [skill] });
		expect(await runSkillCommand(steering.session, "/skill:reviewer")).toBe(true);
		// The default, so a caller that passes nothing steers the running turn
		// rather than silently queueing behind it.
		expect(steering.submitted[0]?.options).toEqual({ streamingBehavior: "steer" });

		const queued = sessionWith({ enabled: true, skills: [skill] });
		expect(await runSkillCommand(queued.session, "/skill:reviewer", "followUp")).toBe(true);
		expect(queued.submitted[0]?.options).toEqual({ streamingBehavior: "followUp" });
	});

	test("nothing is submitted for a text this dispatch does not own", async () => {
		const skill = skillOnDisk("reviewer", "Review the diff.");

		// Each case returns false for a different reason, and each must leave the
		// text for the caller to run as a command or a prompt. A branch that
		// submitted and then returned false would run the text twice.
		const off = sessionWith({ enabled: false, skills: [skill] });
		expect(await runSkillCommand(off.session, "/skill:reviewer")).toBe(false);
		expect(off.submitted).toEqual([]);

		const unknown = sessionWith({ enabled: true, skills: [skill] });
		expect(await runSkillCommand(unknown.session, "/skill:nobody")).toBe(false);
		expect(unknown.submitted).toEqual([]);

		const notASkill = sessionWith({ enabled: true, skills: [skill] });
		expect(await runSkillCommand(notASkill.session, "/compact")).toBe(false);
		expect(await runSkillCommand(notASkill.session, "write the tests")).toBe(false);
		expect(notASkill.submitted).toEqual([]);
	});

	test("a session that declares no skill settings runs no skill", async () => {
		const skill = skillOnDisk("reviewer", "Review the diff.");
		const submitted: Submission[] = [];
		// The settings are optional on the session, so the absent case is a real
		// caller shape rather than a constructed one: it must read as off.
		const session = {
			skills: [skill],
			promptCustomMessage: async (message: Submission["message"], opts: Submission["options"]) => {
				submitted.push({ message, options: opts });
			},
		} as unknown as SkillCommandSession;

		expect(await runSkillCommand(session, "/skill:reviewer")).toBe(false);
		expect(submitted).toEqual([]);
	});
});
