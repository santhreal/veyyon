/**
 * Pure result aggregation and report rendering for the DeepSWE bench.
 *
 * This lives apart from run.ts on purpose: run.ts is the entrypoint and ends with
 * a top-level `await main()`, so importing it to unit-test the math would launch a
 * benchmark. Everything here is a pure function of already-collected results, so a
 * test can feed it fixtures and assert exact numbers. run.ts imports {@link
 * ArmResult} and {@link renderReport} from here.
 *
 * The statistical core is {@link summarizeCell}: with `--repeats K`, an
 * (arm, task) cell holds up to K samples, and a single number cannot describe K
 * stochastic runs. A cell is summarized as a pass RATE with a 95% Wilson
 * confidence interval (see {@link wilsonInterval}), which is what lets a reader
 * tell a real arm effect from run-to-run noise without being fooled by the
 * zero-width standard error a boundary cell produces.
 */

import { ARGOT_PREAMBLE, DEFAULT_SIGIL } from "argot";

/**
 * Heading line of argot's teaching preamble, taken from argot's OWN rendered
 * preamble ({@link ARGOT_PREAMBLE}) so this marker can never drift from the text
 * the runtime injects. `renderPreamble`'s `tools` option changes only the body,
 * not this `## Project shorthand (Argot)` heading, so a single substring match on
 * it is a sound "was the model taught to encode this session" probe regardless of
 * which preamble variant fired.
 */
export const ARGOT_PREAMBLE_HEADING: string = ARGOT_PREAMBLE.split("\n", 1)[0] ?? "";

/**
 * True when a session's system prompt contains argot's teaching preamble, i.e.
 * the ENCODE treatment actually fired for that session.
 *
 * This is the authoritative, post-run treatment-applied probe, and it is the one
 * check the pre-run allowlist guard ({@link ../treatment-guard!encodeArmModelMismatch})
 * structurally cannot make: the pre-run guard matches the REQUESTED `--model`
 * string against the allowlist, but the runtime resolves that id through the
 * catalog (provider aliases, effort-tier collapsing) to a different logical id
 * BEFORE the encode gate sees it. A requested `google-antigravity/gemini-3.6-flash`
 * that resolves to logical `gemini-3.5-flash` passes the pre-run guard (3.6 is on
 * the list) yet fails the gate (the resolved 3.5 is not), so the arm silently
 * degrades to decode-only. Reading the actual system prompt the model was given
 * reflects the model AFTER resolution and catches exactly that silent degrade.
 */
export function systemPromptTeachesArgot(systemPrompt: string): boolean {
	if (ARGOT_PREAMBLE_HEADING === "") return false;
	return systemPrompt.includes(ARGOT_PREAMBLE_HEADING);
}

/**
 * Whether an assistant content block carries an argot handle (a `§name` token).
 *
 * This is the primitive behind the "did the encode treatment fire" probe. The
 * subtlety it exists to fix: encode does NOT only surface in prose. The argot
 * preamble tells the model to write a handle "in prose, a command, or a diff", so
 * on a coding agent a handle most often lands inside a tool call's `arguments` (a
 * shell command string, an edit diff), NOT a text block. A probe that scanned only
 * text blocks would undercount encode and could read a heavy-encode arm as
 * `0 encoded`, which would falsely conclude the treatment never fired and silently
 * invalidate every token delta. So this checks the text block AND the serialized
 * tool-call arguments. The sigil is argot's own {@link DEFAULT_SIGIL} (one place —
 * the bench never customizes it, and a divergence would show up as zero encoded
 * rows rather than a wrong count).
 */
export function blockContainsSigil(block: unknown, sigil: string = DEFAULT_SIGIL): boolean {
	if (typeof block !== "object" || block === null) return false;
	const b = block as Record<string, unknown>;
	if (typeof b.text === "string" && b.text.includes(sigil)) return true;
	if (b.type === "toolCall" && b.arguments !== undefined) {
		try {
			return JSON.stringify(b.arguments).includes(sigil);
		} catch {
			// A non-serializable arguments object (cycles) cannot carry a plain
			// handle string we could have counted; treat it as sigil-free rather
			// than throwing out of a read-only probe.
			return false;
		}
	}
	return false;
}

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	costUsd: number;
	argotLoadCalls: number;
	assistantMsgsWithSigil: number;
	toolCalls: Record<string, number>;
}

/**
 * Tally token usage and tool telemetry from a session's messages.
 *
 * The bug this consolidates and fixes: one tool invocation appears in the
 * transcript TWICE — as a `toolCall` block on the assistant message that
 * requested it, and again as a `toolResult` message carrying its output. The
 * old parser incremented the distribution on BOTH, so every tool count was
 * doubled (a run with 40 real `eval` calls reported 80). Tools are now tallied
 * exactly once, from the assistant's `toolCall` blocks — the model's actual
 * invocations — and `argot_load` is counted from that same place, so the
 * treatment probe and the tool distribution can never disagree about how many
 * times the model called it.
 *
 * `messages` is the ordered sequence of `entry.message` objects from a session
 * jsonl (already JSON-parsed by the caller; malformed lines dropped upstream).
 * Token fields read veyyon's own `usage` accounting on each assistant message.
 */
export function tallyUsage(messages: Array<Record<string, unknown>>): SessionUsage {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheTokens = 0;
	let costUsd = 0;
	let argotLoadCalls = 0;
	let assistantMsgsWithSigil = 0;
	const toolCalls: Record<string, number> = {};
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = (message.usage ?? {}) as Record<string, number | Record<string, number>>;
		inputTokens += (usage.input as number) || 0;
		outputTokens += (usage.output as number) || 0;
		cacheTokens += ((usage.cacheRead as number) || 0) + ((usage.cacheWrite as number) || 0);
		costUsd += (usage.cost as Record<string, number>)?.total || 0;
		const content = (message.content ?? []) as Array<Record<string, unknown>>;
		// Encode is detected wherever a handle can land — a text block OR a tool
		// call's arguments (commands and diffs carry handles too). See
		// blockContainsSigil; scanning text only would undercount encode.
		if (content.some(b => blockContainsSigil(b))) assistantMsgsWithSigil++;
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				block.type === "toolCall" &&
				typeof block.name === "string"
			) {
				toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
				if (block.name === "argot_load") argotLoadCalls++;
			}
		}
	}
	return { inputTokens, outputTokens, cacheTokens, costUsd, argotLoadCalls, assistantMsgsWithSigil, toolCalls };
}

/**
 * Extract a provider "finish reason" (e.g. `PROHIBITED_CONTENT`, `SAFETY`,
 * `RECITATION`) from captured agent output, if one is present.
 *
 * These are content-filter / policy stops: the provider aborts generation
 * mid-turn and the agent process exits non-zero, which the bench records as an
 * errored (excluded) sample. Naming the reason matters because a provider refusal
 * is NOT the same failure as a genuine agent crash, and — critically — a refusal
 * that hits one arm more than another is a confound (or, if it tracks the
 * treatment such as an injected preamble, a real effect). Either way it must be
 * distinguishable, not folded into a generic error bucket. Returns null when no
 * finish-reason marker is found. Matches both `finish reason:` and `finish_reason`.
 */
export function providerFinishReason(text: string): string | null {
	const m = text.match(/finish[ _]reason:?\s*([A-Z][A-Z_]{2,})/);
	return m ? (m[1] as string) : null;
}

/**
 * Group an errored sample under a short, comparable failure label.
 *
 * The stored error is either pier's stringified `exception_info`
 * (`{"exception_type":"…","exception_message":"…"}`) or a runner-side string
 * (a timeout, a pier exit line). This pulls out a stable label — the exception
 * type, refined with a provider finish reason when one is embedded — so the
 * report can show WHICH failure mode hit each arm and expose an asymmetry rather
 * than an anonymous count. Never throws on non-JSON input.
 */
/**
 * Error string stamped on a trial the agent RAN to completion (no exception) but the
 * verifier never scored — `verifier_result` is missing or its `reward` is not a
 * finite number. This is NOT a task failure: a failure is reward=0 (a real number the
 * verifier assigned), whereas a missing reward means the scorer itself did not run.
 */
export const NO_REWARD_ERROR = "verifier produced no reward: missing verifier_result.rewards.reward";

/**
 * Whether a parsed verifier reward means "the verifier did not score this trial".
 * True for null/undefined/NaN/±Infinity; false for any finite number INCLUDING 0
 * (0 is a legitimate scored failure, not a missing score). The runner uses this to
 * fail closed — reclassifying an unscored trial as an error so it is excluded from
 * every rate and mean instead of being silently counted as a fail (reward !== 1),
 * which would understate the pass rate and, if the verifier trips more on one arm's
 * outputs, score a scorer confound as a correctness loss (Law 10, no silent fallback).
 */
export function noRewardError(reward: number | null): boolean {
	return !Number.isFinite(reward ?? Number.NaN);
}

