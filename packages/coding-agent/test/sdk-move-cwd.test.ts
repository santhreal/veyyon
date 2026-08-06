import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake, setAgentDir } from "@veyyon/utils";
import { isolatedAuthStorage } from "./helpers/isolated-auth-storage";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	let globals: SettingsTestState | undefined;

	afterEach(() => {
		// Before the rm: the restore chdirs into the snapshotted dir.
		restoreSettingsTestState(globals);
		globals = undefined;
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		// `moveTo` only keeps an explicitly-pinned session dir when that dir's
		// basename is the ENCODED cwd name (`resolveManagedSessionRoot`); a literal
		// path like this one is treated as unmanaged and the move falls back to the
		// GLOBAL sessions root. A real run has that root inside the agent dir, so
		// pin the agent dir at a temp root rather than the operator's real one.
		globals = beginSettingsTest();
		setAgentDir(tempDir);
		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			authStorage: await isolatedAuthStorage(tempDir),
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["bash"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(result)).toContain(cwdB);
		} finally {
			await session.dispose();
		}
	});

	/**
	 * Calling the rebuild hook is not enough: its closure must read the live cwd
	 * and rediscover destination AGENTS.md. The old closure rebuilt byte-for-byte
	 * from startup captures while tools had already moved.
	 */
	it("rebuilds prompt bytes and project instructions for the moved directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-prompt-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		fs.writeFileSync(path.join(cwdA, "AGENTS.md"), "ORIGIN_AGENTS_MARKER\n");
		fs.writeFileSync(path.join(cwdB, "AGENTS.md"), "DESTINATION_AGENTS_MARKER\n");

		globals = beginSettingsTest();
		setAgentDir(tempDir);
		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			authStorage: await isolatedAuthStorage(tempDir),
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
		});

		try {
			const before = session.agent.state.systemPrompt.join("\n\n");
			expect(before).toContain(`the current working directory is '${cwdA}'`);
			expect(before).toContain("ORIGIN_AGENTS_MARKER");
			expect(before).not.toContain("DESTINATION_AGENTS_MARKER");

			await session.setCwd(cwdB);

			const after = session.agent.state.systemPrompt.join("\n\n");
			expect(after).toContain(`the current working directory is '${cwdB}'`);
			expect(after).toContain("DESTINATION_AGENTS_MARKER");
			expect(after).not.toContain("ORIGIN_AGENTS_MARKER");
			expect(after).not.toBe(before);
		} finally {
			await session.dispose();
		}
	});

	/**
	 * Project-installed extension skills are cwd-scoped. A move must replace the
	 * live session and tool resolver inventory, not only repaint the prompt.
	 */
	it("replaces project extension skills when the session moves", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-skills-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		const agentDir = path.join(tempDir, "agent");

		const installProjectSkill = (project: string, packageName: string, skillName: string): void => {
			const pluginsDir = path.join(project, ".veyyon", "plugins");
			const packageDir = path.join(pluginsDir, "node_modules", packageName);
			const skillDir = path.join(packageDir, "skills", skillName);
			fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
			fs.mkdirSync(skillDir, { recursive: true });
			fs.writeFileSync(
				path.join(packageDir, "package.json"),
				JSON.stringify({ name: packageName, veyyon: { extensions: ["./src/main.ts"] } }),
			);
			fs.writeFileSync(path.join(packageDir, "src", "main.ts"), "export default function () {}\n");
			fs.writeFileSync(
				path.join(skillDir, "SKILL.md"),
				`---\nname: ${skillName}\ndescription: ${skillName} description\n---\n${skillName} body\n`,
			);
			fs.writeFileSync(
				path.join(pluginsDir, "veyyon-plugins.lock.json"),
				JSON.stringify({
					plugins: { [packageName]: { version: "1.0.0", enabled: true, enabledFeatures: null } },
					settings: {},
				}),
			);
		};

		installProjectSkill(cwdA, "project-a-skills", "only-a");
		installProjectSkill(cwdB, "project-b-skills", "only-b");
		fs.mkdirSync(agentDir, { recursive: true });

		globals = beginSettingsTest();
		setAgentDir(agentDir);
		const sessionManager = SessionManager.create(cwdA, path.join(agentDir, "sessions"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage: await isolatedAuthStorage(agentDir),
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			contextFiles: [],
			rules: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
		});

		try {
			expect(session.skills.map(skill => skill.name)).toEqual(["only-a"]);

			await session.setCwd(cwdB);

			expect(session.skills.map(skill => skill.name)).toEqual(["only-b"]);
		} finally {
			await session.dispose();
		}
	});

	/**
	 * TTSR matchers are executable project policy. Keeping the source matcher
	 * after a cwd move leaks policy even if the visible prompt has been rebuilt.
	 *
	 * The cwd-scoped rule source is a project-INSTALLED extension package
	 * (`.veyyon/plugins/node_modules/<pkg>/rules/`), not a checked-in
	 * `<cwd>/.veyyon/rules/`. eea8680b6 / 0adabd386 removed the project layer from
	 * `getConfigDirs`, so a repository's own `.veyyon/rules/` is never read: the
	 * operator installing a plugin is the grant, the checkout is not. Rediscovery
	 * on move is still the contract, because the installed set differs per project.
	 */
	it("replaces project TTSR rules when the session moves", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-rules-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		const agentDir = path.join(tempDir, "agent");

		const installProjectRule = (project: string, packageName: string, name: string, condition: string): void => {
			const pluginsDir = path.join(project, ".veyyon", "plugins");
			const packageDir = path.join(pluginsDir, "node_modules", packageName);
			fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
			fs.mkdirSync(path.join(packageDir, "rules"), { recursive: true });
			fs.writeFileSync(
				path.join(packageDir, "package.json"),
				JSON.stringify({ name: packageName, veyyon: { extensions: ["./src/main.ts"] } }),
			);
			fs.writeFileSync(path.join(packageDir, "src", "main.ts"), "export default function () {}\n");
			fs.writeFileSync(
				path.join(packageDir, "rules", `${name}.md`),
				`---\ndescription: ${name}\ncondition: ${condition}\nscope: [text]\n---\n${name} body\n`,
			);
			fs.writeFileSync(
				path.join(pluginsDir, "veyyon-plugins.lock.json"),
				JSON.stringify({
					plugins: { [packageName]: { version: "1.0.0", enabled: true, enabledFeatures: null } },
					settings: {},
				}),
			);
		};
		installProjectRule(cwdA, "project-a-rules", "source-only", "SOURCE_TRIGGER");
		installProjectRule(cwdB, "project-b-rules", "destination-only", "DESTINATION_TRIGGER");
		fs.mkdirSync(agentDir, { recursive: true });

		globals = beginSettingsTest();
		setAgentDir(agentDir);
		const sessionManager = SessionManager.create(cwdA, path.join(agentDir, "sessions"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage: await isolatedAuthStorage(agentDir),
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			contextFiles: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
		});

		try {
			expect(session.ttsrManager?.getRules().map(rule => rule.name)).toContain("source-only");
			expect(session.ttsrManager?.getRules().map(rule => rule.name)).not.toContain("destination-only");

			await session.setCwd(cwdB);

			expect(session.ttsrManager?.getRules().map(rule => rule.name)).toContain("destination-only");
			expect(session.ttsrManager?.getRules().map(rule => rule.name)).not.toContain("source-only");
		} finally {
			await session.dispose();
		}
	});
});

