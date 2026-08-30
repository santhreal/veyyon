import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { errorMessage, getNonBlankStringProperty } from "@veyyon/utils";
import { formatMore } from "@veyyon/utils/format";
import type { Rule } from "../../capability/rule";
import { buildRuleFromMarkdown, createSourceMeta } from "../../discovery/helpers";
import { TtsrManager, type TtsrMatchContext } from "../../export/ttsr";

export interface ParsedGeneratedRule {
	rule: Rule;
	fileContent: string;
}

export type GeneratedRuleParseResult = ParsedGeneratedRule | { error: string };

export interface RuleHistoryValidation {
	matched: boolean;
	feedback?: string;
}

export interface ParsedRuleHistoryValidation {
	candidate: ParsedGeneratedRule;
	validation: RuleHistoryValidation;
	repairedCondition: boolean;
}
export type OmfgRuleSourceLevel = "project" | "user";

const JSON_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

export function extractGeneratedRuleJson(text: string): string | null {
	const trimmed = text.trim();
	const fenced = JSON_FENCE_PATTERN.exec(trimmed);
	if (fenced?.[1]) {
		const fencedObject = extractBalancedJsonObject(fenced[1]);
		if (fencedObject) return fencedObject;
	}
	return extractBalancedJsonObject(trimmed);
}

export function sanitizeRuleName(rawName: string): string {
	return rawName
		.trim()
		.toLowerCase()
		.replace(/["'`]/g, "")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
}

export function buildOmfgRuleForPath(
	ruleName: string,
	fileContent: string,
	filePath: string,
	level: OmfgRuleSourceLevel,
): Rule {
	return buildRuleFromMarkdown(ruleName, fileContent, filePath, createSourceMeta("omfg", filePath, level), {
		ruleName,
	});
}

function normalizeConditionRegexes(conditions: readonly string[]): { condition: string[] } | { error: string } {
	const normalized: string[] = [];
	for (const condition of conditions) {
		const normalizedCondition = normalizeConditionRegex(condition);
		if ("error" in normalizedCondition) {
			return normalizedCondition;
		}
		if (!normalized.includes(normalizedCondition.condition)) {
			normalized.push(normalizedCondition.condition);
		}
	}
	return { condition: normalized };
}

function normalizeConditionRegex(condition: string): { condition: string } | { error: string } {
	try {
		new RegExp(condition);
		return { condition };
	} catch (originalError) {
		const repaired = unescapeRegexConditionOnce(condition);
		if (repaired !== condition) {
			try {
				new RegExp(repaired);
				return { condition: repaired };
			} catch {
				// The repair did not help; the original error is what gets reported
				// to the operator below, which is the more useful message.
			}
		}
		const message = errorMessage(originalError);
		return { error: `Invalid condition regex ${JSON.stringify(condition)}: ${message}` };
	}
}

function unescapeRegexConditionOnce(condition: string): string {
	return condition.replace(/\\\\/g, "\\");
}

export function parseGeneratedRule(text: string): GeneratedRuleParseResult {
	const jsonText = extractGeneratedRuleJson(text);
	if (!jsonText) {
		return { error: "Missing generated rule JSON object" };
	}

	const payloadResult = parseGeneratedRulePayload(jsonText);
	if ("error" in payloadResult) {
		return payloadResult;
	}

	const ruleName = sanitizeRuleName(payloadResult.name);
	if (ruleName.length === 0) {
		return { error: "Rule name must contain at least one letter or digit" };
	}

	const conditionResult = payloadResult.condition
		? normalizeConditionRegexes(payloadResult.condition)
		: { condition: [] as string[] };
	if ("error" in conditionResult) {
		return conditionResult;
	}

	const fileContent = assembleRuleMarkdown({
		name: ruleName,
		description: payloadResult.description,
		condition: conditionResult.condition,
		astCondition: payloadResult.astCondition,
		scope: payloadResult.scope,
		interruptMode: payloadResult.interruptMode,
		pathScope: payloadResult.pathScope,
		repeatMode: payloadResult.repeatMode,
		repeatGap: payloadResult.repeatGap,
		repeatCompactions: payloadResult.repeatCompactions,
		warmupMatches: payloadResult.warmupMatches,
		body: payloadResult.body,
	});

	const virtualPath = path.join(process.cwd(), `${ruleName}.md`);
	let rule: Rule;
	try {
		rule = buildOmfgRuleForPath(ruleName, fileContent, virtualPath, "project");
	} catch (error) {
		return { error: errorMessage(error) };
	}

	if ((rule.condition?.length ?? 0) === 0 && (rule.astCondition?.length ?? 0) === 0) {
		return { error: "Generated rule JSON must include at least one condition or astCondition" };
	}

	for (const condition of rule.condition ?? []) {
		if (isValidRegexCondition(condition) || isRepairableEscapedRegexCondition(condition)) {
			continue;
		}
		try {
			new RegExp(condition);
		} catch (error) {
			const message = errorMessage(error);
			return { error: `Invalid condition regex ${JSON.stringify(condition)}: ${message}` };
		}
	}

	const manager = new TtsrManager();
	if (!manager.addRule(rule)) {
		return { error: "Rule has no valid condition or reachable scope" };
	}

	return { rule, fileContent };
}

interface GeneratedRulePayload {
	name: string;
	description: string;
	condition: string[];
	astCondition?: string[];
	scope: string[];
	interruptMode?: Rule["interruptMode"];
	pathScope?: Rule["pathScope"];
	repeatMode?: Rule["repeatMode"];
	repeatGap?: number;
	repeatCompactions?: number;
	warmupMatches?: number;
	body: string;
}

function extractBalancedJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth++;
			continue;
		}
		if (char === "}") {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}

	return null;
}

