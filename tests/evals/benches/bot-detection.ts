/**
 * Public bot-detector bench.
 *
 * The browser tool's headless Chromium is judged by what public detection pages conclude about it.
 * This bench opens each detector below through the real `BrowserTool`, drives it the way the page
 * asks (the interactions page wants a real `tab.click` and `tab.type` into its login form), and
 * prints one row per detector: the verdict the page states and every signal it marks against the
 * browser.
 *
 * It needs network access and its verdicts belong to the machine and the day it ran, so it is a
 * bench and not a test. It imports only the browser tool's public API and the flag parser in
 * `engine/plan/flag-grammar`, so a copy runs in any tree that has both: run it in the tree before a
 * change and in the tree after, back to back on one host, and the two reports differ only by the
 * change and by whatever the detectors changed between the runs.
 *
 *   bun benches/bot-detection.ts --label after --json runs/bot-detection-after.json
 *   bun benches/bot-detection.ts --only dabi,creepjs
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, parseFlags } from "../engine/plan/flag-grammar";

export const BOT_DETECTION_BENCH_FLAGS = {
	valued: { label: true, json: true, only: true },
	valueless: { help: true },
} as const satisfies FlagGrammar;

const USAGE =
	"usage: bun benches/bot-detection.ts [--label <name>] [--json <out.json>] [--only <id,id,...>]\n" +
	"detectors: dabi, dabi-interactions, sannysoft, browserscan, creepjs\n";

/** A page that judges the browser, and the run code that reads its judgement back. */
interface Detector {
	readonly id: string;
	readonly url: string;
	/**
	 * Body of a `run` call. It navigates, waits for the page's result, and returns
	 * `{ verdict, details }`: the page's own conclusion and each signal it marks against the browser.
	 */
	readonly code: string;
}

export interface DetectorResult {
	readonly detector: string;
	readonly url: string;
	readonly verdict: string;
	readonly details: readonly string[];
}

/** Reads deviceandbrowserinfo.com's `{ "isBot": ..., "details": {...} }` block once the page prints it. */
const DABI_READ = `
const body = await wait(async () => {
	const text = await tab.evaluate(() => document.body.innerText);
	return /"isBot"\\s*:/.test(text) ? text : undefined;
}, { timeout: 60000 }).catch(() => undefined);
if (!body) {
	const shown = (await tab.evaluate(() => document.body.innerText)).replace(/\\s+/g, " ");
	return { verdict: "no result shown", details: [shown.slice(shown.indexOf("Login"), shown.indexOf("Login") + 300)] };
}
const verdict = body.match(/You are (?:a bot|human)!?/i)?.[0] ?? "no verdict";
const details = [...body.matchAll(/"(\\w+)"\\s*:\\s*true/g)].map(match => match[1]).filter(name => name !== "isBot");
return { verdict, details };`;