// WHY THIS SUITE EXISTS (BACKLOG DOG-R2-8: the "false failure" report)
// -------------------------------------------------------------------
// The session cwd is the SINGLE authority every tool resolves against
// (`resolveToCwd(path, session.cwd)`). `SessionManager.setCwd`/`moveTo` used to
// resolve a relative target with bare `path.resolve(target)`, whose hidden base is
// `process.cwd()` (the OS process dir), NOT the session cwd. When those two bases
// differed, a relative `set_cwd` could validate one directory while the tools
// pointed at another — the dogfood report where `set_cwd home/x` returned
// "Directory does not exist" yet bash/eval still moved. These tests pin the base
// to the session cwd and prove validation never mutates on failure.
describe("SessionManager.setCwd single cwd authority", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	function freshRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-setcwd-auth-${Snowflake.next()}-`));
		tempDirs.push(root);
		return root;
	}

	it("resolves a relative target against the session cwd, not process.cwd()", async () => {
		const root = freshRoot();
		const child = path.join(root, "child");
		fs.mkdirSync(child, { recursive: true });
		// Guard the premise: the process cwd is NOT the session root, and the process
		// cwd has no "child", so a `process.cwd()`-based resolve would 404 or misfire.
		expect(path.resolve(process.cwd())).not.toBe(path.resolve(root));
		expect(fs.existsSync(path.join(process.cwd(), "child"))).toBe(false);

		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const resolved = await sessionManager.setCwd("child");

		expect(resolved).toBe(child);
		expect(sessionManager.getCwd()).toBe(child);
	});

	it("resolves `..` against the session cwd", async () => {
		const root = freshRoot();
		const child = path.join(root, "child");
		fs.mkdirSync(child, { recursive: true });

		const sessionManager = SessionManager.create(child, path.join(root, "sessions"));
		const resolved = await sessionManager.setCwd("..");

		expect(resolved).toBe(path.resolve(root));
		expect(sessionManager.getCwd()).toBe(path.resolve(root));
	});

	it("an absolute target ignores the session cwd base", async () => {
		const root = freshRoot();
		const other = path.join(root, "other");
		fs.mkdirSync(other, { recursive: true });

		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const resolved = await sessionManager.setCwd(other);

		expect(resolved).toBe(other);
		expect(sessionManager.getCwd()).toBe(other);
	});

	it("a failed validation leaves the session cwd UNCHANGED (no false-failure-with-mutation)", async () => {
		const root = freshRoot();
		const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
		const before = sessionManager.getCwd();

		// Relative miss: names the absolute path under the SESSION cwd, and does not move.
		await expect(sessionManager.setCwd("no-such-dir")).rejects.toThrow(
			new RegExp(
				`Directory does not exist: ${path.join(root, "no-such-dir").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
			),
		);
		expect(sessionManager.getCwd()).toBe(before);
	});
});
