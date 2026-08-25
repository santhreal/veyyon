import { describe, expect, it } from "bun:test";
import { commands } from "@veyyon/coding-agent/cli-commands";

/**
 * WHY: `veyyon --help` renders from each entry's `summary` metadata WITHOUT
 * loading the command module. That is only safe while every summary is a
 * faithful copy of the loaded class's statics (`description`, `hidden`,
 * `devTool`). This suite closes the class "root help lists stale or missing
 * metadata": a registry entry without a summary fails here, and one whose
 * summary disagrees with the real statics fails here too — so adding a
 * command or editing its description turns this RED until the summary is
 * recorded, instead of shipping wrong help text.
 */

describe("root-help summaries mirror command statics", () => {
	it("every registered command carries a summary", () => {
		const missing = commands.filter(e => e.summary === undefined).map(e => e.name);
		expect(missing).toEqual([]);
	});

	it("every summary matches the loaded class statics exactly", async () => {
		const drift: string[] = [];
		for (const entry of commands) {
			const Cmd = await entry.load();
			const summary = entry.summary;
			if (summary?.description !== (Cmd.description ?? "")) {
				drift.push(
					`${entry.name}: description ${JSON.stringify(summary?.description)} != statics ${JSON.stringify(Cmd.description ?? "")}`,
				);
			}
			if (summary && (summary.hidden ?? false) !== (Cmd.hidden ?? false)) {
				drift.push(`${entry.name}: hidden ${summary.hidden} != statics ${Cmd.hidden}`);
			}
			if (summary && (summary.devTool ?? false) !== (Cmd.devTool ?? false)) {
				drift.push(`${entry.name}: devTool ${summary.devTool} != statics ${Cmd.devTool}`);
			}
		}
		expect(drift).toEqual([]);
	});
});
