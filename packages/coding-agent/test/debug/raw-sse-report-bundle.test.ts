import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { RawSseDebugBuffer } from "@veyyon/coding-agent/debug/raw-sse-buffer";
import { createReportBundle } from "@veyyon/coding-agent/debug/report-bundle";
import { getReportsDir } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

/**
 * The report bundle lands under the CONFIG root, so that is the root this suite
 * has to move.
 *
 * It used to redirect `XDG_STATE_HOME` and the agent dir, and it deliberately
 * pointed the agent dir at `path.join(getConfigRootDir(), "agent")` when no
 * override was set — the developer's real config root. `createReportBundle` calls
 * `getReportsDir()`, which resolves from the config root and not from either
 * lever this suite pulled, so every run wrote a tarball of system info, sanitized
 * env, and resolved settings into the real `~/.veyyon/profiles/<profile>/reports`.
 * The real-data tripwire refused the `mkdir` and that is how it was found. It had
 * been passing only because whichever suite ran before it happened to leave an
 * isolated config root in place; fixing those leaks exposed this one.
 *
 * It also used to redirect `XDG_STATE_HOME` by hand, and that lever did nothing: the
 * assignment came AFTER `enterIsolatedConfigRoot` had already built the resolver, so
 * `getReportsDir()` never saw it and the assertion below was passing on the config root
 * alone. `enterIsolatedConfigRoot` clears the XDG base directories itself now, which is
 * where that belongs — a developer who runs with `XDG_STATE_HOME` set otherwise has every
 * state-category path resolve under their real home inside a supposedly isolated root.
 */
let isolated: IsolatedConfigRoot | undefined;

afterEach(() => {
	isolated?.restore();
	isolated = undefined;
});

describe("raw SSE report bundle", () => {
	it("includes captured raw SSE text and dropped-record disclosure", async () => {
		isolated = enterIsolatedConfigRoot("raw-sse-report", { defaultProfile: true });
		// Proof, not intention: the reports directory is the one this test writes
		// into, and it must be inside the temp root before anything is written.
		expect(path.relative(isolated.root, path.resolve(getReportsDir())).startsWith("..")).toBe(false);

		const buffer = new RawSseDebugBuffer();
		buffer.recordResponse(
			{ status: 200, requestId: "req_report", headers: {}, metadata: { lastTransport: "sse" } },
			model,
		);
		for (let i = 0; i < 1_001; i++) {
			buffer.recordEvent(
				{ event: "message_delta", data: `{"i":${i}}`, raw: ["event: message_delta", `data: {"i":${i}}`] },
				model,
			);
		}
		const rawSseText = buffer.toRawText();
		expect(rawSseText).toContain(": veyyon-debug-dropped records=");
		expect(rawSseText).toContain("event: message_delta");

		const result = await createReportBundle({ sessionFile: undefined, rawSseText });

		// The bundle itself must be inside the temp root. Asserting the returned
		// path (not just that the call succeeded) is what makes this suite unable to
		// regress into writing a report into a real home again.
		expect(path.relative(isolated.root, path.resolve(result.path)).startsWith("..")).toBe(false);
		expect(result.files).toContain("raw-sse.txt");
		const archive = new Bun.Archive(await Bun.file(result.path).bytes());
		const files = await archive.files();
		expect(await files.get("raw-sse.txt")?.text()).toBe(rawSseText);
	});
});
