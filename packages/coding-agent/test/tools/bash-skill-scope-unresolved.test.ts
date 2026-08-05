/**
 * Contract: "this session never resolved its skills" and "this session has no skills" are
 * different states, and the first one is reported.
 *
 * `tools/bash.ts` used to build the internal-URL options with
 * `skills: this.session.skills ?? []`. An empty array is not a neutral default here: the
 * `skill://` handler resolves against `context?.skills ?? getActiveSkills()`, so `[]`
 * SUPPRESSES the process-wide snapshot and reports `Unknown skill: X / Available: none`,
 * which `expandInternalUrls` swallows, leaving the URL in the command as a literal path.
 * An unresolved parent therefore produced a missing-file error naming a `skill://` string,
 * with nothing anywhere saying the skill list had never been resolved.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetActiveSkillsForTests, setActiveSkills } from "@veyyon/coding-agent/extensibility/active-skills";
import type { Skill } from "@veyyon/coding-agent/extensibility/skills";
import { BashTool, SKILL_SCOPE_UNRESOLVED_NOTICE } from "@veyyon/coding-agent/tools/bash";
import { removeWithRetries } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

// `executeBash` initializes the GLOBAL Settings singleton itself, so a session stub alone
// leaves it loading the developer's real ~/.veyyon agent.db.
useIsolatedGlobalSettings();

function bashSession(cwd: string, skills: Skill[] | undefined) {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills,
		getSessionFile: () => null,
		getSessionId: () => "bash-skill-scope",
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	});
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("");
}

describe("bash skill:// scope resolution", () => {
	let tmpDir: string;
	let skillDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-skill-scope-"));
		skillDir = path.join(tmpDir, "active-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), "# active\n");
		resetActiveSkillsForTests();
	});

	afterEach(async () => {
		resetActiveSkillsForTests();
		await removeWithRetries(tmpDir);
	});

	/**
	 * LOCKS OUT: `skills: this.session.skills ?? []` at `tools/bash.ts`.
	 *
	 * Driven THROUGH the tool, not through `expandInternalUrls` directly: the `??` lived in
	 * bash's construction of the expansion options, so a test that calls the boundary with
	 * `undefined` by hand proves the boundary works and says nothing about the caller. Only the
	 * tool-level run fails when the `??` comes back.
	 *
	 * IF THIS REGRESSES: an unresolved session claims to have zero skills, the process-wide
	 * snapshot is ignored, `skill://` stays in the command as a literal path, and bash reports a
	 * missing file for a skill that exists.
	 */
	it("expands skill:// against the active set when the session never resolved its skills", async () => {
		setActiveSkills([
			{
				name: "active-skill",
				description: "d",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);

		const unresolved = new BashTool(bashSession(tmpDir, undefined) as never);
		const expanded = await unresolved.execute("b-expand", {
			command: "echo skill://active-skill/SKILL.md",
			timeout: 30,
		});
		expect(textOf(expanded)).toContain(path.join(skillDir, "SKILL.md"));

		// The other half of the distinction: `[]` is a session ASSERTING it has no skills, so the
		// URL must not resolve against the process-wide set. That is why `?? []` was a lie.
		const genuinelyEmpty = new BashTool(bashSession(tmpDir, []) as never);
		const literal = await genuinelyEmpty.execute("b-literal", {
			command: "echo skill://active-skill/SKILL.md",
			timeout: 30,
		});
		expect(textOf(literal)).toContain("skill://active-skill/SKILL.md");
		expect(textOf(literal)).not.toContain(skillDir);
	});

	/**
	 * LOCKS OUT: the silence. Even with the fallback in place, a session that never resolved
	 * its own skills resolved `skill://` against another scope, and nothing said so.
	 *
	 * IF THIS REGRESSES: the model debugs a phantom path (`skill://x/y: No such file or
	 * directory`) instead of being told the session's skill list was never resolved.
	 */
	it("names the unresolved scope in the notices when a command uses skill://", async () => {
		const tool = new BashTool(bashSession(tmpDir, undefined) as never);
		const result = await tool.execute("b-unresolved", {
			command: "echo skill://active-skill/SKILL.md",
			timeout: 30,
		});

		expect(textOf(result)).toContain(SKILL_SCOPE_UNRESOLVED_NOTICE);
	});

	/**
	 * LOCKS OUT: turning a legitimate state into noise or a crash. A session with genuinely zero
	 * skills, and any session not using the protocol at all, must run silently.
	 */
	it("stays silent for a genuinely empty skill list and for commands without skill://", async () => {
		const empty = new BashTool(bashSession(tmpDir, []) as never);
		const emptyResult = await empty.execute("b-empty", {
			command: "echo skill://active-skill/SKILL.md",
			timeout: 30,
		});
		expect(textOf(emptyResult)).not.toContain(SKILL_SCOPE_UNRESOLVED_NOTICE);

		const unresolved = new BashTool(bashSession(tmpDir, undefined) as never);
		const plainResult = await unresolved.execute("b-plain", { command: "printf 'plain\\n'", timeout: 30 });
		expect(textOf(plainResult)).toContain("plain");
		expect(textOf(plainResult)).not.toContain(SKILL_SCOPE_UNRESOLVED_NOTICE);
	});
});
