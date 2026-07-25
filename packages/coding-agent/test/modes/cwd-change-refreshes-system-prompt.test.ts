/**
 * A working-directory change must rebuild the base system prompt.
 *
 * WHY THIS SUITE EXISTS. The system prompt states the working directory
 * verbatim ("the current working directory is '<path>'") and carries the
 * workspace tree, the discovered context files (AGENTS.md / CLAUDE.md), and the
 * active-repo-context block. All of it is assembled ONCE, when the session is
 * built.
 *
 * `applyCwdChange` re-scoped everything else on a `/cd`, `/move`, `/cwd`, or the
 * agent's own `set_cwd` — settings, plugin roots, capabilities, slash commands,
 * the ssh tool — but never rebuilt the prompt. So after moving, the agent was
 * still told it was working in the PREVIOUS project: it followed the old
 * project's AGENTS.md instructions and resolved relative paths against a
 * directory it had already left. The failure is invisible from inside the model,
 * which simply believes what the prompt says.
 *
 * That made "launch from anywhere, move later" quietly unsound, which is exactly
 * the workflow the re-root exists to support. `event-controller-cwd-changed-reroot`
 * already documented "the system-prompt project framing for the new directory"
 * as part of the contract; this suite is what actually holds it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

async function promptFor(cwd: string): Promise<string> {
	const result = await buildSystemPrompt({
		toolNames: ["read"],
		contextFiles: [],
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
	 * skipping the rebuild would be harmless and this suite would be pointless.
	 * It does depend on it, verbatim, which is what makes a stale prompt a lie.
	 */
	it("names the working directory in the prompt, and changes when the directory changes", async () => {
		const alpha = await promptFor("/tmp/project-alpha");
		const beta = await promptFor("/tmp/project-beta");

		expect(alpha).toContain("the current working directory is '/tmp/project-alpha'");
		expect(beta).toContain("the current working directory is '/tmp/project-beta'");
		// The stale-prompt bug in one assertion: serving the alpha prompt after a
		// move to beta tells the model it is somewhere it is not.
		expect(alpha).not.toContain("/tmp/project-beta");
		expect(alpha).not.toBe(beta);
	});
});

describe("applyCwdChange re-scopes the destination through the session", () => {
	/**
	 * The rebuild itself now lives on `AgentSession.rescopeToCwd`, where every mode
	 * reaches it, and `test/session/rescope-to-cwd.test.ts` covers it with real
	 * behavior tests. What is left to prove here is the TUI's own wiring, and it
	 * still cannot be proven by behavior: `applyCwdChange` lives on
	 * `InteractiveMode`, whose construction pulls in the whole TUI, so the cwd
	 * tests all mock it and none cover its body.
	 *
	 * The wiring matters because `applyCwdChange` has three callers and only ONE of
	 * them goes through `setCwd`. `/move` calls `sessionManager.moveTo` directly,
	 * and resuming a session from another project calls `switchSession`; neither
	 * raises `cwd_changed`, so neither re-scopes unless this method asks for it.
	 * Reading the shipped source is weaker than a behavior test and is chosen over
	 * no coverage at all for a call whose omission is invisible at runtime.
	 */
	it("delegates to session.rescopeToCwd inside applyCwdChange", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../../src/modes/interactive-mode.ts", import.meta.url)),
			"utf8",
		);
		const start = source.indexOf("async applyCwdChange(");
		expect(start, "applyCwdChange not found — did it move or get renamed?").toBeGreaterThan(-1);

		// Bound the scan to this method: the next method declaration at the same
		// indentation ends it, so a call elsewhere in the file cannot satisfy this
		// assertion by accident.
		const rest = source.slice(start + 1);
		const end = rest.search(/\n\tasync |\n\t[A-Za-z#][A-Za-z0-9_]*\(/);
		const body = end === -1 ? rest : rest.slice(0, end);

		expect(body, "applyCwdChange must re-scope the session for the new directory").toContain(
			"this.session.rescopeToCwd(newCwd)",
		);
	});

	/**
	 * The other half of the same wiring: the re-scope must not be duplicated here.
	 * Two owners for one job is how the settings reload and the prompt rebuild
	 * drifted apart in the first place, and a second rebuild in this method would
	 * cost a full prompt-cache invalidation on every `/cd`.
	 */
	it("does not keep its own copy of the re-scope", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../../src/modes/interactive-mode.ts", import.meta.url)),
			"utf8",
		);
		const start = source.indexOf("async applyCwdChange(");
		const rest = source.slice(start + 1);
		const end = rest.search(/\n\tasync |\n\t[A-Za-z#][A-Za-z0-9_]*\(/);
		const body = end === -1 ? rest : rest.slice(0, end);

		expect(body).not.toContain("refreshBaseSystemPrompt(");
		expect(body).not.toContain("reloadForCwd(");
		expect(body).not.toContain("resetCapabilities(");
	});
});
