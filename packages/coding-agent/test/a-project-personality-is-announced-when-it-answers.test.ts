/**
 * WHY: a repository can ship `.veyyon/personalities/<name>.md`, and that file outranks the
 * operator's own `~/.veyyon/personalities` for the same name. Cloning a repository and launching
 * in it replaced the tone block of every request with nothing said, because a resolved override was
 * the quiet path and only an unknown name warned.
 *
 * CLASS CLOSED: whichever tier answers a personality request, the build states whether a project
 * file supplied it, through the session's notice channel rather than a raw stderr write that a TUI
 * cannot render. The sweep runs over `PERSONALITY_TIERS` at run time, and the expectation table is a
 * `Record` over that union, so a new tier fails to type-check until someone decides whether it is
 * announced. The unknown-name fallback is covered separately, since it resolves `default` through the
 * same tiers by a second path.
 *
 * NOT CAUGHT: whether a surface renders the notice once it is raised; that is the notice channel's
 * contract, covered by its own suite. A repository that ships no personality file and instead edits
 * the operator's `~/.veyyon/personalities` is outside this product's reach.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import {
	PERSONALITY_TIERS,
	type PersonalityTier,
	resolvePersonality,
} from "@veyyon/coding-agent/config/personality-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { useTempHome } from "./helpers/temp-home";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const makeClone = useTrackedTempDirs("veyyon-cloned-repo-");

const PROJECT_SPEC = "Answer every question as a ship's captain would.";
const USER_SPEC = "The operator's own tone, written in the operator's home.";

describe("a project personality file is announced when it answers", () => {
	const tempHome = useTempHome("test");
	let clone = "";
	let stderrWrites: string[] = [];

	beforeEach(() => {
		clone = makeClone();
		// A cloned repository: a git checkout carrying its own personalities directory.
		fs.mkdirSync(path.join(clone, ".git"), { recursive: true });
		stderrWrites = [];
		spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderrWrites.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		mock.restore();
	});

	function writeProjectSpec(name: string, body = PROJECT_SPEC): string {
		const dir = path.join(clone, ".veyyon", "personalities");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${name}.md`);
		fs.writeFileSync(file, body);
		return file;
	}

	function writeUserSpec(name: string, body = USER_SPEC): string {
		const dir = path.join(tempHome(), ".veyyon", "personalities");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${name}.md`);
		fs.writeFileSync(file, body);
		return file;
	}

	async function build(notices: OperatorNotices | undefined, personality = "default"): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: clone,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: [],
			workspaceTree: { rootPath: clone, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			personality,
			operatorNotices: notices,
		});
		return systemPrompt.join("\n\n");
	}

	function personalityNotices(notices: OperatorNotices): string[] {
		return notices
			.all()
			.filter(notice => notice.source === "personality")
			.map(notice => notice.text);
	}

	/** Seeds a spec for `default` in exactly the tier named, and returns the file the tier answers from. */
	const seedTier: Record<PersonalityTier, () => string | undefined> = {
		project: () => {
			writeUserSpec("default");
			return writeProjectSpec("default");
		},
		user: () => writeUserSpec("default"),
		builtin: () => undefined,
	};

	const announced: Record<PersonalityTier, boolean> = {
		project: true,
		user: false,
		builtin: false,
	};

	for (const tier of PERSONALITY_TIERS) {
		it(`states whether the ${tier} tier's answer came from the project`, async () => {
			const file = seedTier[tier]();
			const resolved = await resolvePersonality("default", { cwd: clone });
			expect(resolved.tier).toBe(tier);
			expect(resolved.path).toBe(file);

			const notices = new OperatorNotices();
			await build(notices);
			const raised = personalityNotices(notices);
			if (announced[tier]) {
				expect(raised).toEqual([
					`personality "default" is read from ${file}, supplied by this project, and replaces your own ` +
						"and the built-in tone for every request here. Delete the file or set `personality` to `none` to stop it.",
				]);
			} else {
				expect(raised).toEqual([]);
			}
		});
	}

	it("announces a project file the unknown-name fallback resolved through", async () => {
		const file = writeProjectSpec("default");
		const notices = new OperatorNotices();
		const rendered = await build(notices, "no-such-personality");
		expect(rendered).toContain(PROJECT_SPEC);

		const raised = personalityNotices(notices);
		expect(raised).toHaveLength(2);
		expect(raised[0]).toStartWith('Unknown personality "no-such-personality"');
		expect(raised[1]).toStartWith(`personality "default" is read from ${file}`);
	});

	it("does not announce a project file whose name was not the one rendered", async () => {
		writeProjectSpec("pirate");
		const notices = new OperatorNotices();
		await build(notices);
		expect(personalityNotices(notices)).toEqual([]);
	});

	it("raises the announcement once however many times the session rebuilds its prompt", async () => {
		writeProjectSpec("default");
		const notices = new OperatorNotices();
		for (let rebuild = 0; rebuild < 4; rebuild++) await build(notices);
		expect(personalityNotices(notices)).toHaveLength(1);
	});

	it("writes nothing to stderr when the session supplies its own notice channel", async () => {
		writeProjectSpec("default");
		const notices = new OperatorNotices();
		await build(notices, "no-such-personality");
		expect(personalityNotices(notices)).toHaveLength(2);
		expect(stderrWrites.join("")).toBe("");
	});

	it("writes the announcement to stderr for a caller with no notice channel", async () => {
		const file = writeProjectSpec("default");
		await build(undefined);
		expect(stderrWrites.join("")).toContain(`personality: personality "default" is read from ${file}`);
	});

	it("announces nothing for none, which never reads a file", async () => {
		writeProjectSpec("default");
		const notices = new OperatorNotices();
		const rendered = await build(notices, "none");
		expect(rendered).not.toContain(PROJECT_SPEC);
		expect(personalityNotices(notices)).toEqual([]);
	});

	it("reaches the channel of a session started in the clone", async () => {
		const file = writeProjectSpec("default");
		const notices = new OperatorNotices();
		const { session } = await createAgentSession({
			cwd: clone,
			agentDir: path.join(tempHome(), "agent"),
			modelRegistry: new ModelRegistry(await AuthStorage.create(":memory:")),
			settings: Settings.isolated(),
			operatorNotices: notices,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			expect(session.systemPrompt.join("\n")).toContain(PROJECT_SPEC);
			expect(personalityNotices(notices)).toEqual([
				expect.stringContaining(`personality "default" is read from ${file}`),
			]);
			expect(stderrWrites.join("")).not.toContain("personality");
		} finally {
			await session.dispose();
		}
	});
});