export function classifyError(error: string): string {
	// A verifier-no-reward is a runner-side string with no exception_type; give it its
	// own stable label so a scorer outage shows as a distinct, comparable failure mode
	// (and its per-arm asymmetry is visible) rather than dissolving into "other".
	if (error.includes(NO_REWARD_ERROR)) return "verifier-no-reward";
	const finish = providerFinishReason(error);
	let base = "other";
	// Regex rather than JSON.parse: run.ts appends a recovered `finish_reason: …`
	// after the exception_info JSON, so the whole string is not valid JSON. Pulling
	// the type out directly stays robust to that (and to any trailing pier text).
	const typeMatch = error.match(/"exception_type"\s*:\s*"([^"]+)"/);
	if (typeMatch) {
		base = typeMatch[1] as string;
	} else if (/timed out/i.test(error)) {
		base = "timeout";
	}
	return finish ? `${base} (${finish})` : base;
}

/**
 * The job name is the single identifier for a container run, a config file, and a
 * jobs/ subdirectory, so its format lives in exactly this pair of functions and
 * nowhere else. A repeat suffix (`__r<n>`) is appended only when a cell is sampled
 * more than once; a single-sample run keeps the historic `arm__task` name so runs
 * produced before --repeats existed still reaggregate. The scheme relies on two
 * facts about the inputs: arm names never contain `__`, and DeepSWE task names are
 * hyphenated (never `__`). So the FIRST `__` splits arm from the rest, and a
 * trailing `__r<digits>` is the repeat index. {@link parseJobName} is the exact
 * inverse of {@link jobNameOf}; the round-trip is what keeps reaggregate from
 * mis-attributing a sample to the wrong task or repeat.
 */
export function jobNameOf(arm: string, task: string, repeat: number, repeats: number): string {
	return repeats > 1 ? `${arm}__${task}__r${repeat}` : `${arm}__${task}`;
}

/**
 * Pick `limit` tasks spread EVENLY across the sorted task set, for a smoke/debug
 * run that cannot afford the full suite.
 *
 * The obvious `sorted.slice(0, limit)` is unsound as a sample: DeepSWE task names
 * are repo-prefixed (`astropy__...`, `django__...`), so the alphabetically-first
 * N cluster on the first repo or two, and a pass rate measured over them is not an
 * estimate of the pass rate over the whole suite — it silently benches a biased
 * slice. An even stride across the sorted list spans the whole task space instead,
 * so a limited run is a representative subsample of the full one.
 *
 * The stride is fully deterministic (no RNG), so the same `limit` always selects
 * the same tasks and a limited run stays reproducible and reaggregatable. Returns
 * the full set (a copy) when `limit` is undefined or at least the set size, and the
 * empty set when `limit <= 0`.
 */
export function selectTasks(sorted: readonly string[], limit: number | undefined): string[] {
	if (limit === undefined || limit >= sorted.length) return [...sorted];
	if (limit <= 0) return [];
	const out: string[] = [];
	for (let i = 0; i < limit; i++) {
		// i/limit walks [0,1) in `limit` even steps; scaling by the set size spreads
		// the picks across the whole sorted range instead of clustering at the head.
		out.push(sorted[Math.floor((i * sorted.length) / limit)] as string);
	}
	return out;
}

/**
 * Provenance of a task list: is it safe to report as a headline number, or is it a
 * selection-biased subset? A task-list `.txt` may declare this in its header comments
 * with a directive line:
 *
 *   `# @headline` (optionally `: note`) — an unbiased set (held-out, representative),
 *   whose efficiency/pass numbers can be reported as a headline.
 *   `# @biased: <reason>` — a set curated to favour the feature under test (e.g. the
 *   repos with the most repeated-token mass for a compressor), which yields a
 *   best-case UPPER BOUND, never a headline.
 *
 * This matters because a feature measured only on the tasks hand-picked to make it
 * look good is not measured honestly. Marking the set lets the report warn loudly so
 * a best-case subset is never mistaken for the real-world expected effect.
 */
export interface TaskSetProvenance {
	/** Whether a `@headline` or `@biased` directive was found in the header. */
	marked: boolean;
	/** True for a selection-biased set (`@biased`) that must not be a headline. */
	biased: boolean;
	/** The directive's explanatory note, if any. */
	note: string | null;
}

/**
 * Parse a task list's header comments for its {@link TaskSetProvenance} directive.
 * Only the leading comment block is scanned — a directive must sit in the header,
 * above the first task line — so a `@`-looking token in a task name cannot spoof it.
 * Returns `marked: false` when no directive is present, which the report surfaces as
 * "provenance unmarked" so every task list is nudged toward declaring its status.
 */
export function parseTaskListProvenance(content: string): TaskSetProvenance {
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (!line.startsWith("#")) break; // header ended: first task reached
		const body = line.replace(/^#+\s*/, "");
		const biased = body.match(/^@biased\b:?\s*(.*)$/i);
		if (biased) return { marked: true, biased: true, note: (biased[1] as string).trim() || null };
		const headline = body.match(/^@headline\b:?\s*(.*)$/i);
		if (headline) return { marked: true, biased: false, note: (headline[1] as string).trim() || null };
	}
	return { marked: false, biased: false, note: null };
}

/**
 * The one-line banner the report prints for a task set's provenance, so a reader can
 * never miss that a set is selection-biased (or unmarked). Blockquoted so it stands
 * out at the top of the markdown report.
 */
export function renderTaskSetProvenanceBanner(prov: TaskSetProvenance): string {
	if (prov.biased) {
		const why = prov.note ? ` ${prov.note}` : "";
		return `> ⚠️ **Task set is SELECTION-BIASED — a best-case upper bound, NOT a headline number.**${why}`;
	}
	if (prov.marked) {
		const why = prov.note ? ` ${prov.note}` : "";
		return `> Task set: headline (unbiased).${why}`;
	}
	return "> ⚠️ Task-set provenance is unmarked. Add `# @headline` or `# @biased: <reason>` to the task list header so a best-case subset is never read as a headline.";
}

/** Inverse of {@link jobNameOf}: recover (arm, task, repeat) from a job name. */
export function parseJobName(jobName: string): { arm: string; task: string; repeat: number } {
	const sep = jobName.indexOf("__");
	const arm = jobName.slice(0, sep);
	let task = jobName.slice(sep + 2);
	let repeat = 0;
	const m = task.match(/__r(\d+)$/);
	if (m) {
		repeat = Number(m[1]);
		task = task.slice(0, m.index);
	}
	return { arm, task, repeat };
}

export interface ArmResult {
	arm: string;
	task: string;
	/** 0-based sample index within an (arm, task) cell; 0 when --repeats is 1. */
	repeat: number;
	reward: number | null;
	partial: number | null;
	f2p: number | null;
	p2p: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheTokens: number | null;
	costUsd: number | null;
	agentSeconds: number | null;
	argotLoadCalls: number | null;
	assistantMsgsWithSigil: number | null;
	/**
	 * Whether this trial's session system prompt actually taught argot's encode
	 * preamble (see {@link systemPromptTeachesArgot}). `true` = encode fired,
	 * `false` = a session was present but was NOT taught to encode (the silent
	 * decode-only degrade an encode arm must never hide), `null` = no readable
	 * session, so presence is unknown. This is the authoritative treatment-applied
	 * signal, resolved from the prompt the model was actually given.
	 */
	argotPreamblePresent: boolean | null;
	/**
	 * The handle count the launch project's argot dictionary actually loaded for
	 * this trial, read from the SDK's `argot_armed` telemetry record. This is what
	 * makes a `0 encoded` result interpretable — the number the report cannot infer
	 * from the prompt (the handle table is injected asynchronously AFTER the
	 * `session_init` snapshot, so it never appears in any recorded prompt). `0` is a
	 * real, informative value: the repo had no repeated-token mass, so encode was
	 * impossible for a CORPUS reason, not a model choice. `null` = no `argot_armed`
	 * record was seen (argot off, or an older run predating the telemetry), so the
	 * loaded vocabulary size is unknown and the report says so rather than guessing.
	 */
	argotHandlesLoaded: number | null;
	/**
	 * The effect-size ceiling for this trial: how much shorthand could have saved at
	 * perfect adoption (see {@link encodeHeadroom}). `null` when the trial carried no
	 * `argot_armed` vocabulary to measure against, so no ceiling is computable.
	 * Without this a reader cannot tell a feature that did not help from a workload
	 * on which it could not possibly have helped.
	 */
	encodeHeadroom: EncodeHeadroom | null;
	toolCalls: Record<string, number> | null;
	error: string | null;
}

/**
 * The summary of one group of samples (a whole arm, or a single (arm, task) cell).
 * Every mean is over the OK samples only (errors are excluded from reward/token
 * math but counted in {@link errors}), because a container that never produced a
 * trial has no reward to average and would drag a mean toward zero as if the agent
 * had failed the task, which it did not.
 */
