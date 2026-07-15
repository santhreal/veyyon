/**
 * Profile lifecycle CLI: list, create, and remove self-contained profiles.
 */
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import {
	getActiveProfile,
	getProfileRootDir,
	listProfiles,
	MAIN_CONFIG_FILENAMES,
	normalizeProfileName,
	profileExists,
	removeWithRetries,
	type ProfileInfo,
} from "@veyyon/pi-utils";
import chalk from "chalk";
import { seedKeybindingsFromAgentDir } from "../config/keybindings";

export type ProfileAction = "list" | "new" | "rm";

export type ProfileSeedSource = "default" | "blank" | string;

export interface ProfileCommandArgs {
	action: ProfileAction;
	name?: string;
	from?: ProfileSeedSource;
	yes?: boolean;
	json?: boolean;
}

const IDENTITY_DIRS = ["skills", "commands", "tools", "prompts", "themes", "extensions"] as const;
const IDENTITY_FILES = [
	"AGENTS.md",
	"SYSTEM.md",
	"RULES.md",
	"mcp.json",
	"ssh.json",
	...MAIN_CONFIG_FILENAMES,
] as const;

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

async function seedProfileAgentFrom(sourceAgentDir: string, targetAgentDir: string): Promise<void> {
	await ensureBlankAgentTree(targetAgentDir);
	for (const filename of IDENTITY_FILES) {
		await copyIdentityFile(sourceAgentDir, targetAgentDir, filename);
	}
	for (const dirname of IDENTITY_DIRS) {
		await copyIdentityDir(sourceAgentDir, targetAgentDir, dirname);
	}
	seedKeybindingsFromAgentDir(targetAgentDir, sourceAgentDir);
}

export async function createProfile(name: string, from: ProfileSeedSource | undefined): Promise<ProfileInfo> {
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
		await seedProfileAgentFrom(seedAgentDir, agentDir);
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
			if (args.json) {
				const rows = await Promise.all(
					profiles.map(async profile => ({
						...profile,
						active: profile.name === active,
						bytes: await directorySize(profile.rootDir),
					})),
				);
				console.log(JSON.stringify(rows, null, 2));
				return;
			}
			for (const profile of profiles) {
				const marker = profile.name === active ? chalk.green("*") : " ";
				console.log(`${marker} ${profile.name}\t${profile.rootDir}`);
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
		default: {
			const exhaustive: never = args.action;
			throw new Error(`Unknown profile action: ${String(exhaustive)}`);
		}
	}
}
