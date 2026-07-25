/**
 * The session notices when it is working outside its working directory, and says
 * so once.
 *
 * WHY THIS SUITE EXISTS. Re-rooting only happens if something calls `set_cwd`,
 * and nothing reliably did. The only text describing when to re-root lived in the
 * tool's own description, and `set_cwd` is a `discoverable` tool, so it is not in
 * the initial toolset: a model that has not gone looking for the tool has never
 * read the advice, and a model that has not read the advice does not go looking.
 * Detection was left to the model inferring a policy from an absence, which is
 * why it did not happen.
 *
 * So the harness detects it. Every filesystem tool already declares its targets
 * for the cwd boundary, and those targets are a deterministic signal: three
 * distinct files under one directory outside cwd means the session's real subject
 * has moved. These tests pin the trigger, and just as importantly the SILENCE —
 * a hint that fires on ordinary cross-project reads, or that repeats, is worse
 * than no hint, because it spends context on every call and teaches the model to
 * skim past it.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import {
	MAX_HINTS,
	REROOT_FILE_THRESHOLD,
	RerootDetector,
	wrapToolWithRerootHint,
} from "@veyyon/coding-agent/tools/reroot-hint";

const CWD = "/work/here";
const OTHER = "/elsewhere/project";

/** Feed `files` one call at a time, returning every hint produced. */
function observeEach(detector: RerootDetector, files: string[], cwd = CWD) {
	return files.map(file => detector.observe([file], cwd)).filter(hint => hint !== undefined);
}

