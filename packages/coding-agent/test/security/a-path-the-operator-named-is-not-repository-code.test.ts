/**
 * WHY THIS SUITE EXISTS.
 *
 * The defect: the project-trust gate withheld the operator's OWN extension. `veyyon --extension
 * ./dev/tool.ts` names a path deliberately, and while that file is being written it lives inside
 * the project — so the gate, which exists to stop a cloned repository from executing code nobody
 * chose, refused the one path the operator chose. Three ways in were affected: the session
 * (`createAgentSession`, which passed no trust options at all and so also read the decisions of
 * whichever profile the process booted with rather than the session's), `veyyon models
 * --disable-extension-discovery`, and any configured entry naming a DIRECTORY, because discovery
 * expands a directory into the entry files inside it and the exemption compared exact paths.
 *
 * THE CLASS THIS CLOSES: a path the operator named being treated as repository-controlled. It is
 * closed at the gate itself (`loadExtensions`, the only function in the product that imports an
 * extension module) for the file form and the directory form, and at the session entry point that
 * had forgotten to say so. The negative control is the whole point of the pairing: a project
 * extension the operator did NOT name is still withheld in the same fixture, so a fix that
 * widened the gate into "anything inside the project loads" fails here.
 *
 * WHAT IT DOES NOT CATCH. It does not enumerate every future caller of `loadExtensions`; the trust
 * options are still an optional argument, so a NEW call site can forget them and the failure mode
 * is a refusal rather than an execution. That direction is the safe one, and the two callers that
 * exist are driven here.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { type OperatorNotice, OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { loadExtensions } from "../../src/extensibility/extensions/loader";
import { createAgentSession } from "../../src/sdk";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirFactory();

interface Fixture {
	cwd: string;
	agentDir: string;
	/** Written by the extension's top-level code, from outside the project, so "it ran" is a file. */
	sentinel: string;
}

async function makeFixture(): Promise<Fixture> {
	const root = makeTempDir("veyyon-named-path-");
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	return { cwd, agentDir, sentinel: path.join(root, "ran") };
}

/** An extension inside the project whose factory registers one command, plus a load sentinel. */
async function writeProjectExtension(fixture: Fixture, relativePath: string, name: string): Promise<string> {
	const absolutePath = path.join(fixture.cwd, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(
		absolutePath,
		[
			`import { writeFileSync } from "node:fs";`,
			`writeFileSync(${JSON.stringify(fixture.sentinel)}, ${JSON.stringify(name)});`,
			`export default function (api) {`,
			`  api.registerCommand?.({ name: ${JSON.stringify(name)}, description: "x", handler: async () => {} });`,
			`}`,
			"",
		].join("\n"),
	);
	return absolutePath;
}

async function ran(fixture: Fixture): Promise<boolean> {
	try {
		await fs.stat(fixture.sentinel);
		return true;
	} catch {
		return false;
	}
}

describe("a path the operator named is not repository code", () => {
	it("loads a project file named as a configured path", async () => {
		const fixture = await makeFixture();
		const extension = await writeProjectExtension(fixture, "dev/tool.ts", "named-file");

		const result = await loadExtensions([extension], fixture.cwd, undefined, undefined, {
			agentDir: fixture.agentDir,
			configuredPaths: [extension],
		});

		expect(result.withheld).toEqual([]);
		expect(result.errors).toEqual([]);
		expect(result.extensions.map(loaded => loaded.path)).toEqual([extension]);
		expect(await ran(fixture)).toBe(true);
	});

	it("loads a project file reached through a configured directory", async () => {
		const fixture = await makeFixture();
		const extension = await writeProjectExtension(fixture, "dev/tool.ts", "named-dir");
		const configuredDirectory = path.join(fixture.cwd, "dev");

		// Discovery expands a configured directory into its entry files, so the gate sees the FILE
		// while the operator named the DIRECTORY. Exact-path equality refused exactly this.
		const result = await loadExtensions([extension], fixture.cwd, undefined, undefined, {
			agentDir: fixture.agentDir,
			configuredPaths: [configuredDirectory],
		});

		expect(result.withheld).toEqual([]);
		expect(result.extensions.map(loaded => loaded.path)).toEqual([extension]);
		expect(await ran(fixture)).toBe(true);
	});

	it("still withholds a project file nobody named, in the same fixture", async () => {
		const fixture = await makeFixture();
		const named = await writeProjectExtension(fixture, "dev/tool.ts", "named");
		const unnamed = await writeProjectExtension(fixture, "dev/other.ts", "unnamed");

		const result = await loadExtensions([named, unnamed], fixture.cwd, undefined, undefined, {
			agentDir: fixture.agentDir,
			configuredPaths: [named],
		});

		expect(result.withheld.map(entry => entry.path)).toEqual([unnamed]);
		expect(result.withheld[0]?.reason).toContain("dev/other.ts");
		expect(result.extensions.map(loaded => loaded.path)).toEqual([named]);
	});

	it("a directory named by the operator does not exempt a sibling outside it", async () => {
		const fixture = await makeFixture();
		const inside = await writeProjectExtension(fixture, "dev/tool.ts", "inside");
		const outside = await writeProjectExtension(fixture, "dev-extra/tool.ts", "outside");

		// `dev-extra` shares a prefix with `dev`; containment is a path-segment question, not a
		// string-prefix one, and this is the case a `startsWith` exemption would get wrong.
		const result = await loadExtensions([inside, outside], fixture.cwd, undefined, undefined, {
			agentDir: fixture.agentDir,
			configuredPaths: [path.join(fixture.cwd, "dev")],
		});

		expect(result.withheld.map(entry => entry.path)).toEqual([outside]);
		expect(result.extensions.map(loaded => loaded.path)).toEqual([inside]);
	});

	it("a session started with the path loads it and says nothing about trust", async () => {
		const fixture = await makeFixture();
		const extension = await writeProjectExtension(fixture, "dev/session-tool.ts", "session-named");
		const shown: OperatorNotice[] = [];
		const authStorage = await AuthStorage.create(path.join(fixture.agentDir, "auth.db"));

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated(),
			operatorNotices: new OperatorNotices(notice => shown.push(notice)),
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(shown.filter(notice => notice.source === "extensions")).toEqual([]);
			expect(await ran(fixture)).toBe(true);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	/**
	 * The subagent branch: the child skips discovery and loads the parent's resolved path list.
	 * The named subset travels beside it, because a child that cannot tell a named path from a
	 * discovered one re-gates its parent's `--extension` and starts without it — while a project
	 * file nobody named stays withheld, which the second half of this case asserts.
	 */
	it("a subagent inheriting the parent's paths keeps the named one and still withholds the rest", async () => {
		const fixture = await makeFixture();
		const named = await writeProjectExtension(fixture, "dev/inherited.ts", "inherited-named");
		const discovered = await writeProjectExtension(fixture, "dev/scanned.ts", "inherited-scan");
		const shown: OperatorNotice[] = [];
		const authStorage = await AuthStorage.create(path.join(fixture.agentDir, "auth-sub.db"));

		const { session } = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated(),
			operatorNotices: new OperatorNotices(notice => shown.push(notice)),
			preloadedExtensionPaths: [named, discovered],
			preloadedNamedExtensionPaths: [named],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(await ran(fixture)).toBe(true);
			const trustNotices = shown.filter(notice => notice.source === "extensions");
			expect(trustNotices).toHaveLength(1);
			expect(trustNotices[0].text).toContain("dev/scanned.ts");
			expect(trustNotices[0].text).not.toContain("dev/inherited.ts");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
