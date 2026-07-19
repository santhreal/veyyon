import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createProfile, readProfileDisplayName } from "@veyyon/coding-agent/cli/profile-cli";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
} from "@veyyon/coding-agent/extensibility/extensions";
import {
	CREATE_NEW_LABEL,
	type ProfileCommandPort,
	parseProfileCommand,
	runProfileCommand,
} from "@veyyon/coding-agent/slash-commands/profile-command";
import { getActiveProfile, profileExists, removeWithRetries, setProfile } from "@veyyon/utils";

describe("parseProfileCommand", () => {
	it("maps empty input to the interactive picker", () => {
		expect(parseProfileCommand("")).toEqual({ kind: "picker" });
		expect(parseProfileCommand("   ")).toEqual({ kind: "picker" });
	});

	it("maps list and ls to the text list", () => {
		expect(parseProfileCommand("list")).toEqual({ kind: "list" });
		expect(parseProfileCommand("ls")).toEqual({ kind: "list" });
		expect(parseProfileCommand("LIST")).toEqual({ kind: "list" });
	});

	it("parses create with both new and create verbs", () => {
		expect(parseProfileCommand("new work")).toEqual({ kind: "create", name: "work" });
		expect(parseProfileCommand("create work")).toEqual({ kind: "create", name: "work" });
		expect(parseProfileCommand("CREATE work")).toEqual({ kind: "create", name: "work" });
	});

	it("reports usage when create has no name", () => {
		expect(parseProfileCommand("new")).toEqual({ kind: "usage", message: "Usage: /profile new <name>" });
		expect(parseProfileCommand("create")).toEqual({ kind: "usage", message: "Usage: /profile new <name>" });
	});

	it("parses an explicit switch verb", () => {
		expect(parseProfileCommand("switch work")).toEqual({ kind: "switch", name: "work" });
		expect(parseProfileCommand("switch")).toEqual({ kind: "usage", message: "Usage: /profile switch <name>" });
	});

	it("parses a bare name as a switch", () => {
		expect(parseProfileCommand("work")).toEqual({ kind: "switch", name: "work" });
		expect(parseProfileCommand("My Display Name")).toEqual({ kind: "switch", name: "My Display Name" });
	});

	it("parses remove with rm, remove, and delete", () => {
		expect(parseProfileCommand("rm work")).toEqual({ kind: "remove", name: "work" });
		expect(parseProfileCommand("remove work")).toEqual({ kind: "remove", name: "work" });
		expect(parseProfileCommand("delete work")).toEqual({ kind: "remove", name: "work" });
		expect(parseProfileCommand("rm")).toEqual({ kind: "usage", message: "Usage: /profile rm <name>" });
	});

	it("parses rename x to y with an explicit target", () => {
		expect(parseProfileCommand("rename old to New Name")).toEqual({
			kind: "rename",
			target: "old",
			newName: "New Name",
		});
	});

	it("parses the <old> rename to <new> form", () => {
		expect(parseProfileCommand("old rename to New")).toEqual({
			kind: "rename",
			target: "old",
			newName: "New",
		});
	});

	it("renames the active profile when no target is given", () => {
		expect(parseProfileCommand("rename to Solo")).toEqual({
			kind: "rename",
			target: undefined,
			newName: "Solo",
		});
	});

	it("reports usage for a malformed rename", () => {
		expect(parseProfileCommand("rename")).toEqual({
			kind: "usage",
			message: "Usage: /profile rename <name> to <new name>",
		});
	});
});

interface RecordingPort extends ProfileCommandPort {
	statuses: string[];
	errors: string[];
	editorText: string[];
	relaunched: Array<Record<string, string | undefined>>;
	shutdownCalls: number;
}

function makePort(
	dialogAnswer?: (question: ExtensionAskDialogQuestion) => ExtensionAskDialogResult | undefined,
): RecordingPort {
	const port: RecordingPort = {
		statuses: [],
		errors: [],
		editorText: [],
		relaunched: [],
		shutdownCalls: 0,
		showStatus: message => {
			port.statuses.push(message);
		},
		showError: message => {
			port.errors.push(message);
		},
		setEditorText: text => {
			port.editorText.push(text);
		},
		askDialog: async questions => dialogAnswer?.(questions[0]!),
		requestRelaunch: env => {
			port.relaunched.push(env);
		},
		requestShutdown: () => {
			port.shutdownCalls += 1;
		},
	};
	return port;
}

