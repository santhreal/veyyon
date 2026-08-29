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

export async function readSSHConfigFile(filePath: string): Promise<SSHConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as SSHConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			return { hosts: {} };
		}
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse SSH config file ${filePath}: ${error.message}`);
		}
		throw error;
	}
}

async function writeSSHConfigFile(filePath: string, config: SSHConfigFile): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	const content = JSON.stringify(config, null, 2);
	await atomicWriteFile(filePath, content, { mode: 0o600 });
}

async function mutateSSHConfigFile(filePath: string, mutate: (current: SSHConfigFile) => SSHConfigFile): Promise<void> {
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await withFileLock(filePath, async () => {
		const current = await readSSHConfigFile(filePath);
		const next = mutate(current);
		await writeSSHConfigFile(filePath, next);
	});
}

function validateHostName(name: string): string | undefined {
	if (!name) {
		return "Host name cannot be empty";
	}
	if (name.length > 100) {
		return "Host name is too long (max 100 characters)";
	}
	if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
		return "Host name can only contain letters, numbers, dash, underscore, and dot";
	}
	return undefined;
}

export async function addSSHHost(filePath: string, name: string, hostConfig: SSHHostConfig): Promise<void> {
	const nameError = validateHostName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	if (!hostConfig.host) {
		throw new Error("Host address cannot be empty");
	}

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

export async function updateSSHHost(filePath: string, name: string, hostConfig: SSHHostConfig): Promise<void> {
	const nameError = validateHostName(name);
	if (nameError) {
		throw new Error(nameError);
	}

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

export async function removeSSHHost(filePath: string, name: string): Promise<void> {
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