const INTERRUPT_MODES = ["never", "prose-only", "tool-only", "always"] as const;
const PATH_SCOPES = ["outside-cwd", "inside-cwd"] as const;
const REPEAT_MODES = ["once", "after-gap", "per-compact"] as const;

function enumField<T extends string>(
	object: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
): T | undefined | { error: string } {
	const raw = object[key];
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
		return {
			error: `Generated rule JSON field "${key}" must be one of ${allowed.map(value => JSON.stringify(value)).join(", ")}`,
		};
	}
	return raw as T;
}

function boundedIntField(
	object: Record<string, unknown>,
	key: string,
	min: number,
): number | undefined | { error: string } {
	const raw = object[key];
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min) {
		return { error: `Generated rule JSON field "${key}" must be an integer >= ${min}` };
	}
	return raw;
}

function parseGeneratedRulePayload(jsonText: string): GeneratedRulePayload | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		const message = errorMessage(error);
		return { error: `Generated rule JSON is invalid: ${message}` };
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: "Generated rule JSON must be an object" };
	}

	const object = parsed as Record<string, unknown>;
	const rawName = stringField(object, "name");
	if (!rawName) {
		return { error: "Generated rule JSON must include a non-empty name" };
	}
	const description = stringField(object, "description") ?? stringField(object, "desc");
	if (!description) {
		return { error: "Generated rule JSON must include a non-empty description" };
	}

	const condition = stringArrayField(object, "condition") ?? stringArrayField(object, "cond");
	const astCondition = stringArrayField(object, "astCondition");
	if ((!condition || condition.length === 0) && (!astCondition || astCondition.length === 0)) {
		return { error: "Generated rule JSON must include at least one condition or astCondition" };
	}

	const scope = stringArrayField(object, "scope");
	if (!scope || scope.length === 0) {
		return { error: "Generated rule JSON must include at least one scope" };
	}

	const interruptMode = enumField(object, "interruptMode", INTERRUPT_MODES);
	if (typeof interruptMode === "object") return interruptMode;
	const pathScope = enumField(object, "pathScope", PATH_SCOPES);
	if (typeof pathScope === "object") return pathScope;
	const repeatMode = enumField(object, "repeatMode", REPEAT_MODES);
	if (typeof repeatMode === "object") return repeatMode;
	const repeatGap = boundedIntField(object, "repeatGap", 0);
	if (typeof repeatGap === "object") return repeatGap;
	const repeatCompactions = boundedIntField(object, "repeatCompactions", 1);
	if (typeof repeatCompactions === "object") return repeatCompactions;
	const warmupMatches = boundedIntField(object, "warmupMatches", 1);
	if (typeof warmupMatches === "object") return warmupMatches;

	const body = stringField(object, "body");
	if (!body) {
		return { error: "Generated rule JSON must include a non-empty body" };
	}

	return {
		name: rawName,
		description,
		condition: condition ?? [],
		astCondition,
		scope,
		interruptMode,
		pathScope,
		repeatMode,
		repeatGap,
		repeatCompactions,
		warmupMatches,
		body,
	};
}

