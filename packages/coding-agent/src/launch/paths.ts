import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEnoent } from "@veyyon/utils";

const NAMES = {
	brokerRoot: path.join("run", "daemons"),
	brokerSocket: "broker.sock",
	brokerToken: "broker.token",
	brokerLease: "broker.pid",
	managedRoot: "daemons",
	presenceRoot: "clients",
	completions: "completions.json",
	managedMeta: "meta.json",
	managedLog: "output.log",
	managedPreviousLog: "output.previous.log",
	managedProcessLease: "process.pid",
} as const;

function projectKey(projectDir: string): string {
	return Bun.hash.wyhash(path.resolve(projectDir)).toString(16).padStart(16, "0");
}

export function daemonRuntimeDir(projectDir: string, configRoot: string = getConfigRootDir()): string {
	return path.join(configRoot, NAMES.brokerRoot, projectKey(projectDir));
}

export function daemonBrokerEndpoint(projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\veyyon-daemon-${projectKey(projectDir)}`;
	}
	return path.join(runtimeDir, NAMES.brokerSocket);
}

export function daemonBrokerTokenPath(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.brokerToken);
}

export function daemonBrokerLeasePath(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.brokerLease);
}

export function daemonPresenceDir(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.presenceRoot);
}

export function daemonPresenceEntryPath(presenceDir: string, id: string): string {
	return path.join(presenceDir, `${id}.json`);
}

export function managedDaemonsRoot(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.managedRoot);
}

export function daemonCompletionsPath(runtimeDir: string): string {
	return path.join(runtimeDir, NAMES.completions);
}

export function managedDaemonDir(runtimeDir: string, name: string): string {
	return path.join(managedDaemonsRoot(runtimeDir), name);
}

export function managedDaemonMetaPath(daemonDir: string): string {
	return path.join(daemonDir, NAMES.managedMeta);
}

export function managedDaemonLogPath(daemonDir: string): string {
	return path.join(daemonDir, NAMES.managedLog);
}

export function managedDaemonPreviousLogPath(daemonDir: string): string {
	return path.join(daemonDir, NAMES.managedPreviousLog);
}

export function managedDaemonProcessLeasePath(daemonDir: string): string {
	return path.join(daemonDir, NAMES.managedProcessLease);
}

export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error)) return resolved;
		throw error;
	}
}