describe("RerootDetector", () => {
	it("stays silent below the threshold", () => {
		// THE FALSE-POSITIVE GUARD, and the more important half. Reading a couple of
		// files from another project while working here is ordinary, and re-rooting
		// for it would move the session away from the work the user asked for.
		const detector = new RerootDetector();

		const hints = observeEach(detector, [`${OTHER}/src/a.ts`, `${OTHER}/src/b.ts`]);

		expect(hints).toEqual([]);
	});

	it("fires once the third distinct file under one directory is touched", () => {
		const detector = new RerootDetector();

		const hints = observeEach(detector, [`${OTHER}/src/a.ts`, `${OTHER}/src/b.ts`, `${OTHER}/src/c.ts`]);

		expect(hints).toHaveLength(1);
		expect(hints[0]?.fileCount).toBe(REROOT_FILE_THRESHOLD);
		expect(hints[0]?.directory).toBe(`${OTHER}/src`);
	});

	it("counts distinct files, not repeated reads of the same one", () => {
		// Re-reading a file after editing it is normal and says nothing about where
		// the work lives. Counting calls instead of files would fire on a single file
		// touched three times, which is exactly the case where re-rooting is wrong.
		const detector = new RerootDetector();

		const hints = observeEach(detector, [`${OTHER}/src/a.ts`, `${OTHER}/src/a.ts`, `${OTHER}/src/a.ts`]);

		expect(hints).toEqual([]);
	});

	it("suggests the deepest qualifying directory, not a vague ancestor", () => {
		// Every ancestor is credited the same files, so every ancestor qualifies at the
		// same moment. Answering `/elsewhere` when the work is in
		// `/elsewhere/project/src` is technically true and useless.
		const detector = new RerootDetector();

		const hints = observeEach(detector, [`${OTHER}/src/a.ts`, `${OTHER}/src/b.ts`, `${OTHER}/src/c.ts`]);

		expect(hints[0]?.directory).toBe(`${OTHER}/src`);
	});

	it("rolls up to a shared parent when the files are spread across subdirectories", () => {
		// The realistic shape of moving projects: a file in src, a test, a config. No
		// single leaf directory reaches three, but the project root does, and the
		// project root is the answer a user would give.
		const detector = new RerootDetector();

		const hints = observeEach(detector, [`${OTHER}/src/a.ts`, `${OTHER}/test/b.test.ts`, `${OTHER}/package.json`]);

		expect(hints).toHaveLength(1);
		expect(hints[0]?.directory).toBe(OTHER);
	});

	it("never repeats a directory it has already named", () => {
		// THE NAGGING GUARD. The model may decline for a good reason, and repeating the
		// suggestion on every subsequent call would spend context arguing with it.
		const detector = new RerootDetector();
		const hints = observeEach(detector, [
			`${OTHER}/src/a.ts`,
			`${OTHER}/src/b.ts`,
			`${OTHER}/src/c.ts`,
			`${OTHER}/src/d.ts`,
			`${OTHER}/src/e.ts`,
			`${OTHER}/src/f.ts`,
		]);

		expect(hints).toHaveLength(1);
	});

	it("does not re-announce an ancestor of a directory it already named", () => {
		// The ancestor describes the same activity. Naming `/elsewhere/project` after
		// having named `/elsewhere/project/src` is the same hint with a worse answer.
		const detector = new RerootDetector();
		observeEach(detector, [`${OTHER}/src/a.ts`, `${OTHER}/src/b.ts`, `${OTHER}/src/c.ts`]);

		const later = observeEach(detector, [`${OTHER}/x.ts`, `${OTHER}/y.ts`, `${OTHER}/z.ts`]);

		expect(later).toEqual([]);
	});

	it("stops for good after the session cap", () => {
		const detector = new RerootDetector();
		observeEach(detector, [`/a/one/1.ts`, `/a/one/2.ts`, `/a/one/3.ts`]);
		observeEach(detector, [`/b/two/1.ts`, `/b/two/2.ts`, `/b/two/3.ts`]);

		const third = observeEach(detector, [`/c/three/1.ts`, `/c/three/2.ts`, `/c/three/3.ts`]);

		expect(third).toEqual([]);
		expect(MAX_HINTS).toBe(2);
	});

	it("ignores files inside the working directory", () => {
		// The whole point is activity OUTSIDE cwd. Counting inside files would fire on
		// every session after three reads and suggest re-rooting to where it already is.
		const detector = new RerootDetector();

		const hints = observeEach(detector, [`${CWD}/a.ts`, `${CWD}/b.ts`, `${CWD}/c.ts`, `${CWD}/nested/d.ts`]);

		expect(hints).toEqual([]);
	});

	it("never suggests a parent of the working directory", () => {
		// A parent does not MOVE the session, it widens it: every path that is
		// currently relative would become absolute, which is the opposite of the point.
		// Reaching a few files above cwd is common and must stay silent.
		const detector = new RerootDetector();

		const hints = observeEach(detector, ["/work/a.ts", "/work/b.ts", "/work/c.ts", "/work/d.ts"]);

		expect(hints).toEqual([]);
	});

	it("resolves relative targets against cwd before judging them", () => {
		// Tools declare targets as the model wrote them. A relative path is by
		// definition inside cwd and must not be credited to some parent directory.
		const detector = new RerootDetector();

		const hints = observeEach(detector, ["src/a.ts", "src/b.ts", "src/c.ts"]);

		expect(hints).toEqual([]);
	});

	it("counts every target of one call, not just the first", () => {
		// A search tool declares several bases at once, and an edit can name multiple
		// files. Crediting one per call would need three calls where one did the work.
		const detector = new RerootDetector();

		const hint = detector.observe([`${OTHER}/a.ts`, `${OTHER}/b.ts`, `${OTHER}/c.ts`], CWD);

		expect(hint?.directory).toBe(OTHER);
	});

	it("says what to do, and that declining is allowed", () => {
		// The text is the whole deliverable. It has to name the directory, name the
		// tool, say what re-rooting buys, and explicitly permit ignoring it: a
		// directive the model cannot decline would turn every incidental read into a
		// re-root away from the user's project.
		const detector = new RerootDetector();
		const hints = observeEach(detector, [`${OTHER}/a.ts`, `${OTHER}/b.ts`, `${OTHER}/c.ts`]);
		const text = hints[0]?.text ?? "";

		expect(text).toContain(OTHER);
		expect(text).toContain(CWD);
		expect(text).toContain("set_cwd");
		expect(text).toContain("AGENTS.md");
		expect(text).toContain("ignore this");
	});

	it("does nothing when there is no working directory to compare against", () => {
		const detector = new RerootDetector();

		expect(detector.observe([`${OTHER}/a.ts`], "")).toBeUndefined();
	});

	it("ignores blank and non-string targets rather than crediting them", () => {
		const detector = new RerootDetector();

		const hint = detector.observe(["", "   ", undefined as never, `${OTHER}/a.ts`], CWD);

		expect(hint).toBeUndefined();
	});

	it("keeps separate projects in separate buckets", () => {
		// Two files here and two there is not three anywhere, and merging them would
		// nominate a common ancestor like `/` that no one wants to work in.
		const detector = new RerootDetector();

		const hints = observeEach(detector, [
			"/one/project/a.ts",
			"/one/project/b.ts",
			"/two/other/c.ts",
			"/two/other/d.ts",
		]);

		expect(hints).toEqual([]);
	});

	it("treats a path with a line selector as the file it names", () => {
		// `read` targets carry `:1-40` suffixes. Left attached, the same file at two
		// line ranges would count as two distinct files and fire a directory early.
		const detector = new RerootDetector();

		const hints = observeEach(detector, [`${OTHER}/a.ts:1-40`, `${OTHER}/a.ts:41-80`, `${OTHER}/a.ts:81-120`]);

		expect(hints).toEqual([]);
	});
});

