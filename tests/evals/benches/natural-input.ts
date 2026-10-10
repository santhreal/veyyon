/**
 * `browser.naturalInput` latency bench.
 *
 * Natural input paces the browser tool's clicks, typing and fills the way a person's are paced, and
 * every model action on a page pays for it. This bench times `tab.click`, `tab.type`, `tab.fill` on a
 * text field, a date input and a range, and `tab.select` on a drop-down, in real headless Chromium,
 * inside the tab worker so the number is the action and not the tool call around it, with the setting
 * off and on in one tab of one browser, and counts an action correct only when the page shows its
 * effect: the pressed button's count, the field's exact value, the selected option.
 *
 * Apart from the flag parser in `engine/plan/flag-grammar`, it imports only the browser tool's public
 * API and its settings. The off arm is the instant input that preceded the setting, so the two arms of
 * one report differ only by the setting.
 *
 * Deliberately NOT a test: it launches Chromium and its numbers belong to the machine it ran on.
 *
 *   bun benches/natural-input.ts --label after --json runs/natural-input.json
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, flagCount, parseFlags } from "../engine/plan/flag-grammar";

export const NATURAL_INPUT_BENCH_FLAGS = {
	valued: { label: true, json: true, rounds: true },
	valueless: { help: true },
} as const satisfies FlagGrammar;

const USAGE = "usage: bun benches/natural-input.ts [--label <name>] [--json <out.json>] [--rounds <n, default 15>]\n";

const COUNTRIES = ["Argentina", "Australia", "Austria", "Belgium", "Brazil", "Canada", "Chile", "Denmark", "Finland", "France", "Germany", "Greece", "India", "Ireland", "Italy", "Japan", "Mexico", "Norway", "Peru", "Poland", "Portugal", "Spain", "Sweden"];

/** Two buttons across the viewport that count their presses, a field, a drop-down, a date and a range. */
const PAGE = `<!doctype html><title>natural input bench</title>
<style>body{margin:0}button,input,select{position:absolute;margin:0}#a{left:40px;top:40px;width:120px;height:40px}#b{left:900px;top:560px;width:120px;height:40px}#field{left:300px;top:240px;width:320px}#country{left:300px;top:300px}#day{left:300px;top:360px}#level{left:300px;top:420px}</style>
<button id="a" onclick="presses.a++">A</button><button id="b" onclick="presses.b++">B</button><input id="field">
<select id="country">${COUNTRIES.map(name => `<option>${name}</option>`).join("")}</select>
<input type="date" id="day"><input type="range" id="level">
<script>window.presses = { a: 0, b: 0 };</script>`;

/** What each timed action does, as run code: `i` is the round. */
const ACTIONS = {
	click: {
		setup: "",
		act: 'await tab.click(i % 2 ? "#b" : "#a");',
		check: 'const p = await tab.evaluate(() => presses); ok = p.a + p.b === i + 1 && p[i % 2 ? "b" : "a"] === Math.floor(i / 2) + 1;',
	},
	type: {
		setup: 'await tab.evaluate(() => { document.getElementById("field").value = ""; });',
		act: 'await tab.type("#field", "hello world");',
		check: 'ok = (await tab.evaluate(() => document.getElementById("field").value)) === "hello world";',
	},
	"fill-short": {
		setup: 'await tab.evaluate(() => { document.getElementById("field").value = "old"; });',
		act: 'await tab.fill("#field", "jo@example.test");',
		check: 'ok = (await tab.evaluate(() => document.getElementById("field").value)) === "jo@example.test";',
	},
	"fill-long": {
		setup: 'await tab.evaluate(() => { document.getElementById("field").value = "old"; });',
		act: `await tab.fill("#field", ${JSON.stringify("abcdefghij klmnopqrstuvwxyz0123456789".repeat(7).slice(0, 256))});`,
		check: `ok = (await tab.evaluate(() => document.getElementById("field").value)) === ${JSON.stringify("abcdefghij klmnopqrstuvwxyz0123456789".repeat(7).slice(0, 256))};`,
	},
	select: {
		setup: "",
		act: 'await tab.select("#country", i % 2 ? "Norway" : "Brazil");',
		check: 'ok = (await tab.evaluate(() => document.getElementById("country").value)) === (i % 2 ? "Norway" : "Brazil");',
	},
	"fill-date": {
		setup: "",
		act: 'await tab.fill("#day", i % 2 ? "1999-12-31" : "2026-09-26");',
		check: 'ok = (await tab.evaluate(() => document.getElementById("day").value)) === (i % 2 ? "1999-12-31" : "2026-09-26");',
	},
	"fill-range": {
		setup: "",
		act: 'await tab.fill("#level", i % 2 ? "73" : "20");',
		check: 'ok = (await tab.evaluate(() => document.getElementById("level").value)) === (i % 2 ? "73" : "20");',
	},
} as const;

