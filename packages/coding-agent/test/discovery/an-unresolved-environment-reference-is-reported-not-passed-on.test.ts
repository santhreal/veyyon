/**
 * WHY. `${VAR}` expansion re-emitted the literal `${VAR}` when a variable was unset, so an
 * unresolved reference was indistinguishable from config text. Every consumer had to rediscover the
 * residue: the MCP connect path eventually refused it in a structural field, and the eight discovery
 * providers that expand a config reported nothing at all, so a mistyped or unexported variable
 * produced a server that could not start with no line anywhere naming the variable.
 *
 * The class this closes: a consumer of the expansion that silently passes the residue on. It is
 * closed by the signature — `expandEnvVarsDeep` takes the sink that receives the reports, and the
 * parameter is required, so a new consumer cannot inherit silence by omitting an argument. It must
 * name a decision: warn, read the reports, or discard them with the guard that refuses them named.
 *
 * Pinned here: the reports themselves (field path, variable, no value), that a resolved reference
 * and a defaulted reference produce none, that the discard sink refuses an unnamed reason, and that
 * a discovery provider turns a report into a warning naming the file and the variable. The sink set
 * is pinned by exact equality, so a fourth "quietly ignore" helper turns this red.
 *
 * What it does not catch: a consumer that passes a sink and then throws the warnings away further
 * up its own return path. The warning surfaces are each provider's `LoadResult`, and only the
 * `native` provider's end-to-end path is exercised below.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@veyyon/coding-agent/capability/mcp";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import * as expansion from "@veyyon/coding-agent/discovery/env-expansion";
import {
	collectUnresolved,
	expandEnvVarsDeep,
	unresolvedRefusedDownstream,
	warnUnresolved,
} from "@veyyon/coding-agent/discovery/env-expansion";
import { removeWithRetries, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

const ABSENT = "VEYYON_TEST_UNSET_EXPANSION_VAR";
const D = "$";
const ref = (name: string) => `${D}{${name}}`;

describe("an unresolved environment reference", () => {
	test("is reported with the field it sits in and the variable that is not set", () => {
		const sink = collectUnresolved();
		const value = expandEnvVarsDeep(
			{ command: ref(ABSENT), args: ["--root", `--flag=${ref(ABSENT)}`], nested: { url: ref("OTHER_UNSET") } },
			sink,
			{},
		);
		expect(sink.refs).toEqual([
			{ field: "command", variable: ABSENT },
			{ field: "args[1]", variable: ABSENT },
			{ field: "nested.url", variable: "OTHER_UNSET" },
		]);
		// The value keeps the literal: a consumer that acts on it is refused by name downstream
		// rather than handed an empty string that reads as a deliberate setting.
		expect(value.command).toBe(ref(ABSENT));
	});

	test("is not reported when the variable resolves or the reference carries a default", () => {
		const sink = collectUnresolved();
		const value = expandEnvVarsDeep({ a: ref("FOO"), b: [`${D}{BAR:-def}`, 5], c: true }, sink, { FOO: "vfoo" });
		expect(value).toEqual({ a: "vfoo", b: ["def", 5], c: true });
		expect(sink.refs).toEqual([]);
	});

	test("names the variable and the field in a warning, and quotes no value", () => {
		const warnings: string[] = [];
		expandEnvVarsDeep({ srv: { url: ref(ABSENT) } }, warnUnresolved(warnings, "/cfg/mcp.json"), {
			SECRET: "hunter2",
		});
		expect(warnings).toEqual([`/cfg/mcp.json: environment variable ${ABSENT} is not set in srv.url`]);
		expect(warnings[0]).not.toContain("hunter2");
	});

	test("cannot be discarded without naming the guard that refuses it", () => {
		expect(() => unresolvedRefusedDownstream("   ")).toThrow(TypeError);
		expect(() => unresolvedRefusedDownstream("the MCP connect guard")).not.toThrow();
	});

	test("has exactly three sinks, so a silent fourth cannot be added unnoticed", () => {
		const sinks = Object.keys(expansion)
			.filter(name => name.endsWith("Unresolved") || name.startsWith("unresolved"))
			.sort();
		expect(sinks).toEqual(["collectUnresolved", "unresolvedRefusedDownstream", "warnUnresolved"]);
	});
});

describe("a discovered MCP config naming a variable that is not set", () => {
	let agentDir = "";
	const dirOverrides = captureDirOverrides();

	beforeEach(async () => {
		delete process.env[ABSENT];
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-expansion-"));
		setAgentDir(agentDir);
		clearFsCache();
	});

	afterEach(async () => {
		restoreDirOverrides(dirOverrides);
		clearFsCache();
		await removeWithRetries(agentDir);
	});

	test("reports the file and the variable as a discovery warning", async () => {
		const configPath = path.join(agentDir, "mcp.json");
		await fs.writeFile(
			configPath,
			JSON.stringify({ mcpServers: { probe: { command: "server", args: [`--token=${ref(ABSENT)}`] } } }),
		);

		const result = await loadCapability<MCPServer>(mcpCapability.id, { providers: ["native"] });
		const reported = result.warnings.filter(w => w.includes(ABSENT));
		// `[Veyyon]` is the provider's own prefix on every warning it reports.
		expect(reported).toEqual([`[Veyyon] ${configPath}: environment variable ${ABSENT} is not set in probe.args[0]`]);
	});
});
