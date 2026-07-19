/**
 * `/profile` and `/profiles` command logic, kept out of the registry so the
 * verb parser and the effects are unit-testable without a live TUI.
 *
 * There is one home for profile lifecycle: {@link ../cli/profile-cli}. This
 * module never re-implements create/switch/rename/remove; it parses operator
 * input, drives the interactive picker, and delegates every effect to that API.
 */

import { getActiveProfile, listProfiles } from "@veyyon/utils";
import {
	createProfile,
	PROFILE_COPY_ITEMS,
	readProfileDisplayName,
	removeProfile,
	resolveProfileByName,
	writeProfileDisplayName,
} from "../cli/profile-cli";
import type {
	ExtensionAskDialogOption,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
} from "../extensibility/extensions";

/** Label of the picker row that starts a fresh profile. */
export const CREATE_NEW_LABEL = "＋ Create new profile";

/**
 * A parsed `/profile` invocation. `parseProfileCommand` maps raw argument text
 * to exactly one of these; the dispatcher then runs the matching effect.
 */
export type ProfileIntent =
	| { kind: "picker" }
	| { kind: "list" }
	| { kind: "create"; name: string }
	| { kind: "switch"; name: string }
	| { kind: "rename"; target: string | undefined; newName: string }
	| { kind: "remove"; name: string }
	| { kind: "usage"; message: string };

/**
 * The narrow TUI surface the dispatcher needs. The registry builds this from
 * `InteractiveModeContext`; tests supply a fake that records the calls.
 */
export interface ProfileCommandPort {
	showStatus(message: string): void;
	showError(message: string): void;
	/** Prefill the composer so the operator finishes a free-text argument (name). */
	setEditorText(text: string): void;
	askDialog(questions: ExtensionAskDialogQuestion[]): Promise<ExtensionAskDialogResult | undefined>;
	/** Relaunch the process under a new profile. `env` carries `VEYYON_PROFILE`. */
	requestRelaunch(env: Record<string, string | undefined>): void;
	requestShutdown(): void;
}

/**
 * Parse raw `/profile` argument text into a single {@link ProfileIntent}.
 *
 * Recognized forms (case-insensitive verbs):
 * - `` (empty) -> interactive picker
 * - `list` / `ls` -> text list
 * - `new <name>` / `create <name>` -> create
 * - `switch <name>` -> switch
 * - `rm <name>` / `remove <name>` / `delete <name>` -> remove
 * - `rename <old> to <new>` / `<old> rename to <new>` / `rename to <new>` -> rename
 * - anything else -> switch to a profile named by the whole argument
 */
export function parseProfileCommand(rawArgs: string): ProfileIntent {
	const args = rawArgs.trim();
	if (!args) return { kind: "picker" };

	const lower = args.toLowerCase();
	if (lower === "list" || lower === "ls") return { kind: "list" };

	// Rename, three spellings. Try the explicit `rename <old> to <new>` first so
	// the old-profile token is captured, then the `[<old>] rename to <new>` form
	// (bare `rename to <new>` renames the active profile).
	let match = args.match(/^rename\s+(\S+)\s+to\s+(.+)$/i);
	if (match) return { kind: "rename", target: match[1], newName: match[2]!.trim() };
	match = args.match(/^(?:(\S+)\s+)?rename\s+to\s+(.+)$/i);
	if (match) return { kind: "rename", target: match[1], newName: match[2]!.trim() };
	if (/^rename\b/i.test(args)) {
		return { kind: "usage", message: "Usage: /profile rename <name> to <new name>" };
	}

	match = args.match(/^(?:new|create)\s+(\S+)$/i);
	if (match) return { kind: "create", name: match[1]! };
	if (/^(?:new|create)\b/i.test(args)) return { kind: "usage", message: "Usage: /profile new <name>" };

	match = args.match(/^switch\s+(\S+)$/i);
	if (match) return { kind: "switch", name: match[1]! };
	if (/^switch\b/i.test(args)) return { kind: "usage", message: "Usage: /profile switch <name>" };

	match = args.match(/^(?:rm|remove|delete)\s+(\S+)$/i);
	if (match) return { kind: "remove", name: match[1]! };
	if (/^(?:rm|remove|delete)\b/i.test(args)) return { kind: "usage", message: "Usage: /profile rm <name>" };

	return { kind: "switch", name: args };
}

/** Human label for a profile directory name (`default` stays literal). */
function profileLabel(name: string, display: string): string {
	return display && display !== name ? `${name} (${display})` : name;
}