function stringField(object: Record<string, unknown>, key: string): string | undefined {
	return getNonBlankStringProperty(object, key)?.trim();
}

function stringArrayField(object: Record<string, unknown>, key: string): string[] | undefined {
	const value = object[key];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : undefined;
	}
	if (!Array.isArray(value)) return undefined;

	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed.length > 0 && !items.includes(trimmed)) {
			items.push(trimmed);
		}
	}
	return items.length > 0 ? items : undefined;
}

function assembleRuleMarkdown(payload: GeneratedRulePayload): string {
	const lines = [
		"---",
		`name: ${payload.name}`,
		`description: ${JSON.stringify(payload.description)}`,
		`condition: ${formatFrontmatterStringArray(payload.condition)}`,
	];
	if (payload.astCondition && payload.astCondition.length > 0) {
		lines.push(`astCondition: ${formatFrontmatterStringArray(payload.astCondition)}`);
	}
	lines.push(`scope: ${formatFrontmatterStringArray(payload.scope)}`);
	if (payload.interruptMode !== undefined) lines.push(`interruptMode: ${payload.interruptMode}`);
	if (payload.pathScope !== undefined) lines.push(`pathScope: ${payload.pathScope}`);
	if (payload.repeatMode !== undefined) lines.push(`repeatMode: ${payload.repeatMode}`);
	if (payload.repeatGap !== undefined) lines.push(`repeatGap: ${payload.repeatGap}`);
	if (payload.repeatCompactions !== undefined) lines.push(`repeatCompactions: ${payload.repeatCompactions}`);
	if (payload.warmupMatches !== undefined) lines.push(`warmupMatches: ${payload.warmupMatches}`);
	lines.push("---", "", payload.body.trim().replace(/\r\n?/g, "\n"));
	return lines.join("\n");
}

function formatFrontmatterStringArray(values: readonly string[]): string {
	if (values.length === 1) {
		return JSON.stringify(values[0]);
	}
	return `[${values.map(value => JSON.stringify(value)).join(", ")}]`;
}

interface HistorySurface {
	text: string;
	label: string;
	context: TtsrMatchContext;
	/** Raw arguments of the tool call this surface came from; absent on prose and thinking. */
	args?: unknown;
}

function collectAssistantSurfaces(messages: readonly AgentMessage[]): HistorySurface[] {
	const surfaces: HistorySurface[] = [];
	for (const message of messages) {
		if (!isAssistantMessageWithBlocks(message)) continue;
		for (let index = 0; index < message.content.length; index++) {
			const block = message.content[index];
			if (block.type === "text") {
				surfaces.push({
					text: block.text,
					label: "assistant text",
					context: { source: "text" },
				});
				continue;
			}
			if (block.type === "thinking") {
				surfaces.push({
					text: block.thinking,
					label: "assistant thinking",
					context: { source: "thinking" },
				});
				continue;
			}
			if (block.type === "toolCall") {
				const filePaths = extractArgPaths(block.arguments);
				surfaces.push({
					text: stringifyToolArguments(block.arguments),
					args: block.arguments,
					label: formatToolSurfaceLabel(block.name, filePaths),
					context: {
						source: "tool",
						toolName: block.name,
						filePaths,
						streamKey: block.id ? `toolcall:${block.id}` : `tool:${block.name}:${index}`,
					},
				});
			}
		}
	}
	return surfaces;
}

