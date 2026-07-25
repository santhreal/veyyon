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

describe("applyCwdChange rebuilds the prompt for the destination", () => {
	/**
	 * `applyCwdChange` lives on `InteractiveMode`, whose construction pulls in the
	 * whole TUI, so the existing cwd tests all mock it and none cover its body.
	 * This reads the shipped source instead: weaker than a behavior test, and
	 * chosen deliberately over no coverage at all for a method whose omission is
	 * invisible at runtime. The behavior half above proves WHY the call must be
	 * there; this proves it IS there.
	 */
	it("calls refreshBaseSystemPrompt inside applyCwdChange", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../../src/modes/interactive-mode.ts", import.meta.url)),
			"utf8",
		);
		const start = source.indexOf("async applyCwdChange(");
		expect(start, "applyCwdChange not found — did it move or get renamed?").toBeGreaterThan(-1);

		// Bound the scan to this method: the next method declaration at the same
		// indentation ends it, so a refresh call elsewhere in the file cannot
		// satisfy this assertion by accident.
		const rest = source.slice(start + 1);
		const end = rest.search(/\n\tasync |\n\t[A-Za-z#][A-Za-z0-9_]*\(/);
		const body = end === -1 ? rest : rest.slice(0, end);

		expect(body, "applyCwdChange must rebuild the base system prompt for the new directory").toContain(
			"refreshBaseSystemPrompt()",
		);
	});
});
