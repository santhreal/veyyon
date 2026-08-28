import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	assertRemovableProfileDir,
	atomicWriteFile,
	errorMessage,
	getActiveProfile,
	getProfileRootDir,
	isMissingPath,
	isRecord,
	listProfiles,
	logger,
	MAIN_CONFIG_FILENAMES,
	normalizeProfileName,
	type ProfileInfo,
	profileExists,
	removeWithRetries,
	resolveGlobalDefaultProfile,
	syncYamlTextToSettings,
	writeGlobalDefaultProfile,
} from "@veyyon/utils";
import chalk from "chalk";
import { seedKeybindingsFromAgentDir } from "../config/keybindings";
import { ensureProfileAgentsFileAt } from "../discovery/agents-guidance";

export type ProfileAction = "list" | "new" | "rm" | "default";

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

export interface ProfileCopyItem {
	key: string;
	label: string;
	description: string;
	files?: readonly string[];
	dirs?: readonly string[];
	keybindings?: boolean;
}

export const PROFILE_COPY_ITEMS: readonly ProfileCopyItem[] = [
	{
		key: "agents",
		label: "AGENTS.md",
		description: "Profile-specific agent instructions",
		files: ["AGENTS.md"],
	},
	{
		key: "settings",
		label: "Settings",
		description: "Everything `veyyon config list` shows",
		files: MAIN_CONFIG_FILENAMES.slice(),
	},
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

export interface ProfilePreset {
	displayName: string;
	description: string;
	settings: Record<string, unknown>;
}

export const PROFILE_PRESETS: Record<string, ProfilePreset> = {
	dev: {
		displayName: "Dev (study)",
		description: "Ultra-rich session instrumentation and Argot on, for studying sessions in depth.",
		settings: {
			"session.instrumentation": "ultra",
			"argot.enabled": true,
		},
	},
};

async function applyPresetSettings(agentDir: string, preset: ProfilePreset): Promise<void> {
	const { Settings } = await import("../config/settings");
	const settings = await Settings.loadIsolated({ agentDir });
	settings.set("profile.displayName", preset.displayName);
	for (const [key, value] of Object.entries(preset.settings)) {
		settings.set(key as Parameters<typeof settings.set>[0], value as never);
	}
	await settings.flush();
}

interface DirectorySize {
	bytes: number;
	unmeasured: string[];
}

async function directorySize(root: string): Promise<DirectorySize> {
	let bytes = 0;
	const unmeasured: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (!isMissingPath(error)) unmeasured.push(dir);
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
			} else if (entry.isFile()) {
				try {
					bytes += (await fs.stat(fullPath)).size;
				} catch (error) {
					if (!isMissingPath(error)) unmeasured.push(fullPath);
				}
			}
		}
	};
	await walk(root);
	return { bytes, unmeasured };
}

function resolveSeedAgentDir(from: ProfileSeedSource | undefined): string | undefined {
	const source = from ?? "default";
	if (source === "blank" || source in PROFILE_PRESETS) return undefined;
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
	let stat: Stats;
	try {
		stat = await fs.stat(sourcePath);
	} catch (error) {
		if (isMissingPath(error)) return;
		throw new Error(`Cannot inspect profile seed file ${sourcePath}: ${errorMessage(error)}`, { cause: error });
	}
	if (!stat.isFile()) {
		throw new Error(`Cannot copy profile seed item ${sourcePath}: expected a file`);
	}
	await fs.mkdir(targetAgentDir, { recursive: true });
	try {
		await fs.copyFile(sourcePath, path.join(targetAgentDir, filename));
	} catch (error) {
		throw new Error(`Cannot copy profile seed file ${sourcePath}: ${errorMessage(error)}`, { cause: error });
	}
}

async function copyIdentityDir(sourceAgentDir: string, targetAgentDir: string, dirname: string): Promise<void> {
	const sourcePath = path.join(sourceAgentDir, dirname);
	let stat: Stats;
	try {
		stat = await fs.stat(sourcePath);
	} catch (error) {
		if (isMissingPath(error)) return;
		throw new Error(`Cannot inspect profile seed directory ${sourcePath}: ${errorMessage(error)}`, { cause: error });
	}
	if (!stat.isDirectory()) {
		throw new Error(`Cannot copy profile seed item ${sourcePath}: expected a directory`);
	}
	try {
		await fs.cp(sourcePath, path.join(targetAgentDir, dirname), { recursive: true });
	} catch (error) {
		throw new Error(`Cannot copy profile seed directory ${sourcePath}: ${errorMessage(error)}`, { cause: error });
	}
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
	await ensureProfileAgentsFileAt(targetAgentDir);
}