/** Derive an ast-grep language alias from candidate paths (bare extension), the same inference the live `checkAstSnapshot` path applies. */
function deriveHistoryLang(filePaths: readonly string[] | undefined): string | undefined {
	for (const filePath of filePaths ?? []) {
		const ext = path.extname(filePath.replaceAll("\\", "/"));
		if (ext.length > 1) {
			return ext.slice(1).toLowerCase();
		}
	}
	return undefined;
}

/** Every string value inside tool arguments, depth-first: the code an edit or write call introduces. */
function collectArgStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") {
		if (value.length > 0 && !out.includes(value)) out.push(value);
		return out;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectArgStrings(item, out);
		return out;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectArgStrings(item, out);
	}
	return out;
}

export async function validateRuleAgainstAssistantHistory(
	rule: Rule,
	messages: readonly AgentMessage[],
): Promise<RuleHistoryValidation> {
	const manager = new TtsrManager();
	// Warm-up is noise policy, not match policy: whether the condition is right must not depend on
	// how many streams history happens to hold, so the probe registers without it.
	const probe = rule.warmupMatches === undefined ? rule : { ...rule, warmupMatches: undefined };
	if (!manager.addRule(probe)) {
		return {
			matched: false,
			feedback: "TTSR rejected the rule: it has no valid condition or its scope cannot reach any stream.",
		};
	}

	const surfaces = collectAssistantSurfaces(messages);
	const matches: HistorySurface[] = [];
	for (const surface of surfaces) {
		manager.resetBuffer();
		if (surface.text.length > 0 && manager.checkDelta(surface.text, surface.context).length > 0) {
			matches.push(surface);
			continue;
		}
		// AST conditions go through the same `checkAstSnapshot` gate chain as a live stream —
		// scope, path globs, language inference — so a rule that validates here fires there.
		if ((rule.astCondition?.length ?? 0) === 0 || surface.context.source !== "tool") continue;
		const lang = deriveHistoryLang(surface.context.filePaths);
		if (!lang) continue;
		for (const snippet of collectArgStrings(surface.args)) {
			manager.resetBuffer();
			if ((await manager.checkAstSnapshot(snippet, surface.context)).length > 0) {
				matches.push(surface);
				break;
			}
		}
	}

	if (matches.length === 0) {
		return { matched: false, feedback: buildNoMatchFeedback(rule, surfaces) };
	}

	const scopeFeedback = buildScopeFeedback(rule, matches);
	if (scopeFeedback) {
		return { matched: false, feedback: scopeFeedback };
	}

	return { matched: true };
}

export async function validateParsedRuleAgainstAssistantHistory(
	candidate: ParsedGeneratedRule,
	messages: readonly AgentMessage[],
): Promise<ParsedRuleHistoryValidation> {
	const validation = await validateRuleAgainstAssistantHistory(candidate.rule, messages);
	if (validation.matched) {
		return { candidate, validation, repairedCondition: false };
	}

	const repaired = repairEscapedConditions(candidate);
	if (!repaired) {
		return { candidate, validation, repairedCondition: false };
	}

	const repairedValidation = await validateRuleAgainstAssistantHistory(repaired.rule, messages);
	if (repairedValidation.matched) {
		return { candidate: repaired, validation: repairedValidation, repairedCondition: true };
	}

	return { candidate, validation, repairedCondition: false };
}

export async function ruleMatchesAssistantHistory(rule: Rule, messages: readonly AgentMessage[]): Promise<boolean> {
	const validation = await validateRuleAgainstAssistantHistory(rule, messages);
	return validation.matched;
}

function isValidRegexCondition(condition: string): boolean {
	try {
		new RegExp(condition);
		return true;
	} catch {
		// This asks whether the condition IS a valid regex, so a throw is the answer rather than an error:
		// invalid means the rule is reported as invalid by the validator that called this.
		return false;
	}
}

function isRepairableEscapedRegexCondition(condition: string): boolean {
	const repaired = condition.replace(/\\\\/g, "\\");
	return repaired !== condition && isValidRegexCondition(repaired);
}

