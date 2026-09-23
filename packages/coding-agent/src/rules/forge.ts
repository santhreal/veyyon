/**
 * Forging a TTSR rule from a complaint, for whichever host asked.
 *
 * `/omfg` is one loop: ask the model for a rule, parse it, check it against
 * what the assistant actually said, and either return it or feed the failure
 * back and ask again. None of that reads a terminal, so it runs here and each
 * host supplies only the surface it reports progress on and the prompts it
 * answers with.
 *
 * The rule is saved into the active profile's rules directory, which is the
 * one location rule discovery reads. A project `.veyyon/rules/` target used to
 * sit beside it and nothing discovered it, so a rule saved there was live for
 * that session and gone at the next launch.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { prompt } from "@veyyon/utils";
import type { Rule } from "../discovery/capability/rule";
import { sideChannelPrompts } from "../prompts/side-channel/rows";
import type { AgentSession } from "../session/agent-session";
import {
	buildOmfgRuleForPath,
	extractGeneratedRuleJson,
	type OmfgRuleSourceLevel,
	type ParsedGeneratedRule,
	parseGeneratedRule,
	validateParsedRuleAgainstAssistantHistory,
} from "./omfg-rule";

/** How many times a rule that fails to parse or to match is asked for again. */
export const MAX_FORGE_ATTEMPTS = 3;

/** A forged rule, and whether it was confirmed against the conversation. */
export interface ForgeCandidate extends ParsedGeneratedRule {
	validated: boolean;
}

/** What the forge is doing, in the words a host states it in. */
export type ForgeStage = "generating" | "validating";

/**
 * Where a host hears about the attempt in progress.
 *
 * `draft` carries the model's text as it streams, and `rule` replaces it with
 * the rule once one parses, so a host that drew the draft shows the parsed
 * form rather than the JSON it arrived in.
 */
export interface ForgeProgress {
	stage?(stage: ForgeStage, attempt: number, detail: string): void;
	draft?(delta: string): void;
	rule?(fileContent: string): void;
}

export interface ForgeOptions {
	/** Feedback to open with, which is how an amendment re-enters the loop. */
	feedback?: string;
	/** The rule that feedback is about. */
	previousRule?: string;
	progress?: ForgeProgress;
	signal?: AbortSignal;
}

/**
 * Asks the model for a rule that stops what `complaint` describes.
 *
 * Returns the confirmed rule, the last unconfirmed one when no attempt
 * matched the conversation, or `undefined` when nothing parsed at all or the
 * signal was aborted.
 */
export async function forgeRule(
	session: AgentSession,
	complaint: string,
	options: ForgeOptions = {},
): Promise<ForgeCandidate | undefined> {
	const failures = options.feedback ? [options.feedback] : [];
	let previousRule = options.previousRule;
	let lastCandidate: ParsedGeneratedRule | undefined;
	const progress = options.progress;

	for (let attempt = 1; attempt <= MAX_FORGE_ATTEMPTS; attempt++) {
		if (options.signal?.aborted) return undefined;
		progress?.rule?.("");
		progress?.stage?.("generating", attempt, `Attempt ${attempt}/${MAX_FORGE_ATTEMPTS} · generating…`);
		const promptText = prompt.render(sideChannelPrompts["side-channel/omfg-user"].text, {
			complaint,
			feedback: failures.length > 0 ? failures.join("\n\n") : undefined,
			previousRule,
		});
		const { replyText } = await session.runEphemeralTurn({
			promptText,
			dedupeReply: false,
			onTextDelta: delta => progress?.draft?.(delta),
			signal: options.signal,
		});
		if (options.signal?.aborted) return undefined;

		const parsed = parseGeneratedRule(replyText);
		if ("error" in parsed) {
			const failed = extractGeneratedRuleJson(replyText) ?? replyText.trim();
			failures.push(`Attempt ${attempt} failed: invalid rule (${parsed.error}).\nFailed candidate:\n${failed}`);
			previousRule = failed;
			progress?.stage?.("validating", attempt, `Attempt ${attempt}/${MAX_FORGE_ATTEMPTS} · ${parsed.error}`);
			continue;
		}

		progress?.rule?.(parsed.fileContent);
		progress?.stage?.("validating", attempt, `Attempt ${attempt}/${MAX_FORGE_ATTEMPTS} · validating…`);
		const validated = await validateParsedRuleAgainstAssistantHistory(parsed, session.messages);
		if (validated.repairedCondition) progress?.rule?.(validated.candidate.fileContent);
		if (validated.validation.matched) return { ...validated.candidate, validated: true };

		lastCandidate = validated.candidate;
		const failure = validated.validation.feedback ?? "The rule condition did not match any earlier assistant output.";
		failures.push(
			`Attempt ${attempt} failed validation:\n${failure}\nFailed candidate:\n${validated.candidate.fileContent}`,
		);
		previousRule = validated.candidate.fileContent;
	}

	return lastCandidate ? { ...lastCandidate, validated: false } : undefined;
}

/** The file a rule of this name is written to, and the level it is read at. */
export function forgedRuleTarget(agentDir: string, ruleName: string): { filePath: string; level: OmfgRuleSourceLevel } {
	return { filePath: path.join(agentDir, "rules", `${ruleName}.md`), level: "user" };
}

/** Whether a rule of this name is already on disk at `target`. */
export async function forgedRuleExists(filePath: string): Promise<boolean> {
	return await fs
		.stat(filePath)
		.then(() => true)
		.catch(() => false);
}

/**
 * Writes the rule and makes it live for this session, so it interrupts from
 * the next turn rather than from the next launch.
 */
export async function saveForgedRule(
	session: AgentSession,
	agentDir: string,
	candidate: ForgeCandidate,
): Promise<string> {
	const target = forgedRuleTarget(agentDir, candidate.rule.name);
	await fs.mkdir(path.dirname(target.filePath), { recursive: true });
	await fs.writeFile(target.filePath, candidate.fileContent, "utf8");
	const saved: Rule = buildOmfgRuleForPath(candidate.rule.name, candidate.fileContent, target.filePath, target.level);
	session.ttsrManager?.addRule(saved);
	return target.filePath;
}