/** Render the plain-text profile list for `/profile list`. */
export async function formatProfileList(): Promise<string> {
	const active = getActiveProfile() ?? "default";
	const lines: string[] = [];
	for (const profile of listProfiles()) {
		const display = await readProfileDisplayName(profile.name === "default" ? undefined : profile.name);
		const marker = profile.name === active ? "*" : " ";
		lines.push(`${marker} ${profileLabel(profile.name, display)}`);
	}
	lines.push(
		"",
		"Switch: /profile <name> · Rename: /profile <name> rename to <new> · New: /profile new <name> · Delete: /profile rm <name>",
	);
	return lines.join("\n");
}

/** Dispatch a parsed intent against the port. */
export async function runProfileCommand(intent: ProfileIntent, port: ProfileCommandPort): Promise<void> {
	switch (intent.kind) {
		case "usage":
			port.showError(intent.message);
			return;
		case "list":
			port.showStatus(await formatProfileList());
			return;
		case "picker":
			await runPicker(port);
			return;
		case "create":
			await runCreate(intent.name, port);
			return;
		case "switch":
			await runSwitch(intent.name, port);
			return;
		case "rename":
			await runRename(intent.target, intent.newName, port);
			return;
		case "remove":
			await runRemove(intent.name, port);
			return;
		default: {
			const exhaustive: never = intent;
			throw new Error(`Unknown profile intent: ${String(exhaustive)}`);
		}
	}
}

async function runSwitch(name: string, port: ProfileCommandPort): Promise<void> {
	const resolved = await resolveProfileByName(name);
	if (resolved === null) {
		port.showError(`No profile named "${name}". Try /profiles or /profile new ${name}`);
		return;
	}
	if (resolved === getActiveProfile()) {
		port.showStatus(`Already on profile "${resolved ?? "default"}"`);
		return;
	}
	port.requestRelaunch({ VEYYON_PROFILE: resolved });
	port.showStatus(`Switching to profile "${resolved ?? "default"}", starting a fresh session…`);
	port.requestShutdown();
}

/**
 * Warn when a new display name will not behave as a switch target. Directory
 * names are the unique key; display names are not, so a rename can silently
 * mint a name the operator can never switch to. Surface both cases at rename
 * time instead of leaving them to be discovered at the next `/profile <name>`.
 * Returns undefined when the name is cleanly reachable.
 */
async function renameCaveat(resolved: string | undefined, trimmed: string): Promise<string | undefined> {
	const ownDir = resolved ?? "default";
	const profiles = listProfiles();
	// (1) Shadowed by a directory name: resolveProfileByName resolves directory
	// names first, so a display name equal to ANOTHER profile's directory name is
	// unreachable — the directory always wins.
	if (profiles.some(profile => profile.name !== ownDir && profile.name === trimmed)) {
		return `Heads up: "${trimmed}" is also another profile's directory name, so /profile ${trimmed} switches to that profile, not this one. Rename to a distinct name to switch by it.`;
	}
	// (2) Duplicate display name: two profiles sharing a display name make
	// switch-by-display-name ambiguous, which fails loudly only later at switch.
	for (const profile of profiles) {
		if (profile.name === ownDir) continue;
		const dirName = profile.name === "default" ? undefined : profile.name;
		const display = await readProfileDisplayName(dirName);
		if (display && display.localeCompare(trimmed, undefined, { sensitivity: "accent" }) === 0) {
			return `Heads up: another profile already shows as "${trimmed}", so /profile ${trimmed} is ambiguous. Switch by directory name, or pick a unique display name.`;
		}
	}
	return undefined;
}

async function runRename(target: string | undefined, newName: string, port: ProfileCommandPort): Promise<void> {
	const trimmed = newName.trim();
	if (!trimmed) {
		port.showError("Usage: /profile rename <name> to <new name>");
		return;
	}
	const resolved = target === undefined ? getActiveProfile() : await resolveProfileByName(target);
	if (resolved === null) {
		port.showError(`No profile named "${target}". Try /profiles`);
		return;
	}
	// Check reachability against the pre-rename world (skips the target itself).
	const caveat = await renameCaveat(resolved, trimmed);
	await writeProfileDisplayName(resolved, trimmed);
	const base = `Renamed profile "${resolved ?? "default"}" to "${trimmed}"`;
	port.showStatus(caveat ? `${base}\n${caveat}` : base);
}

async function runRemove(name: string, port: ProfileCommandPort): Promise<void> {
	const resolved = await resolveProfileByName(name);
	if (resolved === undefined) {
		port.showError("Cannot remove the default profile");
		return;
	}
	if (resolved === null) {
		port.showError(`No profile named "${name}". Try /profiles`);
		return;
	}
	if (resolved === getActiveProfile()) {
		port.showError(`Cannot remove the active profile "${resolved}". Switch to another profile first.`);
		return;
	}
	const deleteLabel = `Delete "${resolved}"`;
	const confirm = await port.askDialog([
		{
			id: "confirm-delete",
			header: "Delete profile",
			question: `Delete profile "${resolved}"? This removes it from disk and cannot be undone.`,
			options: [{ label: deleteLabel }, { label: "Cancel" }],
			multi: false,
		},
	]);
	if (confirm?.kind !== "submit" || confirm.results[0]?.selectedOptions[0] !== deleteLabel) {
		port.showStatus("Deletion cancelled");
		return;
	}
	await removeProfile(resolved, { yes: true });
	port.showStatus(`Deleted profile "${resolved}"`);
}

