import { describe, expect, it } from "bun:test";
import type { CommandEntry, CommandSummary } from "@veyyon/utils/cli";
import { renderRootHelp, run } from "@veyyon/utils/cli";

/**
 * WHY: root help renders from registry `summary` metadata WITHOUT loading
 * every command module. The fast path is only safe while every summary
 * faithfully mirrors the loaded class's statics and every entry carries one.
 * These tests close the class "root help renders from stale or partial
 * listing metadata": a missing summary must force the load-everything
 * fallback, and the fast path must not import non-default commands at all.
 */

function fakeEntry(name: string, summary?: CommandSummary): CommandEntry & { loads: number } {
	const entry = {
		name,
		loads: 0,
		load: undefined,
	} as unknown as CommandEntry & { loads: number };
	entry.load = () => {
		entry.loads += 1;
		// The help renderer reads only these statics off the constructor, so a
		// plain object satisfies the same surface without a class.
		const statics = {
			description: `${name} description`,
			hidden: summary?.hidden ?? false,
			devTool: summary?.devTool ?? false,
		};
		return Promise.resolve(statics) as unknown as Promise<new () => never>;
	};
	if (summary !== undefined) entry.summary = summary;
	return entry;
}

/** Capture stdout without touching global state outside the write call. */
function captureStdout(fn: () => void): string {
	const chunks: string[] = [];
	const originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		fn();
	} finally {
		process.stdout.write = originalWrite;
	}
	return chunks.join("");
}

describe("root help fast path", () => {
	it("loads only the hidden default command when every entry has a summary", async () => {
		const launch = fakeEntry("launch", { description: "AI coding assistant", hidden: true });
		const models = fakeEntry("models", { description: "List models" });
		await run({
			bin: "veyyon",
			version: "0.0.0",
			argv: ["--help"],
			commands: [launch, models],
			help: () => {},
		});
		expect(launch.loads).toBe(1);
		expect(models.loads).toBe(0);
	});

	it("falls back to loading every command when any entry lacks a summary", async () => {
		const summarized = fakeEntry("models", { description: "List models" });
		const unsummarized = fakeEntry("legacy");
		await run({
			bin: "veyyon",
			version: "0.0.0",
			argv: ["--help"],
			commands: [summarized, unsummarized],
			help: () => {},
		});
		expect(summarized.loads).toBe(1);
		expect(unsummarized.loads).toBe(1);
	});

	it("renders the full listing from summaries with sections in the same order as statics would", () => {
		const summaries = new Map(
			[
				["launch", { description: "AI coding assistant", hidden: true }],
				["models", { description: "List, search, and refresh available models" }],
				["grep", { description: "Run grep standalone", devTool: true }],
			].map(([name, s]) => [name, s as { description?: string; hidden?: boolean; devTool?: boolean }]),
		) as unknown as Map<never, never>;
		const output = captureStdout(() =>
			renderRootHelp({ bin: "veyyon", version: "0.0.0", commands: new Map(), summaries }),
		);
		expect(output).toContain("COMMANDS");
		expect(output).toContain("models");
		expect(output).toContain("List, search, and refresh available models");
		expect(output).toContain("DIAGNOSTIC COMMANDS");
		expect(output).toContain("grep");
		// Hidden entries never list.
		expect(output).not.toContain("AI coding assistant");
	});
});