describe("runProfileCommand effects", () => {
	let tempHome: string;
	let originalActiveProfile: string | undefined;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-profile-cmd-"));
		spyOn(os, "homedir").mockReturnValue(tempHome);
		// The active profile is cached at module load from the machine's global
		// default; force the default profile so a named profile is never active.
		originalActiveProfile = getActiveProfile();
		setProfile(undefined);
	});

	afterEach(async () => {
		setProfile(originalActiveProfile);
		spyOn(os, "homedir").mockRestore();
		await removeWithRetries(tempHome);
	});

	it("switches to an existing profile by relaunching under VEYYON_PROFILE", async () => {
		await createProfile("work", "blank");
		const port = makePort();
		await runProfileCommand(parseProfileCommand("work"), port);
		expect(port.relaunched).toEqual([{ VEYYON_PROFILE: "work" }]);
		expect(port.shutdownCalls).toBe(1);
		expect(port.statuses.some(s => s.includes('Switching to profile "work"'))).toBe(true);
	});

	it("reports an error and does not relaunch for an unknown switch target", async () => {
		const port = makePort();
		await runProfileCommand(parseProfileCommand("ghost"), port);
		expect(port.relaunched).toHaveLength(0);
		expect(port.shutdownCalls).toBe(0);
		expect(port.errors.some(e => e.includes('No profile named "ghost"'))).toBe(true);
	});

	it("renames a profile by writing its display name", async () => {
		await createProfile("work", "blank");
		const port = makePort();
		await runProfileCommand(parseProfileCommand("work rename to Renamed"), port);
		expect(await readProfileDisplayName("work")).toBe("Renamed");
		expect(port.statuses.some(s => s.includes('Renamed profile "work" to "Renamed"'))).toBe(true);
	});

	it("removes a non-active profile after the delete confirmation", async () => {
		await createProfile("scratch", "blank");
		expect(profileExists("scratch")).toBe(true);
		const port = makePort(question => ({
			kind: "submit",
			results: [
				{
					id: question.id,
					question: question.question,
					options: question.options.map(o => o.label),
					multi: false,
					selectedOptions: ['Delete "scratch"'],
				},
			],
		}));
		await runProfileCommand(parseProfileCommand("rm scratch"), port);
		expect(profileExists("scratch")).toBe(false);
		expect(port.statuses.some(s => s.includes('Deleted profile "scratch"'))).toBe(true);
	});

	it("keeps the profile when the delete confirmation is cancelled", async () => {
		await createProfile("scratch", "blank");
		const port = makePort(question => ({
			kind: "submit",
			results: [
				{
					id: question.id,
					question: question.question,
					options: question.options.map(o => o.label),
					multi: false,
					selectedOptions: ["Cancel"],
				},
			],
		}));
		await runProfileCommand(parseProfileCommand("delete scratch"), port);
		expect(profileExists("scratch")).toBe(true);
		expect(port.statuses.some(s => s.includes("Deletion cancelled"))).toBe(true);
	});

	it("refuses to remove the default profile", async () => {
		const port = makePort();
		await runProfileCommand(parseProfileCommand("rm default"), port);
		expect(port.errors.some(e => e.includes("Cannot remove the default profile"))).toBe(true);
	});

	it("creates a profile from the copy-items dialog", async () => {
		const port = makePort(question => ({
			kind: "submit",
			results: [
				{
					id: question.id,
					question: question.question,
					options: question.options.map(o => o.label),
					multi: true,
					// Deselect everything: a blank profile still gets created.
					selectedOptions: [],
				},
			],
		}));
		await runProfileCommand(parseProfileCommand("new fresh"), port);
		expect(profileExists("fresh")).toBe(true);
		expect(port.statuses.some(s => s.includes('Created profile "fresh"'))).toBe(true);
	});

	it("prefills the composer when the picker chooses create-new", async () => {
		const port = makePort(question => {
			// The picker is the first (and only) dialog; pick the create row.
			expect(question.id).toBe("profile");
			return {
				kind: "submit",
				results: [
					{
						id: question.id,
						question: question.question,
						options: question.options.map(o => o.label),
						multi: false,
						selectedOptions: [CREATE_NEW_LABEL],
					},
				],
			};
		});
		await runProfileCommand(parseProfileCommand(""), port);
		expect(port.editorText).toContain("/profile new ");
	});
});
