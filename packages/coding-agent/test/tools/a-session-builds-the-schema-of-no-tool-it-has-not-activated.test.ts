/**
 * WHY: ArkType registers every node a `type(...)` call builds in a process-global table,
 * `$ark.nodesByRegisteredId`, and never releases one. Tool parameter schemas were declared at module
 * scope, so evaluating a tool's module built its schema, and session creation read `parameters` on
 * every registered tool twice more: once to list the tool's schema keys for discovery and once for
 * the prompt's tool metadata. A default idle session registered 1,841 nodes, where building only its
 * active tools' schemas registers 834, and a session with discovery on built the schema of every tool
 * it never loaded.
 *
 * Class closed: a path that builds a tool's parameter schema before that tool is active, or a schema
 * that belongs to no tool while a session starts. One session is created in a fresh process with
 * every tool-enabling setting on and tool discovery `all`, and each stage where a schema can be built
 * early is checked:
 * - evaluating the modules a session imports registers no node;
 * - with every tool schema already built, creating the session registers no node, which catches a
 *   schema of no tool that a module imported during creation builds;
 * - constructing any built-in or hidden factory's tool registers no node before its parameters are
 *   read;
 * - the schema of every tool the session holds inactive is built by that tool's first read.
 * The tool sets come from the session's registry and the factory tables at run time, so a new tool is
 * checked when it is registered, and a factory the settings cannot construct fails the suite.
 *
 * Not caught: a schema built after creation by a path this suite does not drive, such as a slash
 * command, an MCP connection or the first turn, and schemas an extension or MCP server supplies.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { TempDir } from "@veyyon/utils";
import type {
	ColdSessionSchemaReport,
	PrewarmedSessionSchemaReport,
	SessionSchemaReport,
} from "../fixtures/session-schema-registry";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "session-schema-registry.ts");

async function report(scratch: TempDir, mode: SessionSchemaReport["mode"]): Promise<SessionSchemaReport> {
	const { env, cleanup } = hermeticSpawnEnv();
	try {
		const { stdout, stderr } = await run(process.execPath, [FIXTURE, scratch.path(), mode], {
			env,
			timeout: 60_000,
			killSignal: "SIGKILL",
		});
		if (stderr !== "") throw new Error(`session fixture wrote to stderr:\n${stderr}`);
		return JSON.parse(stdout) as SessionSchemaReport;
	} finally {
		cleanup();
	}
}

const scratches: TempDir[] = [];
let cold: ColdSessionSchemaReport;
let prewarmed: PrewarmedSessionSchemaReport;

beforeAll(async () => {
	const [coldScratch, prewarmedScratch] = [
		TempDir.createSync("@veyyon-schema-cold-"),
		TempDir.createSync("@veyyon-schema-prewarmed-"),
	];
	scratches.push(coldScratch, prewarmedScratch);
	const [coldReport, prewarmedReport] = await Promise.all([
		report(coldScratch, "cold"),
		report(prewarmedScratch, "prewarmed"),
	]);
	if (coldReport.mode !== "cold" || prewarmedReport.mode !== "prewarmed") throw new Error("fixture mode mismatch");
	cold = coldReport;
	prewarmed = prewarmedReport;
}, 120_000);

afterAll(() => {
	for (const scratch of scratches) scratch.removeSync();
});

describe("a session builds the schema of no tool it has not activated", () => {
	it("constructs every built-in and hidden factory's tool, so every tool is checked", () => {
		expect(cold.unbuiltFactories).toEqual([]);
		expect(prewarmed.unbuiltFactories).toEqual([]);
	});

	it("checks a tool schema for every tool the session registers, with inactive tools among them", () => {
		expect(cold.sessionTools.filter(name => !cold.schemaTools.includes(name))).toEqual([]);
		expect(cold.sessionTools.filter(name => !cold.activeTools.includes(name))).not.toEqual([]);
	});

	it("registers no node while the modules a session imports evaluate", () => {
		expect(cold.builtAtImport).toEqual([]);
	});

	it("registers no node while a session is created once every tool schema exists", () => {
		expect(prewarmed.builtAtCreate).toEqual([]);
		expect(prewarmed.createdNodes).toBe(0);
	});

	it("registers no node while a factory constructs its tool", () => {
		expect(cold.builtByConstruction).toEqual([]);
	});

	it("builds an inactive tool's schema on that tool's first read of its parameters", () => {
		expect(cold.readWithoutBuild.filter(name => !cold.activeTools.includes(name))).toEqual([]);
	});
});
