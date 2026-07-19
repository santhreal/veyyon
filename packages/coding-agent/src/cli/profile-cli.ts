/**
 * Profile lifecycle CLI: list, create, and remove self-contained profiles.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	getActiveProfile,
	getProfileRootDir,
	isRecord,
	listProfiles,
	MAIN_CONFIG_FILENAMES,
	normalizeProfileName,
	type ProfileInfo,
	profileExists,
	removeWithRetries,
	resolveGlobalDefaultProfile,
	writeGlobalDefaultProfile,
} from "@veyyon/utils";
import chalk from "chalk";
import { seedKeybindingsFromAgentDir } from "../config/keybindings";

export type ProfileAction = "list" | "new" | "rm" | "default";

/** Canonical action list; the `profile` command's options validation imports this. */
export const PROFILE_ACTIONS: ProfileAction[] = ["list", "new", "rm", "default"];

export type ProfileSeedSource = "default" | "blank" | string;

export interface ProfileCommandArgs {
	action: ProfileAction;
	name?: string;
	from?: ProfileSeedSource;
	yes?: boolean;
	json?: boolean;
	clear?: boolean;
}

/**
 * One owner for everything a profile can carry over when seeded from another
 * profile. The CLI copies all of it; the TUI `/profile new` picker offers each
 * item individually. IDENTITY_DIRS is derived from this table.
 */
export interface ProfileCopyItem {
	key: string;
	label: string;
	description: string;
	files?: readonly string[];
	dirs?: readonly string[];
	/** Copies keybindings via seedKeybindingsFromAgentDir instead of plain file copy. */
	keybindings?: boolean;
}

export const PROFILE_COPY_ITEMS: readonly ProfileCopyItem[] = [
	{
		key: "agents",
		label: "AGENTS.md",
		description: "Agent instructions (AGENTS.md, SYSTEM.md, RULES.md)",
		files: ["AGENTS.md", "SYSTEM.md", "RULES.md"],
	},
	{ key: "settings", label: "Settings", description: "All /settings values", files: [...MAIN_CONFIG_FILENAMES] },
	{ key: "mcp", label: "MCP servers", description: "mcp.json server config", files: ["mcp.json"] },
	{ key: "ssh", label: "SSH targets", description: "ssh.json remote targets", files: ["ssh.json"] },
	{ key: "skills", label: "Skills", description: "skills/ directory", dirs: ["skills"] },
	{ key: "commands", label: "Commands", description: "commands/ directory", dirs: ["commands"] },
	{ key: "tools", label: "Tools", description: "tools/ directory", dirs: ["tools"] },
	{ key: "prompts", label: "Prompts", description: "prompts/ directory", dirs: ["prompts"] },
	{ key: "themes", label: "Themes", description: "themes/ directory", dirs: ["themes"] },
	{ key: "extensions", label: "Extensions", description: "extensions/ directory", dirs: ["extensions"] },
	{ key: "keybindings", label: "Keybindings", description: "Custom key bindings", keybindings: true },
];

const IDENTITY_DIRS = PROFILE_COPY_ITEMS.flatMap(item => item.dirs ?? []);

async function directorySize(root: string): Promise<number> {
	let total = 0;
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				try {
					total += (await fs.stat(fullPath)).size;
				} catch {}
			}
		}
	};
	await walk(root);
	return total;
}

function resolveSeedAgentDir(from: ProfileSeedSource | undefined): string | undefined {
	const source = from ?? "default";
	if (source === "blank") return undefined;
	if (source === "default") {
		return path.join(getProfileRootDir(undefined), "agent");
	}
	const normalized = normalizeProfileName(source);
	if (!normalized) {
		throw new Error(`Invalid seed profile "${source}"`);
	}
	if (!profileExists(normalized)) {
		throw new Error(`Seed profile "${source}" does not exist`);
	}
	return path.join(getProfileRootDir(normalized), "agent");
}

async function ensureBlankAgentTree(agentDir: string): Promise<void> {
	await fs.mkdir(agentDir, { recursive: true });
	for (const subdir of IDENTITY_DIRS) {
		await fs.mkdir(path.join(agentDir, subdir), { recursive: true });
	}
}

async function copyIdentityFile(sourceAgentDir: string, targetAgentDir: string, filename: string): Promise<void> {
	const sourcePath = path.join(sourceAgentDir, filename);
	try {
		await fs.access(sourcePath);
	} catch {
		return;
	}
	await fs.mkdir(targetAgentDir, { recursive: true });
	await fs.copyFile(sourcePath, path.join(targetAgentDir, filename));
}

