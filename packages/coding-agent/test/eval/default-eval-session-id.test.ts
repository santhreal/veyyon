/**
 * defaultEvalSessionId is the kernel-namespace key. Two sessions that share
 * a cwd but have different session files must not share an eval heap, and a
 * session with no file (ephemeral / -p) must still be keyed so two
 * concurrent `-p` runs in the same directory do not collide on `cwd:` alone
 * — they do, today, and that is the contract: no session file means the
 * cwd is the whole identity. Pinning it stops someone "fixing" the
 * collision by hashing random bytes and breaking kernel reuse inside one
 * session.
 */
import { describe, expect, it } from "bun:test";
import { defaultEvalSessionId, type EvalSessionSource } from "@veyyon/coding-agent/eval/session-id";

describe("defaultEvalSessionId", () => {
	it("keys an ephemeral session as cwd: plus the working directory, nothing else", () => {
		expect(defaultEvalSessionId({ cwd: "/work/a", getSessionFile: () => null })).toBe("cwd:/work/a");
		// Empty string is falsy, so it is the no-file arm, not session::cwd:
		expect(defaultEvalSessionId({ cwd: "/work/a", getSessionFile: () => "" })).toBe("cwd:/work/a");
	});

	it("includes the session file when one exists, so two files in one cwd do not share a kernel", () => {
		expect(
			defaultEvalSessionId({
				cwd: "/work/a",
				getSessionFile: () => "/work/a/.veyyon/sessions/one.jsonl",
			}),
		).toBe("session:/work/a/.veyyon/sessions/one.jsonl:cwd:/work/a");
		expect(
			defaultEvalSessionId({
				cwd: "/work/a",
				getSessionFile: () => "/work/a/.veyyon/sessions/two.jsonl",
			}),
		).toBe("session:/work/a/.veyyon/sessions/two.jsonl:cwd:/work/a");
	});

	it("does not trim or resolve the cwd — a trailing slash is a different kernel than without", () => {
		const withSlash = defaultEvalSessionId({ cwd: "/work/a/", getSessionFile: () => null });
		const without = defaultEvalSessionId({ cwd: "/work/a", getSessionFile: () => null });
		expect(withSlash).toBe("cwd:/work/a/");
		expect(without).toBe("cwd:/work/a");
		expect(withSlash).not.toBe(without);
	});

	it("treats a missing getSessionFile the same as one that returns null", () => {
		expect(defaultEvalSessionId({ cwd: "/x" } as EvalSessionSource)).toBe("cwd:/x");
	});
});
