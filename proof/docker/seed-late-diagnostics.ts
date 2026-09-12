/**
 * Seed a synthetic session containing late LSP diagnostics using production
 * SessionManager and message builders, so a proof scene can verify transcript
 * rendering, home path shortening, grouping and global expansion (ctrl+o)
 * deterministically.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildLateDiagnosticsBatchMessage } from "@veyyon/coding-agent/session/factory-notices";
import type { DeferredDiagnosticsEntry } from "@veyyon/coding-agent/tools";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

const [repoDirArg] = process.argv.slice(2);
const repoDir = path.resolve(repoDirArg || "/sandbox/home/demo");

// Ensure demo source files exist so path references resolve to real files.
const srcDir = path.join(repoDir, "src");
fs.mkdirSync(srcDir, { recursive: true });

const dummyFiles: Record<string, string> = {
	"service.ts": "export interface ServiceOptions { timeoutMs?: number; }\nexport class Service {}\n",
	"config.ts": "export interface ConfigStore { host: string; port: number; }\n",
};

for (const [name, content] of Object.entries(dummyFiles)) {
	const filePath = path.join(srcDir, name);
	if (!fs.existsSync(filePath)) {
		fs.writeFileSync(filePath, content, "utf8");
	}
}

const parserTs = path.join(repoDir, "src", "parser.ts");
const serviceTs = path.join(repoDir, "src", "service.ts");
const configTs = path.join(repoDir, "src", "config.ts");

// Use production SessionManager to create session in canonical session dir with versioned header.
const sessionManager = SessionManager.create(repoDir);

sessionManager.appendMessage({
	role: "user",
	content: [{ type: "text", text: "Check parser and service compilation" }],
	timestamp: Date.now() - 3000,
});

sessionManager.appendMessage({
	role: "assistant",
	content: [{ type: "text", text: "Ran type check across project files." }],
	api: "custom",
	provider: "local",
	model: "qwen2.5-1.5b",
	usage: {
		input: 120,
		output: 40,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 160,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	},
	stopReason: "stop",
	timestamp: Date.now() - 2000,
});

const entries: DeferredDiagnosticsEntry[] = [
	{
		path: parserTs,
		summary: "1 error, 1 warning, 1 info",
		errored: true,
		messages: [
			`${parserTs}:42:15 [error] [typescript] Type 'string' is not assignable to type 'number'. (2322)`,
			`${parserTs}:18:7 [warning] [typescript] 'options' is declared but its value is never read. (6133)`,
			`${parserTs}:5:1 [info] [typescript] File is a CommonJS module; it may be converted to an ES module. (80001)`,
		],
		isStale: () => false,
	},
	{
		path: serviceTs,
		summary: "1 error, 1 warning, 1 info",
		errored: true,
		messages: [
			`${serviceTs}:104:22 [error] [typescript] Property 'timeoutMs' does not exist on type 'ServiceOptions'. (2339)`,
			`${serviceTs}:88:9 [warning] [typescript] Unreachable code detected. (7027)`,
			`${serviceTs}:12:3 [info] [typescript] Consider using optional chaining instead. (80006)`,
		],
		isStale: () => false,
	},
	{
		path: configTs,
		summary: "1 error",
		errored: true,
		messages: [
			`${configTs}:31:10 [error] [typescript] Cannot find name 'ConfigStore'. (2304)`,
		],
		isStale: () => false,
	},
	{
		path: repoDir,
		summary: "",
		errored: false,
		messages: [
			"build output: compilation finished with 3 errors and 2 warnings",
			"hint: run with --verbose for detailed diagnostic trace",
		],
		isStale: () => false,
	},
];

const lateDiagMsg = buildLateDiagnosticsBatchMessage(entries);
if (!lateDiagMsg) {
	throw new Error("Failed to build late diagnostics batch message");
}

sessionManager.appendMessage(lateDiagMsg);
await sessionManager.flush();

const sessionFile = sessionManager.getSessionFile();
process.stdout.write(`seeded late diagnostics session at ${sessionFile}\n`);
