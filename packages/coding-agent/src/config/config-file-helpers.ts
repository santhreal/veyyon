import * as fs from "node:fs";
import { atomicWriteFileSync, logger } from "@veyyon/utils";
import type { Type } from "arktype";
import { JSONC, YAML } from "bun";

export interface ConfigSchemaError {
	instancePath: string;
	message: string | undefined;
}

export const migratedPaths = new Set<string>();

export function migrationKey(jsonPath: string, ymlPath: string): string {
	return `${jsonPath}\u0000${ymlPath}`;
}

export function migrateJsonToYml(jsonPath: string, ymlPath: string) {
	const key = migrationKey(jsonPath, ymlPath);
	if (migratedPaths.has(key)) return;
	try {
		if (fs.existsSync(ymlPath)) {
			migratedPaths.add(key);
			return;
		}
		if (!fs.existsSync(jsonPath)) {
			migratedPaths.add(key);
			return;
		}

		const content = fs.readFileSync(jsonPath, "utf-8");
		const parsed = JSONC.parse(content);
		if (!parsed) {
			logger.warn("migrateJsonToYml: invalid json structure", { path: jsonPath });
			migratedPaths.add(key);
			return;
		}
		atomicWriteFileSync(ymlPath, YAML.stringify(parsed, null, 2));
		migratedPaths.add(key);
	} catch (error) {
		logger.warn("migrateJsonToYml: migration failed", { error: String(error) });
	}
}

export interface IConfigFile<T> {
	readonly id: string;
	readonly schema: Type;
	path?(): string;
	load(): T | null;
	invalidate?(): void;
}

export const MAX_CONFIG_ISSUE_LENGTH = 200;
export const MAX_CONFIG_ISSUES = 20;
export const MAX_CONFIG_ERROR_LENGTH = 4500;
