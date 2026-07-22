import { describe, expect, it } from "bun:test";
import { getSessionSlashCommands } from "@veyyon/coding-agent/extensibility/extensions/get-commands-handler";

/**
 * getSessionSlashCommands is the single union over the three dynamic slash-command
 * sources (extension-registered, prompt/custom commands, and skills), shared by the
 * five wiring sites so they cannot drift. Its behavior was untested. This suite locks:
 * the source order (extension, then prompt, then skill), the CustomCommandSource ->
 * location mapping (user/project map through, bundled yields no location field), the
 * skill name shape (`skill:<name>`), that an empty skill description is dropped rather
 * than emitted as "", that skill commands appear only when skillsSettings
 * .enableSkillCommands is on, and that a missing extensionRunner contributes nothing.
 * Built-in commands are intentionally excluded (each frontend prepends its own).
 */

type Session = Parameters<typeof getSessionSlashCommands>[0];

const fullSession = (): Session =>
	({
		extensionRunner: {
			getRegisteredCommands: () => [{ name: "ext-cmd", description: "an extension cmd" }],
		},
		customCommands: [
			{ command: { name: "userc", description: "user cmd" }, source: "user", resolvedPath: "/u/userc.md" },
			{ command: { name: "projc", description: "proj cmd" }, source: "project", resolvedPath: "/p/projc.md" },
			{ command: { name: "bundc", description: "bundled cmd" }, source: "bundled", resolvedPath: "/b/bundc.md" },
		],
		skills: [
			{ name: "myskill", description: "skill desc", filePath: "/s/SKILL.md" },
			{ name: "noskilldesc", description: "", filePath: "/s2/SKILL.md" },
		],
		skillsSettings: { enableSkillCommands: true },
	}) as unknown as Session;

describe("getSessionSlashCommands", () => {
	it("unions all three sources in order with correct locations and skill names", () => {
		expect(getSessionSlashCommands(fullSession())).toEqual([
			{ name: "ext-cmd", description: "an extension cmd", source: "extension" },
			{ name: "userc", description: "user cmd", source: "prompt", location: "user", path: "/u/userc.md" },
			{ name: "projc", description: "proj cmd", source: "prompt", location: "project", path: "/p/projc.md" },
			// bundled: no `location` key at all
			{ name: "bundc", description: "bundled cmd", source: "prompt", path: "/b/bundc.md" },
			{ name: "skill:myskill", description: "skill desc", source: "skill", path: "/s/SKILL.md" },
			// empty description dropped, not emitted as ""
			{ name: "skill:noskilldesc", source: "skill", path: "/s2/SKILL.md" },
		]);
	});

	it("omits skill commands when enableSkillCommands is off", () => {
		const session = { ...fullSession(), skillsSettings: { enableSkillCommands: false } } as unknown as Session;
		expect(getSessionSlashCommands(session).some(c => c.source === "skill")).toBe(false);
	});

	it("omits skill commands when skillsSettings is absent", () => {
		const session = { ...fullSession(), skillsSettings: undefined } as unknown as Session;
		expect(getSessionSlashCommands(session).some(c => c.source === "skill")).toBe(false);
	});

	it("contributes no extension commands when there is no extensionRunner", () => {
		const session = { ...fullSession(), extensionRunner: undefined } as unknown as Session;
		expect(getSessionSlashCommands(session).some(c => c.source === "extension")).toBe(false);
	});

	it("passes the builtin reserved names to the extension runner so it can skip them", () => {
		let received: unknown;
		const session = {
			...fullSession(),
			extensionRunner: {
				getRegisteredCommands: (reserved: unknown) => {
					received = reserved;
					return [];
				},
			},
		} as unknown as Session;
		getSessionSlashCommands(session);
		// The reserved-name collection is non-empty and contains a known builtin.
		expect(received instanceof Set || Array.isArray(received)).toBe(true);
		const names = received instanceof Set ? [...received] : (received as string[]);
		expect(names).toContain("help");
	});
});