export interface CellSummary {
	/** All attempts in the group, including errored ones. */
	total: number;
	/** Attempts that errored (no trial result). */
	errors: number;
	/** OK attempts (total - errors); the denominator for every rate and mean. */
	n: number;
	/** OK attempts with reward exactly 1. */
	passes: number;
	/** passes / n, or null when n is 0. */
	passRate: number | null;
	/**
	 * Binomial normal-approximation standard error of {@link passRate}:
	 * sqrt(p*(1-p)/n). A convenient point measure of spread, kept for downstream
	 * analysis, but NOT the displayed interval: at the boundaries it is degenerate
	 * (all-pass or all-fail gives exactly 0, falsely implying certainty), and on a
	 * SWE bench with small K those boundary cells are common. The report shows the
	 * Wilson interval instead (see {@link wilsonLow}). Null when n is 0.
	 */
	stdErr: number | null;
	/**
	 * Lower / upper bound of the Wilson score 95% confidence interval for
	 * {@link passRate}. This is the honest uncertainty the report prints: unlike the
	 * normal-approximation {@link stdErr}, it never collapses to a zero-width claim
	 * at the boundary — 3 of 3 passes yields roughly [0.44, 1.0], not [1.0, 1.0], so
	 * a reader cannot mistake a lucky small sample for a certain result. Two arms
	 * whose Wilson intervals overlap are not distinguishable at this sample count.
	 * Null when n is 0.
	 */
	wilsonLow: number | null;
	wilsonHigh: number | null;
	meanReward: number | null;
	meanPartial: number | null;
	meanOutputTokens: number | null;
	/**
	 * Mean uncached input tokens. Present so the efficiency comparison can TEST a
	 * feature that trades input for output rather than only displaying it: a larger
	 * argot dictionary is injected into the prompt every turn, so it buys shorter
	 * output with longer input. A comparison that scores only output would call
	 * that a clean win no matter how much input it cost.
	 */
	meanInputTokens: number | null;
	meanCostUsd: number | null;
	sumOutputTokens: number;
	sumCostUsd: number;
	sumInputTokens: number;
	sumCacheTokens: number;
	sumAgentSeconds: number;
}

function mean(values: Array<number | null>): number | null {
	const nums = values.filter((v): v is number => v !== null && v !== undefined);
	if (nums.length === 0) return null;
	return nums.reduce((a, v) => a + v, 0) / nums.length;
}

/**
 * The sampling temperature the bench pins for every arm that does not set its own.
 *
 * 0 means greedy/deterministic decoding. The bench pins it, rather than inheriting
 * veyyon's own default of -1 ("use the provider default"), for two reasons that
 * matter for an eval set meant to be iterated on for a long time:
 *
 *  1. Interpretability of `--repeats`. At temperature 0 the only run-to-run
 *     variation is genuine provider nondeterminism, not sampling spread, so a small
 *     K estimates each arm's pass rate with the tightest interval and a real arm
 *     effect is detectable with fewer samples.
 *  2. Longitudinal comparability. A provider default can change silently between two
 *     runs (a model or provider update), which would make two runs non-comparable
 *     with nothing recording the drift. A pinned, stamped value cannot drift
 *     unnoticed.
 *
 * At temperature 0 the decode is greedy, so top-p / top-k are irrelevant; pinning
 * temperature alone fully determines the sampling regime. An individual arm MAY
 * still set its own temperature for a deliberate temperature-as-independent-variable
 * experiment (see {@link effectiveTemperature}), and that override is recorded.
 */
export const PINNED_TEMPERATURE = 0;

/**
 * The temperature one arm actually runs at: the arm's own `temperature` when it
 * sets a real (non-negative) one — a deliberate temperature-as-IV experiment —
 * otherwise {@link PINNED_TEMPERATURE}. A value below 0 in the config means "use the
 * provider default", which is exactly the silent-drift regime the bench refuses to
 * leave in place, so it is treated as unset and the pinned value wins. Pure so the
 * runner and the results.json stamp agree by construction.
 */
export function effectiveTemperature(config: unknown, pinned: number = PINNED_TEMPERATURE): number {
	if (config !== null && typeof config === "object" && "temperature" in config) {
		const t = (config as { temperature: unknown }).temperature;
		if (typeof t === "number" && Number.isFinite(t) && t >= 0) return t;
	}
	return pinned;
}

/** z for a two-sided 95% interval (standard normal 0.975 quantile). */
const Z_95 = 1.959963984540054;

/**
 * Wilson score confidence interval for a binomial proportion (passes out of n).
 * Returns the interval that is honest at the boundaries where the normal
 * approximation is not: with k = n (or k = 0) it still reports real width instead
 * of collapsing to a point, which is exactly the small-sample, near-0/near-1 regime
 * a task-level bench spends most of its time in. Bounds are clamped to [0, 1].
 * Returns null bounds when n is 0 (no attempts to estimate from).
 */
export function wilsonInterval(
	passes: number,
	n: number,
	z: number = Z_95,
): { low: number | null; high: number | null } {
	if (n <= 0) return { low: null, high: null };
	const p = passes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const halfWidth = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
	return {
		low: Math.max(0, center - halfWidth),
		high: Math.min(1, center + halfWidth),
	};
}

/**
 * Two-sided exact sign-test p-value for a paired comparison: given `wins` tasks
 * where arm B beat arm A and `losses` where A beat B (ties excluded), the
 * probability, under the null that B and A are equally good, of a win/loss split
 * at least this lopsided in either direction.
 *
 * This is the honest arm-vs-arm test. Comparing two arms' independent Wilson
 * intervals for overlap throws away the fact that BOTH arms ran the SAME tasks:
 * task difficulty is the dominant source of variance, and pairing by task removes
 * it, so the paired test has far more power. The sign test is chosen over a
 * normal-approximation paired t because it is exact and makes no distributional
 * assumption — it cannot understate uncertainty at the small task counts a bench
 * usually runs, which is the same failure mode the Wilson interval fixes for a
 * single cell. Computed from the Binomial(n, 0.5) CDF with an iterative PMF, so
 * there is no overflow even at 100+ tasks and no floating factorial.
 *
 * Returns 1 when there are no decisive tasks (all ties): no evidence either way.
 */
export function signTestPValue(wins: number, losses: number): number {
	const n = wins + losses;
	if (n <= 0) return 1;
	const k = Math.min(wins, losses);
	// Cumulative P(X <= k) for X ~ Binomial(n, 0.5), built from pmf(0) = 0.5^n and
	// the ratio pmf(i) = pmf(i-1) * (n-i+1)/i. Stable and exact-in-spirit.
	let pmf = 0.5 ** n;
	let cdf = pmf;
	for (let i = 1; i <= k; i++) {
		pmf *= (n - i + 1) / i;
		cdf += pmf;
	}
	return Math.min(1, 2 * cdf);
}

/**
 * Whether a paired comparison could reach significance AT ALL at its current task
 * count — the honest reading of a "not distinguishable" verdict. `nDecisive` is the
 * number of informative (non-tie) tasks; `familySize` is how many pairs are being
 * Holm-corrected together.
 *
 * The exact sign test cannot beat α=0.05 below a minimum decisive-task count: a
 * perfect 3-0 sweep is p=0.25, 4-0 is p=0.125, 5-0 is p=0.0625 — all above 0.05 —
 * and only 6-0 (p=0.03125) clears it. So a run with 4 paired tasks CANNOT produce a
 * significant pass-rate result no matter how lopsided, and Holm makes the bar
 * stricter still. A verdict of "not distinguishable" from such a run means "too few
 * tasks to decide", NOT "measured and found equal". This flags exactly that case by
 * asking whether the best possible outcome — a clean sweep, taking the maximum Holm
 * penalty ×familySize — would clear α. If not, the comparison is structurally
 * underpowered and the reader must add tasks, not conclude a null.
 */
export function sweepCanReachSignificance(nDecisive: number, familySize: number, alpha = 0.05): boolean {
	if (nDecisive <= 0) return false;
	const bestCaseRaw = signTestPValue(nDecisive, 0);
	const bestCaseAdjusted = Math.min(1, bestCaseRaw * Math.max(1, familySize));
	return bestCaseAdjusted < alpha;
}

/**
 * Holm–Bonferroni step-down adjustment of a family of p-values, returned aligned to
 * the input order. Each adjusted value is the number to compare against a single α:
 * a test is significant at family-wise error rate α iff its adjusted p is below α.
 *
 * Why the report needs this: the arm comparison runs one sign test PER arm pair, and
 * a run with k arms tests k(k-1)/2 pairs. Judging each at α=0.05 independently means
 * the probability of AT LEAST ONE spurious "winner" grows with the pair count — about
 * 40% at 10 pairs (5 arms). That is the exact way a multi-arm bench manufactures a
 * false result, so the "winner" verdict must be judged against the corrected value,
 * not the raw one. Holm controls the family-wise error rate while being uniformly
 * more powerful than plain Bonferroni: it multiplies the smallest p by m, the next by
 * m-1, and so on, inflating each only as much as its rank requires.
 *
 * The running max enforces the step-down monotonicity the procedure requires (a
 * larger raw p can never adjust below a smaller one) and each value is clamped to 1.
 * An empty family returns an empty array; a single test is returned unchanged (×1).
 */
export function holmBonferroni(pValues: readonly number[]): number[] {
	const m = pValues.length;
	if (m === 0) return [];
	const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
	const adjusted = new Array<number>(m);
	let running = 0;
	order.forEach((entry, rank) => {
		// rank is 0-based; the step-down factor is (m - rank), i.e. m for the smallest.
		const val = Math.min(1, entry.p * (m - rank));
		running = Math.max(running, val);
		adjusted[entry.i] = running;
	});
	return adjusted;
}

