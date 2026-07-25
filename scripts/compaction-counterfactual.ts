#!/usr/bin/env bun
/**
 * Compaction counterfactual: one session, four arms.
 *
 * Runs the SAME session history through both compaction strategies on both
 * models, so the only thing that varies between arms is (strategy x model):
 *
 *     summary x gemini-3.6-flash      summary x gpt-5.6-sol
 *     handoff x gemini-3.6-flash      handoff x gpt-5.6-sol
 *
 * Single independent variable is enforced structurally: `prepareCompaction()`
 * runs ONCE and its result is shared by every arm, so all four see byte-identical
 * `messagesToSummarize` / `recentMessages` / `fileOps`. Nothing is re-derived
 * per arm.
 *
 * Scoring is mechanical, not vibes. Ground truth comes out of the source session
 * itself: the file paths the agent actually read and wrote (recorded in the
 * session's own compaction `details`) and the tool names it actually used. An
 * arm's output is scored on how many of those it still mentions. That measures
 * the one thing compaction exists to do, carry forward what the next turn needs.
 *
 * By default the replay point is the session's FIRST compaction entry: the
 * entries are truncated to everything before it, so every arm faces the exact
 * decision the real session faced at that moment, against the same history and
 * the same token pressure. `--at <n>` picks a later compaction point instead,
 * and `--at tail` compacts whatever is left after the last one.
 *
 * Usage:
 *   bun scripts/compaction-counterfactual.ts <session.jsonl> [--at <n|tail>] [--out <dir>] [--dry]
 *
 * `--dry` prepares and scores nothing but prints the arm plan and the shared
 * input size, so you can confirm the control before spending tokens.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
	prepareCompaction,
	type SessionEntry,
	type SummaryOptions,
} from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "@veyyon/coding-agent/sdk";
import { parseSessionEntries } from "@veyyon/coding-agent/session/session-loader";
import { migrateSessionEntries } from "@veyyon/coding-agent/session/session-migrations";
import { getProjectDir } from "@veyyon/utils";

interface ArmSpec {
	strategy: "summary" | "handoff";
	provider: string;
	modelId: string;
}

const ARMS: ArmSpec[] = [
	{ strategy: "summary", provider: "google-antigravity", modelId: "gemini-3.6-flash" },
	{ strategy: "summary", provider: "openai-codex", modelId: "gpt-5.6-sol" },
	{ strategy: "handoff", provider: "google-antigravity", modelId: "gemini-3.6-flash" },
	{ strategy: "handoff", provider: "openai-codex", modelId: "gpt-5.6-sol" },
];

interface ArmResult {
	arm: ArmSpec;
	label: string;
	ok: boolean;
	error?: string;
	text: string;
	chars: number;
	words: number;
	latencyMs: number;
	filesRecalled: number;
	filesTotal: number;
	toolsRecalled: number;
	toolsTotal: number;
	hasNextSteps: boolean;
	hasDecisions: boolean;
	/** Real provider usage for the arm's single LLM call. */
	inputTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
	costUsd: number;
}

/** Ground truth pulled from the session itself, not invented by the scorer. */
interface GroundTruth {
	/** Files the agent read or wrote, from the session's own compaction details. */
	files: string[];
	/** Distinct tool names the agent actually called. */
	tools: string[];
}

function extractGroundTruth(entries: SessionEntry[]): GroundTruth {
	const files = new Set<string>();
	const tools = new Set<string>();
	// `SessionEntry` is a discriminated union, so read it as one. The previous cast
	// to `Record<string, unknown>` threw the discriminant away and then re-asserted
	// each field by hand, which is how a `details` shape that no longer exists
	// would keep compiling and quietly contribute nothing to the ground truth.
	for (const entry of entries) {
		if (entry.type === "compaction") {
			// `details` is the extension-specific slot, typed `unknown` on the entry,
			// so this is the one place a shape assertion is genuinely required.
			const details = entry.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
			for (const f of details?.readFiles ?? []) files.add(f);
			for (const f of details?.modifiedFiles ?? []) files.add(f);
		}
		if (entry.type === "message" && "toolName" in entry.message && typeof entry.message.toolName === "string") {
			tools.add(entry.message.toolName);
		}
	}
	// Basenames are what a summary realistically names; full absolute paths are
	// too long to expect verbatim. Score on the distinctive tail of each path.
	const basenames = [...files]
		.map(f => f.split("/").filter(Boolean).pop() ?? f)
		.filter(f => f.length > 3 && f.includes("."));
	return { files: [...new Set(basenames)], tools: [...tools] };
}