function repairEscapedConditions(candidate: ParsedGeneratedRule): ParsedGeneratedRule | undefined {
	const currentConditions = candidate.rule.condition;
	if (!currentConditions || currentConditions.length === 0) return undefined;

	const repairedConditions: string[] = [];
	let changed = false;
	for (const condition of currentConditions) {
		const repaired = condition.replace(/\\\\/g, "\\");
		repairedConditions.push(repaired);
		if (repaired !== condition) {
			changed = true;
		}
	}
	if (!changed) return undefined;

	const scope = candidate.rule.scope;
	if (!scope || scope.length === 0) return undefined;

	const fileContent = assembleRuleMarkdown({
		name: candidate.rule.name,
		description: candidate.rule.description ?? candidate.rule.name,
		condition: repairedConditions,
		astCondition: candidate.rule.astCondition,
		scope,
		interruptMode: candidate.rule.interruptMode,
		pathScope: candidate.rule.pathScope,
		repeatMode: candidate.rule.repeatMode,
		repeatGap: candidate.rule.repeatGap,
		repeatCompactions: candidate.rule.repeatCompactions,
		warmupMatches: candidate.rule.warmupMatches,
		body: candidate.rule.content,
	});
	const level = candidate.rule._source.level === "user" ? "user" : "project";
	return {
		rule: buildOmfgRuleForPath(candidate.rule.name, fileContent, candidate.rule.path, level),
		fileContent,
	};
}

function buildNoMatchFeedback(rule: Rule, surfaces: readonly HistorySurface[]): string {
	const conditionSummary = [
		...(rule.condition?.length ? [`regex ${formatRuleList(rule.condition)}`] : []),
		...(rule.astCondition?.length ? [`ast-grep ${formatRuleList(rule.astCondition)}`] : []),
	].join(" or ");
	const hints = extractConditionHints([...(rule.condition ?? []), ...(rule.astCondition ?? [])]);
	const lines = [
		`No assistant history surface matched condition ${conditionSummary} within scope ${formatRuleList(rule.scope)}.`,
	];
	if (surfaces.length === 0) {
		lines.push("No assistant text, thinking, or tool-call argument surfaces were available to check.");
		return lines.join("\n");
	}

	lines.push("Checked surfaces:");
	const max = Math.min(surfaces.length, 5);
	for (let i = 0; i < max; i++) {
		const surface = surfaces[i];
		lines.push(`- ${surface.label}: ${JSON.stringify(excerptForSurface(surface.text, hints))}`);
	}
	if (surfaces.length > max) {
		lines.push(`- ... ${formatMore("surface", surfaces.length - max)}`);
	}
	lines.push(
		'If the visible bad code contains quotes, remember tool arguments are checked as serialized JSON, so quotes may appear as escaped sequences such as \\".',
	);
	lines.push("If the condition looks right, fix the scope so it reaches the offending tool and file glob.");
	return lines.join("\n");
}

function buildScopeFeedback(rule: Rule, matches: readonly HistorySurface[]): string | undefined {
	const toolMatch = findFileToolMatch(matches);
	if (!toolMatch) return undefined;

	const recommendedScope = recommendedToolScope(toolMatch);
	if (!recommendedScope) return undefined;

	const scope = rule.scope ?? [];
	let hasBroadToolScope = scope.length === 0;
	let hasTextScope = false;
	for (const rawToken of scope) {
		const token = rawToken.trim().toLowerCase();
		if (token === "tool" || token === "toolcall") {
			hasBroadToolScope = true;
			continue;
		}
		if (token === "text") {
			hasTextScope = true;
		}
	}

	if (!hasBroadToolScope && !hasTextScope) {
		return undefined;
	}

	const problems: string[] = [];
	if (hasBroadToolScope) {
		problems.push(`scope ${formatRuleList(rule.scope)} is broader than the matching file-specific tool call`);
	}
	if (hasTextScope) {
		problems.push("scope includes `text`, but the offending content was confirmed in tool arguments");
	}

	return `The condition matched ${toolMatch.label}, but ${problems.join("; ")}. Use a narrow scope such as ${JSON.stringify(
		recommendedScope,
	)} and do not repeat the failed scope ${formatRuleList(rule.scope)}.`;
}

function findFileToolMatch(matches: readonly HistorySurface[]): HistorySurface | undefined {
	for (const match of matches) {
		if (match.context.source !== "tool") continue;
		if (!match.context.toolName) continue;
		if (!extensionGlob(match.context.filePaths)) continue;
		return match;
	}
	return undefined;
}