/** One arm-vs-arm paired comparison over the tasks both arms ran. */
export interface ArmDelta {
	/** Reference arm (the "from" side of the delta). */
	armA: string;
	/** Candidate arm (the "to" side); {@link meanDelta} is B minus A. */
	armB: string;
	/** Tasks with at least one OK (non-errored) sample in BOTH arms — the paired unit count. */
	nTasks: number;
	/** Mean over paired tasks of (passRate_B - passRate_A). Positive = B better. Null when nTasks is 0. */
	meanDelta: number | null;
	/**
	 * 95% CI for {@link meanDelta} from the per-task deltas (normal approximation,
	 * z * sd/sqrt(nTasks)). An effect-size aid, secondary to {@link signTestP}; at a
	 * small nTasks read the sign test, not this. Null when nTasks < 2 (no spread to
	 * estimate).
	 */
	ciLow: number | null;
	ciHigh: number | null;
	/** Tasks where B's pass rate exceeded A's. */
	wins: number;
	/** Tasks where A's pass rate exceeded B's. */
	losses: number;
	/** Tasks where the two pass rates were equal. */
	ties: number;
	/** Two-sided exact sign-test p-value over wins/losses (see {@link signTestPValue}). */
	signTestP: number;
}

/** One arm-vs-arm paired comparison on an arbitrary per-cell metric. */
export interface PairedComparison {
	/** Reference arm (the "from" side). */
	armA: string;
	/** Candidate arm (the "to" side); {@link meanDelta} is B minus A on the metric. */
	armB: string;
	/** Tasks with a non-null metric in BOTH arms — the paired unit count. */
	nTasks: number;
	/** Mean over paired tasks of (metric_B - metric_A). Null when nTasks is 0. */
	meanDelta: number | null;
	/** 95% normal-approximation CI for {@link meanDelta} (z * sd/sqrt(nTasks)). Null when nTasks < 2. */
	ciLow: number | null;
	ciHigh: number | null;
	/** Tasks where B's metric exceeded A's. */
	pos: number;
	/** Tasks where A's metric exceeded B's. */
	neg: number;
	/** Tasks where the two metrics were equal. */
	ties: number;
	/** Two-sided exact sign-test p-value over pos vs neg (see {@link signTestPValue}). */
	signTestP: number;
}

/**
 * The paired-by-task core every arm comparison shares. For each unordered arm pair
 * (first-seen order), a task counts only when `metricOf` is non-null for BOTH arms'
 * cells; the per-task delta is `valueB - valueA`. Returns the mean delta with a
 * normal-approximation CI (effect size) and an exact sign test over the up/down
 * counts (the verdict). Pure and deterministic. One implementation so pass-rate and
 * efficiency comparisons cannot drift apart.
 */
function pairedByTask(
	results: readonly ArmResult[],
	metricOf: (cell: CellSummary) => number | null,
): PairedComparison[] {
	// Sorted, not insertion-ordered. A live run pushes rows as jobs finish (which
	// depends on --jobs and on which container happens to be slow) and a
	// reaggregate rebuilds them in readdir order, so the same data can arrive in
	// different orders. Deriving arm order from that would flip a pair's direction
	// between two renders of ONE run, inverting every delta's sign and making two
	// reports of the same data diff as though the result had changed.
	const arms = [...new Set(results.map(r => r.arm))].sort();
	const tasks = [...new Set(results.map(r => r.task))].sort();
	const valueAt = (arm: string, task: string): number | null =>
		metricOf(summarizeCell(results.filter(r => r.arm === arm && r.task === task)));
	const out: PairedComparison[] = [];
	for (let i = 0; i < arms.length; i++) {
		for (let j = i + 1; j < arms.length; j++) {
			const armA = arms[i] as string;
			const armB = arms[j] as string;
			const deltas: number[] = [];
			let pos = 0;
			let neg = 0;
			let ties = 0;
			for (const task of tasks) {
				const a = valueAt(armA, task);
				const b = valueAt(armB, task);
				if (a === null || b === null) continue; // unpaired: one arm has no value here
				const d = b - a;
				deltas.push(d);
				if (d > 0) pos++;
				else if (d < 0) neg++;
				else ties++;
			}
			const nTasks = deltas.length;
			const meanDelta = nTasks > 0 ? deltas.reduce((s, d) => s + d, 0) / nTasks : null;
			let ciLow: number | null = null;
			let ciHigh: number | null = null;
			if (nTasks >= 2 && meanDelta !== null) {
				const variance = deltas.reduce((s, d) => s + (d - meanDelta) ** 2, 0) / (nTasks - 1);
				const se = Math.sqrt(variance / nTasks);
				ciLow = meanDelta - Z_95 * se;
				ciHigh = meanDelta + Z_95 * se;
			}
			out.push({
				armA,
				armB,
				nTasks,
				meanDelta,
				ciLow,
				ciHigh,
				pos,
				neg,
				ties,
				signTestP: signTestPValue(pos, neg),
			});
		}
	}
	return out;
}

/**
 * Every unordered arm pair, compared PAIRED by task on PASS RATE. A task counts only
 * when both arms produced at least one OK sample. This is what lets the report state
 * whether B actually beat A on correctness instead of asking the reader to eyeball
 * two overlapping independent intervals. Thin wrapper over {@link pairedByTask};
 * `wins`/`losses` are the pass-rate up/down counts.
 */
export function pairwiseArmDeltas(results: readonly ArmResult[]): ArmDelta[] {
	return pairedByTask(results, c => c.passRate).map(p => ({
		armA: p.armA,
		armB: p.armB,
		nTasks: p.nTasks,
		meanDelta: p.meanDelta,
		ciLow: p.ciLow,
		ciHigh: p.ciHigh,
		wins: p.pos,
		losses: p.neg,
		ties: p.ties,
		signTestP: p.signTestP,
	}));
}

/**
 * Every unordered arm pair, compared PAIRED by task on an efficiency metric (mean
 * output tokens, mean cost, ...). This is what makes an efficiency feature like argot
 * measurable: its promise is FEWER tokens at equal reward, so the win is a negative
 * paired delta here (B cheaper than A) that the sign test confirms, READ TOGETHER
 * WITH the pass-rate comparison as a guardrail — cheaper only counts if correctness
 * did not drop. `metric` picks the per-cell number to compare; a cell whose metric is
 * null (all-errored, or the metric was never recorded) drops the task from the pair.
 */
export function pairwiseMetricDeltas(
	results: readonly ArmResult[],
	metric: (cell: CellSummary) => number | null,
): PairedComparison[] {
	return pairedByTask(results, metric);
}

/**
 * Reduce a group of samples to a {@link CellSummary}. Pure: same input, same
 * output, no IO. Used for both the per-arm rollup (all of an arm's samples) and
 * each per-task cell (one arm, one task, all repeats).
 */
export function summarizeCell(rows: readonly ArmResult[]): CellSummary {
	const ok = rows.filter(r => !r.error);
	const n = ok.length;
	const passes = ok.filter(r => r.reward === 1).length;
	const passRate = n > 0 ? passes / n : null;
	const stdErr = passRate === null ? null : Math.sqrt((passRate * (1 - passRate)) / n);
	const wilson = wilsonInterval(passes, n);
	const sum = (f: (r: ArmResult) => number | null) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);
	return {
		total: rows.length,
		errors: rows.length - n,
		n,
		passes,
		passRate,
		stdErr,
		wilsonLow: wilson.low,
		wilsonHigh: wilson.high,
		meanReward: mean(ok.map(r => r.reward)),
		meanPartial: mean(ok.map(r => r.partial)),
		meanOutputTokens: mean(ok.map(r => r.outputTokens)),
		meanInputTokens: mean(ok.map(r => r.inputTokens)),
		meanCostUsd: mean(ok.map(r => r.costUsd)),
		sumOutputTokens: sum(r => r.outputTokens),
		sumCostUsd: sum(r => r.costUsd),
		sumInputTokens: sum(r => r.inputTokens),
		sumCacheTokens: sum(r => r.cacheTokens),
		sumAgentSeconds: sum(r => r.agentSeconds),
	};
}

function fmt(n: number | null, digits = 0): string {
	if (n === null || n === undefined) return "—";
	return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

/**
 * A pass rate rendered with its 95% Wilson confidence interval, e.g.
 * `0.67 [0.30–0.90] (4/6)`. The interval is the Wilson score interval, not
 * `passRate ± stdErr`: the normal-approximation error collapses to a zero-width
 * `±0.00` at an all-pass or all-fail cell (`3/3` → `1.00 ±0.00`), which reads as
 * false certainty. Boundary cells are common on a SWE bench, so the report shows
 * the Wilson bounds — `3/3` becomes `1.00 [0.44–1.00]`, honestly wide.
 */
function fmtRate(s: CellSummary): string {
	if (s.passRate === null) return "—";
	const ci =
		s.wilsonLow === null || s.wilsonHigh === null ? "" : ` [${s.wilsonLow.toFixed(2)}–${s.wilsonHigh.toFixed(2)}]`;
	return `${s.passRate.toFixed(2)}${ci} (${s.passes}/${s.n})`;
}

/**
 * Concatenate everything the model actually emitted across a session's messages.
 *
 * "Emitted" means exactly what {@link blockContainsSigil} scans for handles: the
 * assistant's text blocks AND its tool-call arguments. The two must agree, because
 * one measures where handles DID land and the other measures where they COULD
 * have; scanning different seams would let the headroom claim a saving in a place
 * the encode probe never looks (or the reverse), and the two numbers would quietly
 * describe different runs.
 *
 * Only assistant messages count. Tool RESULTS are the harness feeding text back to
 * the model, not output the model pays for, so including them would inflate the
 * denominator and understate the achievable saving.
 */
export function collectEmittedText(messages: Array<Record<string, unknown>>): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message.content ?? []) as Array<Record<string, unknown>>) {
			if (typeof block !== "object" || block === null) continue;
			if (typeof block.text === "string") parts.push(block.text);
			if (block.type === "toolCall" && block.arguments !== undefined) {
				try {
					parts.push(JSON.stringify(block.arguments));
				} catch {
					// A non-serializable arguments object cannot carry a plain expansion
					// we could have counted; skip it rather than throwing out of a probe.
				}
			}
		}
	}
	return parts.join("\n");
}

