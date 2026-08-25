/**
 * `TtsrManager` decides inside-vs-outside cwd with `path.relative(root, candidate)`
 * and then `relative.startsWith("..")`. A directory whose *name* begins with
 * two dots (`...hidden`, `..foo`) produces a relative path that starts with
 * `..` without ever leaving the root.
 *
 * `pathScope: outside-cwd` then fires for a file that is INSIDE the working
 * directory — the exact misfire `pathScope` was added to stop (advising the
 * model to re-root to the project it is already in). `pathScope: inside-cwd`
 * goes silent for a real in-tree path.
 *
 * Prefix-string `..` is not a hop. The hop is a path segment equal to `..`.
 */
import { describe, expect, it } from "bun:test";
import type { Rule } from "@veyyon/coding-agent/capability/rule";
import { TtsrManager } from "@veyyon/coding-agent/export/ttsr";

const CWD = "/work/project";

function pathRule(overrides: Partial<Rule> = {}): Rule {
	return {
		name: "path-rule",
		path: "/rules/path-rule.md",
		content: "body",
		condition: ["(?:^|[\\s\"'=(,])/(?:[\\w.@+-]+/){3,}[\\w.@+-]+"],
		scope: ["tool:read"],
		interruptMode: "never",
		_source: { provider: "test", providerName: "test", path: "/rules/path-rule.md", level: "project" },
		...overrides,
	};
}

function match(rule: Rule, delta: string): string[] {
	const manager = new TtsrManager(undefined, { getCwd: () => CWD });
	expect(manager.addRule(rule)).toBe(true);
	return manager.checkDelta(delta, { source: "tool", toolName: "read" }).map(r => r.name);
}

const TRIPLE = '{"path":"/work/project/...hidden/src/turn.ts"}';
const DOTDOT_NAME = '{"path":"/work/project/..foo/src/turn.ts"}';
const REAL_OUTSIDE = '{"path":"/work/other-project/crates/cli/src/main.rs"}';
const REAL_INSIDE = '{"path":"/work/project/packages/agent/src/turn.ts"}';

describe("pathScope: outside-cwd does not treat a ..-prefixed directory name as outside", () => {
	const rule = pathRule({ pathScope: "outside-cwd" });

	it("still fires for a path in a different project", () => {
		expect(match(rule, REAL_OUTSIDE)).toEqual(["path-rule"]);
	});

	it("does not fire for a normal path inside the working directory", () => {
		expect(match(rule, REAL_INSIDE)).toEqual([]);
	});

	it("does not fire for /work/project/...hidden/..., which never left the root", () => {
		expect(match(rule, TRIPLE)).toEqual([]);
	});

	it("does not fire for /work/project/..foo/..., a legal directory name", () => {
		expect(match(rule, DOTDOT_NAME)).toEqual([]);
	});
});

describe("pathScope: inside-cwd still sees a ..-prefixed directory name as inside", () => {
	const rule = pathRule({ pathScope: "inside-cwd" });

	it("fires for a normal in-tree path", () => {
		expect(match(rule, REAL_INSIDE)).toEqual(["path-rule"]);
	});

	it("fires for ...hidden under the working directory", () => {
		expect(match(rule, TRIPLE)).toEqual(["path-rule"]);
	});

	it("does not fire for a different project", () => {
		expect(match(rule, REAL_OUTSIDE)).toEqual([]);
	});
});
