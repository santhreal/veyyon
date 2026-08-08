import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool, bashToolRenderer } from "@veyyon/coding-agent/tools/bash";
import { sanitizeText } from "@veyyon/utils";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

/**
 * WHY: a bash "notice" is a line the tool appends to the model payload and the
 * TUI folds into the styled footer (wall time, exit code, backgrounded job id,
 * raw-output artifact). The class this closes is a notice that is only half
 * retired. `perf(tools): omit wall time text string from bash tool model
 * payload` (7b2074d7f) made the wall-time formatter return `""` and left its
 * push in `#buildCompletedResult`, so every completed command still paid for the
 * blank separator line the notice list adds, welding `\n\n` onto the payload of
 * every bash result, and the renderer's strip became a no-op that could no
 * longer fold the line out of a session recorded BEFORE the change. Three
 * renderer cases had been red on main since that commit and nothing else noticed.
 *
 * The invariant is two-sided, and both sides are asserted here:
 *   1. What the tool emits now: the command's own output plus the notices that
 *      still exist, with no empty notice and no padding. Exact equality, because
 *      a `trimEnd()` in the assertion is what hid this for two days.
 *   2. What the tool emitted before: a persisted result still carries the legacy
 *      wall-time line, so a retired notice keeps its stripper and the renderer
 *      folds the line into the footer instead of printing it twice.
 *
 * Not caught: a notice added to a result this suite does not build (the
 * background-start and client-bridge results assemble their own text), and a
 * notice whose formatter is non-empty but wrong. The padding assertion is the
 * general one, since it fails for any notice list that gains an empty member,
 * whoever pushed it.
 */

useIsolatedGlobalSettings();

function makeSession(): ToolSession {
	return makeToolSession({
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	});
}

async function bashPayload(callId: string, command: string): Promise<string> {
	const tool = new BashTool(makeSession());
	const result = await tool.execute(callId, { command });
	return result.content.find(c => c.type === "text")?.text ?? "";
}

describe("a retired bash notice costs the payload nothing", () => {
	it("appends no separator for a notice it no longer emits", async () => {
		// Exact equality: `wt\n\n` passes every assertion that trims first. The
		// payload is the command's own bytes and nothing else, so a command that
		// prints no trailing newline yields a payload with none either.
		expect(await bashPayload("call-plain", "printf wt")).toBe("wt");
		expect(await bashPayload("call-lines", "seq 1 3")).toBe("1\n2\n3\n");
	});

	it("keeps the exit notice, one separator line before it, nothing after", async () => {
		// `echo` ends in a newline and the notice list adds one blank line, so the
		// notice sits two newlines past the output and the payload ends AT it.
		expect(await bashPayload("call-exit", "echo boom; exit 1")).toBe("boom\n\n\nCommand exited with code 1");
	});

	it("states wall time in the details and never in the payload", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-wall", { command: "printf wt" });
		expect(typeof result.details?.wallTimeMs).toBe("number");
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).not.toContain("Wall time");
	});
});

describe("a persisted bash result reads its notices from the footer", () => {
	async function render(text: string, details: Record<string, unknown>, isError: boolean): Promise<string> {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text }], details, isError },
			{ expanded: false, isPartial: false },
			theme!,
			{ command: "echo hi" },
		);
		return sanitizeText(component.render(120).join("\n"));
	}

	// Every notice a completed result can carry, in the shape a session file
	// recorded before the wall-time retirement holds it. A new notice belongs in
	// this table; a retired one stays in it, because the sessions that recorded
	// it are still resumable.
	const cases: { name: string; text: string; details: Record<string, unknown>; isError: boolean; footer: string }[] = [
		{
			name: "wall time",
			text: "hello\n\nWall time: 1.23 seconds",
			details: { timeoutSeconds: 5, wallTimeMs: 1230 },
			isError: false,
			footer: "Wall: 1.23s",
		},
		{
			name: "exit code",
			text: "boom\n\nWall time: 0.02 seconds\n\nCommand exited with code 1",
			details: { timeoutSeconds: 300, wallTimeMs: 20, exitCode: 1 },
			isError: true,
			footer: "Exit: 1",
		},
		{
			name: "raw output artifact",
			text: "filtered\n[raw output: artifact://13]\n\nWall time: 0.08 seconds",
			details: { timeoutSeconds: 300, wallTimeMs: 80 },
			isError: false,
			footer: "Artifact: 13",
		},
	];

	for (const item of cases) {
		it(`folds the ${item.name} notice into the footer and out of the output pane`, async () => {
			const rendered = await render(item.text, item.details, item.isError);
			expect(rendered).toContain(item.footer);
			// The command's own first line survives the fold.
			expect(rendered).toContain(item.text.split("\n")[0]!);
			for (const notice of ["Wall time:", "Command exited with code", "artifact://13"]) {
				if (item.text.includes(notice)) expect(rendered).not.toContain(notice);
			}
		});
	}
});
