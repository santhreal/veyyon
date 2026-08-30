/**
 * WHY: two changes to `task/discovery.ts` that a suite has to hold in place.
 *
 * 1. THE USER-AUTHORED DEFINITIONS DIRECTORY IS GLOBAL. It moved from the
 *    profile's `agents/` to `<configRoot>/subagents`, so switching profile
 *    changes which agents are ENABLED and never which ones exist. The class
 *    this closes is "a discovery source silently stops being scanned": each
 *    earlier move left a suite writing fixtures into a directory nothing read,
 *    and the suite went on passing having proved nothing. Every case here
 *    asserts the agent is FOUND, so a source that stops being scanned fails.
 *
 * 2. A `tools:` NAME NOBODY RECOGNIZES IS REPORTED. `tools: [reed, serch]`
 *    normalizes to two names that resolve to nothing, so the agent runs with no
 *    tools and the tool-gated statements drop out of its system prompt — which
 *    reads exactly like a working agent that decided to do nothing. The report
 *    is warn-only, so the agent still loads; the class is "a definition whose
 *    tool list is wrong loads silently". The check is deliberately narrow: a
 *    namespaced name (`mcp__server__tool`, an extension tool) cannot be
 *    enumerated at parse time and must never be reported.
 *
 * Not caught here: whether a namespaced tool actually resolves at spawn time.
 * That is the MCP/extension registry's contract, not the parser's, and a
 * definition naming an MCP server that is not configured is a runtime miss
 * rather than a typo the loader can see.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { discoverAgents } from "@veyyon/coding-agent/task/discovery";
import {
	attachFaultSink,
	type DetachFaultSink,
	type Fault,
	getGlobalSubagentsDir,
	removeWithRetries,
	SUBAGENTS_DIR_NAME,
} from "@veyyon/utils";

function definition(name: string, tools?: string[]): string {
	const frontmatter = ["---", `name: ${name}`, `description: ${name} does one thing.`];
	if (tools) frontmatter.push(`tools: [${tools.join(", ")}]`);
	frontmatter.push("---");
	return [...frontmatter, `You are ${name}.`].join("\n");
}

describe("user subagents are global and their tools are checked", () => {
	let tempHome = "";
	let projectDir = "";
	let configRoot = "";
	let subagentsDir = "";
	let faults: Fault[] = [];
	let detach: DetachFaultSink | undefined;
	let previousConfigDir: string | undefined;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-global-subagents-"));
		projectDir = path.join(tempHome, "project");
		configRoot = path.join(tempHome, "config");
		subagentsDir = path.join(configRoot, SUBAGENTS_DIR_NAME);
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(subagentsDir, { recursive: true });
		previousConfigDir = process.env.VEYYON_CONFIG_DIR;
		process.env.VEYYON_CONFIG_DIR = configRoot;
		faults = [];
		detach = attachFaultSink(fault => faults.push(fault));
	});

	afterEach(async () => {
		detach?.();
		detach = undefined;
		if (previousConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
		else process.env.VEYYON_CONFIG_DIR = previousConfigDir;
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	/** Only this suite's own faults, so a host-level report cannot pass or fail it. */
	function agentFaults(): Fault[] {
		return faults.filter(
			fault => fault.source === "agents" && String(fault.context?.filePath).startsWith(subagentsDir),
		);
	}

	test("resolves the directory off the config root, not off a profile", () => {
		expect(getGlobalSubagentsDir()).toBe(subagentsDir);
		expect(path.basename(getGlobalSubagentsDir())).toBe(SUBAGENTS_DIR_NAME);
		// The profile segment must not appear: that is what made the directory
		// profile-scoped before.
		expect(getGlobalSubagentsDir()).not.toContain(`${path.sep}profiles${path.sep}`);
	});

	test("finds a definition there whatever profile the caller names", async () => {
		await fs.writeFile(path.join(subagentsDir, "surveyor.md"), definition("surveyor"));

		const withoutProfile = await discoverAgents(projectDir, tempHome);
		const withProfileA = await discoverAgents(projectDir, tempHome, path.join(configRoot, "profiles", "a"));
		const withProfileB = await discoverAgents(projectDir, tempHome, path.join(configRoot, "profiles", "b"));

		for (const result of [withoutProfile, withProfileA, withProfileB]) {
			const found = result.agents.find(agent => agent.name === "surveyor");
			expect(found).toBeDefined();
			expect(found?.source).toBe("user");
		}
	});

	test("a user definition outranks the bundled agent of the same name", async () => {
		const bundled = (await discoverAgents(projectDir, tempHome)).agents;
		const target = bundled.find(agent => agent.source === "bundled");
		expect(target).toBeDefined();
		const name = target?.name ?? "";

		await fs.writeFile(path.join(subagentsDir, `${name}.md`), definition(name));
		const { agents } = await discoverAgents(projectDir, tempHome);

		const matches = agents.filter(agent => agent.name === name);
		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe("user");
	});

	test("reports every unrecognized bare tool name, naming the file", async () => {
		const filePath = path.join(subagentsDir, "typo.md");
		await fs.writeFile(filePath, definition("typo", ["reed", "serch"]));

		const { agents } = await discoverAgents(projectDir, tempHome);

		// Warn-only: the agent still loads, so a typo does not remove it.
		expect(agents.map(agent => agent.name)).toContain("typo");

		const reported = agentFaults();
		expect(reported).toHaveLength(1);
		expect(reported[0].context?.filePath).toBe(filePath);
		expect(reported[0].context?.tools).toEqual(["reed", "serch"]);
		expect(reported[0].text).toContain(filePath);
		expect(reported[0].text).toContain("reed, serch");
	});

	test("says nothing about a namespaced third-party tool", async () => {
		await fs.writeFile(
			path.join(subagentsDir, "proxied.md"),
			definition("proxied", ["read", "mcp__github__list_issues", "some_extension__do_thing"]),
		);

		const { agents } = await discoverAgents(projectDir, tempHome);

		expect(agents.map(agent => agent.name)).toContain("proxied");
		expect(agentFaults()).toEqual([]);
	});

	test("says nothing about a definition whose tools are all built in", async () => {
		await fs.writeFile(path.join(subagentsDir, "reader.md"), definition("reader", ["read", "search"]));

		const { agents } = await discoverAgents(projectDir, tempHome);

		expect(agents.map(agent => agent.name)).toContain("reader");
		expect(agentFaults()).toEqual([]);
	});

	test("reports only the unrecognized names when a list mixes both", async () => {
		const filePath = path.join(subagentsDir, "mixed.md");
		await fs.writeFile(filePath, definition("mixed", ["read", "wirte", "mcp__x__y"]));

		await discoverAgents(projectDir, tempHome);

		const reported = agentFaults();
		expect(reported).toHaveLength(1);
		expect(reported[0].context?.tools).toEqual(["wirte"]);
	});
});
