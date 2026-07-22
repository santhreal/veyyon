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

	async function run(session: ToolSession, path: string): Promise<{ text: string; details: unknown }> {
		const tool = new SetCwdTool(session);
		const result = await tool.execute("call-1", { path });
		const first = result.content[0];
		return { text: first.type === "text" ? first.text : "", details: result.details };
	}

	it("states where the cwd now is after a real change", () => {
		const session = makeSession("/start");

		return run(session, "/target").then(({ text }) => {
			expect(text).toContain("Session cwd is now /target");
			expect(text).toContain("previously /start");
		});
	});

	it("confirms success rather than reporting 'unchanged' for a no-op", async () => {
		// REGRESSION, and the exact line that drove the loop. Asking for the
		// directory you are already in is a success, and the result has to read like
		// one.
		const session = makeSession("/already/here");

		const { text } = await run(session, "/already/here");

		expect(text).toContain("Session cwd is /already/here");
		expect(text).not.toContain("unchanged");
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

	it("reports the requested path in the details for the transcript", async () => {
		const session = makeSession("/start");

		const { details } = await run(session, "/target");

		expect(details).toEqual({ previous: "/start", cwd: "/target", requested: "/target" });
	});

	it("trims a padded path before resolving and echoes the trimmed value", async () => {
		const session = makeSession("/start");

		const { details } = await run(session, "  /target  ");

		expect(details).toEqual({ previous: "/start", cwd: "/target", requested: "/target" });
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

		expect(text).toContain("Session cwd is now /private/target");
		expect(details).toEqual({ previous: "/start", cwd: "/private/target", requested: "/target" });
	});
});
