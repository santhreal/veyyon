/**
 * `tab.fill` speed bench.
 *
 * `tab.fill` is how the browser tool writes into a form field, and a model fills a field on nearly
 * every page it works on. This bench times it in real headless Chromium, inside the tab worker so the
 * number is the fill and not the tool call around it, for values of growing length, and checks the
 * field holds exactly the value after every fill. A fill that is fast and wrong is not counted as a
 * fill.
 *
 * It imports nothing newer than the browser tool's public API, so the same file runs against any tree
 * that has the tool: run it in the tree before a change and in the tree after, same flags, and the
 * two reports differ only by the change.
 *
 * Deliberately NOT a test: it launches Chromium and its numbers belong to the machine it ran on.
 *
 *   bun benches/browser-fill.ts --label after --json runs/fill-after.json
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, flagCount, parseFlags } from "../engine/flag-grammar";

/** Value lengths timed: a word, a paragraph, a page. */
const LENGTHS = [16, 256, 4096] as const;

export const BROWSER_FILL_BENCH_FLAGS = {
	valued: { label: true, json: true, rounds: true },
	valueless: { help: true },
} as const satisfies FlagGrammar;

const USAGE = "usage: bun benches/browser-fill.ts [--label <name>] [--json <out.json>] [--rounds <n, default 15>]\n";

export interface FillTiming {
	readonly length: number;
	readonly rounds: number;
	/** Fills that left the field holding exactly the value. */
	readonly correct: number;
	readonly medianMs: number;
	readonly p90Ms: number;
}

function quantile(sorted: readonly number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

/** Time `rounds` fills of each length in one headless tab. */
export async function runBrowserFillBench(rounds: number): Promise<FillTiming[]> {
	const server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end('<!doctype html><title>fill</title><input id="field" value="old">');
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	const tool = new BrowserTool(session);
	const tab = `fill-bench-${process.pid}`;
	try {
		await tool.execute("open", { action: "open", name: tab, url });
		const timings: FillTiming[] = [];
		for (const length of LENGTHS) {
			// Printable ASCII only, so every tree fills the same characters.
			const value = "abcdefghij klmnopqrstuvwxyz0123456789".repeat(Math.ceil(length / 37)).slice(0, length);
			const result = await tool.execute("run", {
				action: "run",
				name: tab,
				timeout: 300,
				code: `
					const value = ${JSON.stringify(value)};
					const times = [];
					let correct = 0;
					for (let i = 0; i < ${rounds}; i++) {
						await tab.evaluate(() => { document.getElementById("field").value = "old"; });
						const start = performance.now();
						await tab.fill("#field", value);
						times.push(performance.now() - start);
						if ((await tab.evaluate(() => document.getElementById("field").value)) === value) correct++;
					}
					return { times, correct };
				`,
			});
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
			const measured = JSON.parse(text) as { times: number[]; correct: number };
			const sorted = measured.times.slice().sort((a, b) => a - b);
			timings.push({
				length,
				rounds,
				correct: measured.correct,
				medianMs: Number(quantile(sorted, 0.5).toFixed(2)),
				p90Ms: Number(quantile(sorted, 0.9).toFixed(2)),
			});
		}
		return timings;
	} finally {
		await tool.execute("close", { action: "close", name: tab, kill: true });
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
}

if (import.meta.main) {
	let flags: Record<string, string>;
	let rounds: number;
	try {
		flags = parseFlags(process.argv.slice(2), BROWSER_FILL_BENCH_FLAGS);
		rounds = flagCount(flags, "rounds") ?? 15;
	} catch (error) {
		console.error(errorMessage(error));
		console.error(USAGE);
		process.exit(2);
	}
	if (flags.help !== undefined) {
		console.log(USAGE);
		process.exit(0);
	}
	const timings = await runBrowserFillBench(rounds);
	const report = { label: flags.label ?? "unlabelled", timings };
	for (const t of timings) {
		console.log(
			`${report.label}  ${String(t.length).padStart(5)} chars  median ${t.medianMs} ms  p90 ${t.p90Ms} ms  correct ${t.correct}/${t.rounds}`,
		);
	}
	if (flags.json !== undefined) {
		await fs.mkdir(path.dirname(path.resolve(flags.json)), { recursive: true });
		await fs.writeFile(flags.json, `${JSON.stringify(report, null, 2)}\n`);
	}
}