describe("RerootDetector, on a session that follows the hint", () => {
	it("goes quiet once cwd has moved to the suggested directory", () => {
		// The end state that proves the loop closes: after re-rooting, the same files
		// are inside cwd, so nothing further is credited and the hint cannot recur.
		const detector = new RerootDetector();
		observeEach(detector, [`${OTHER}/src/a.ts`, `${OTHER}/src/b.ts`, `${OTHER}/src/c.ts`]);

		const after = observeEach(detector, [`${OTHER}/src/d.ts`, `${OTHER}/src/e.ts`, `${OTHER}/src/f.ts`], OTHER);

		expect(after).toEqual([]);
	});
});

describe("path assumptions the detector relies on", () => {
	it("uses the platform separator, so nesting is judged the same way paths are built", () => {
		expect(path.dirname(path.join(OTHER, "src", "a.ts"))).toBe(path.join(OTHER, "src"));
	});
});

describe("wrapToolWithRerootHint", () => {
	/** A minimal filesystem-backed tool: it declares targets and always succeeds. */
	function fakeTool(): AgentTool<never, unknown> {
		return {
			name: "fake_read",
			label: "Fake",
			description: "",
			parameters: undefined as never,
			filesystemTargets: (args: unknown) => [(args as { path: string }).path],
			execute: async () => ({ content: [{ type: "text" as const, text: "file body" }] }),
		} as unknown as AgentTool<never, unknown>;
	}

	it("appends the hint to a real tool result once the trigger fires", async () => {
		// The wiring test. The detector being correct is worthless if the hint never
		// reaches the model, and the tool result is the only channel that works in
		// every mode, including yolo, where the cwd boundary never runs.
		const session = { cwd: CWD };
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), session);

		await tool.execute("1", { path: `${OTHER}/a.ts` } as never);
		await tool.execute("2", { path: `${OTHER}/b.ts` } as never);
		const third = await tool.execute("3", { path: `${OTHER}/c.ts` } as never);

		const texts = third.content.map(block => (block as { text?: string }).text ?? "");
		expect(texts[0]).toBe("file body");
		expect(texts[1]).toContain("set_cwd");
		expect(texts[1]).toContain(OTHER);
	});

	it("leaves the result untouched before the trigger", async () => {
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), { cwd: CWD });

		const result = await tool.execute("1", { path: `${OTHER}/a.ts` } as never);

		expect(result.content).toHaveLength(1);
	});

	it("reads cwd live, so a re-root mid-session is respected immediately", async () => {
		// `session.cwd` is a getter on the real ToolSession. Capturing it at wrap time
		// would keep judging against the launch directory forever, and the hint would
		// keep firing for the project the model had already moved into.
		const session = { cwd: CWD };
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), session);

		await tool.execute("1", { path: `${OTHER}/a.ts` } as never);
		session.cwd = OTHER;
		await tool.execute("2", { path: `${OTHER}/b.ts` } as never);
		const third = await tool.execute("3", { path: `${OTHER}/c.ts` } as never);

		expect(third.content).toHaveLength(1);
	});

	it("does not add a hint to a failed call", async () => {
		// An error is the model's problem to solve first. Stacking advice onto it is
		// how a result becomes unreadable at the moment it most needs to be clear.
		const tool = wrapToolWithRerootHint(
			{
				...fakeTool(),
				execute: async () => ({ content: [{ type: "text" as const, text: "boom" }], isError: true }),
			} as unknown as AgentTool<never, unknown>,
			new RerootDetector(),
			{ cwd: CWD },
		);

		await tool.execute("1", { path: `${OTHER}/a.ts` } as never);
		await tool.execute("2", { path: `${OTHER}/b.ts` } as never);
		const third = await tool.execute("3", { path: `${OTHER}/c.ts` } as never);

		expect(third.content).toHaveLength(1);
	});

	it("leaves a tool with no filesystem targets alone", async () => {
		const plain = { name: "plain", execute: async () => ({ content: [] }) } as unknown as AgentTool<never, unknown>;

		expect(wrapToolWithRerootHint(plain, new RerootDetector(), { cwd: CWD })).toBe(plain);
	});

	it("returns the result unchanged when target parsing throws", async () => {
		// Extensions implement `filesystemTargets` too. A hint is never worth failing a
		// tool call that already succeeded.
		const throwing = {
			...fakeTool(),
			filesystemTargets: () => {
				throw new Error("bad args");
			},
		} as unknown as AgentTool<never, unknown>;
		const tool = wrapToolWithRerootHint(throwing, new RerootDetector(), { cwd: CWD });

		const result = await tool.execute("1", { path: `${OTHER}/a.ts` } as never);

		expect(result.content).toHaveLength(1);
	});

	it("does not double-wrap", async () => {
		const tool = wrapToolWithRerootHint(fakeTool(), new RerootDetector(), { cwd: CWD });

		expect(wrapToolWithRerootHint(tool, new RerootDetector(), { cwd: CWD })).toBe(tool);
	});
});