async function copyIdentityDir(sourceAgentDir: string, targetAgentDir: string, dirname: string): Promise<void> {
	const sourcePath = path.join(sourceAgentDir, dirname);
	try {
		const stat = await fs.stat(sourcePath);
		if (!stat.isDirectory()) return;
	} catch {
		return;
	}
	await fs.cp(sourcePath, path.join(targetAgentDir, dirname), { recursive: true });
}

async function seedProfileAgentFrom(
	sourceAgentDir: string,
	targetAgentDir: string,
	items?: ReadonlySet<string>,
): Promise<void> {
	await ensureBlankAgentTree(targetAgentDir);
	for (const item of PROFILE_COPY_ITEMS) {
		if (items && !items.has(item.key)) continue;
		for (const filename of item.files ?? []) {
			await copyIdentityFile(sourceAgentDir, targetAgentDir, filename);
		}
		for (const dirname of item.dirs ?? []) {
			await copyIdentityDir(sourceAgentDir, targetAgentDir, dirname);
		}
		if (item.keybindings) {
			seedKeybindingsFromAgentDir(targetAgentDir, sourceAgentDir);
		}
	}
}

/**
 * Read a profile's persisted display name ("" when unset). `undefined` /
 * "default" addresses the base profile. Reads the profile's own settings file
 * (`profile.displayName`) without touching the global settings singleton.
 */
export async function readProfileDisplayName(profile: string | undefined): Promise<string> {
	const { Settings } = await import("../config/settings");
	const agentDir = path.join(getProfileRootDir(normalizeProfileName(profile)), "agent");
	const settings = await Settings.loadReadOnly({ agentDir });
	return (settings.get("profile.displayName") ?? "").trim();
}

/** Remove `profile.displayName` from a freshly copied settings file, leaving every other key untouched. */
async function clearCopiedDisplayName(agentDir: string): Promise<void> {
	const { YAML } = await import("bun");
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const filePath = path.join(agentDir, filename);
		const file = Bun.file(filePath);
		if (!(await file.exists())) continue;
		let parsed: unknown;
		try {
			parsed = YAML.parse(await file.text());
		} catch (error) {
			throw new Error(`Copied settings file ${filePath} is not valid YAML: ${String(error)}`);
		}
		if (!isRecord(parsed)) continue;
		const root = parsed as Record<string, unknown>;
		const profile = root.profile;
		if (!isRecord(profile)) continue;
		const profileObj = profile as Record<string, unknown>;
		if (!("displayName" in profileObj)) continue;
		delete profileObj.displayName;
		if (Object.keys(profileObj).length === 0) delete root.profile;
		await Bun.write(filePath, YAML.stringify(root, null, 2));
	}
}

/** Persist a profile's display name into that profile's own settings file. */
export async function writeProfileDisplayName(profile: string | undefined, displayName: string): Promise<void> {
	const { Settings } = await import("../config/settings");
	const agentDir = path.join(getProfileRootDir(normalizeProfileName(profile)), "agent");
	const settings = await Settings.loadIsolated({ agentDir });
	settings.set("profile.displayName", displayName.trim());
	await settings.flush();
}

/**
 * Resolve user input to a profile directory name. Directory names win
 * (`"default"` resolves to the base profile as `undefined`); otherwise a
 * unique display-name match resolves. Returns `null` when nothing matches,
 * and throws when a display name is ambiguous across profiles.
 */
export async function resolveProfileByName(input: string): Promise<string | undefined | null> {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (trimmed === "default") return undefined;
	try {
		const normalized = normalizeProfileName(trimmed);
		if (normalized && profileExists(normalized)) return normalized;
	} catch {
		// Not a valid directory name — fall through to display-name matching.
	}
	const matches: (string | undefined)[] = [];
	for (const profile of listProfiles()) {
		const dirName = profile.name === "default" ? undefined : profile.name;
		const display = await readProfileDisplayName(dirName);
		if (display && display.localeCompare(trimmed, undefined, { sensitivity: "accent" }) === 0) {
			matches.push(dirName);
		}
	}
	if (matches.length > 1) {
		throw new Error(`Display name "${trimmed}" matches multiple profiles; use the directory name instead`);
	}
	return matches.length === 1 ? matches[0] : null;
}

