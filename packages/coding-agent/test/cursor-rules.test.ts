import { describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import { cursorContextFileRules, usesCursorRuleDelivery } from "@veyyon/coding-agent/cursor";
import type { ContextFileEntry } from "@veyyon/coding-agent/tools";

const GLOBAL: ContextFileEntry = {
	path: "/home/operator/.veyyon/AGENTS.md",
	content: "# global rules",
	level: "global",
};
const PROFILE: ContextFileEntry = {
	path: "/home/operator/.veyyon/profiles/work/agent/AGENTS.md",
	content: "# profile rules",
	level: "user",
};
const REPO: ContextFileEntry = {
	path: "/repo/AGENTS.md",
	content: "# repository rules",
	level: "project",
	depth: 0,
};
const REPO_CURSOR_RULE: ContextFileEntry = {
	path: "/repo/.cursor/rules/style.mdc",
	content: "# cursor mdc rule",
	level: "project",
	depth: 1,
};

describe("cursorContextFileRules", () => {
	it("keeps the operator's global and profile files as per-file rules, in authority order", () => {
		// Discovery order is ascending authority: project (deepest first) → profile → global.
		const rules = cursorContextFileRules([REPO_CURSOR_RULE, REPO, PROFILE, GLOBAL]);

		expect(rules).toEqual([
			{ fullPath: PROFILE.path, content: PROFILE.content },
			{ fullPath: GLOBAL.path, content: GLOBAL.content },
		]);
	});

	it("excludes repository content and entries without provenance", () => {
		// A repository may not configure the agent: project-level files never become
		// rules, and a synthesized entry with no level is not the operator's own either.
		const synthesized: ContextFileEntry = { path: "/tmp/notes.md", content: "caller-assembled" };

		expect(cursorContextFileRules([REPO, REPO_CURSOR_RULE, synthesized])).toEqual([]);
	});
});

describe("usesCursorRuleDelivery", () => {
	it("holds only for cursor-agent models", () => {
		expect(usesCursorRuleDelivery({ api: "cursor-agent" } as Pick<Model, "api">)).toBe(true);
		expect(usesCursorRuleDelivery({ api: "anthropic-messages" } as Pick<Model, "api">)).toBe(false);
		expect(usesCursorRuleDelivery(undefined)).toBe(false);
	});
});