export interface NaturalInputTiming {
	readonly action: keyof typeof ACTIONS;
	readonly naturalInput: boolean;
	readonly rounds: number;
	/** Actions whose effect the page shows exactly. */
	readonly correct: number;
	readonly minMs: number;
	readonly medianMs: number;
	readonly p90Ms: number;
	readonly maxMs: number;
}

function quantile(sorted: readonly number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
}

/** Time `rounds` of each action with natural input off, then on, in one headless tab. */
export async function runNaturalInputBench(rounds: number): Promise<NaturalInputTiming[]> {
	const server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(PAGE);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	const settings = Settings.isolated({ "browser.headless": true });
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
	const tool = new BrowserTool(session);
	const tab = `natural-input-bench-${process.pid}`;
	try {
		await tool.execute("open", { action: "open", name: tab, url });
		const timings: NaturalInputTiming[] = [];
		for (const naturalInput of [false, true]) {
			settings.set("browser.naturalInput", naturalInput);
			for (const [action, steps] of Object.entries(ACTIONS) as Array<[keyof typeof ACTIONS, (typeof ACTIONS)[keyof typeof ACTIONS]]>) {
				await tool.execute("run", { action: "run", name: tab, code: `await tab.goto(${JSON.stringify(url)});` });
				const result = await tool.execute("run", {
					action: "run",
					name: tab,
					timeout: 300,
					code: `
						const times = [];
						let correct = 0;
						for (let i = 0; i < ${rounds}; i++) {
							${steps.setup}
							const start = performance.now();
							${steps.act}
							times.push(performance.now() - start);
							let ok = false;
							${steps.check}
							if (ok) correct++;
						}
						return { times, correct };
					`,
				});
				const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
				const measured = JSON.parse(text) as { times: number[]; correct: number };
				const sorted = measured.times.toSorted((a, b) => a - b);
				timings.push({
					action,
					naturalInput,
					rounds,
					correct: measured.correct,
					minMs: Number((sorted[0] ?? Number.NaN).toFixed(2)),
					medianMs: Number(quantile(sorted, 0.5).toFixed(2)),
					p90Ms: Number(quantile(sorted, 0.9).toFixed(2)),
					maxMs: Number((sorted.at(-1) ?? Number.NaN).toFixed(2)),
				});
			}
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
		flags = parseFlags(process.argv.slice(2), NATURAL_INPUT_BENCH_FLAGS);
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
	const timings = await runNaturalInputBench(rounds);
	const report = { label: flags.label ?? "unlabelled", timings };
	for (const t of timings) {
		console.log(
			`${report.label}  ${t.action.padEnd(10)} natural ${t.naturalInput ? "on " : "off"}  min ${t.minMs} ms  median ${t.medianMs} ms  p90 ${t.p90Ms} ms  max ${t.maxMs} ms  correct ${t.correct}/${t.rounds}`,
		);
	}
	if (flags.json !== undefined) {
		await fs.mkdir(path.dirname(path.resolve(flags.json)), { recursive: true });
		await fs.writeFile(flags.json, `${JSON.stringify(report, null, 2)}\n`);
	}
}
