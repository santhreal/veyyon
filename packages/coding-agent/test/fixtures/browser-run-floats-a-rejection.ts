/**
 * Drives one headless tab through runs whose code floats a rejection, in a `bun` process of its own:
 * under `bun test` a worker thread ends on any unhandled rejection whatever listens for it, while the
 * CLI runs its tab workers under `bun`. Prints one JSON line of what each run returned or failed with.
 */
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/sdk";
import { BrowserTool } from "../../src/tools/web/browser";

const PAGE = "data:text/html,<title>t</title><button id=here>here</button>";
const TAB = "floating";

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({ "browser.headless": true }),
};
const tool = new BrowserTool(session);

/** A run with a budget short enough that one hanging for it shows in the outcome, not as a stalled test. */
async function run(code: string): Promise<string> {
	try {
		const result = await tool.execute("run", { action: "run", name: TAB, timeout: 5, code });
		return `returned: ${result.content.map(part => (part.type === "text" ? part.text : "")).join("\n")}`;
	} catch (error) {
		return `failed: ${(error as Error).message}`;
	}
}

await tool.execute("open", { action: "open", name: TAB, url: PAGE });
try {
	const outcome = {
		// The click's query takes the page a few milliseconds; the run is still waiting when it rejects.
		floatedInRun: await run('page.click("#missing"); await wait(300); return "returned";'),
		afterFloatedInRun: await run("return 1 + 1;"),
		floatedAfterRun: await run('setTimeout(() => { Promise.reject(new Error("late")); }, 300); return "returned";'),
		// The late rejection lands while this run waits; it names the run that floated it, not this one.
		runWhileItLands: await run("await wait(900); return 1 + 1;"),
		afterItLanded: await run('return await tab.evaluate(() => document.getElementById("here").textContent);'),
	};
	process.stdout.write(`${JSON.stringify(outcome)}\n`);
} finally {
	await tool.execute("close", { action: "close", all: true, kill: true });
}
process.exit(0);
