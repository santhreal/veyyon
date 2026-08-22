/**
 * A working-directory change must rebuild the base system prompt.
 *
 * WHY THIS SUITE EXISTS. The prompt carries the workspace tree, the discovered
 * context files (AGENTS.md / CLAUDE.md), the skills and the active-repo-context
 * block. All of it is assembled ONCE, when the session is built.
 *
 * `applyCwdChange` re-scoped everything else on a `/cd`, `/move`, `/cwd`, or the
 * agent's own `set_cwd` — settings, plugin roots, capabilities, slash commands,
 * the ssh tool — but never rebuilt the prompt. So after moving, the agent was
 * still told it was working in the PREVIOUS project: it followed the old
 * project's AGENTS.md instructions and resolved relative paths against a
 * directory it had already left. The failure is invisible from inside the model,
 * which simply believes what the prompt says.
 *
 * WHAT FLIPPED, AND WHY THIS SUITE CHANGED. The prompt used to also state the
 * path verbatim ("the current working directory is '<path>'"), and this suite
 * asserted exactly that, on the premise that a prompt independent of cwd would
 * make the rebuild pointless. The premise held and the sentence was the problem:
 * the prompt is the provider's cache prefix, so a move that changed nothing else
 * still discarded the cached prefix for the whole conversation to restate one
 * path. The path is delivered as a turn message now, and the assertion below is
 * the same premise stated against what still differs — the RULES the destination
 * loads, which is the reason the rebuild is worth its cost.
 * `test/session/a-re-root-does-not-rewrite-the-cached-prompt-prefix.test.ts`
 * owns the other half: that a move inside one project rebuilds to identical
 * bytes.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

async function promptFor(
	cwd: string,
	contextFiles: { path: string; content: string; level: "project" }[],
): Promise<string> {
	const result = await buildSystemPrompt({
		toolNames: ["read"],
		contextFiles,
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
		cwd,
	});
	return result.systemPrompt.join("\n");
}

describe("the system prompt is directory-specific", () => {
	/**
	 * The premise of the whole contract: if the prompt did NOT depend on cwd,
	 * skipping the rebuild would be harmless and this suite would be pointless. It
	 * depends on it through the rules the destination loads, which is what a stale
	 * prompt gets wrong — the agent follows the previous project's instructions.
	 */
	it("carries the destination project's rules, and changes when the project changes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-cwd-rules-"));
		const alphaDir = path.join(root, "project-alpha");
		const betaDir = path.join(root, "project-beta");
		fs.mkdirSync(alphaDir);
		fs.mkdirSync(betaDir);
		try {
			const alpha = await promptFor(alphaDir, [
				{ path: path.join(alphaDir, "AGENTS.md"), content: "Alpha rule: two spaces.", level: "project" },
			]);
			const beta = await promptFor(betaDir, [
				{ path: path.join(betaDir, "AGENTS.md"), content: "Beta rule: tabs only.", level: "project" },
			]);

			expect(alpha).toContain("Alpha rule: two spaces.");
			expect(beta).toContain("Beta rule: tabs only.");
			// The stale-prompt bug in one assertion: serving the alpha prompt after a
			// move to beta hands the model the wrong project's rules.
			expect(alpha).not.toContain("Beta rule: tabs only.");
			expect(alpha).not.toBe(beta);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("applyCwdChange re-scopes the destination through the session", () => {
	/**
	 * The rebuild itself lives on `AgentSession.rescopeToCwd`, where every mode
	 * reaches it, and `test/session/rescope-to-cwd.test.ts` covers it. What is left
	 * to prove here is the TUI's own wiring, and it matters because
	 * `applyCwdChange` has three callers and only ONE goes through `setCwd`.
	 * `/move` calls `sessionManager.moveTo` directly, and resuming a session from
	 * another project calls `switchSession`; neither raises `cwd_changed`, so
	 * neither re-scopes unless this method asks for it.
	 *
	 * The method is driven for real on a bare prototype instance rather than read
	 * as source text. Constructing an `InteractiveMode` pulls in the whole TUI,
	 * which is why this was a source scan for so long; the method itself touches
	 * only six members, so supplying those and calling it exercises the shipped
	 * body and fails on a call that was removed, reordered past the re-scope, or
	 * pointed at the wrong destination.
	 */
	it("re-scopes the session to the destination before refreshing its own chrome", async () => {
		const calls: string[] = [];
		const rescopeToCwd = vi.fn(async (cwd: string) => {
			calls.push(`rescope:${cwd}`);
		});
		const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & {
			session: unknown;
			sessionManager: unknown;
			statusLine: unknown;
			ui: unknown;
			refreshTitleSystemPrompt: (cwd: string) => Promise<void>;
			refreshSlashCommandState: (cwd: string) => Promise<void>;
		};
		Object.assign(mode, {
			session: { rescopeToCwd },
			sessionManager: { getSessionName: () => "test-session", getCwd: () => "/destination" },
			statusLine: { invalidate: () => calls.push("status") },
			ui: { requestRender: () => calls.push("render") },
			refreshTitleSystemPrompt: async (cwd: string) => {
				calls.push(`title:${cwd}`);
			},
			refreshSlashCommandState: async (cwd: string) => {
				calls.push(`slash:${cwd}`);
			},
		});

		await mode.applyCwdChange("/destination");

		// Order is the contract, not just presence: the title prompt and the slash
		// commands are read FROM the destination, so a re-scope that ran after them
		// would refresh them against the directory being left.
		expect(calls).toEqual(["rescope:/destination", "title:/destination", "slash:/destination", "status", "render"]);
		expect(rescopeToCwd).toHaveBeenCalledTimes(1);
	});
});