function recommendedToolScope(surface: HistorySurface): string | undefined {
	const toolName = surface.context.toolName;
	const glob = extensionGlob(surface.context.filePaths);
	if (!toolName || !glob) return undefined;
	return `tool:${toolName}(${glob})`;
}

function extensionGlob(filePaths: readonly string[] | undefined): string | undefined {
	for (const filePath of filePaths ?? []) {
		const extension = path.extname(filePath.replaceAll("\\", "/")).toLowerCase();
		if (extension.length > 1) {
			return `*${extension}`;
		}
	}
	return undefined;
}

function formatToolSurfaceLabel(toolName: string, filePaths: readonly string[] | undefined): string {
	if (!filePaths || filePaths.length === 0) {
		return `tool:${toolName} serialized arguments`;
	}
	return `tool:${toolName}(${filePaths.join(", ")}) serialized arguments`;
}

function formatRuleList(values: readonly string[] | undefined): string {
	if (!values || values.length === 0) {
		return "<default>";
	}
	return values.map(value => JSON.stringify(value)).join(", ");
}

function extractConditionHints(conditions: readonly string[] | undefined): string[] {
	const hints: string[] = [];
	for (const condition of conditions ?? []) {
		const matches = condition.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
		for (const match of matches) {
			const normalized = match.toLowerCase();
			if (
				normalized === "tool" ||
				normalized === "text" ||
				normalized === "any" ||
				normalized === "true" ||
				normalized === "false"
			) {
				continue;
			}
			if (!hints.includes(normalized)) {
				hints.push(normalized);
			}
		}
	}
	return hints;
}

function excerptForSurface(text: string, hints: readonly string[]): string {
	const normalized = text.replace(/\s+/g, " ");
	if (normalized.length <= 260) {
		return normalized;
	}

	const lower = normalized.toLowerCase();
	let bestIndex = -1;
	for (const hint of hints) {
		const index = lower.indexOf(hint);
		if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
			bestIndex = index;
		}
	}
	if (bestIndex === -1) {
		return `${normalized.slice(0, 260)}…`;
	}

	const start = Math.max(0, bestIndex - 120);
	const end = Math.min(normalized.length, bestIndex + 140);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < normalized.length ? "…" : "";
	return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

/**
 * Whether an `AgentMessage` is an assistant message whose content is a block list.
 *
 * The block list is the point: the caller walks `content` looking for tool calls, so a
 * message with the right role and a non-array body is not usable here. Named for that
 * requirement rather than `isAssistantMessage`, which three other modules also used for
 * three other questions.
 */
function isAssistantMessageWithBlocks(message: AgentMessage): message is AssistantMessage {
	const candidate = message as { role?: unknown; content?: unknown };
	return candidate.role === "assistant" && Array.isArray(candidate.content);
}

function stringifyToolArguments(args: unknown): string {
	try {
		const text = JSON.stringify(args);
		return typeof text === "string" ? text : "";
	} catch {
		// Arguments with a cycle have no text form to match a rule against, and an empty string matches no
		// rule condition. Failing closed on purpose: a rule must not fire on arguments it could not read.
		return "";
	}
}

function extractArgPaths(args: unknown): string[] | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) {
		return undefined;
	}

	const paths: string[] = [];
	for (const key in args as Record<string, unknown>) {
		const value = (args as Record<string, unknown>)[key];
		const normalizedKey = key.toLowerCase();
		if (typeof value === "string" && (normalizedKey === "path" || normalizedKey.endsWith("path"))) {
			paths.push(value);
			continue;
		}
		if (Array.isArray(value) && (normalizedKey === "paths" || normalizedKey.endsWith("paths"))) {
			for (const candidate of value) {
				if (typeof candidate === "string") {
					paths.push(candidate);
				}
			}
		}
	}

	const uniquePaths: string[] = [];
	for (const candidate of paths) {
		if (!uniquePaths.includes(candidate)) {
			uniquePaths.push(candidate);
		}
	}
	return uniquePaths.length > 0 ? uniquePaths : undefined;
}