function scoreRecall(text: string, needles: string[]): number {
	const haystack = text.toLowerCase();
	return needles.filter(n => haystack.includes(n.toLowerCase())).length;
}

async function loadEntries(sessionPath: string): Promise<SessionEntry[]> {
	const content = await fs.readFile(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

/**
 * Truncate to the history the real session held just before its `n`th
 * compaction, so the replay faces that exact decision. Returns the untouched
 * list for `tail`, which compacts whatever follows the last compaction.
 */
function sliceToCompactionPoint(
	entries: SessionEntry[],
	at: number | "tail",
): { entries: SessionEntry[]; real?: SessionEntry } {
	if (at === "tail") return { entries };
	const indices = entries.flatMap((e, i) => (e.type === "compaction" ? [i] : []));
	const idx = indices[at - 1];
	if (idx === undefined) {
		throw new Error(`session has ${indices.length} compaction entries; --at ${at} is out of range`);
	}
	return { entries: entries.slice(0, idx), real: entries[idx] };
}

/** Messages the compaction would summarize, in the order compact() sees them. */
function armMessages(preparation: CompactionPreparation): AgentMessage[] {
	return [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages, ...preparation.recentMessages];
}

async function resolveModel(registry: ModelRegistry, spec: ArmSpec): Promise<Model> {
	const available = registry.getAvailable();
	const model = available.find(m => m.provider === spec.provider && m.id === spec.modelId);
	if (!model) {
		throw new Error(
			`${spec.provider}/${spec.modelId} is not available. Authenticated providers: ` +
				[...new Set(available.map(m => m.provider))].join(", "),
		);
	}
	return model;
}

async function runArm(
	spec: ArmSpec,
	preparation: CompactionPreparation,
	model: Model,
	apiKey: string,
	truth: GroundTruth,
): Promise<ArmResult> {
	const label = `${spec.strategy} x ${spec.provider}/${spec.modelId}`;
	const started = Date.now();
	let text = "";
	let ok = true;
	let error: string | undefined;

	// Capture the provider's own usage for the arm's LLM call. Cache-read tokens
	// are the point: the two strategies build structurally different requests
	// (summary sends one synthetic message, handoff replays the live prefix), so
	// only a real number settles which one hits the prompt cache.
	const usage = { input: 0, cacheRead: 0, output: 0, cost: 0 };
	const completeImpl = (async (requestModel, ctx, requestOptions) => {
		const response = await ai.completeSimple(requestModel, ctx, requestOptions);
		usage.input += response.usage?.input ?? 0;
		usage.cacheRead += response.usage?.cacheRead ?? 0;
		usage.output += response.usage?.output ?? 0;
		usage.cost += response.usage?.cost?.total ?? 0;
		return response;
	}) as NonNullable<SummaryOptions["completeImpl"]>;

	try {
		if (spec.strategy === "summary") {
			const result = await compact(preparation, model, apiKey, undefined, undefined, { completeImpl });
			text = result.summary;
		} else {
			text = await generateHandoff(armMessages(preparation), model, apiKey, {
				completeImpl,
				systemPrompt: ["You are a coding agent handing off an in-progress session."],
				tools: [],
				// Same deterministic file block the summary strategy appends, so the
				// arms differ by strategy and model only.
				fileOps: preparation.fileOps,
			});
		}
	} catch (err) {
		ok = false;
		error = err instanceof Error ? err.message : String(err);
	}

	const latencyMs = Date.now() - started;
	const lower = text.toLowerCase();
	return {
		arm: spec,
		label,
		ok,
		error,
		text,
		chars: text.length,
		words: text.split(/\s+/).filter(Boolean).length,
		latencyMs,
		filesRecalled: scoreRecall(text, truth.files),
		filesTotal: truth.files.length,
		toolsRecalled: scoreRecall(text, truth.tools),
		toolsTotal: truth.tools.length,
		hasNextSteps: /next step|todo|remaining|still open|in progress|to do/.test(lower),
		hasDecisions: /decision|decided|chose|rationale|because|constraint/.test(lower),
		inputTokens: usage.input,
		cacheReadTokens: usage.cacheRead,
		outputTokens: usage.output,
		costUsd: usage.cost,
	};
}

function renderReport(
	sessionPath: string,
	preparation: CompactionPreparation,
	truth: GroundTruth,
	results: ArmResult[],
) {
	const lines: string[] = [];
	lines.push(`# Compaction counterfactual`);
	lines.push("");
	lines.push(`Session: \`${sessionPath}\``);
	lines.push("");
	lines.push(`## Control`);
	lines.push("");
	lines.push(`All four arms share one \`prepareCompaction()\` result, so the input is identical:`);
	lines.push("");
	lines.push(`- messages to summarize: ${preparation.messagesToSummarize.length}`);
	lines.push(`- turn-prefix messages: ${preparation.turnPrefixMessages.length}`);
	lines.push(`- recent messages kept: ${preparation.recentMessages.length}`);
	lines.push(`- tokens before: ${preparation.tokensBefore}`);
	lines.push(`- ground-truth files: ${truth.files.length}, tool names: ${truth.tools.length}`);
	lines.push("");
	lines.push(`## Results`);
	lines.push("");
	lines.push(`| arm | ok | chars | file recall | tool recall | input tok | cache-read | out tok | cost | latency |`);
	lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
	for (const r of results) {
		const filePct = r.filesTotal ? Math.round((r.filesRecalled / r.filesTotal) * 100) : 0;
		const toolPct = r.toolsTotal ? Math.round((r.toolsRecalled / r.toolsTotal) * 100) : 0;
		lines.push(
			`| ${r.label} | ${r.ok ? "yes" : "NO"} | ${r.chars} | ` +
				`${r.filesRecalled}/${r.filesTotal} (${filePct}%) | ${r.toolsRecalled}/${r.toolsTotal} (${toolPct}%) | ` +
				`${r.inputTokens} | ${r.cacheReadTokens} (${r.inputTokens + r.cacheReadTokens > 0 ? Math.round((r.cacheReadTokens / (r.inputTokens + r.cacheReadTokens)) * 100) : 0}%) | ` +
				`${r.outputTokens} | $${r.costUsd.toFixed(4)} | ${(r.latencyMs / 1000).toFixed(1)}s |`,
		);
	}
	lines.push("");
	for (const r of results) {
		lines.push(`## ${r.label}`);
		lines.push("");
		if (!r.ok) {
			lines.push(`FAILED: ${r.error}`);
			lines.push("");
			continue;
		}
		lines.push("```markdown");
		lines.push(r.text);
		lines.push("```");
		lines.push("");
	}
	return lines.join("\n");
}

async function main() {
	const args = process.argv.slice(2);
	const sessionPath = args.find(a => !a.startsWith("--"));
	if (!sessionPath) {
		console.error("usage: bun scripts/compaction-counterfactual.ts <session.jsonl> [--out <dir>] [--dry]");
		process.exit(1);
	}
	const dry = args.includes("--dry");
	// `--arms <substr>` restricts to matching arms and `--repeat <n>` runs each
	// arm n times. Together they measure run-to-run variance on one cell cheaply,
	// which is what tells a real prompt effect apart from sampling noise.
	const armsIdx = args.indexOf("--arms");
	const armsFilter = armsIdx >= 0 ? args[armsIdx + 1] : undefined;
	const repeatIdx = args.indexOf("--repeat");
	const repeat = repeatIdx >= 0 ? Number(args[repeatIdx + 1]) : 1;
	const atIdx = args.indexOf("--at");
	const atRaw = atIdx >= 0 ? args[atIdx + 1] : "1";
	const at: number | "tail" = atRaw === "tail" ? "tail" : Number(atRaw);
	if (at !== "tail" && (!Number.isInteger(at) || at < 1)) {
		console.error(`--at must be a positive integer or "tail"`);
		process.exit(1);
	}
	const outIdx = args.indexOf("--out");
	const outDir = outIdx >= 0 ? args[outIdx + 1] : "runs/compaction-counterfactual";

	console.error(`loading ${sessionPath} ...`);
	const allEntries = await loadEntries(sessionPath);
	// Ground truth comes from the WHOLE session, so it is not biased by where we cut.
	const truth = extractGroundTruth(allEntries);
	const { entries, real } = sliceToCompactionPoint(allEntries, at);
	if (real && real.type === "compaction") {
		console.error(
			`replaying compaction #${at} (real run: tokensBefore=${(real as { tokensBefore?: number }).tokensBefore}, ` +
				`summary ${((real as { summary?: string }).summary ?? "").length} chars)`,
		);
	}

	// ONE preparation, shared by every arm. This is the control.
	const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS });
	if (!preparation) {
		console.error("prepareCompaction returned nothing — session too small or already compacted at the tip.");
		process.exit(1);
	}

	console.error(
		`shared input: ${preparation.messagesToSummarize.length} to summarize, ` +
			`${preparation.recentMessages.length} recent, tokensBefore=${preparation.tokensBefore}`,
	);
	console.error(`ground truth: ${truth.files.length} files, ${truth.tools.length} tools`);
	console.error(`arms:\n${ARMS.map(a => `  - ${a.strategy} x ${a.provider}/${a.modelId}`).join("\n")}`);
	if (dry) return;

	// Same auth + registry construction the real CLI uses (`discoverAuthStorage`
	// resolves the shared credential store, which is where the OAuth providers
	// live). Building it any other way would silently see only API-key providers.
	const authStorage = await discoverAuthStorage();
	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	const registry = new ModelRegistry(authStorage);
	await loadCliExtensionProviders(registry, settings, cwd);

	const selected = ARMS.filter(
		a => !armsFilter || `${a.strategy} ${a.provider}/${a.modelId}`.includes(armsFilter),
	).flatMap(a => Array.from({ length: repeat }, () => a));
	const results: ArmResult[] = [];
	for (const spec of selected) {
		console.error(`running ${spec.strategy} x ${spec.provider}/${spec.modelId} ...`);
		try {
			const model = await resolveModel(registry, spec);
			const apiKey = await authStorage.getApiKey(model.provider);
			if (!apiKey) throw new Error(`no credential for ${model.provider}`);
			results.push(await runArm(spec, preparation, model, apiKey, truth));
		} catch (err) {
			results.push({
				arm: spec,
				label: `${spec.strategy} x ${spec.provider}/${spec.modelId}`,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				text: "",
				chars: 0,
				words: 0,
				latencyMs: 0,
				filesRecalled: 0,
				filesTotal: truth.files.length,
				toolsRecalled: 0,
				toolsTotal: truth.tools.length,
				hasNextSteps: false,
				hasDecisions: false,
				inputTokens: 0,
				cacheReadTokens: 0,
				outputTokens: 0,
				costUsd: 0,
			});
		}
	}

	const report = renderReport(sessionPath, preparation, truth, results);
	await fs.mkdir(outDir, { recursive: true });
	const reportPath = path.join(outDir, "report.md");
	await fs.writeFile(reportPath, report, "utf-8");
	console.error(`\nwrote ${reportPath}`);
	console.log(report.split("## Results")[1]?.split("##")[0] ?? report);
}

await main();
