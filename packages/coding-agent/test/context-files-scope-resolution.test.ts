import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PROFILE_AGENTS_GUIDANCE } from "@veyyon/coding-agent/discovery/agents-guidance";
import { discoverContextFiles } from "@veyyon/coding-agent/sdk";
import { loadProjectContextFiles } from "@veyyon/coding-agent/system-prompt";
import {
	GLOBAL_BODY,
	PROFILE_BODY,
	PROJECT_NESTED_BODY,
	PROJECT_ROOT_BODY,
	useContextScopeFixture,
} from "./helpers/context-scope-fixture";

const fixture = useContextScopeFixture("context-scope-resolution-");

/**
 * Scope RESOLUTION, at the loader seam.
 *
 * The bug this file exists for: the operator's `~/.veyyon/AGENTS.md` (24KB, full
 * of real instructions) and their profile `AGENTS.md` never reached one agent's
 * prompt, and nothing failed. Every existing suite around this code asserted
 * either the rendered CONFIGURATION PATHS (`system-prompt-profile-context`) or
 * the authority WORDING (`system-prompt-context-authority`). Neither ever loaded
 * a byte of file content, so a loader that returned an empty list, or dropped a
 * whole scope, passed the suite unchanged.
 *
 * Every case below therefore asserts resolved absolute paths, exact file
 * content, exact depths, and exact ORDER. A shape-only or non-empty assertion
 * would re-open the same hole.
 */
