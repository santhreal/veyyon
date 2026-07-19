/**
 * SSH Configuration File Writer
 *
 * Utilities for reading/writing ssh.json files at user or project level.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile, isEnoent, withFileLock } from "@veyyon/utils";

export interface SSHHostConfig {
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	description?: string;
	compat?: boolean;
}

export interface SSHConfigFile {
	hosts?: Record<string, SSHHostConfig>;
}

/**
 * Read an SSH config file.
 * Returns empty config if file doesn't exist.
 */
export async function readSSHConfigFile(filePath: string): Promise<SSHConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as SSHConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			// File doesn't exist, return empty config
			return { hosts: {} };
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse SSH config file ${filePath}: ${error.message}`);
		}
		throw error;
	}
}

/**
 * Write an SSH config file atomically.
 * Creates parent directories if they don't exist.
 */
export async function writeSSHConfigFile(filePath: string, config: SSHConfigFile): Promise<void> {
	// Ensure the parent directory exists and is owner-only (it holds credentials).
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	const content = JSON.stringify(config, null, 2);
	await atomicWriteFile(filePath, content, { mode: 0o600 });
}

/**
 * Read-modify-write an SSH config file under a cross-process lock.
 *
 * Every mutation (add/update/remove) funnels through here so two concurrent
 * writers cannot both read the same base config, each apply one change, and have
 * the last write silently drop the other's host. The lock serializes the
 * read+mutate+write critical section across processes; the write itself is still
 * atomic (temp file + rename), so a crash mid-write never tears the file.
 *
 * `mutate` runs inside the lock with the freshly re-read config and returns the
 * next config. Duplicate/not-found checks that depend on the current on-disk
 * state must run inside `mutate` so they see the latest committed state.
 */
async function mutateSSHConfigFile(filePath: string, mutate: (current: SSHConfigFile) => SSHConfigFile): Promise<void> {
	await withFileLock(filePath, async () => {
		const current = await readSSHConfigFile(filePath);
		const next = mutate(current);
		await writeSSHConfigFile(filePath, next);
	});
}

/**
 * Validate host name.
 * @returns Error message if invalid, undefined if valid
 */
export function validateHostName(name: string): string | undefined {
	if (!name) {
		return "Host name cannot be empty";
	}
	if (name.length > 100) {
		return "Host name is too long (max 100 characters)";
	}
	// Check for invalid characters (only allow alphanumeric, dash, underscore, dot)
	if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
		return "Host name can only contain letters, numbers, dash, underscore, and dot";
	}
	return undefined;
}

/**
 * Add an SSH host to a config file.
 *
 * @throws Error if host name already exists or validation fails
 */
export async function addSSHHost(filePath: string, name: string, hostConfig: SSHHostConfig): Promise<void> {
	// Validate host name
	const nameError = validateHostName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate host field
	if (!hostConfig.host) {
		throw new Error("Host address cannot be empty");
	}

	// The duplicate check reads the current on-disk state, so it must run inside
	// the lock: another writer may have added this name between our validation
	// and our write.
	await mutateSSHConfigFile(filePath, existing => {
		if (existing.hosts?.[name]) {
			throw new Error(`Host "${name}" already exists in ${filePath}`);
		}
		return {
			...existing,
			hosts: {
				...existing.hosts,
				[name]: hostConfig,
			},
		};
	});
}

/**
 * Update an existing SSH host in a config file.
 * If the host doesn't exist, this will add it.
 *
 * @throws Error if validation fails
 */
export async function updateSSHHost(filePath: string, name: string, hostConfig: SSHHostConfig): Promise<void> {
	// Validate host name
	const nameError = validateHostName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	// Validate host field
	if (!hostConfig.host) {
		throw new Error("Host address cannot be empty");
	}

	await mutateSSHConfigFile(filePath, existing => ({
		...existing,
		hosts: {
			...existing.hosts,
			[name]: hostConfig,
		},
	}));
}

/**
 * Remove an SSH host from a config file.
 *
 * @throws Error if host doesn't exist
 */
export async function removeSSHHost(filePath: string, name: string): Promise<void> {
	// The existence check reads the current on-disk state, so it must run inside
	// the lock alongside the removal.
	await mutateSSHConfigFile(filePath, existing => {
		if (!existing.hosts?.[name]) {
			throw new Error(`Host "${name}" not found in ${filePath}`);
		}
		const { [name]: _removed, ...remaining } = existing.hosts;
		return {
			...existing,
			hosts: remaining,
		};
	});
}

/**
 * List all host names in a config file.
 */
export async function listSSHHosts(filePath: string): Promise<string[]> {
	const config = await readSSHConfigFile(filePath);
	return Object.keys(config.hosts ?? {});
}