/** The ceiling on what shorthand could have saved a run, at perfect adoption. */
export interface EncodeHeadroom {
	/** Characters the model actually emitted (assistant text plus tool-call arguments). */
	emittedChars: number;
	/** Handles in the loaded vocabulary. */
	handles: number;
	/** Handles whose expansion appears at least once in what the model emitted. */
	usableHandles: number;
	/** Characters saved if EVERY occurrence of every expansion had been written as its handle. */
	maxSavedChars: number;
	/** {@link maxSavedChars} as a percentage of {@link emittedChars}; 0 when nothing was emitted. */
	maxSavedPct: number;
}

/**
 * Compute the maximum saving shorthand could possibly have delivered on a run.
 *
 * This is the effect-size ceiling, and it is the instrument that decides whether a
 * run can measure argot AT ALL. It answers a question no amount of repeats can:
 * if the model had encoded perfectly — every occurrence of every expansion written
 * as its handle — how much shorter would its output be? When that ceiling sits
 * below the run's token noise, the comparison is measuring variance, and adding
 * samples cannot help, because the effect being sought is smaller than the effect
 * that exists. Note how this differs from {@link sweepCanReachSignificance}: that
 * detects too few DECISIVE TASKS (a sample-size limit), this detects too small an
 * ACHIEVABLE EFFECT (a workload limit). A run can be fine on one and hopeless on
 * the other.
 *
 * Measured against the real ytt task this caught the case it was built for: 33
 * handles loaded, only 7 ever emitted, ceiling 0.27% of output — while run-to-run
 * token variance was around 9%. Every argot delta on that workload was noise, and
 * the report had no way to say so.
 *
 * Occurrences are counted non-overlapping, the same way a real encoder would
 * substitute them, and each one saves the expansion's length minus the handle's
 * (plus its sigil). Expansions shorter than their handle contribute nothing rather
 * than a negative saving: an encoder would simply not use them.
 */
export function encodeHeadroom(
	emitted: string,
	handles: Readonly<Record<string, string>>,
	sigil: string = DEFAULT_SIGIL,
): EncodeHeadroom {
	let usableHandles = 0;
	let maxSavedChars = 0;
	for (const [name, expansion] of Object.entries(handles)) {
		if (expansion.length === 0) continue;
		let occurrences = 0;
		let from = 0;
		for (;;) {
			const at = emitted.indexOf(expansion, from);
			if (at === -1) break;
			occurrences++;
			from = at + expansion.length;
		}
		if (occurrences === 0) continue;
		usableHandles++;
		const perOccurrence = expansion.length - (sigil.length + name.length);
		if (perOccurrence > 0) maxSavedChars += occurrences * perOccurrence;
	}
	return {
		emittedChars: emitted.length,
		handles: Object.keys(handles).length,
		usableHandles,
		maxSavedChars,
		maxSavedPct: emitted.length === 0 ? 0 : (100 * maxSavedChars) / emitted.length,
	};
}

/** How much of a repository's vocabulary is in strings a coding agent would ever type. */
export interface TypeableMass {
	/** Handles in the vocabulary. */
	handles: number;
	/** Handles whose expansion contains no whitespace, so an agent could plausibly type it. */
	typeable: number;
	/**
	 * Characters saved per emission if every typeable handle were written once:
	 * the sum over typeable handles of expansion length minus handle length.
	 * This is the compressible mass that is actually reachable by an agent.
	 */
	savingPerEmission: number;
	/** Longest typeable expansion, the best single substitution available. */
	longestTypeable: number;
}

/**
 * Score a vocabulary by how much of it a coding agent could ever actually write.
 *
 * This is the pre-run screen for choosing tasks that can measure shorthand at all.
 * It exists because the exact ceiling ({@link encodeHeadroom}) is only computable
 * AFTER a run, which is far too late to discover that a multi-hour benchmark was
 * unmeasurable by construction.
 *
 * The whitespace test is the whole idea, and it is calibrated against real data
 * rather than assumed. On the first run where encoding actually fired, every one
 * of the seven handles the model emitted was whitespace-free, and not a single
 * whitespace-bearing handle was ever emitted: 100% recall, 33% precision. Prose
 * repeats heavily in a repository (license blocks, fixture YAML, documentation
 * URLs) and therefore earns handles, but an agent never retypes it. Paths, import
 * specifiers, and symbols are what an agent writes over and over.
 *
 * Because the test never misses a string the model would have written, a low score
 * is a SOUND one-sided conclusion: such a repository cannot show a shorthand
 * effect, whatever the run does. A high score is only a candidate, not a promise,
 * since the agent still has to touch those particular strings. Screen with this,
 * then confirm with {@link encodeHeadroom} on the run itself.
 */
export function typeableHandleMass(
	handles: Readonly<Record<string, string>>,
	sigil: string = DEFAULT_SIGIL,
): TypeableMass {
	let typeable = 0;
	let savingPerEmission = 0;
	let longestTypeable = 0;
	for (const [name, expansion] of Object.entries(handles)) {
		if (expansion.length === 0 || /\s/.test(expansion)) continue;
		const saving = expansion.length - (sigil.length + name.length);
		if (saving <= 0) continue;
		typeable++;
		savingPerEmission += saving;
		longestTypeable = Math.max(longestTypeable, expansion.length);
	}
	return { handles: Object.keys(handles).length, typeable, savingPerEmission, longestTypeable };
}

/**
 * The run's own noise floor: how much output size varies between REPEATED SAMPLES
 * OF THE SAME TASK, as a percentage.
 *
 * Grouping by task is the whole point and not a detail. Pooling every sample of
 * an arm across tasks measures task difficulty, which dwarfs run-to-run noise: a
 * one-line fix and a subsystem refactor differ in output by multiples, while two
 * runs of the same task differ by a few percent. Pooled that way the "noise" floor
 * is enormous, and an effect ceiling that genuinely clears real noise gets
 * declared unmeasurable. Only samples of the SAME task under the SAME arm differ
 * by nothing except chance, which is exactly the floor a real effect must clear.
 *
 * Per-task spreads are combined by taking the median, so one pathological task (a
 * timeout, a refusal retry) cannot set the floor for the whole run. Returns `null`
 * when no task has at least two samples, since spread is then unobservable.
 */
export function withinTaskSpreadPct(rows: readonly ArmResult[]): number | null {
	const byTask = new Map<string, number[]>();
	for (const row of rows) {
		if (row.error || row.outputTokens === null) continue;
		const list = byTask.get(row.task);
		if (list === undefined) byTask.set(row.task, [row.outputTokens]);
		else list.push(row.outputTokens);
	}
	const spreads: number[] = [];
	for (const values of byTask.values()) {
		const spread = relativeSpreadPct(values);
		if (spread !== null) spreads.push(spread);
	}
	if (spreads.length === 0) return null;
	spreads.sort((a, b) => a - b);
	const mid = Math.floor(spreads.length / 2);
	return spreads.length % 2 === 1 ? spreads[mid]! : (spreads[mid - 1]! + spreads[mid]!) / 2;
}

/**
 * Relative spread of a set of values, as a percentage of their mean.
 *
 * Used as the run's own noise floor: the token totals of repeated samples of the
 * SAME arm on the SAME task differ only by run-to-run variance, so their spread is
 * a direct, assumption-free estimate of how large a difference this workload can
 * produce by chance. Returns `null` when fewer than two values are available (no
 * spread is observable) or the mean is zero.
 */
export function relativeSpreadPct(values: readonly number[]): number | null {
	if (values.length < 2) return null;
	const avg = values.reduce((a, b) => a + b, 0) / values.length;
	if (avg === 0) return null;
	const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / (values.length - 1);
	return (100 * Math.sqrt(variance)) / Math.abs(avg);
}

/**
 * Decide whether a run's achievable saving is large enough to be detectable at all.
 *
 * The rule is deliberately blunt because the failure it prevents is severe: if the
 * BEST possible outcome (perfect encoding of every handle) is smaller than the
 * noise the workload already produces between identical samples, then no delta the
 * report prints can be attributed to the feature, and no number of repeats changes
 * that. Reporting such a run as "not distinguishable" is technically true and
 * badly misleading, because it invites "we measured it and it does not help" when
 * the truth is "this workload cannot show it either way".
 *
 * `noisePct` is `null` when the run had no repeats to estimate spread from; then
 * the ceiling alone is judged against a conservative floor of one percent, below
 * which a token effect is not credibly separable from ordinary drift.
 */
export function ceilingBelowNoise(maxSavedPct: number, noisePct: number | null): boolean {
	return maxSavedPct < (noisePct ?? 1);
}

