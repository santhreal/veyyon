import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile, isEnoent, withFileLock } from "@veyyon/utils";
import { invalidate as invalidateFsCache } from "../capability/fs";
import { MCP_CONFIG_SCHEMA_URL, type MCPConfigFile, type MCPServerConfig } from "./types";
import { validateServerConfig } from "./validate";

function withSchema(config: MCPConfigFile): MCPConfigFile {
	return {
		$schema: config.$schema ?? MCP_CONFIG_SCHEMA_URL,
		...config,
	};
}

export async function readMCPConfigFile(filePath: string): Promise<MCPConfigFile> {
	try {
		const content = await fs.promises.readFile(filePath, "utf-8");
		const parsed = JSON.parse(content) as MCPConfigFile;
		return parsed;
	} catch (error) {
		if (isEnoent(error)) {
			return { mcpServers: {} };
		}
		throw error;
	}
}

export async function writeMCPConfigFile(filePath: string, config: MCPConfigFile): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	const content = JSON.stringify(withSchema(config), null, 2);
	await atomicWriteFile(filePath, content, { mode: 0o600 });
	invalidateFsCache(filePath);
}

async function mutateMCPConfigFile(filePath: string, mutate: (current: MCPConfigFile) => MCPConfigFile): Promise<void> {
	await withFileLock(filePath, async () => {
		const current = await readMCPConfigFile(filePath);
		const next = mutate(current);
		await writeMCPConfigFile(filePath, next);
	});
}

export function validateServerName(name: string): string | undefined {
	if (!name) {
		return "Server name cannot be empty. Fix: give the server a short id you will type in `/mcp` commands, for example `filesystem`.";
	}
	if (name.length > 100) {
		return `Server name is too long: ${name.length} characters, and the maximum is 100. Fix: shorten it to a short id you will type in \`/mcp\` commands, for example \`filesystem\`.`;
	}
	if (!/^[a-zA-Z0-9_.:-]+$/.test(name)) {
		return `Server name "${name}" can only contain letters, numbers, dash, underscore, dot, and colon. Fix: replace the other characters, for example \`my-server\` rather than \`my server\`.`;
	}
	if (name === "." || name === ".." || name.split(/[.:]/).every(p => p === "" || p === "." || p === "..")) {
		return `Server name "${name}" cannot be a path segment like '.' or '..', because consumers that treat the name as a filename would misread it. Fix: give the server a real id, for example \`local-fs\`.`;
	}
	return undefined;
}

export async function addMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Cannot add MCP server "${name}" to ${filePath}: ${errors.join("; ")}`);
	}

	await mutateMCPConfigFile(filePath, existing => {
		if (existing.mcpServers?.[name]) {
			throw new Error(
				`MCP server "${name}" already exists in ${filePath}, and adding it again would silently replace a working entry. Fix: pick a different name, or run \`/mcp remove ${name}\` first, or edit ${filePath} directly to change the existing entry.`,
			);
		}
		return {
			...existing,
			mcpServers: {
				...existing.mcpServers,
				[name]: config,
			},
		};
	});
}

export async function updateMCPServer(filePath: string, name: string, config: MCPServerConfig): Promise<void> {
	const nameError = validateServerName(name);
	if (nameError) {
		throw new Error(nameError);
	}

	const errors = validateServerConfig(name, config);
	if (errors.length > 0) {
		throw new Error(`Cannot update MCP server "${name}" in ${filePath}: ${errors.join("; ")}`);
	}

	await mutateMCPConfigFile(filePath, existing => ({
		...existing,
		mcpServers: {
			...existing.mcpServers,
			[name]: config,
		},
	}));
}

export async function removeMCPServer(filePath: string, name: string): Promise<void> {
	await mutateMCPConfigFile(filePath, existing => {
		if (!existing.mcpServers?.[name]) {
			throw new Error(
				`MCP server "${name}" was not found in ${filePath}, so there is nothing to remove. Fix: run \`/mcp list\` to see the configured servers and which file each one comes from; \`/mcp remove\` only edits your profile's mcp.json, and a server listed under another provider is removed by editing that provider's own file.`,
			);
		}
		const { [name]: _removed, ...remaining } = existing.mcpServers;
		return {
			...existing,
			mcpServers: remaining,
		};
	});
}

export async function getMCPServer(filePath: string, name: string): Promise<MCPServerConfig | undefined> {
	const config = await readMCPConfigFile(filePath);
	return config.mcpServers?.[name];
}

export async function listMCPServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFile(filePath);
	return Object.keys(config.mcpServers ?? {});
}

async function readMCPConfigFileForQuery(filePath: string): Promise<MCPConfigFile> {
	try {
		return await readMCPConfigFile(filePath);
	} catch (error) {
		if (error instanceof SyntaxError) return { mcpServers: {} };
		throw error;
	}
}

export async function readDisabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFileForQuery(filePath);
	return Array.isArray(config.disabledServers) ? config.disabledServers : [];
}

export async function setServerDisabled(filePath: string, name: string, disabled: boolean): Promise<void> {
	await mutateMCPConfigFile(filePath, config => {
		const current = new Set(config.disabledServers ?? []);

		if (disabled) {
			current.add(name);
		} else {
			current.delete(name);
		}

		const updated: MCPConfigFile = {
			...config,
			disabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
		};

		if (!updated.disabledServers) {
			delete updated.disabledServers;
		}

		return updated;
	});
}

export async function readEnabledServers(filePath: string): Promise<string[]> {
	const config = await readMCPConfigFileForQuery(filePath);
	return Array.isArray(config.enabledServers) ? config.enabledServers : [];
}

export async function setServerForceEnabled(filePath: string, name: string, force: boolean): Promise<void> {
	await mutateMCPConfigFile(filePath, config => {
		const current = new Set(config.enabledServers ?? []);

		if (force) {
			current.add(name);
		} else {
			current.delete(name);
		}

		const updated: MCPConfigFile = {
			...config,
			enabledServers: current.size > 0 ? Array.from(current).sort() : undefined,
		};

		if (!updated.enabledServers) {
			delete updated.enabledServers;
		}

		return updated;
	});
}

export interface SetMcpServerEnabledOptions {
	userPath: string;
	projectPath: string;
	sourcePath?: string;
	name: string;
	enabled: boolean;
}

export async function setMcpServerEnabled(options: SetMcpServerEnabledOptions): Promise<void> {
	const { userPath, projectPath, sourcePath, name, enabled } = options;
	const candidatePaths = Array.from(new Set([sourcePath, projectPath, userPath].filter(path => path !== undefined)));
	let updatedInConfig = false;

	for (const filePath of candidatePaths) {
		const config = await readMCPConfigFile(filePath);
		const server = config.mcpServers?.[name];
		if (server === undefined) continue;

		await updateMCPServer(filePath, name, { ...server, enabled });
		updatedInConfig = true;
		break;
	}

	if (enabled) {
		const denied = await readDisabledServers(userPath);
		if (denied.includes(name)) {
			await setServerDisabled(userPath, name, false);
		}

		const forced = await readEnabledServers(userPath);
		const isForced = forced.includes(name);
		if (!updatedInConfig && !isForced) {
			await setServerForceEnabled(userPath, name, true);
		} else if (updatedInConfig && isForced) {
			await setServerForceEnabled(userPath, name, false);
		}
		return;
	}

	const forced = await readEnabledServers(userPath);
	if (forced.includes(name)) {
		await setServerForceEnabled(userPath, name, false);
	}
	if (!updatedInConfig) {
		await setServerDisabled(userPath, name, true);
	}
}
