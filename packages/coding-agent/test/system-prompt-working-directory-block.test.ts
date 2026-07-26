/**
 * The prompt may not order the model to call a tool the model does not have.
 *
 * WHY THIS SUITE EXISTS. The `<working-directory>` block tells the model to "re-root
 * with `set_cwd`" and lists three concrete situations that call for it. That advice
 * is right, and for a long time it was also unfollowable: `set_cwd` is declared
 * `loadMode: "discoverable"`, so under `tools.discoveryMode: all` the SDK removes it
 * from the initial toolset and expects the model to find it through
 * `search_tool_bm25`. The prompt said nothing about that. A model that did exactly
 * what it was told issued a call naming a tool absent from the request, which is the
 * "it just does not work, and not as a false positive -- it does nothing" shape of
 * this bug: the instruction was correct, the model complied, and nothing happened.
 *
 * The block is now conditional on the live tool list, which the prompt data already
 * carries. This suite pins both spellings against the real `buildSystemPrompt`,
 * because the failure is invisible in isolation: the sentence reads perfectly well
 * either way, and only the tool list decides whether it is true.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@veyyon/coding-agent/system-prompt";
import { SET_CWD_TOOL_NAME } from "@veyyon/coding-agent/tools/reroot-hint";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function toolMetadata(names: string[]): Map<string, SystemPromptToolMetadata> {
	return new Map(names.map(name => [name, { label: name, description: `The ${name} tool.` }]));
}

describe("the working-directory block and the tool it names", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-wd-block-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-wd-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	async function promptWithTools(toolNames: string[]): Promise<string> {
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames,
			tools: toolMetadata(toolNames),
			workspaceTree: {
				rootPath: tempDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});
		return systemPrompt.join("\n\n");
	}

	/** The block itself is unconditional: every session needs to know when to re-root. */
	it("always states when to re-root", async () => {
		const text = await promptWithTools(["read", SET_CWD_TOOL_NAME]);

		expect(text).toContain("<working-directory>");
		expect(text).toContain(`Re-root with \`${SET_CWD_TOOL_NAME}\``);
		expect(text).toContain("The user names a project or directory and you are about to work there.");
	});

	/**
	 * THE REGRESSION. With the tool absent the block must say so and name the way to
	 * get it. Without this sentence the instruction is an order to call something the
	 * request does not contain.
	 */
	it("says the tool must be activated first when it is not in the toolset", async () => {
		const text = await promptWithTools(["read", "bash"]);

		expect(text).toContain(`\`${SET_CWD_TOOL_NAME}\` is not in your active toolset right now`);
		expect(text).toContain("search_tool_bm25");
	});

	/**
	 * And the warning disappears once the tool is there. A permanent warning would be
	 * false in the majority of sessions and would teach the model to route every
	 * re-root through a discovery call it does not need.
	 */
	it("omits the activation sentence when the tool is already active", async () => {
		const text = await promptWithTools(["read", SET_CWD_TOOL_NAME]);

		expect(text).not.toContain("is not in your active toolset right now");
	});

	/**
	 * The gate reads the SAME tool list the request is built from, so the two cannot
	 * disagree. This asserts the discriminator rather than the wording: a gate keyed
	 * on anything else (a setting, a discovery mode, a hardcoded assumption) would
	 * pass the two tests above and still be wrong for the session in between.
	 */
	it("keys the sentence on the tool list alone", async () => {
		const withTool = await promptWithTools(["read", SET_CWD_TOOL_NAME]);
		const withoutTool = await promptWithTools(["read"]);

		expect(withoutTool).toContain("is not in your active toolset right now");
		expect(withTool).not.toContain("is not in your active toolset right now");
		// Both carry the rest of the block verbatim, so the only difference is the
		// activation sentence.
		expect(withTool).toContain("Re-rooting loads the destination's `AGENTS.md`");
		expect(withoutTool).toContain("Re-rooting loads the destination's `AGENTS.md`");
	});

	/**
	 * The detected case has to carry the instruction, not only the observation.
	 *
	 * WHY THIS EXISTS. The block above lists three situations that call for a re-root, and the third
	 * is "the working directory is a home, temp, or launch directory rather than the project you
	 * were asked about". `<active-repo-context>` renders when the harness has DETECTED exactly that,
	 * with certainty rather than by inference: the cwd is not itself a repository and exactly one of
	 * its direct children is. That is the least ambiguous re-root case the session will ever see.
	 *
	 * It used to say only that paths under the child are the active project and that a miss at the
	 * parent is inconclusive. Both are true and neither is an instruction. The model was left to
	 * connect a general rule in one block to a concrete detection twenty lines later, every session,
	 * from scratch. Detecting the case correctly and then declining to say what to do about it is
	 * the whole of "the re-rooting rule is not robust": the detection was never the weak part.
	 */
	async function promptWithActiveRepo(relativeRepoRoot: string): Promise<string> {
		const repoRoot = path.join(tempDir, relativeRepoRoot);
		const toolNames = ["read", SET_CWD_TOOL_NAME];
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir,
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames,
			tools: toolMetadata(toolNames),
			activeRepoContext: { cwd: tempDir, repoRoot, relativeRepoRoot, source: "single-direct-child-repo" },
			workspaceTree: {
				rootPath: tempDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});
		return systemPrompt.join("\n\n");
	}

	/**
	 * The session that was never rooted anywhere sensible.
	 *
	 * WHY THIS EXISTS. The block above has listed "the working directory is a home, temp, or launch
	 * directory rather than the project you were asked about" as a re-root case since it was written,
	 * and nothing anywhere ever checked whether it was true. It was advice the model had to apply to
	 * itself from a description, with no signal telling it the description matched, which is the same
	 * shape as every other failure in this area. The check is now real, so the block states the
	 * finding instead of describing a situation the model has to recognise unaided.
	 *
	 * These build the prompt against REAL directories, because the check reads the filesystem: a
	 * temp directory with a manifest in it is a project, and the same directory without one is not.
	 */
	describe("a working directory that is not a project", () => {
		async function promptIn(directory: string): Promise<string> {
			const toolNames = ["read", SET_CWD_TOOL_NAME];
			const { systemPrompt } = await buildSystemPrompt({
				cwd: directory,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames,
				tools: toolMetadata(toolNames),
				workspaceTree: {
					rootPath: directory,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
			});
			return systemPrompt.join("\n\n");
		}

		/**
		 * THE regression. A directory with no `.git`, no manifest and no `AGENTS.md` is not the root
		 * of anything, and the prompt now says so rather than leaving the model to notice.
		 */
		it("says the working directory is not a project root and names why", async () => {
			const bare = path.join(tempDir, "volume");
			fs.mkdirSync(bare, { recursive: true });

			const text = await promptIn(bare);

			expect(text).toContain("is not a project root, because");
			expect(text).toContain("no build manifest");
		});

		/** And it names the action, in the same shape as every other confirmed case in this block. */
		it("tells the model to re-root as soon as it knows the project", async () => {
			const bare = path.join(tempDir, "volume");
			fs.mkdirSync(bare, { recursive: true });

			expect(await promptIn(bare)).toContain(`\`${SET_CWD_TOOL_NAME}\` to its root before doing anything else`);
		});

		/**
		 * The stakes are stated, because they are the reason the instruction is worth following and
		 * they are invisible otherwise: nothing in the transcript announces that no project rules
		 * loaded.
		 */
		it("says that no project rules have loaded", async () => {
			const bare = path.join(tempDir, "volume");
			fs.mkdirSync(bare, { recursive: true });

			expect(await promptIn(bare)).toContain("No project `AGENTS.md` has loaded");
		});

		/**
		 * THE false positive that would make this unbearable. An ordinary project must produce no
		 * such sentence at all, in every session, or the prompt permanently tells correctly-rooted
		 * sessions that they are misrooted.
		 */
		it("says nothing when the working directory carries a manifest", async () => {
			const project = path.join(tempDir, "project");
			fs.mkdirSync(project, { recursive: true });
			fs.writeFileSync(path.join(project, "package.json"), "{}");

			const text = await promptIn(project);

			expect(text).not.toContain("is not a project root");
			expect(text).not.toContain("before doing anything else");
		});

		/**
		 * A container tree is reported by ITS reason rather than the marker one, which matters
		 * because it carries the markers a project carries. Getting the reason right is what makes
		 * the sentence true rather than merely present.
		 */
		it("names the container reason for a repository holding other projects", async () => {
			const container = path.join(tempDir, "container");
			fs.mkdirSync(container, { recursive: true });
			Bun.spawnSync(["git", "init", "--quiet"], { cwd: container });
			fs.writeFileSync(path.join(container, "Cargo.toml"), "");
			const nested = path.join(container, "software", "thing", "thing");
			fs.mkdirSync(nested, { recursive: true });
			Bun.spawnSync(["git", "init", "--quiet"], { cwd: nested });

			const text = await promptIn(container);

			expect(text).toContain("holding other projects rather than being one itself");
		});
	});

	describe("the detected single-child repository", () => {
		/** THE regression: the block now names the call to make, not just the fact it observed. */
		it("tells the model to re-root into the repository it detected", async () => {
			const text = await promptWithActiveRepo("app");

			expect(text).toContain("<active-repo-context>");
			expect(text).toContain(`\`${SET_CWD_TOOL_NAME}\` to \`app\` before you start`);
		});

		/**
		 * The payoff is named, because it is the reason the instruction is worth following. Rules are
		 * found by walking up from the working directory, so a session rooted at the parent never
		 * loads the project's own `AGENTS.md` and works the whole time without its conventions.
		 */
		it("says what re-rooting buys, so the instruction is not arbitrary", async () => {
			expect(await promptWithActiveRepo("app")).toContain("loads that project's `AGENTS.md`");
		});

		/**
		 * The escape hatch survives. A user who deliberately opened the parent to work across
		 * sibling directories must not be re-rooted out of the only place both are visible, and an
		 * instruction with no way to decline gets followed in exactly that case.
		 */
		it("leaves work spanning the parent directory as an exception", async () => {
			expect(await promptWithActiveRepo("app")).toContain("unless the user asked for work spanning the parent");
		});

		/** The observation the instruction rests on is still there, so the model can check it. */
		it("keeps the observation alongside the instruction", async () => {
			const text = await promptWithActiveRepo("app");

			expect(text).toContain("Paths under `app/` are the active project");
			expect(text).toContain("The session cwd is outside git");
		});

		/**
		 * The repository name is interpolated in every sentence that mentions it. A template that
		 * dropped the variable would leave "`set_cwd` to `` before you start", which reads as an
		 * instruction and names nowhere to go.
		 */
		it("names the detected directory rather than leaving the variable empty", async () => {
			const text = await promptWithActiveRepo("nested-project");

			expect(text).toContain("`set_cwd` to `nested-project` before you start");
			expect(text).not.toContain("to `` before you start");
		});

		/**
		 * No detection, no instruction. Telling a session already rooted in its project to re-root
		 * somewhere is the false positive the whole `activeRepoContext` gate exists to avoid.
		 */
		it("says nothing when no single child repository was detected", async () => {
			const text = await promptWithTools(["read", SET_CWD_TOOL_NAME]);

			expect(text).not.toContain("<active-repo-context>");
			expect(text).not.toContain("before you start");
		});
	});
});