async function runCreate(name: string, port: ProfileCommandPort): Promise<void> {
	const active = getActiveProfile();
	const activeName = active ?? "default";
	const labels = PROFILE_COPY_ITEMS.map(item => item.label);
	const result = await port.askDialog([
		{
			id: "copy-items",
			header: "New profile",
			question: `Copy which items from "${activeName}" into "${name}"? Everything is selected; deselect what should stay behind.`,
			options: PROFILE_COPY_ITEMS.map(item => ({ label: item.label, description: item.description })),
			multi: true,
			preselected: labels,
		},
	]);
	if (result?.kind !== "submit") {
		port.showStatus("Profile creation cancelled");
		return;
	}
	const chosen = new Set(result.results[0]?.selectedOptions ?? []);
	const keys = new Set(PROFILE_COPY_ITEMS.filter(item => chosen.has(item.label)).map(item => item.key));
	const created = await createProfile(name, keys.size > 0 ? (active ?? "default") : "blank", keys);
	port.showStatus(
		`Created profile "${created.name}" (${keys.size}/${PROFILE_COPY_ITEMS.length} items copied from "${activeName}"). Switch with /profile ${created.name}`,
	);
}

/**
 * The interactive picker: list every profile plus a create row, then act on the
 * chosen one. Free-text names (create, rename) are finished in the composer via
 * `setEditorText`, so name entry always flows through the same typed-command
 * path rather than a second bespoke input surface.
 */
async function runPicker(port: ProfileCommandPort): Promise<void> {
	const active = getActiveProfile();
	const activeName = active ?? "default";
	const options: ExtensionAskDialogOption[] = [];
	const labelToName = new Map<string, string>();
	for (const profile of listProfiles()) {
		const display = await readProfileDisplayName(profile.name === "default" ? undefined : profile.name);
		const label = profileLabel(profile.name, display);
		options.push({ label, description: profile.name === activeName ? "active" : profile.rootDir });
		labelToName.set(label, profile.name);
	}
	options.push({ label: CREATE_NEW_LABEL, description: "Start a fresh profile" });

	const result = await port.askDialog([
		{
			id: "profile",
			header: "Profiles",
			question: "Select a profile to manage, or create a new one.",
			options,
			multi: false,
		},
	]);
	if (result?.kind !== "submit") return;
	const item = result.results[0];
	const custom = item?.customInput?.trim();
	if (custom) {
		// Typed a name via the dialog's free-text row: switch if it exists, else create.
		const resolved = await resolveProfileByName(custom);
		if (resolved === null) await runCreate(custom, port);
		else await runSwitch(custom, port);
		return;
	}
	const selected = item?.selectedOptions[0];
	if (!selected) return;
	if (selected === CREATE_NEW_LABEL) {
		port.setEditorText("/profile new ");
		port.showStatus("Type a name for the new profile and press Enter");
		return;
	}
	const dirName = labelToName.get(selected);
	if (dirName === undefined) return;
	await runProfileActionMenu(dirName, active, port);
}

/** Second picker step: switch / rename / delete the chosen profile. */
async function runProfileActionMenu(
	dirName: string,
	active: string | undefined,
	port: ProfileCommandPort,
): Promise<void> {
	const isActive = dirName === (active ?? "default");
	const isDefault = dirName === "default";
	const switchLabel = `Switch to "${dirName}"`;
	const renameLabel = `Rename "${dirName}"`;
	const deleteLabel = `Delete "${dirName}"`;
	const options: ExtensionAskDialogOption[] = [];
	if (!isActive) options.push({ label: switchLabel, description: "Relaunch under this profile" });
	options.push({ label: renameLabel, description: "Set a new display name" });
	if (!isActive && !isDefault) options.push({ label: deleteLabel, description: "Remove from disk" });
	options.push({ label: "Cancel" });

	const result = await port.askDialog([
		{ id: "action", header: dirName, question: `Manage profile "${dirName}".`, options, multi: false },
	]);
	if (result?.kind !== "submit") return;
	const choice = result.results[0]?.selectedOptions[0];
	if (!choice || choice === "Cancel") return;
	if (choice === switchLabel) {
		await runSwitch(dirName, port);
		return;
	}
	if (choice === renameLabel) {
		port.setEditorText(`/profile ${dirName} rename to `);
		port.showStatus(`Type the new name for "${dirName}" and press Enter`);
		return;
	}
	if (choice === deleteLabel) {
		await runRemove(dirName, port);
	}
}
