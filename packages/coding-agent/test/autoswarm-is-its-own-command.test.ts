/**
 * WHY: autoswarm is autoresearch with breadth. It reuses one engine — the same
 * session, store, tools and prompt — but it is its own command, and the serial
 * command has to stay exactly what it was.
 *
 * The class this closes is the two commands collapsing into one: autoswarm
 * disappearing behind a flag on `/autoresearch`, or `/autoresearch` quietly
 * acquiring breadth and stopping being the serial loop. Both are regressions a
 * type check cannot see, because the handlers share a body.
 *
 * What it does not catch: what the arms then do. That is the certification
 * suite, which drives `certify_arms` against a real database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { createAutoresearchExtension } from "@veyyon/coding-agent/autoresearch";
import { closeAllAutoresearchStorages, openAutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import { DEFAULT_SWARM_BREADTH, MAX_BREADTH } from "@veyyon/coding-agent/autoresearch/tools/init-experiment";
import type { ExtensionAPI, ExtensionContext } from "@veyyon/coding-agent/extensibility/extensions";
import * as git from "@veyyon/coding-agent/utils/git";
import type { AutocompleteItem } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { $ } from "bun";

interface CommandSpec {
	description: string;
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface Harness {
	commands: Map<string, CommandSpec>;
	notices: Array<{ text: string; level: string }>;
	messages: string[];
	activeTools: string[];
}

function buildHarness(): Harness {
	const commands = new Map<string, CommandSpec>();
	const notices: Array<{ text: string; level: string }> = [];
	const messages: string[] = [];
	const activeTools: string[] = [];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(): void {},
		registerCommand(name: string, spec: CommandSpec): void {
			commands.set(name, spec);
		},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools: (): string[] => [...activeTools],
		setActiveTools: async (names: string[]): Promise<void> => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage(text: string): void {
			messages.push(text);
		},
		sendMessage(): void {},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	return { commands, notices, messages, activeTools };
}

function makeCtx(cwd: string, notices: Array<{ text: string; level: string }>): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		hasPendingMessages: () => false,
		ui: {
			notify: (text: string, level: string) => {
				notices.push({ text, level });
			},
		},
		sessionManager: {
			getSessionId: () => "session-autoswarm-test",
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
}

describe("autoswarm is its own command", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(async () => {
		dbDir = TempDir.createSync("@pi-autoswarm-cmd-db-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoswarm-cmd-cwd-");
		// Both commands put the session on a dedicated branch before they do
		// anything else, so the handler needs a real repository to reach the
		// behaviour under test.
		await Bun.write(path.join(cwdDir.path(), "README.md"), "# baseline\n");
		await $`git init --initial-branch=main && git config user.email tester@example.com && git config user.name Tester && git add -A && git commit -m baseline && git checkout -b autoresearch/test`
			.cwd(cwdDir.path())
			.quiet();
		vi.spyOn(git.branch, "current").mockResolvedValue("autoresearch/test");
		vi.spyOn(git.repo, "root").mockResolvedValue(cwdDir.path());
	});

	afterEach(() => {
		delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwdDir.removeSync();
		dbDir.removeSync();
		vi.restoreAllMocks();
	});

	it("registers both commands, and they are not the same command", () => {
		const { commands } = buildHarness();
		expect(commands.has("autoresearch")).toBe(true);
		expect(commands.has("autoswarm")).toBe(true);
		expect(commands.get("autoswarm")?.handler).not.toBe(commands.get("autoresearch")?.handler);
		expect(commands.get("autoswarm")?.description).toContain("breadth");
		expect(commands.get("autoresearch")?.description).not.toContain("breadth");
	});

	it("offers breadth on autoswarm and never on autoresearch", () => {
		const { commands } = buildHarness();
		const swarm = commands.get("autoswarm")?.getArgumentCompletions?.("b") ?? [];
		const serial = commands.get("autoresearch")?.getArgumentCompletions?.("b") ?? [];
		expect(swarm.map(item => item.label)).toContain("breadth");
		expect(serial.map(item => item.label)).not.toContain("breadth");
	});

	it("parks the ring-sized default breadth when autoswarm opens with no session", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness.notices);
		await harness.commands.get("autoswarm")?.handler("make it faster", ctx);
		const storage = await openAutoresearchStorage(cwdDir.path());
		// The session is opened later by init_experiment, so the value is parked
		// rather than written. Read it back through the command surface: an
		// autoswarm that parks nothing opens at breadth 1 and runs serially under
		// the swarm name, which is the whole defect.
		expect(DEFAULT_SWARM_BREADTH).toBe(3);
		expect(storage.getActiveSession()).toBeNull();
		expect(harness.messages).toContain("make it faster");
		await harness.commands.get("autoswarm")?.handler("breadth", ctx);
		expect(harness.notices.at(-1)?.text).toBe(
			`Autoswarm breadth is ${DEFAULT_SWARM_BREADTH}: each iteration explores ${DEFAULT_SWARM_BREADTH} arms and cross-reviews them.`,
		);
	});

	it("does not park breadth when autoresearch opens, so the serial loop stays serial", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness.notices);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		await harness.commands.get("autoswarm")?.handler("breadth", ctx);
		expect(harness.notices.at(-1)?.text).toContain("running serially");
	});

	it("leaves breadth alone when autoresearch opens, so the serial loop is unchanged", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness.notices);
		await harness.commands.get("autoresearch")?.handler("make it faster", ctx);
		expect(harness.messages).toContain("make it faster");
		// `/autoresearch breadth 4` is a goal, not a control: the serial command
		// has no breadth subcommand and must forward the text to the model.
		await harness.commands.get("autoresearch")?.handler("breadth 4", ctx);
		expect(harness.messages).toContain("breadth 4");
		expect(harness.notices.map(notice => notice.text).join("\n")).not.toContain("breadth set to");
	});

	it("reports and clamps breadth through autoswarm before a session exists", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness.notices);
		const autoswarm = harness.commands.get("autoswarm");

		await autoswarm?.handler("breadth", ctx);
		expect(harness.notices.at(-1)?.text).toContain("running serially");

		await autoswarm?.handler("breadth 4", ctx);
		expect(harness.notices.at(-1)?.text).toBe("Autoswarm breadth 4 will apply when the session opens.");

		await autoswarm?.handler("breadth", ctx);
		expect(harness.notices.at(-1)?.text).toContain("Autoswarm breadth is 4");

		await autoswarm?.handler(`breadth ${MAX_BREADTH + 1}`, ctx);
		expect(harness.notices.at(-1)?.level).toBe("error");
		await autoswarm?.handler("breadth nonsense", ctx);
		expect(harness.notices.at(-1)?.level).toBe("error");
	});

	it("disables under the name it was invoked with", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(cwdDir.path(), harness.notices);
		await harness.commands.get("autoswarm")?.handler("off", ctx);
		expect(harness.notices.at(-1)?.text).toBe("Autoswarm mode disabled");
		await harness.commands.get("autoresearch")?.handler("off", ctx);
		expect(harness.notices.at(-1)?.text).toBe("Autoresearch mode disabled");
	});
});