/**
 * Explain what an encode arm's `0 encoded` (or nonzero) result actually means, by
 * reading the loaded vocabulary size alongside the taught/encoded counts.
 *
 * This is the instrument that makes an argot token delta interpretable. Three
 * distinct realities produce a "full ≈ decode" report, and the raw counts alone
 * cannot tell them apart:
 *
 * - The preamble was taught but the launch dictionary loaded ZERO handles: the
 *   corpus has no repeated-token mass, so encoding was structurally impossible.
 *   The token delta measures nothing about argot — do NOT read it as "argot does
 *   not help". This is the trap the whole helper exists to catch.
 * - Handles WERE available (a positive load) yet the model wrote none: a genuine
 *   model-adoption result, chargeable to the model, not the corpus.
 * - The model did encode (`encoded > 0`): the delta is a real argot measurement.
 *
 * `handlesLoaded` is `null` for a run that predates the `argot_armed` telemetry;
 * then the loaded size is unknown and the verdict says so rather than guessing.
 * Returns `null` when there is nothing to say (no OK runs, or the arm never taught
 * the preamble in any run — a non-encode arm needs no interpretation here).
 */
export function interpretEncodeArm(opts: {
	arm: string;
	okRuns: number;
	taught: number;
	handlesLoaded: number | null;
	encoded: number;
}): string | null {
	const { arm, okRuns, taught, handlesLoaded, encoded } = opts;
	if (okRuns === 0 || taught === 0) return null;
	if (encoded > 0) {
		const size = handlesLoaded === null ? "an unknown number of" : `${handlesLoaded}`;
		return (
			`**${arm}**: the model encoded in ${encoded}/${okRuns} runs with ${size} handles loaded — ` +
			"the token delta against this arm is a real argot measurement."
		);
	}
	if (handlesLoaded === null) {
		return (
			`**${arm}**: taught the preamble but encoded in 0/${okRuns} runs, and the loaded vocabulary size is ` +
			"UNKNOWN (this run predates the `argot_armed` telemetry). The 0-encoded result is uninterpretable — " +
			"rerun so the loaded handle count is recorded before reading any token delta as an argot effect."
		);
	}
	if (handlesLoaded === 0) {
		return (
			`**${arm}**: taught the preamble but the launch dictionary loaded 0 handles, so encoding was ` +
			"IMPOSSIBLE — this corpus has no repeated-token mass to compress. The token delta against this arm " +
			"is NOT a measure of argot; pick tasks whose repos carry repeated paths/commands to measure encode."
		);
	}
	return (
		`**${arm}**: ${handlesLoaded} handles WERE loaded but the model encoded in 0/${okRuns} runs — it ignored ` +
		"the available shorthand. This is a model-adoption result (chargeable to the model), not a corpus limit; " +
		"the token delta reflects the model declining to encode, not argot being ineffective."
	);
}

/**
 * Render the full markdown report. `repeats` is passed so the header can state the
 * sample count; it is not re-derived from the rows, so an all-errored run still
 * reports the intended repeat count rather than collapsing to 1. `taskSet`, when
 * given, prints a provenance banner so a selection-biased set is never read as a
 * headline; omit it (older runs, unit fixtures) to skip the banner.
 */
