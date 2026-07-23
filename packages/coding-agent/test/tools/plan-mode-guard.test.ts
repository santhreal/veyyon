import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { targetsLocalSandbox, unwrapHashlineHeaderPath } from "@veyyon/coding-agent/tools/plan-mode-guard";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/**
 * Complements plan-mode-guard-local.test.ts with pure unwrap contracts and
 * targetsLocalSandbox membership (absolute path under artifacts/local).
 * enforcePlanModeWrite + local:// resolution live in the -local suite.
 */

function session(artifactsDir: string | null, cwd: string): ToolSession {
	return makeToolSession({
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			get: () => undefined,
			getPlansDirectory: () => path.join(os.tmpdir(), "plans"),
		},
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "sess-plan-guard",
		getPlanModeState: () => ({ enabled: true as const, planFilePath: "local://PLAN.md" }),
	});
}

describe("unwrapHashlineHeaderPath", () => {
	it("returns non-bracketed paths unchanged", () => {
		expect(unwrapHashlineHeaderPath("src/a.ts")).toBe("src/a.ts");
		expect(unwrapHashlineHeaderPath("  spaced  ")).toBe("  spaced  ");
	});

	it("unwraps [path] and [path#TAG] with a 4-hex tag", () => {
		expect(unwrapHashlineHeaderPath("[src/a.ts]")).toBe("src/a.ts");
		expect(unwrapHashlineHeaderPath("[src/a.ts#ab12]")).toBe("src/a.ts");
		expect(unwrapHashlineHeaderPath("[src/a.ts#AB12]")).toBe("src/a.ts");
	});

	it("leaves non-hex tags and double-hash forms wrapped so downstream sees the original", () => {
		// Non-hex / short tags: no strip of the outer brackets... wait: if the
		// regex does not match a trailing 4-hex tag, pathPart is the whole inner
		// string and brackets ARE stripped when pathPart has no '#'. For non-hex
		// with '#', pathPart includes '#' → leave original.
		expect(unwrapHashlineHeaderPath("[src/a.ts#zzzz]")).toBe("[src/a.ts#zzzz]");
		expect(unwrapHashlineHeaderPath("[src/a.ts#abc]")).toBe("[src/a.ts#abc]");
		expect(unwrapHashlineHeaderPath("[#ab12]")).toBe("[#ab12]");
		expect(unwrapHashlineHeaderPath("[src/a.ts#ab12#cd34]")).toBe("[src/a.ts#ab12#cd34]");
	});

	it("strips brackets around path:selector when there is no #TAG (literal path after unwrap)", () => {
		// Selectors without a 4-hex tag are not hashline headers; the function
		// still peels matching outer brackets when the inner has no '#', so the
		// result is the selector-bearing path string for the next resolver.
		expect(unwrapHashlineHeaderPath("[src/a.ts:1-10]")).toBe("src/a.ts:1-10");
	});
});

describe("targetsLocalSandbox", () => {
	it("is true only for paths under artifacts/local (the local:// root)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), `plan-sandbox-${Snowflake.next()}-`));
		const artifacts = path.join(root, "artifacts");
		const localRoot = path.join(artifacts, "local");
		const tree = path.join(root, "project");
		fs.mkdirSync(localRoot, { recursive: true });
		fs.mkdirSync(tree, { recursive: true });
		fs.writeFileSync(path.join(localRoot, "plan.md"), "# plan\n");
		fs.writeFileSync(path.join(tree, "src.ts"), "export {};\n");
		// Sibling under artifacts but NOT under local/ must not count.
		fs.writeFileSync(path.join(artifacts, "other.md"), "nope\n");
		try {
			const s = session(artifacts, tree);
			expect(targetsLocalSandbox(s, path.join(localRoot, "plan.md"))).toBe(true);
			expect(targetsLocalSandbox(s, path.join(localRoot, "nested", "x.md"))).toBe(true);
			expect(targetsLocalSandbox(s, path.join(artifacts, "other.md"))).toBe(false);
			expect(targetsLocalSandbox(s, path.join(tree, "src.ts"))).toBe(false);
			expect(targetsLocalSandbox(s, "src.ts")).toBe(false);
			expect(targetsLocalSandbox(s, `[${path.join(localRoot, "plan.md")}#ab12]`)).toBe(true);
		} finally {
			removeSyncWithRetries(root);
		}
	});

	it("is false when the session has no artifacts dir", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `plan-noart-${Snowflake.next()}-`));
		try {
			const s = session(null, cwd);
			expect(targetsLocalSandbox(s, path.join(cwd, "x.ts"))).toBe(false);
		} finally {
			removeSyncWithRetries(cwd);
		}
	});
});