export async function createProfile(
	name: string,
	from: ProfileSeedSource | undefined,
	items?: ReadonlySet<string>,
): Promise<ProfileInfo> {
	const normalized = normalizeProfileName(name);
	if (!normalized) {
		throw new Error('Profile name is required (cannot be "default")');
	}
	if (profileExists(normalized)) {
		throw new Error(`Profile "${normalized}" already exists`);
	}

	const rootDir = getProfileRootDir(normalized);
	const agentDir = path.join(rootDir, "agent");
	const seedAgentDir = resolveSeedAgentDir(from);
	if (seedAgentDir) {
		await seedProfileAgentFrom(seedAgentDir, agentDir, items);
		// A copied settings file carries the source's display name; the new
		// profile must not answer to it. Edit the YAML surgically — a full
		// Settings load/save would migrate legacy keys as a side effect.
		await clearCopiedDisplayName(agentDir);
	} else {
		await ensureBlankAgentTree(agentDir);
	}

	return { name: normalized, rootDir, agentDir };
}

export async function removeProfile(name: string, options: { yes?: boolean } = {}): Promise<void> {
	const normalized = normalizeProfileName(name);
	if (!normalized) {
		throw new Error("Cannot remove the default profile");
	}
	if (!profileExists(normalized)) {
		throw new Error(`Profile "${normalized}" does not exist`);
	}
	if (getActiveProfile() === normalized) {
		throw new Error(`Cannot remove the active profile "${normalized}"`);
	}

	const rootDir = getProfileRootDir(normalized);
	if (!options.yes) {
		throw new Error(`Refusing to remove ${rootDir} without --yes`);
	}
	await removeWithRetries(rootDir);
}

export async function runProfileCommand(args: ProfileCommandArgs): Promise<void> {
	switch (args.action) {
		case "list": {
			const profiles = listProfiles();
			const active = getActiveProfile() ?? "default";
			const launchDefault = resolveGlobalDefaultProfile() ?? "default";
			if (args.json) {
				const rows = await Promise.all(
					profiles.map(async profile => ({
						...profile,
						displayName: await readProfileDisplayName(profile.name === "default" ? undefined : profile.name),
						active: profile.name === active,
						launchDefault: profile.name === launchDefault,
						bytes: await directorySize(profile.rootDir),
					})),
				);
				console.log(JSON.stringify(rows, null, 2));
				return;
			}
			for (const profile of profiles) {
				const marker = profile.name === active ? chalk.green("*") : " ";
				const display = await readProfileDisplayName(profile.name === "default" ? undefined : profile.name);
				let label = display && display !== profile.name ? `${profile.name} (${display})` : profile.name;
				if (profile.name === launchDefault) {
					label += ` ${chalk.dim("[launch default]")}`;
				}
				console.log(`${marker} ${label}\t${profile.rootDir}`);
			}
			return;
		}
		case "new": {
			if (!args.name) {
				throw new Error("profile new requires a name");
			}
			const created = await createProfile(args.name, args.from);
			if (args.json) {
				console.log(JSON.stringify(created, null, 2));
				return;
			}
			console.log(chalk.green(`Created profile "${created.name}"`));
			console.log(created.agentDir);
			return;
		}
		case "rm": {
			if (!args.name) {
				throw new Error("profile rm requires a name");
			}
			const rootDir = getProfileRootDir(normalizeProfileName(args.name));
			await removeProfile(args.name, { yes: args.yes });
			if (args.json) {
				console.log(JSON.stringify({ removed: rootDir }, null, 2));
				return;
			}
			console.log(chalk.green(`Removed profile at ${rootDir}`));
			return;
		}
		case "default": {
			if (args.clear) {
				const filePath = writeGlobalDefaultProfile(undefined);
				if (args.json) {
					console.log(JSON.stringify({ defaultProfile: null, file: filePath }, null, 2));
					return;
				}
				console.log(`Cleared defaultProfile — a bare launch uses the default profile (${filePath})`);
				return;
			}
			if (!args.name) {
				const current = resolveGlobalDefaultProfile();
				if (args.json) {
					console.log(JSON.stringify({ defaultProfile: current ?? null }, null, 2));
					return;
				}
				console.log(
					current
						? `defaultProfile: ${current}`
						: "defaultProfile is unset — a bare launch uses the default profile",
				);
				return;
			}
			const normalized = normalizeProfileName(args.name);
			if (normalized !== undefined && !profileExists(normalized)) {
				throw new Error(
					`Profile "${normalized}" does not exist. Create it first: veyyon profile new ${normalized}`,
				);
			}
			const filePath = writeGlobalDefaultProfile(normalized);
			if (args.json) {
				console.log(JSON.stringify({ defaultProfile: normalized ?? null, file: filePath }, null, 2));
				return;
			}
			console.log(
				normalized
					? chalk.green(`defaultProfile set to "${normalized}" (${filePath})`)
					: `Cleared defaultProfile — a bare launch uses the default profile (${filePath})`,
			);
			return;
		}
		default: {
			const exhaustive: never = args.action;
			throw new Error(`Unknown profile action: ${String(exhaustive)}`);
		}
	}
}
