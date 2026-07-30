#!/usr/bin/env bun
/**
 * Real-terminal stress harness for veyyon's `/secret` feature.
 *
 *     bun scripts/secret-stress/run.ts
 *
 * WHY IT EXISTS. Everything in this area had unit coverage and shipped broken anyway, because the
 * failures live in the seams the unit tests do not span: two processes disagreeing about a vault
 * file, a throw escaping a render pass, a prompt that only exists behind a TTY. So this harness
 * refuses to import anything from the product. It launches the real CLI, in a real pseudo-terminal,
 * against a temp HOME it owns, and judges the bytes the terminal actually received.
 *
 * WHAT IT WILL NOT DO. It never reads or writes the operator's real `~/.veyyon` vaults, and it
 * never overrides `HOME` for anything but the child it spawned. It never prints a stored value:
 * the recorder redacts every seeded value out of every report line, so a detected leak is reported
 * without being reproduced. It never judges terminal output from a tmux capture, which repo policy
 * bans because tmux normalises away the exact difference between "drew an error" and "died".
 *
 * FLAGS
 *   --model <id>    catalog id for the session model (default `google-antigravity/gemini-2.5-flash`)
 *   --auth link     symlink the machine-global provider logins so a real model turn works (default)
 *   --auth none     no credential; scenarios needing a model turn record NOT RUN
 *   --only <a,b>    run only the named groups (see GROUPS below)
 *   --keep          leave the temp root on disk for post-mortem
 *   --cli <path>    drive ANOTHER checkout's `packages/coding-agent/src/cli.ts` (negative control)
 *   --report <path> where to write the markdown report (default `<root>/report.md`)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type AuthMode, createIsolatedRoot, destroyIsolatedRoot, runCliPiped, useCliEntry } from "./lib/isolation";
import { Recorder } from "./lib/report";
import {
	runAddScenarios,
	runIsolationSelfChecks,
	runListScenarios,
	runProtectionScenarios,
	runRemoveExtendScenarios,
	runRotationScenarios,
	runScopeScenarios,
	runTtlScenarios,
} from "./scenarios/commands";
import type { Ctx } from "./scenarios/context";
import { runSpendScenarios } from "./scenarios/spend";
import {
	runColdStartAfterExternalChange,
	runConcurrencyScenarios,
	runRevisionStabilityScenarios,
	runStaleVaultScenarios,
} from "./scenarios/stale-vault";
import { runTerminalScenarios } from "./scenarios/terminal";

/**
 * Groups in run order. `crash` is deliberately NOT last: it is the reason this harness exists, and
 * a run that dies half way through should still have produced that verdict.
 */
const GROUPS: Record<string, (ctx: Ctx) => Promise<void>> = {
	crash: runStaleVaultScenarios,
	coldstart: runColdStartAfterExternalChange,
	revision: runRevisionStabilityScenarios,
	add: runAddScenarios,
	scope: runScopeScenarios,
	ttl: runTtlScenarios,
	rotation: runRotationScenarios,
	list: runListScenarios,
	rmextend: runRemoveExtendScenarios,
	spend: runSpendScenarios,
	protection: runProtectionScenarios,
	terminal: runTerminalScenarios,
	concurrency: runConcurrencyScenarios,
};

/**
 * Gemini Flash: the cheapest fast model in the catalog that still emits real tool calls, so a run
 * that exercises the spend path costs almost nothing. Overridable with `--model`.
 */
const DEFAULT_MODEL = "google-antigravity/gemini-2.5-flash";

function parseArgs(argv: readonly string[]) {
	let model = DEFAULT_MODEL;
	let auth: AuthMode = "link";
	let only: string[] | null = null;
	let keep = false;
	let report: string | null = null;
	let cli: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model") model = argv[++i] ?? model;
		else if (arg === "--auth") auth = (argv[++i] as AuthMode) ?? auth;
		else if (arg === "--only")
			only = (argv[++i] ?? "")
				.split(",")
				.map(s => s.trim())
				.filter(Boolean);
		else if (arg === "--keep") keep = true;
		else if (arg === "--cli") cli = argv[++i] ?? null;
		else if (arg === "--report") report = argv[++i] ?? null;
		else throw new Error(`unknown flag ${arg}. See the header of scripts/secret-stress/run.ts.`);
	}
	if (auth !== "link" && auth !== "none") throw new Error(`--auth must be link or none, got ${auth}`);
	if (only) {
		const unknown = only.filter(name => !(name in GROUPS));
		if (unknown.length > 0) {
			throw new Error(`unknown group(s): ${unknown.join(", ")}. Known: ${Object.keys(GROUPS).join(", ")}`);
		}
	}
	return { model, auth, only, keep, report, cli };
}

const options = parseArgs(Bun.argv.slice(2));
if (options.cli) useCliEntry(options.cli);

const startedAt = new Date().toISOString();
const startedMs = Date.now();

const iso = await createIsolatedRoot("run", options.auth);
const rec = new Recorder(path.join(iso.work, "captures"));

process.stdout.write("=== veyyon /secret real-terminal stress ===\n");
process.stdout.write(`root      ${iso.root}\n`);
process.stdout.write(`agent dir ${iso.agentDir}\n`);
process.stdout.write(`project   ${iso.project}\n`);
process.stdout.write(`model     ${options.model} (auth=${options.auth})\n`);

/**
 * Whether a model resolves at all.
 *
 * Checked once, up front, with a trivial turn. Every model-dependent scenario reads this flag and
 * records NOT RUN with the reason rather than failing for the wrong cause -- a harness that reports
 * "the spend did not happen" when the truth is "nobody is signed in" sends the next reader chasing
 * a bug that is not there.
 */
const probe = await runCliPiped(iso, ["--model", options.model, "-p", "Reply with exactly: PONG"]);
const hasModel = probe.text.includes("PONG");
process.stdout.write(`model turn ${hasModel ? "works" : `UNAVAILABLE: ${probe.text.trim().split("\n")[0] ?? ""}`}\n`);

const ctx: Ctx = { iso, rec, model: options.model, hasModel, auth: options.auth, seeds: {} };

const isolated = await runIsolationSelfChecks(ctx);
if (!isolated) {
	process.stdout.write("\nFATAL: isolation self-checks failed. Nothing destructive was run.\n");
	process.exit(2);
}

const selected = options.only ?? Object.keys(GROUPS);
for (const name of selected) {
	try {
		await GROUPS[name]?.(ctx);
	} catch (error) {
		rec.record({
			name: `group ${name} ran to completion`,
			verdict: "FAIL",
			observed: "the harness itself threw while driving this group",
			detail: rec.redact(error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 800),
		});
	}
}

const reportPath = options.report ?? path.join(iso.root, "report.md");
fs.writeFileSync(
	reportPath,
	rec.renderMarkdown({ startedAt, model: options.model, durationMs: Date.now() - startedMs, root: iso.root }),
);

const passes = rec.results.length - rec.failures.length - rec.notRun.length;
process.stdout.write(`\n=== ${passes} PASS, ${rec.failures.length} FAIL, ${rec.notRun.length} NOT RUN ===\n`);
for (const failure of rec.failures) process.stdout.write(`FAIL  ${failure.name}\n        ${failure.observed}\n`);
process.stdout.write(`\nreport   ${reportPath}\ncaptures ${path.join(iso.work, "captures")}\n`);

if (options.keep) process.stdout.write("root kept for post-mortem (--keep)\n");
else if (rec.failures.length === 0) destroyIsolatedRoot(iso);
else process.stdout.write("root kept because the run had failures; delete it yourself when done\n");

process.exit(rec.failures.length === 0 ? 0 : 1);
