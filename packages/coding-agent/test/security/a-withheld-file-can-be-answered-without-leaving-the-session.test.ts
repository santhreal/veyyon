/**
 * WHY THIS SUITE EXISTS.
 *
 * The gate in `opening-a-directory-is-not-consent-to-run-what-is-in-it.test.ts` refuses project
 * code and prints a sentence naming two ways to answer it. A refusal whose recourse does not work
 * is worse than no gate: the operator reads "approve it with `/trust approve`", types that, and
 * the file is still withheld — so they turn the feature off, or stop reading the notice. The class
 * this closes is a named recourse that does not reach the authority the gate reads.
 *
 * It therefore drives the real command logic (`runTrustCommand`, the body behind `veyyon trust`)
 * and the real slash verb (`runTrustSlashCommand`, the body behind `/trust`) against the same
 * store the gate consults, and asserts the load afterwards rather than the store contents.
 *
 * WHAT IT DOES NOT CATCH: the oclif argv parsing in `src/commands/trust.ts` and the TUI plumbing
 * in the slash registry. Both are one call into what is asserted here, and the command-declaration
 * architecture suite already fails when a declared command has no handler.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderTrustReport, runTrustCommand, runTrustSlashCommand } from "../../src/cli/trust-cli";
import { clearClaudePluginRootsCache, listClaudePluginRoots } from "../../src/discovery/helpers";
import { loadExtensions } from "../../src/extensibility/extensions/loader";
import { canonicalProjectRoot, ProjectTrust } from "../../src/security/project-trust";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirFactory();

interface Fixture {
	cwd: string;
	agentDir: string;
	home: string;
}

async function makeFixture(): Promise<Fixture> {
	const root = makeTempDir("veyyon-trust-recourse-");
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(cwd, ".veyyon"), { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { cwd, agentDir, home: root };
}

async function writeRegistry(fixture: Fixture, installPath: string): Promise<string> {
	const registryPath = path.join(fixture.cwd, ".veyyon", "plugins", "installed_plugins.json");
	await fs.mkdir(path.dirname(registryPath), { recursive: true });
	await fs.writeFile(
		registryPath,
		`${JSON.stringify({ version: 1, plugins: { "p@market": [{ version: "1.0.0", installPath }] } }, null, 2)}\n`,
	);
	return registryPath;
}

async function writeExtension(fixture: Fixture, relativePath: string): Promise<string> {
	const absolutePath = path.join(fixture.cwd, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, `export default function () { return { name: "ext" }; }\n`);
	return absolutePath;
}

async function projectRoots(fixture: Fixture): Promise<string[]> {
	clearClaudePluginRootsCache();
	const { roots } = await listClaudePluginRoots(fixture.home, fixture.cwd, undefined, fixture.agentDir);
	return roots.filter(root => root.scope === "project").map(root => root.path);
}

describe("`veyyon trust` decides what the gate then honours", () => {
	it("approves the discovered project registry, and discovery starts reading it", async () => {
		const fixture = await makeFixture();
		const installPath = path.join(fixture.home, "plugin");
		await writeRegistry(fixture, installPath);

		expect(await projectRoots(fixture)).toEqual([]);

		const result = await runTrustCommand({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			action: "approve",
			paths: [],
		});

		expect(result.decision).toBe("trusted");
		expect(result.candidates.map(candidate => candidate.relativePath)).toEqual([
			".veyyon/plugins/installed_plugins.json",
		]);
		expect(result.candidates[0]?.verdict).toBe("trusted");
		expect(await projectRoots(fixture)).toEqual([installPath]);
	});

	it("approves a file named on the command line, which is how a withheld extension is answered", async () => {
		const fixture = await makeFixture();
		const extension = await writeExtension(fixture, "ext/mine.ts");

		const result = await runTrustCommand({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			action: "approve",
			paths: ["ext/mine.ts"],
		});

		expect(result.candidates.map(candidate => candidate.relativePath)).toEqual(["ext/mine.ts"]);
		const load = await loadExtensions([extension], fixture.cwd, undefined, undefined, {
			agentDir: fixture.agentDir,
		});
		expect(load.withheld).toEqual([]);
		expect(load.extensions.length).toBe(1);
	});

	it("reports a path outside the project as nothing to decide, and does not record it", async () => {
		const fixture = await makeFixture();
		const outside = path.join(fixture.home, "not-mine.ts");
		await fs.writeFile(outside, 'export default function () { return { name: "x" }; }\n');

		const result = await runTrustCommand({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			action: "approve",
			paths: [outside],
		});

		expect(result.outOfScope).toEqual([outside]);
		expect(result.candidates).toEqual([]);
		// Nothing was inside the project, so there was nothing to approve — and an empty approval
		// must not write a "trusted" record that a later file could satisfy.
		expect(result.decision).toBe("undecided");
		expect((await ProjectTrust.load(fixture.agentDir)).isDecided(await canonicalProjectRoot(fixture.cwd))).toBe(
			false,
		);
	});

	it("names a path it cannot read, rather than reporting success", async () => {
		const fixture = await makeFixture();

		const result = await runTrustCommand({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			action: "approve",
			paths: ["ext/typo.ts"],
		});

		expect(result.unreadable).toEqual([path.join(fixture.cwd, "ext/typo.ts")]);
		expect(renderTrustReport(result)).toContain("missing");
	});

	it("forgets a denial, so the same project can be decided again", async () => {
		const fixture = await makeFixture();
		const installPath = path.join(fixture.home, "plugin");
		await writeRegistry(fixture, installPath);
		const args = { cwd: fixture.cwd, agentDir: fixture.agentDir, paths: [] as string[] };

		expect((await runTrustCommand({ ...args, action: "deny" })).decision).toBe("denied");
		expect(await projectRoots(fixture)).toEqual([]);
		expect((await runTrustCommand({ ...args, action: "forget" })).decision).toBe("undecided");
		expect(await projectRoots(fixture)).toEqual([]);
		expect((await runTrustCommand({ ...args, action: "approve" })).decision).toBe("trusted");
		expect(await projectRoots(fixture)).toEqual([installPath]);
	});
});

describe("`/trust` answers it from inside a running session", () => {
	it("reports without deciding when it is given no verb", async () => {
		const fixture = await makeFixture();
		await writeRegistry(fixture, path.join(fixture.home, "plugin"));

		const report = await runTrustSlashCommand("", fixture.agentDir, fixture.cwd);

		expect(report).toContain("Decision: undecided");
		expect(report).toContain(".veyyon/plugins/installed_plugins.json");
		expect(await projectRoots(fixture)).toEqual([]);
	});

	it("approves the exact file a refusal named", async () => {
		const fixture = await makeFixture();
		const extension = await writeExtension(fixture, "ext/mine.ts");

		const report = await runTrustSlashCommand("approve ext/mine.ts", fixture.agentDir, fixture.cwd);

		expect(report).toContain("trusted");
		const load = await loadExtensions([extension], fixture.cwd, undefined, undefined, {
			agentDir: fixture.agentDir,
		});
		expect(load.withheld).toEqual([]);
	});

	it("refuses a verb it does not have, instead of guessing at a decision", async () => {
		const fixture = await makeFixture();
		await writeRegistry(fixture, path.join(fixture.home, "plugin"));

		const report = await runTrustSlashCommand("yes please", fixture.agentDir, fixture.cwd);

		expect(report).toContain(`Unknown /trust verb "yes"`);
		expect(await projectRoots(fixture)).toEqual([]);
	});
});