export async function readProfileDisplayName(profile: string | undefined): Promise<string> {
	const { Settings } = await import("../config/settings");
	const agentDir = path.join(getProfileRootDir(normalizeProfileName(profile)), "agent");
	const settings = await Settings.loadReadOnly({ agentDir });
	return (settings.get("profile.displayName") ?? "").trim();
}

async function clearCopiedDisplayName(agentDir: string): Promise<void> {
	const { YAML } = await import("bun");
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const filePath = path.join(agentDir, filename);
		const file = Bun.file(filePath);
		if (!(await file.exists())) continue;
		const text = await file.text();
		let parsed: unknown;
		try {
			parsed = YAML.parse(text);
		} catch (error) {
			throw new Error(`Copied settings file ${filePath} is not valid YAML: ${errorMessage(error)}`);
		}
		if (!isRecord(parsed)) continue;
		const root = parsed as Record<string, unknown>;
		const profile = root.profile;
		if (!isRecord(profile)) continue;
		const profileObj = profile as Record<string, unknown>;
		if (!("displayName" in profileObj)) continue;
		delete profileObj.displayName;
		if (Object.keys(profileObj).length === 0) delete root.profile;
		await atomicWriteFile(filePath, syncYamlTextToSettings(text, root));
	}
}

export async function writeProfileDisplayName(profile: string | undefined, displayName: string): Promise<void> {
	const { Settings, isSettingsInitialized } = await import("../config/settings");
	const trimmed = displayName.trim();
	const normalized = normalizeProfileName(profile);
	if (isSettingsInitialized() && normalized === getActiveProfile()) {
		const live = Settings.instance;
		live.set("profile.displayName", trimmed);
		await live.flush();
		return;
	}
	const agentDir = path.join(getProfileRootDir(normalized), "agent");
	const settings = await Settings.loadIsolated({ agentDir });
	settings.set("profile.displayName", trimmed);
	await settings.flush();
}

export async function resolveProfileByName(input: string): Promise<string | undefined | null> {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (trimmed === "default") return undefined;
	try {
		const normalized = normalizeProfileName(trimmed);
		if (normalized && profileExists(normalized)) return normalized;
	} catch {}
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
	const preset = from !== undefined ? PROFILE_PRESETS[from] : undefined;
	const seedAgentDir = resolveSeedAgentDir(from);

	const parentDir = path.dirname(rootDir);
	await fs.mkdir(parentDir, { recursive: true });
	const stagingRoot = path.join(parentDir, `.${normalized}.${process.pid}.${crypto.randomUUID()}.tmp`);
	assertRemovableProfileDir(stagingRoot);
	const stagingAgentDir = path.join(stagingRoot, "agent");
	try {
		if (seedAgentDir) {
			await seedProfileAgentFrom(seedAgentDir, stagingAgentDir, items);
			await clearCopiedDisplayName(stagingAgentDir);
		} else {
			await ensureBlankAgentTree(stagingAgentDir);
		}
		await fs.rename(stagingRoot, rootDir);
	} catch (error) {
		await removeWithRetries(stagingRoot).catch(() => {});
		throw error;
	}

	if (preset) {
		await applyPresetSettings(agentDir, preset);
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
	await removeWithRetries(assertRemovableProfileDir(rootDir));

	if (resolveGlobalDefaultProfile() === normalized) {
		writeGlobalDefaultProfile(undefined);
	}
}

export async function runProfileCliCommand(args: ProfileCommandArgs): Promise<void> {
	switch (args.action) {
		case "list": {
			const profiles = listProfiles();
			const active = getActiveProfile() ?? "default";
			const launchDefault = resolveGlobalDefaultProfile() ?? "default";
			if (args.json) {
				const rows = await Promise.all(
					profiles.map(async profile => {
						const size = await directorySize(profile.rootDir);
						if (size.unmeasured.length > 0) {
							logger.warn("Profile size is incomplete; some paths could not be read", {
								profile: profile.name,
								bytes: size.bytes,
								unmeasured: size.unmeasured,
							});
						}
						return {
							...profile,
							displayName: await readProfileDisplayName(profile.name === "default" ? undefined : profile.name),
							active: profile.name === active,
							launchDefault: profile.name === launchDefault,
							bytes: size.bytes,
							bytesComplete: size.unmeasured.length === 0,
						};
					}),
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
