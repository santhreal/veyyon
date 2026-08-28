import * as fs from "node:fs";
import { isMissingPath } from "./fs-error";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function isMacosMallocStackLoggingEnvName(name: string): boolean {
	return name === "MallocStackLogging" || name === "MallocStackLoggingNoCompact";
}

export type UnreadableEnvFileReporter = (filePath: string, error: unknown) => void;

export function parseEnvFile(filePath: string, onUnreadable: UnreadableEnvFileReporter): Record<string, string> {
	const result: Record<string, string> = {};
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if (!isMissingPath(error)) onUnreadable(filePath, error);
		return result;
	}

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;

		const key = trimmed.slice(0, eqIndex).trim();
		if (!isValidEnvName(key)) continue;

		let value = trimmed.slice(eqIndex + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (!isSafeEnvValue(value)) continue;

		result[key] = value;
	}
	return result;
}