export function renderReport(
	results: readonly ArmResult[],
	model: string,
	nowIso: string,
	repeats = 1,
	taskSet?: TaskSetProvenance,
): string {
	// Sorted for the same reason as pairedByTask: rendering must depend only on the
	// DATA, never on the order rows happened to arrive in.
	const arms = [...new Set(results.map(r => r.arm))].sort();
	const tasks = [...new Set(results.map(r => r.task))].sort();
	const cell = (arm: string, task: string) => results.filter(r => r.arm === arm && r.task === task);
	const lines: string[] = [];
	lines.push(`# DeepSWE bench — ${nowIso}`);
	lines.push("");
	lines.push(`Model: \`${model}\`. Tasks: ${tasks.length}. Repeats/cell: ${repeats}. Arms: ${arms.join(", ")}.`);
	lines.push("");
	if (taskSet) {
		lines.push(renderTaskSetProvenanceBanner(taskSet));
		lines.push("");
	}
	lines.push("## Per arm totals");
	lines.push("");
	lines.push(
		"| arm | samples | pass rate [95% CI] | mean reward | mean partial | input tok | output tok | cache tok | cost USD | agent wall |",
	);
	lines.push("|---|---|---|---|---|---|---|---|---|---|");
	for (const arm of arms) {
		const s = summarizeCell(results.filter(r => r.arm === arm));
		const samples = s.errors > 0 ? `${s.n} (+${s.errors} err)` : String(s.n);
		lines.push(
			`| ${arm} | ${samples} | ${fmtRate(s)} | ${fmt(s.meanReward, 2)} | ${fmt(s.meanPartial, 2)} | ` +
				`${fmt(s.sumInputTokens)} | ${fmt(s.sumOutputTokens)} | ${fmt(s.sumCacheTokens)} | ` +
				`$${s.sumCostUsd.toFixed(3)} | ${fmt(s.sumAgentSeconds)}s |`,
		);
	}
	lines.push("");
	lines.push("## Per task");
	lines.push("");
	lines.push(`| task | ${arms.map(a => `${a}: pass | ${a}: mean out tok | ${a}: mean cost`).join(" | ")} |`);
	lines.push(`|---|${arms.map(() => "---|---|---|").join("")}`);
	for (const task of tasks) {
		const cells = arms.flatMap(a => {
			const s = summarizeCell(cell(a, task));
			if (s.total === 0) return ["—", "—", "—"];
			if (s.n === 0) return ["ERR", "—", "—"];
			return [fmtRate(s), fmt(s.meanOutputTokens), s.meanCostUsd === null ? "—" : `$${s.meanCostUsd.toFixed(3)}`];
		});
		lines.push(`| ${task} | ${cells.join(" | ")} |`);
	}
	if (arms.length >= 2) {
		lines.push("");
		lines.push("## Arm comparison (paired by task)");
		lines.push("");
		lines.push(
			"Δ pass rate is arm B minus arm A, averaged over tasks both arms ran. The verdict is a two-sided exact " +
				"sign test over per-task wins/losses (ties excluded); it uses the paired structure, so it has far more " +
				"power than comparing the two arms' independent intervals above. The Δ 95% CI is a normal-approximation " +
				"effect-size aid — at a small task count, trust the sign test. `adj p` is the Holm–Bonferroni-corrected " +
				"p-value across all decisive arm pairs in this run: with k arms there are k(k-1)/2 pairs, so the raw " +
				"p-value manufactures a false winner as the pair count grows. The verdict is decided on `adj p < 0.05`, " +
				"which holds the family-wise false-positive rate at 5% no matter how many arms you compare.",
		);
		lines.push("");
		const armDeltas = pairwiseArmDeltas(results);
		// The family being corrected is the set of pairs that actually ran a test (at
		// least one decisive task); a pair with only ties/unpaired tasks is not a
		// hypothesis and must not inflate the correction factor. Holm is applied to that
		// family and the adjusted p is looked up per row by the ordered A→B key.
		const armTested = armDeltas.filter(d => d.wins + d.losses > 0);
		const armAdj = holmBonferroni(armTested.map(d => d.signTestP));
		const armAdjByPair = new Map(armTested.map((d, i) => [`${d.armA}→${d.armB}`, armAdj[i] as number]));
		// Continuous-reward comparison, computed here so BOTH its own table below and the
		// efficiency guardrail read the same tested family. Binary pass rate above
		// (reward===1) cannot see a partial-credit regression: the DeepSWE verifier returns
		// a fractional reward, so an arm can lower the mean reward on hard tasks without
		// flipping any task's pass/fail. This is its own Holm family (a reward drop is a
		// different hypothesis than a resolved-rate drop).
		const rewardDeltas = pairwiseMetricDeltas(results, c => c.meanReward);
		const rewardTested = rewardDeltas.filter(d => d.pos + d.neg > 0);
		const rewardAdj = holmBonferroni(rewardTested.map(d => d.signTestP));
		const rewardAdjByPair = new Map(rewardTested.map((d, i) => [`${d.armA}→${d.armB}`, rewardAdj[i] as number]));
		lines.push("| A → B | paired tasks | Δ pass rate | Δ 95% CI | W-L-T | sign-test p | adj p (Holm) | verdict |");
		lines.push("|---|---|---|---|---|---|---|---|");
		for (const d of armDeltas) {
			const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + d.meanDelta.toFixed(3);
			const ci =
				d.ciLow === null || d.ciHigh === null
					? "—"
					: `[${(d.ciLow >= 0 ? "+" : "") + d.ciLow.toFixed(3)}, ${(d.ciHigh >= 0 ? "+" : "") + d.ciHigh.toFixed(3)}]`;
			const adjP = armAdjByPair.get(`${d.armA}→${d.armB}`);
			const decisive = adjP !== undefined && adjP < 0.05;
			// A non-significant verdict is only "measured equal" if the run COULD have shown
			// a difference. If even a clean sweep at this decisive-task count can't clear the
			// Holm-adjusted bar, the null is uninformative — say "underpowered" so the reader
			// adds tasks instead of concluding the arms are equivalent.
			const underpowered = !decisive && !sweepCanReachSignificance(d.wins + d.losses, armTested.length);
			const verdict = decisive
				? `${d.meanDelta !== null && d.meanDelta > 0 ? d.armB : d.armA} better (adj p<0.05)`
				: underpowered
					? "not distinguishable (underpowered)"
					: "not distinguishable";
			lines.push(
				`| ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} | ${ci} | ${d.wins}-${d.losses}-${d.ties} | ${d.signTestP.toFixed(3)} | ${adjP === undefined ? "—" : adjP.toFixed(3)} | ${verdict} |`,
			);
		}

		// Continuous-reward table. The binary pass rate above is the headline SWE-bench
		// "resolved" metric; this catches the partial-credit regression it is blind to and
		// makes the efficiency guardrail's reward input operator-visible instead of hidden.
		const rewardHasSignal = results.some(r => !r.error && r.reward !== null);
		if (rewardHasSignal) {
			lines.push("");
			lines.push("## Reward comparison — continuous partial credit (paired by task)");
			lines.push("");
			lines.push(
				"The pass-rate table binarizes at reward=1 (SWE-bench 'resolved'). The DeepSWE " +
					"verifier returns a fractional reward, so an arm can lower the mean reward on hard " +
					"tasks without flipping any task's pass/fail — invisible above, caught here. Δ is B " +
					"minus A on each task's mean reward; a negative Δ the sign test confirms is B doing " +
					"WORSE. The efficiency guardrail reads this: 'reward held' requires BOTH this and the " +
					"binary pass rate to not significantly drop.",
			);
			lines.push("");
			lines.push(
				"| A → B | paired tasks | Δ mean reward | Δ 95% CI | up-B / down-B / tie | sign-test p | adj p (Holm) | verdict |",
			);
			lines.push("|---|---|---|---|---|---|---|---|");
			for (const d of rewardDeltas) {
				const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + d.meanDelta.toFixed(3);
				const ci =
					d.ciLow === null || d.ciHigh === null
						? "—"
						: `[${(d.ciLow >= 0 ? "+" : "") + d.ciLow.toFixed(3)}, ${(d.ciHigh >= 0 ? "+" : "") + d.ciHigh.toFixed(3)}]`;
				const adjP = rewardAdjByPair.get(`${d.armA}→${d.armB}`);
				const sig = adjP !== undefined && adjP < 0.05;
				const rUnderpowered = !sig && !sweepCanReachSignificance(d.pos + d.neg, rewardTested.length);
				const verdict =
					sig && d.meanDelta !== null && d.meanDelta > 0
						? `${d.armB} higher reward`
						: sig && d.meanDelta !== null && d.meanDelta < 0
							? `${d.armB} lower reward`
							: rUnderpowered
								? "not distinguishable (underpowered)"
								: "not distinguishable";
				lines.push(
					`| ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} | ${ci} | ${d.pos}/${d.neg}/${d.ties} | ${d.signTestP.toFixed(3)} | ${adjP === undefined ? "—" : adjP.toFixed(3)} | ${verdict} |`,
				);
			}
		}

		// Efficiency comparison. For a feature whose promise is FEWER tokens at equal
		// reward (argot), this is the section that actually measures the claim: a win
		// is a negative paired delta (B cheaper) the sign test confirms, READ WITH the
		// pass-rate table above as a guardrail — cheaper only counts if correctness held.
		const metrics: Array<{
			label: string;
			unit: string;
			of: (c: CellSummary) => number | null;
			raw: (r: ArmResult) => number | null;
			digits: number;
		}> = [
			{ label: "output tok", unit: "tok", of: c => c.meanOutputTokens, raw: r => r.outputTokens, digits: 0 },
			// Input is tested, not merely displayed. A feature can buy shorter output
			// by spending prompt: a larger argot dictionary rides in the prompt every
			// turn. Scoring output alone would score only one side of that trade.
			{ label: "input tok", unit: "tok", of: c => c.meanInputTokens, raw: r => r.inputTokens, digits: 0 },
			{ label: "cost", unit: "$", of: c => c.meanCostUsd, raw: r => r.costUsd, digits: 4 },
		];
		lines.push("");
		lines.push("## Efficiency comparison (paired by task)");
		lines.push("");
		lines.push(
			"Δ is arm B minus arm A on the per-task mean, over tasks both arms ran. A negative Δ means B is cheaper. " +
				"The verdict pairs the sign test on this metric with the pass-rate guardrail: B is an efficiency win only " +
				"when it is significantly cheaper (Holm-adjusted p<0.05 within this metric's pairs) AND the pass-rate " +
				"comparison above did not find B worse (also on the Holm-adjusted p). `adj p` is corrected across this " +
				"metric's arm pairs for the same reason the pass-rate table is.",
		);
		lines.push("");
		lines.push(
			"| metric | A → B | paired tasks | Δ mean | Δ 95% CI | cheaper-B / dearer-B / tie | sign-test p | adj p (Holm) | verdict |",
		);
		lines.push("|---|---|---|---|---|---|---|---|---|");
		for (const m of metrics) {
			// A metric the provider never reports (e.g. cost is 0 for a provider with no
			// pricing entry) is uniformly 0/null across every OK sample. Its paired delta
			// is then 0 with p=1, which the loop below would render as "not
			// distinguishable" — reading as "measured and found equal" when it was never
			// measured at all. Detect the no-signal case and say so, so a missing metric
			// is never mistaken for a null result.
			const hasSignal = results.some(r => !r.error && (m.raw(r) ?? 0) !== 0);
			if (!hasSignal) {
				lines.push(`| ${m.label} | — | — | — | — | — | — | — | not measured (all 0/null for this provider) |`);
				continue;
			}
			// Each metric is its own family of arm-pair tests, corrected independently.
			const metricDeltas = pairwiseMetricDeltas(results, m.of);
			const metricTested = metricDeltas.filter(d => d.pos + d.neg > 0);
			const metricAdj = holmBonferroni(metricTested.map(d => d.signTestP));
			const metricAdjByPair = new Map(metricTested.map((d, i) => [`${d.armA}→${d.armB}`, metricAdj[i] as number]));
			for (const d of metricDeltas) {
				const dv = (x: number) => (m.digits > 0 ? x.toFixed(m.digits) : String(Math.round(x)));
				const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + dv(d.meanDelta);
				const ci =
					d.ciLow === null || d.ciHigh === null
						? "—"
						: `[${(d.ciLow >= 0 ? "+" : "") + dv(d.ciLow)}, ${(d.ciHigh >= 0 ? "+" : "") + dv(d.ciHigh)}]`;
				const cheaperB = d.neg; // B < A on this cost metric
				const dearerB = d.pos;
				const adjP = metricAdjByPair.get(`${d.armA}→${d.armB}`);
				const sig = adjP !== undefined && adjP < 0.05;
				const cheaperSig = sig && d.meanDelta !== null && d.meanDelta < 0;
				// The guardrail: B is not worse on correctness — its pass-rate comparison is
				// not a significant loss for B, judged on the SAME Holm-adjusted standard as
				// the pass-rate table's own verdict (so the two sections cannot disagree).
				const passAdj = armAdjByPair.get(`${d.armA}→${d.armB}`);
				const passDelta = armDeltas.find(a => a.armA === d.armA && a.armB === d.armB)?.meanDelta ?? null;
				const binaryHeld = !(passAdj !== undefined && passAdj < 0.05 && passDelta !== null && passDelta < 0);
				// Reward held on the CONTINUOUS metric too: a partial-credit regression that
				// leaves the binary rate untouched must still veto a "cheaper" win, or the
				// "equal reward" half of argot's claim is not actually being checked.
				const rewardAdj = rewardAdjByPair.get(`${d.armA}→${d.armB}`);
				const rewardDelta = rewardDeltas.find(a => a.armA === d.armA && a.armB === d.armB)?.meanDelta ?? null;
				const rewardHeld = !(
					rewardAdj !== undefined &&
					rewardAdj < 0.05 &&
					rewardDelta !== null &&
					rewardDelta < 0
				);
				const passHeld = binaryHeld && rewardHeld;
				// Same honesty guard as the pass-rate table: a non-significant efficiency
				// delta is only a real null if a clean sweep at this decisive-task count could
				// have cleared the Holm bar for this metric's family. Otherwise flag it.
				const effUnderpowered = !sig && !sweepCanReachSignificance(d.pos + d.neg, metricTested.length);
				const verdict = cheaperSig
					? passHeld
						? `${d.armB} cheaper, reward held`
						: `${d.armB} cheaper BUT reward dropped`
					: sig && d.meanDelta !== null && d.meanDelta > 0
						? `${d.armB} dearer`
						: effUnderpowered
							? "not distinguishable (underpowered)"
							: "not distinguishable";
				lines.push(
					`| ${m.label} | ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} ${m.unit} | ${ci} | ${cheaperB}/${dearerB}/${d.ties} | ${d.signTestP.toFixed(3)} | ${adjP === undefined ? "—" : adjP.toFixed(3)} | ${verdict} |`,
				);
			}
		}
	}
	// Errors (per arm): a crashed or provider-refused sample is EXCLUDED from every
	// rate and mean above, so an arm that errors more is silently measured on fewer
	// (and possibly easier) samples. If a content-filter refusal or a crash hits one
	// arm more than another — most of all if it tracks the treatment, e.g. an
	// injected preamble — a token or pass-rate delta against that arm may be a
	// selection effect, not a real difference. This groups every excluded sample by
	// failure reason across ALL arms (including arms with zero errors, so the
	// asymmetry is visible), turning an anonymous "+N err" count into evidence.
	const errored = results.filter(r => r.error);
	if (errored.length > 0) {
		const reasons = [...new Set(errored.map(r => classifyError(r.error as string)))].sort();
		lines.push("");
		lines.push("## Errors (per arm)");
		lines.push("");
		lines.push(
			"Each sample counted here is EXCLUDED from every rate and mean above. Watch for an asymmetry: " +
				"an arm that refuses or crashes more is measured on fewer samples, so a delta against it can be a " +
				"selection effect rather than a real effect of the arm.",
		);
		lines.push("");
		lines.push(`| arm | total err | ${reasons.join(" | ")} |`);
		lines.push(`|---|---|${reasons.map(() => "---|").join("")}`);
		for (const arm of arms) {
			const armErrs = errored.filter(r => r.arm === arm);
			const cells = reasons.map(reason => armErrs.filter(r => classifyError(r.error as string) === reason).length);
			lines.push(`| ${arm} | ${armErrs.length} | ${cells.join(" | ")} |`);
		}
	}
	// Per-arm treatment-application probe: an argot encode arm is only measuring its
	// treatment if the model actually LOADED a dictionary and WROTE handles. A row of
	// zeros here means the encode never fired, so any token delta above is comparing
	// "encode on paper" against decode — the eval is inert, not a null result.
	const okByArm = (a: string) => results.filter(r => r.arm === a && !r.error);
	const argotArms = arms.filter(a =>
		okByArm(a).some(
			r =>
				r.argotLoadCalls !== null ||
				r.assistantMsgsWithSigil !== null ||
				r.argotPreamblePresent !== null ||
				r.argotHandlesLoaded !== null,
		),
	);
	if (argotArms.length > 0) {
		lines.push("");
		lines.push("## Argot treatment applied? (per arm)");
		lines.push("");
		lines.push(
			"`preamble taught` is the authoritative signal that the treatment REACHED the model: it reads the " +
				"actual system prompt, so it reflects the model AFTER catalog id resolution. An encode arm whose " +
				"`preamble taught` is `0/N` never fired the treatment (a silent degrade to decode-only). But teaching " +
				"is NOT sufficient — `vocab handles` is the launch dictionary's actual size, and encode is only " +
				"POSSIBLE when it is above zero. `0` handles means the corpus has no repeated-token mass, so a " +
				"`0 encoded` result there measures nothing about argot. `—` handles means the run predates the " +
				"telemetry, so its 0-encoded is uninterpretable. Read the per-arm interpretation below the table.",
		);
		lines.push("");
		lines.push(
			"| arm | OK runs | preamble taught | vocab handles | mean argot_load calls | mean msgs with § | runs that encoded (§>0) |",
		);
		lines.push("|---|---|---|---|---|---|---|");
		const interpretations: string[] = [];
		for (const a of argotArms) {
			const rows = okByArm(a);
			const encoded = rows.filter(r => (r.assistantMsgsWithSigil ?? 0) > 0).length;
			const taught = rows.filter(r => r.argotPreamblePresent === true).length;
			const known = rows.filter(r => r.argotPreamblePresent !== null).length;
			const taughtCell = known === 0 ? "unknown" : `${taught}/${known}`;
			// The loaded handle count is a per-repo property, so across a single task's
			// repeats it is constant; the max over OK rows recovers it even if a stray
			// row lacked the record (null), and stays null only when EVERY row lacked it.
			const handleVals = rows.map(r => r.argotHandlesLoaded).filter((h): h is number => h !== null);
			const handlesLoaded = handleVals.length === 0 ? null : Math.max(...handleVals);
			const handlesCell = handlesLoaded === null ? "—" : `${handlesLoaded}`;
			lines.push(
				`| ${a} | ${rows.length} | ${taughtCell} | ${handlesCell} | ${fmt(mean(rows.map(r => r.argotLoadCalls)), 2)} | ` +
					`${fmt(mean(rows.map(r => r.assistantMsgsWithSigil)), 2)} | ${encoded}/${rows.length} |`,
			);
			const note = interpretEncodeArm({ arm: a, okRuns: rows.length, taught, handlesLoaded, encoded });
			if (note !== null) interpretations.push(note);
		}
		if (interpretations.length > 0) {
			lines.push("");
			for (const note of interpretations) lines.push(`- ${note}`);
		}
	}
	// Effect-size ceiling. This section answers a question the significance tests
	// structurally cannot: not "did we see a difference" but "could a difference
	// large enough to see have existed at all on this workload". A run whose ceiling
	// sits under its own noise is unmeasurable no matter how many repeats it gets.
	const headroomArms = arms.filter(a => okByArm(a).some(r => r.encodeHeadroom !== null));
	if (headroomArms.length > 0) {
		lines.push("");
		lines.push("## Encode headroom — the maximum saving that was ever available");
		lines.push("");
		lines.push(
			"`max saving` is what shorthand would have saved if the model had encoded PERFECTLY: every " +
				"occurrence of every loaded handle's expansion, in text and in tool-call arguments, written as the " +
				"handle instead. It is an upper bound the feature cannot beat on this workload. `noise` is the " +
				"observed run-to-run spread of output tokens across repeated samples of the same arm and task, which " +
				"is the smallest difference this run could distinguish from chance. When the ceiling is below the " +
				"noise, the efficiency comparison above is measuring variance and NOTHING can be concluded about the " +
				"feature — more repeats cannot help, because the effect being sought is smaller than the effect that " +
				"exists. Fix the workload (tasks whose repos repeat long paths and commands the agent actually " +
				"retypes) or the vocabulary, not the sample count.",
		);
		lines.push("");
		lines.push(
			"| arm | emitted chars | handles | handles ever emitted | max saving | max saving % | noise % | verdict |",
		);
		lines.push("|---|---|---|---|---|---|---|---|");
		for (const a of headroomArms) {
			const rows = okByArm(a).filter(r => r.encodeHeadroom !== null);
			const emitted = rows.reduce((s, r) => s + (r.encodeHeadroom?.emittedChars ?? 0), 0);
			const saved = rows.reduce((s, r) => s + (r.encodeHeadroom?.maxSavedChars ?? 0), 0);
			const handles = Math.max(...rows.map(r => r.encodeHeadroom?.handles ?? 0));
			const usable = Math.max(...rows.map(r => r.encodeHeadroom?.usableHandles ?? 0));
			const pct = emitted === 0 ? 0 : (100 * saved) / emitted;
			// Noise is estimated WITHIN each task, then combined. Pooling an arm's
			// samples across tasks would measure task difficulty rather than chance,
			// and that inflated floor would declare a genuinely measurable run
			// unmeasurable. Only repeats of the same task differ by nothing else.
			const noise = withinTaskSpreadPct(okByArm(a));
			const verdict = ceilingBelowNoise(pct, noise)
				? "**CANNOT MEASURE** — ceiling below noise; any delta here is variance"
				: "measurable — the ceiling exceeds this run's noise";
			lines.push(
				`| ${a} | ${emitted} | ${handles} | ${usable} | ${saved} | ${pct.toFixed(2)}% | ` +
					`${noise === null ? "—" : `${noise.toFixed(2)}%`} | ${verdict} |`,
			);
		}
	}
	const probeArms = arms.filter(a => results.some(r => r.arm === a && (r.argotLoadCalls ?? 0) > 0));
	if (probeArms.length > 0) {
		lines.push("");
		lines.push("## Argot probes");
		lines.push("");
		lines.push("| arm | task | repeat | argot_load calls | assistant msgs containing § |");
		lines.push("|---|---|---|---|---|");
		for (const r of results.filter(x => probeArms.includes(x.arm))) {
			lines.push(
				`| ${r.arm} | ${r.task} | ${r.repeat} | ${fmt(r.argotLoadCalls)} | ${fmt(r.assistantMsgsWithSigil)} |`,
			);
		}
	}
	const allTools = [...new Set(results.flatMap(r => Object.keys(r.toolCalls ?? {})))].sort();
	if (allTools.length > 0) {
		lines.push("");
		// MEAN calls per completed run, not raw per-arm totals: arms rarely have the same
		// number of OK samples (one arm errors more), and a raw sum divided by nothing makes
		// the arm with fewer completed runs look like it "streamlined" its tool use when it
		// merely ran less. Dividing by each arm's completed-run count `n` (shown per row)
		// makes the columns comparable across arms, which is the whole point of the table.
		lines.push("## Tool call distribution (mean calls per completed run)");
		lines.push("");
		lines.push(`| arm | ${allTools.join(" | ")} |`);
		lines.push(`|---|${allTools.map(() => "---|").join("")}`);
		for (const arm of arms) {
			const rows = results.filter(r => r.arm === arm && !r.error);
			const n = rows.length;
			const cells = allTools.map(t =>
				n === 0 ? "—" : fmt(rows.reduce((acc, r) => acc + (r.toolCalls?.[t] ?? 0), 0) / n, 2),
			);
			lines.push(`| ${arm} (n=${n}) | ${cells.join(" | ")} |`);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