export const DETECTORS: readonly Detector[] = [
	{
		id: "dabi",
		url: "https://deviceandbrowserinfo.com/are_you_a_bot",
		code: `await tab.goto("https://deviceandbrowserinfo.com/are_you_a_bot", { waitUntil: "networkidle2", timeout: 60000 });
${DABI_READ}`,
	},
	{
		id: "dabi-interactions",
		url: "https://deviceandbrowserinfo.com/are_you_a_bot_interactions",
		code: `await tab.goto("https://deviceandbrowserinfo.com/are_you_a_bot_interactions", { waitUntil: "networkidle2", timeout: 60000 });
await tab.click("#email");
await tab.type("#email", "not-a-real-user@example.com");
await tab.click("#password");
await tab.type("#password", "not-a-real-password-1");
await tab.click("#loginForm button[type=submit]");
${DABI_READ}`,
	},
	{
		id: "sannysoft",
		url: "https://bot.sannysoft.com/",
		code: `await tab.goto("https://bot.sannysoft.com/", { waitUntil: "networkidle2", timeout: 60000 });
await wait(5000);
const rows = await tab.evaluate(() =>
	Array.from(document.querySelectorAll("td.failed, td.warn")).map(cell => {
		const name = (cell.closest("tr")?.cells[0]?.innerText ?? "").trim().replace(/\\s+/g, " ");
		const value = cell.innerText.trim().replace(/\\s+/g, " ").slice(0, 60);
		return (cell.classList.contains("failed") ? "failed " : "warn ") + name + ": " + value;
	}),
);
const failed = rows.filter(row => row.startsWith("failed ")).length;
return { verdict: failed + " failed, " + (rows.length - failed) + " warn", details: rows };`,
	},
	{
		id: "browserscan",
		url: "https://www.browserscan.net/bot-detection",
		code: `await tab.goto("https://www.browserscan.net/bot-detection", { waitUntil: "networkidle2", timeout: 60000 });
const lines = await wait(async () => {
	const text = await tab.evaluate(() => document.body.innerText);
	const all = text.split("\\n").map(line => line.trim()).filter(Boolean);
	const at = all.indexOf("Test Results:");
	return at >= 0 && all[at + 1] ? all : undefined;
}, { timeout: 30000 });
const statuses = { Normal: true, Robot: true, Abnormal: true, Bot: true, Warning: true, Unknown: true };
const details = [];
for (let i = 1; i < lines.length; i++) {
	if (Object.hasOwn(statuses, lines[i]) && lines[i] !== "Normal" && lines[i - 1] !== "Test Results:") details.push(lines[i - 1] + ": " + lines[i]);
}
return { verdict: lines[lines.indexOf("Test Results:") + 1], details };`,
	},
	{
		id: "creepjs",
		url: "https://abrahamjuliot.github.io/creepjs/",
		code: `await tab.goto("https://abrahamjuliot.github.io/creepjs/", { waitUntil: "networkidle2", timeout: 60000 });
const body = await wait(async () => {
	const text = await tab.evaluate(() => document.body.innerText);
	return /\\d+% stealth/.test(text) ? text : undefined;
}, { timeout: 45000 });
const score = label => body.match(new RegExp("(\\\\d+)% " + label))?.[1] ?? "?";
const workerAgent = body.match(/Worker[\\s\\S]*?userAgent:\\s*\\n([^\\n]+)/)?.[1] ?? "";
const workerGpu = body.match(/Worker[\\s\\S]*?gpu:\\s*\\n[^\\n]*\\n([^\\n]+)/)?.[1] ?? "";
return {
	verdict: "like headless " + score("like headless") + "%, headless " + score("headless") + "%, stealth " + score("stealth") + "%",
	details: ["worker userAgent: " + workerAgent, "worker gpu: " + workerGpu],
};`,
	},
];

function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** Open each detector in one headless tab and read back its verdict. */
export async function runBotDetectionBench(detectors: readonly Detector[]): Promise<DetectorResult[]> {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	const tool = new BrowserTool(session);
	const tab = `bot-detection-bench-${process.pid}`;
	const results: DetectorResult[] = [];
	try {
		await tool.execute("open", { action: "open", name: tab, url: "about:blank" });
		for (const detector of detectors) {
			try {
				const result = await tool.execute("run", { action: "run", name: tab, timeout: 150, code: detector.code });
				const read = JSON.parse(resultText(result)) as { verdict: string; details: string[] };
				results.push({ detector: detector.id, url: detector.url, verdict: read.verdict, details: read.details });
			} catch (error) {
				results.push({ detector: detector.id, url: detector.url, verdict: "error", details: [errorMessage(error)] });
			}
		}
		return results;
	} finally {
		await tool.execute("close", { action: "close", name: tab, kill: true });
	}
}

if (import.meta.main) {
	let flags: Record<string, string>;
	try {
		flags = parseFlags(process.argv.slice(2), BOT_DETECTION_BENCH_FLAGS);
	} catch (error) {
		console.error(errorMessage(error));
		console.error(USAGE);
		process.exit(2);
	}
	if (flags.help !== undefined) {
		console.log(USAGE);
		process.exit(0);
	}
	const only = flags.only?.split(",").map(id => id.trim());
	const unknown = only?.filter(id => !DETECTORS.some(detector => detector.id === id)) ?? [];
	if (unknown.length > 0) {
		console.error(`unknown detector: ${unknown.join(", ")}`);
		console.error(USAGE);
		process.exit(2);
	}
	const chosen = only ? DETECTORS.filter(detector => only.includes(detector.id)) : DETECTORS;
	const results = await runBotDetectionBench(chosen);
	const report = { label: flags.label ?? "unlabelled", results };
	for (const r of results) {
		console.log(`${report.label}  ${r.detector.padEnd(18)} ${r.verdict}`);
		for (const detail of r.details) console.log(`${" ".repeat(report.label.length + 2)}${" ".repeat(19)}- ${detail}`);
	}
	if (flags.json !== undefined) {
		await fs.mkdir(path.dirname(path.resolve(flags.json)), { recursive: true });
		await fs.writeFile(flags.json, `${JSON.stringify(report, null, 2)}\n`);
	}
}
