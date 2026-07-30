import { describe, expect, it } from "bun:test";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SetCwdTool } from "@veyyon/coding-agent/tools/set-cwd";
import { makeToolSession } from "./helpers/tool-session";

/**
 * A real agent locked into a retry loop on this tool. It called
 * `set_cwd /media/.../veyyon`, the call succeeded, and it called the same thing
 * again, repeatedly, narrating that the parameter "must not be getting through".
 *
 * The cause was the result text. When the requested path resolved to the
 * directory the session was already in, the tool answered
 * `Session cwd unchanged: <path>`. To a caller that just asked for that path,
 * "unchanged" reads as "your call did not take effect", so the obvious next move
 * is to retry, which produces the identical line, forever. Nothing in the
 * message stated the end state, and nothing echoed the path that had actually
 * arrived, so the caller could not check its own argument either.
 *
 * A tool result that a model can read as failure while it succeeded is a defect
 * in the tool, not in the model. These tests pin the properties that break the
 * loop: the result always states where the cwd now is, always echoes what was
 * requested, and never describes a success in words that suggest failure.
 */
describe("set_cwd result confirmation", () => {
	/** Minimal ToolSession honoring setCwd, starting at `startCwd`. */
	function makeSession(startCwd: string, opts: { accept?: (p: string) => string } = {}) {
		// `cwd` is reassigned by `setCwd`, so the session is built first and the
		// mutation closes over it. The old `as unknown as ToolSession & {cwd}`
		// form bought nothing here beyond switching off the check on `setCwd`.
		const session: ToolSession = makeToolSession({
			cwd: startCwd,
			async setCwd(resolved: string): Promise<string> {
				session.cwd = opts.accept ? opts.accept(resolved) : resolved;
				return session.cwd;
			},
		});
		return session;
	}

	/**
	 * The result text with every sentence about RULE FILES removed.
	 *
	 * The word "unchanged" is legitimate in one place and forbidden in another, and the two are one
	 * sentence apart. "The rule files in effect are unchanged." is a true, useful statement about which
	 * AGENTS.md/CLAUDE.md govern the session. "Session cwd unchanged: X" is the sentence that drove the
	 * retry loop this suite exists for. A blanket `not.toContain("unchanged")` cannot tell them apart, so
	 * it either fails on the harmless sentence or has to be dropped, and dropping it would leave the
	 * original bug free to come back. Dropping the rules sentences and asserting on the remainder keeps the
	 * ban aimed at the CWD wording, which is the part that must never read as failure.
	 */
	function cwdWordingOnly(text: string): string {
		// Sentence-level, not line-level: the no-op result is ONE line that ends with the rules sentence.
		return text
			.split(/(?<=\.)\s+|\n/)
			.filter(sentence => !/rule/i.test(sentence))
			.join(" ");
	}

	async function run(session: ToolSession, path: string): Promise<{ text: string; details: unknown }> {
		const tool = new SetCwdTool(session);
		const result = await tool.execute("call-1", { path });
		const first = result.content[0];
		return { text: first.type === "text" ? first.text : "", details: result.details };
	}

	it("states where the cwd now is after a real change", () => {
		const session = makeSession("/start");

		return run(session, "/target").then(({ text }) => {
			expect(text).toContain("Moved cwd: /start → /target");
		});
	});

	it("confirms success rather than reporting 'unchanged' for a no-op", async () => {
		// REGRESSION, and the exact line that drove the loop. Asking for the
		// directory you are already in is a success, and the result has to read like
		// one.
		const session = makeSession("/already/here");

		const { text } = await run(session, "/already/here");

		expect(text).toContain("Cwd stays at /already/here");
		expect(cwdWordingOnly(text)).not.toContain("unchanged");
		// And specifically not the sentence that caused it, in any spacing.
		expect(text).not.toMatch(/cwd\s+unchanged/i);
	});

	it("tells the caller not to retry a no-op", async () => {
		// The loop was a retry loop. The result says outright that retrying is not
		// the fix, because a model reading only this line has nothing else to go on.
		const session = makeSession("/already/here");

		const { text } = await run(session, "/already/here");

		expect(text).toContain("do not retry");
	});

	it("echoes the path it actually received, so the caller can check its own argument", async () => {
		// The agent's stated theory was that its parameter was arriving as ".".
		// Echoing the received value is what makes that checkable instead of
		// guesswork.
		const session = makeSession("/already/here");

		const { text } = await run(session, "/already/here");

		expect(text).toContain('"/already/here"');
	});

	it("echoes a relative request alongside the absolute directory it resolved to", async () => {
		// The two differ in exactly the case the agent was confused by: a `.` that
		// resolves to a long absolute path. Showing both is what distinguishes
		// "my argument was wrong" from "my argument was fine".
		const session = makeSession("/start");

		const { text } = await run(session, ".");

		expect(text).toContain('"."');
		expect(text).toContain("/start");
	});

	/**
	 * Directory listings label the active root as `.`, which led an agent to conclude that set_cwd
	 * had moved upward and to run `bash pwd`. The result defines that display alias and keeps the
	 * absolute endpoint authoritative so a successful call does not trigger a second probe.
	 */
	it("explains that the dot display aliases the absolute cwd rather than its parent", async () => {
		const session = makeSession("/already/here");

		const { text } = await run(session, ".");

		expect(text).toContain(`"." in later tool paths and directory headers means the current cwd, /already/here`);
		expect(text).toContain(`it does not mean the parent directory (that is "..")`);
		expect(text).toContain("Treat /already/here as authoritative and do not run another tool to rediscover it.");
	});

	it("reports the requested path in the details for the transcript", async () => {
		const session = makeSession("/start");

		const { details } = await run(session, "/target");

		// `toMatchObject`, not `toEqual`: the result also carries the rule-file change, asserted below.
		expect(details).toMatchObject({ previous: "/start", cwd: "/target", requested: "/target" });
	});

	/**
	 * The rule-file keys are part of the details contract, so they are asserted rather than merely
	 * tolerated: a re-root that reports no rule change when the rules DID change is the failure the
	 * tracking exists to prevent, and only the details carry that machine-readable answer.
	 *
	 * The expected values are computed from the same loader the tool uses instead of being hardcoded,
	 * because neither `/start` nor `/target` exists yet `rulesUnchanged` is legitimately non-zero: user-level
	 * rule files apply in every directory, including ones that are not there. Hardcoding a zero here would
	 * pin the developer's own home directory into the suite. What is genuinely fixed is the DIFFERENCE:
	 * moving between two ruleless directories gains nothing and drops nothing, and the shared count is
	 * exactly the set both directories see.
	 */
	it("reports the rule-file change in the details", async () => {
		const { loadProjectContextFiles } = await import("@veyyon/coding-agent/system-prompt");
		const [atStart, atTarget] = await Promise.all([
			loadProjectContextFiles({ cwd: "/start" }),
			loadProjectContextFiles({ cwd: "/target" }),
		]);
		const session = makeSession("/start");

		const { details } = await run(session, "/target");

		expect(details).toMatchObject({
			rulesApplied: [],
			rulesDropped: [],
			// Every file in effect at `/target` was already in effect at `/start`, so all of them are shared.
			rulesUnchanged: atTarget.length,
		});
		expect(atStart.map(file => file.path)).toEqual(atTarget.map(file => file.path));
	});

	/**
	 * A no-op reported `rulesUnchanged: 0`, and that was simply untrue.
	 *
	 * The re-root branch computed its rule counts from the loader; the `cwd === previous` branch asserted an
	 * empty rule state of its own instead, hardcoding zero applied, zero dropped and zero unchanged. But
	 * user-level rule files (`~/.veyyon/AGENTS.md` and friends) are in effect from every directory, so a
	 * session that never moved still has rules governing it. A caller reading the details of a no-op saw a
	 * count that said no rules were in play at all, one field away from a re-root that would have counted the
	 * same files correctly. Two branches of one tool disagreeing about the same fact is the inconsistency
	 * this pins: whatever the truth about rule files is, both branches now get it from the same place.
	 *
	 * The count is computed from the real loader rather than hardcoded, for the reason the re-root case above
	 * gives: a literal number here would pin whoever ran the suite last into it.
	 */
	it("reports the real rule-file state for a no-op, not an empty one", async () => {
		const { loadProjectContextFiles } = await import("@veyyon/coding-agent/system-prompt");
		const inEffect = await loadProjectContextFiles({ cwd: "/already/here" });
		const session = makeSession("/already/here");

		const { details } = await run(session, "/already/here");

		expect(details).toMatchObject({
			previous: "/already/here",
			cwd: "/already/here",
			// Nothing moved, so nothing can be gained or lost; everything in effect is shared with itself.
			rulesApplied: [],
			rulesDropped: [],
			rulesUnchanged: inEffect.length,
		});
	});

	/**
	 * And the sentence a reader sees agrees with those counts.
	 *
	 * The old no-op text ended in a hand-written "The rule files in effect are unchanged.", a second copy of
	 * a sentence the shared describer already produces. Both branches now take that wording from the one
	 * owner, so the prose cannot drift away from the numbers beside it.
	 */
	it("describes the rule files in effect for a no-op in the same words as a re-root", async () => {
		const noop = await run(makeSession("/already/here"), "/already/here");
		const moved = await run(makeSession("/start"), "/target");

		const rulesSentence = (text: string) =>
			text
				.split(/\n+/)
				.filter(line => /rule/i.test(line))
				.join("\n");

		expect(rulesSentence(noop.text)).not.toBe("");
		expect(rulesSentence(noop.text)).toBe(rulesSentence(moved.text));
	});

	it("trims a padded path before resolving and echoes the trimmed value", async () => {
		const session = makeSession("/start");

		const { details } = await run(session, "  /target  ");

		expect(details).toMatchObject({ previous: "/start", cwd: "/target", requested: "/target" });
	});

	it("still fails loudly on an empty path rather than reporting a no-op", async () => {
		// The no-op wording must not become a place for a genuinely bad call to
		// hide. An empty path is an error, not a directory you are already in.
		const session = makeSession("/start");
		const tool = new SetCwdTool(session);

		await expect(tool.execute("call-1", { path: "   " })).rejects.toThrow("path is required");
	});

	it("surfaces a rejected directory as an error, not as a confirmation", async () => {
		const session = makeToolSession({
			cwd: "/start",
			async setCwd(): Promise<string> {
				throw new Error("ENOENT: no such directory");
			},
		});
		const tool = new SetCwdTool(session);

		await expect(tool.execute("call-1", { path: "/missing" })).rejects.toThrow("ENOENT");
	});

	it("describes the end state even when the session resolves elsewhere than requested", async () => {
		// A session may canonicalize (symlinks, macOS /private). The caller needs to
		// see where it actually landed, which is the returned path, not the argument.
		const session = makeSession("/start", { accept: () => "/private/target" });

		const { text, details } = await run(session, "/target");

		expect(text).toContain("Moved cwd: /start → /private/target");
		expect(details).toMatchObject({ previous: "/start", cwd: "/private/target", requested: "/target" });
	});

	/**
	 * THE REPORTED DEFECT. A successful re-root has to name the directory it came FROM as well as
	 * the one it landed in, in that order, as one readable move.
	 *
	 * The previous wording put the origin in a trailing parenthetical -- `Session cwd is now
	 * /target (previously /start)` -- and the origin is the half that decides whether the call did
	 * anything. A reader that cannot see the move treats a re-root and a no-op as the same event:
	 * it either re-issues the call or keeps resolving relative paths against the old root. Both
	 * endpoints, one arrow, nothing between them.
	 */
	it("names both ends of the move in order", async () => {
		const session = makeSession("/start");

		const { text } = await run(session, "/target");

		expect(text).toContain("Moved cwd: /start → /target");
		// Origin BEFORE destination: the reversed pair describes the opposite move.
		expect(text.indexOf("/start")).toBeLessThan(text.indexOf("/target"));
	});

	/**
	 * The move is worthless to a caller that does not know relative paths moved with it, which is
	 * the second half of the same confusion: a model re-roots, then reads `src/foo.ts` against the
	 * directory it just left. Both branches point at the one call that establishes the new root.
	 */
	it.each([
		["a real move", "/start", "/target"],
		["a no-op", "/already/here", "/already/here"],
	])("tells the caller how to list the cwd after %s", async (_case, from, to) => {
		const session = makeSession(from);

		const { text } = await run(session, to);

		expect(text).toContain(`read "." to list the top level`);
	});

	/**
	 * The degenerate line this rewrite exists to make unrepresentable: `Session cwd is now .
	 * (previously .)`, emitted on a SUCCESSFUL re-root when either endpoint reached the message
	 * unresolved. It names neither directory, so it reads as a failed call. The tool resolves both
	 * ends against the session before formatting; this asserts the formatted line can never carry a
	 * bare relative endpoint even when the session hands back a relative cwd.
	 */
	it("never reports a bare '.' as either endpoint", async () => {
		const session = makeSession(".", { accept: () => "/target" });

		const { text } = await run(session, "/target");

		expect(text).toContain(`→ /target`);
		expect(text).not.toMatch(/Moved cwd: \.\s/);
		expect(text).not.toContain("Moved cwd: . → .");
	});
});
