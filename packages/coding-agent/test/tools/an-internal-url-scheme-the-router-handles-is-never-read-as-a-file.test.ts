/**
 * Every scheme the internal-URL router registers is classified, in both tables.
 *
 * THE DEFECT. `read` with `history://Main:160-220` answered
 * `Unknown agent: Main:160-220` and then listed `Main` among the known agents,
 * because `history` was missing from `INTERNAL_SCHEMES_WITH_SELECTORS` in
 * `tools/path-utils.ts`. The selector was never peeled, so the whole
 * `<id>:<selector>` string was handed to the handler as an agent id. It happened
 * 46 times across the recorded sessions, on the one surface whose whole purpose is
 * reading a long transcript in pieces, and the error text pointed at the agent
 * rather than at the selector, so it read as a lost transcript.
 *
 * THE CLASS. A scheme the router handles that a scheme table in `path-utils.ts`
 * forgot. There are two such tables and they had drifted apart: the selector
 * allowlist above, and `TOP_LEVEL_INTERNAL_URL_PREFIXES`, which decides whether a
 * string is an internal URL at all. The second was missing five schemes
 * (`history`, `issue`, `memory`, `pr`, `veyyon`), so those were measured against
 * the cwd boundary as filenames, had their backslashes rewritten as path
 * separators, and escaped `assertNotInternalUrl`. Neither table can be checked by
 * reading it; both are checked here against the router itself.
 *
 * Both arms enumerate `InternalUrlRouter.instance().schemes()` at run time, so
 * registering a handler and forgetting either table turns this suite red. The
 * one deliberate exclusion, `mcp`, is pinned by exact equality rather than
 * counted, so a second opaque scheme cannot slip in beside it.
 *
 * WHAT THIS DOES NOT CATCH. It proves a selector is peeled off and that the
 * scheme is recognised as a URL. It does not prove each handler PAGINATES what it
 * returns, and it says nothing about completions or about `mcp`, whose selector
 * support needs a resolver-aware path that tries the exact URI first. It also
 * sees only what the constructor registers: a handler registered conditionally,
 * behind a setting or a platform check, is invisible here and would need the
 * condition driven both ways.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls/router";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { isInternalUrlPath, splitInternalUrlSel } from "@veyyon/coding-agent/tools/path-utils";
import { ReadTool } from "@veyyon/coding-agent/tools/read";
import { makeToolSession } from "../helpers/tool-session";

/** Schemes whose resource URIs are server-defined, so a selector-shaped tail is theirs. */
const OPAQUE = ["mcp"];

const schemes = InternalUrlRouter.instance().schemes();

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("internal URL schemes are classified", () => {
	it("registers at least the schemes the router documents", () => {
		expect(schemes.length).toBeGreaterThanOrEqual(13);
	});

	it("peels a line selector off every scheme except the opaque ones", () => {
		const notPeeled: string[] = [];
		for (const scheme of schemes) {
			// `ssh://host:port` has a colon of its own, so a selector there trails the
			// path. That is a grammar difference, not an exemption: the peel is still
			// required, on the shape the scheme actually addresses.
			const subject = scheme === "ssh" ? "host/leaf" : "subject";
			const { path, sel } = splitInternalUrlSel(`${scheme}://${subject}:1-5`);
			if (sel === "1-5" && path === `${scheme}://${subject}`) continue;
			notPeeled.push(scheme);
		}
		expect(notPeeled).toEqual(OPAQUE);
	});

	it("recognises every scheme as an internal URL rather than a filesystem path", () => {
		const unrecognised = schemes.filter(scheme => !isInternalUrlPath(`${scheme}://subject`));
		expect(unrecognised).toEqual([]);
	});

	/**
	 * The reported defect, through the real tool: a registered agent, addressed
	 * with a line range, must not come back as an unknown one. Reverting
	 * `history: true` in the selector allowlist fails this on the exact bytes the
	 * sessions recorded.
	 */
	it("reads a range of a live agent's transcript instead of calling it unknown", async () => {
		AgentRegistry.global().register({
			id: "Main",
			displayName: "main",
			kind: "main",
			session: {
				messages: [],
				sessionManager: { getArtifactsDir: () => null },
			} as unknown as AgentSession,
			sessionFile: null,
		});
		AgentRegistry.global().register({
			id: "Scout",
			displayName: "scout",
			kind: "sub",
			parentId: "Main",
			status: "running",
			session: { messages: [{ role: "user", content: "find the rail" }] } as unknown as AgentSession,
		});

		const tool = new ReadTool(makeToolSession());
		const result = await tool.execute("r1", { path: "history://Scout:1-5" });

		const text = textOf(result);
		expect(text).not.toContain("Unknown agent");
		expect(text).toContain("Scout");
	});
});
