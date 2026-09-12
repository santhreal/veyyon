import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadHistoricalOracle, ORACLE_EXPORTS } from "./historical-loader";

// 1. Load all historical oracles first in child process
for (const name of Object.keys(ORACLE_EXPORTS)) {
	await loadHistoricalOracle(name);
}

// 2. Use createRequire only to access builtin-themes
const requireTheme = createRequire(import.meta.url);
const builtinThemesPath = path.resolve(import.meta.dirname, "../../src/theme/builtin-themes.ts");
const { getBuiltinTheme } = requireTheme(builtinThemesPath) as {
	getBuiltinTheme: (name: string) => Record<string, unknown> | undefined;
};

// 3. Derive theme input variant list from JSON directories and compare exact objects
const themeDir = path.resolve(import.meta.dirname, "../../src/theme");
const defaultsDir = path.join(themeDir, "defaults");

const themeFiles: Array<{ name: string; filePath: string }> = [
	{ name: "dark", filePath: path.join(themeDir, "dark.json") },
	{ name: "light", filePath: path.join(themeDir, "light.json") },
];

for (const entry of fs.readdirSync(defaultsDir)) {
	if (entry.endsWith(".json")) {
		themeFiles.push({
			name: path.basename(entry, ".json"),
			filePath: path.join(defaultsDir, entry),
		});
	}
}

for (const { name, filePath } of themeFiles) {
	const rawJson = fs.readFileSync(filePath, "utf-8");
	const expectedObject = JSON.parse(rawJson) as Record<string, unknown>;
	const decoded = getBuiltinTheme(name);
	if (!decoded) {
		throw new Error(`getBuiltinTheme("${name}") returned undefined`);
	}
	if (JSON.stringify(decoded) !== JSON.stringify(expectedObject)) {
		throw new Error(`Decoded theme "${name}" mismatch with input file ${filePath}`);
	}
}