describe("context file scope resolution", () => {
	/**
	 * GLOBAL scope, the reported bug in its smallest form.
	 *
	 * `~/.veyyon/AGENTS.md` is the cross-profile baseline and the file the
	 * operator lost. If this regresses, every machine-wide standing instruction
	 * disappears from every session on the box with no error, and the agent
	 * behaves as if the user never wrote them.
	 */
	it("loads the global AGENTS.md from the global config root", async () => {
		const f = fixture("scope-global");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd });

		expect(files).toEqual([{ path: f.globalAgentsPath, content: `${GLOBAL_BODY}\n`, depth: undefined }]);
	});

	/**
	 * PROFILE scope.
	 *
	 * The profile file is how a user separates work rules from personal rules.
	 * Losing it silently means the wrong ruleset is in force for the profile the
	 * user explicitly selected, which is worse than no rules: the agent is
	 * confidently following the other profile's policy.
	 */
	it("loads the profile AGENTS.md from the active profile agent dir", async () => {
		const f = fixture("scope-profile");
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd });

		expect(files).toEqual([{ path: f.profileAgentsPath, content: `${PROFILE_BODY}\n`, depth: undefined }]);
		expect(f.profileAgentsPath).toBe(path.join(f.agentDir, "AGENTS.md"));
	});

	/**
	 * PROFILE scope must follow the agent dir the CALLER names.
	 *
	 * This is the ignored-parameter defect: `discoverContextFiles(cwd, agentDir)`
	 * declared the parameter as `_agentDir` and never forwarded it, so profile
	 * scope was always resolved from the process-global active profile. Any
	 * caller running under one agent dir while the process global points at
	 * another (a session created with an explicit agentDir, a spawned subagent,
	 * the eval bridge) silently got a STRANGER'S profile rules. If this
	 * regresses, the parameter goes back to being decorative and the resolved
	 * profile scope stops being a function of its inputs.
	 */
	it("resolves profile scope from the agentDir argument, not the process-global profile", async () => {
		const f = fixture("scope-active");
		const otherAgentDir = f.agentDirFor("scope-other");
		f.writeFile(path.join(f.agentDir, "AGENTS.md"), `${PROFILE_BODY}\n`);
		const otherAgentsPath = f.writeFile(path.join(otherAgentDir, "AGENTS.md"), "Marker: OTHER-PROFILE-BYTES-4d19.\n");

		const viaLoader = await loadProjectContextFiles({ cwd: f.cwd, agentDir: otherAgentDir });
		f.resetCaches();
		const viaSdk = await discoverContextFiles(f.cwd, otherAgentDir);

		expect(viaLoader).toEqual([
			{ path: otherAgentsPath, content: "Marker: OTHER-PROFILE-BYTES-4d19.\n", depth: undefined },
		]);
		expect(viaSdk).toEqual(viaLoader);
	});

	/**
	 * PROJECT scope, depth numbering and prominence order.
	 *
	 * The prompt tells the model that deeper rules override shallower ones, and
	 * that promise is only true if the array is ordered farthest-from-cwd first
	 * so the closest file lands last and most prominent. A sort that reverses
	 * this makes the repo-root house style override the package's own
	 * conventions, which is a silent behavior change with no error anywhere.
	 */
	it("walks the project tree with repo root at depth 1 and cwd at depth 0, root first", async () => {
		const f = fixture("scope-project");
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd });

		expect(files).toEqual([
			{ path: f.rootAgentsPath, content: `${PROJECT_ROOT_BODY}\n`, depth: 1 },
			{ path: f.nestedAgentsPath, content: `${PROJECT_NESTED_BODY}\n`, depth: 0 },
		]);
	});

	/**
	 * PROMINENCE across all three scopes, which is a different axis from the
	 * order the scopes are RESOLVED in. Resolution runs global, then profile,
	 * then the project walk. The array is then sorted least prominent first:
	 * global (the cross-machine baseline), the project walk farthest-from-cwd
	 * first, and the user's own profile file last and most authoritative.
	 *
	 * Profile sits last on purpose. A user's standing rules must not lose to
	 * whatever repository happens to be checked out, and `capability/context-file.ts`
	 * documents that prominence deliberately.
	 *
	 * Asserting only that all four files are present would pass under any
	 * permutation, including the one that puts the machine-wide baseline last
	 * and lets it override the package the user is actually editing. The exact
	 * array is the contract; anything weaker is decoration.
	 */
	it("orders global, then project by descending depth, then the profile file last", async () => {
		const f = fixture("scope-precedence");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, `${PROFILE_BODY}\n`);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);
		f.writeFile(f.nestedAgentsPath, `${PROJECT_NESTED_BODY}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd });

		expect(files.map(file => file.path)).toEqual([
			f.globalAgentsPath,
			f.rootAgentsPath,
			f.nestedAgentsPath,
			f.profileAgentsPath,
		]);
		expect(files.map(file => file.depth)).toEqual([undefined, 1, 0, undefined]);
		expect(files.map(file => file.content)).toEqual([
			`${GLOBAL_BODY}\n`,
			`${PROJECT_ROOT_BODY}\n`,
			`${PROJECT_NESTED_BODY}\n`,
			`${PROFILE_BODY}\n`,
		]);
	});

	/**
	 * THE OPERATOR'S INSTALL, exactly: a real global file plus a profile file
	 * that is nothing but the seeded 597-byte guidance preamble.
	 *
	 * The preamble is veyyon's own managed header, stripped before the model
	 * sees it, so the profile scope legitimately contributes nothing. What it
	 * must NEVER do is take the other scopes down with it. This is the shape the
	 * operator had on disk when their global `AGENTS.md` vanished, so it is
	 * pinned as its own case rather than folded into the precedence test.
	 */
	it("keeps global and project scope when the profile file is only the seeded preamble", async () => {
		const f = fixture("scope-preamble");
		f.writeFile(f.globalAgentsPath, `${GLOBAL_BODY}\n`);
		f.writeFile(f.profileAgentsPath, PROFILE_AGENTS_GUIDANCE);
		f.writeFile(f.rootAgentsPath, `${PROJECT_ROOT_BODY}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd });

		expect(PROFILE_AGENTS_GUIDANCE.length).toBe(597);
		expect(files).toEqual([
			{ path: f.globalAgentsPath, content: `${GLOBAL_BODY}\n`, depth: undefined },
			{ path: f.rootAgentsPath, content: `${PROJECT_ROOT_BODY}\n`, depth: 1 },
		]);
	});

	/**
	 * The managed guidance header is stripped from a file that ALSO carries real
	 * instructions, rather than the whole file being discarded.
	 *
	 * Without this, a user who typed their rules underneath the seeded header
	 * would either ship veyyon's own boilerplate to the model or lose the rules
	 * entirely, depending on which way the strip broke.
	 */
	it("strips the managed preamble but keeps the instructions written under it", async () => {
		const f = fixture("scope-preamble-plus");
		f.writeFile(f.profileAgentsPath, `${PROFILE_AGENTS_GUIDANCE}${PROFILE_BODY}\n`);

		const files = await loadProjectContextFiles({ cwd: f.cwd });

		expect(files).toEqual([{ path: f.profileAgentsPath, content: `${PROFILE_BODY}\n`, depth: undefined }]);
	});
});
