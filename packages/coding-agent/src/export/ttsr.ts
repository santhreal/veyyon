import * as path from "node:path";
import { AstMatchStrictness, astMatch } from "@veyyon/natives";
import { errorMessage, logger, nearestNames } from "@veyyon/utils";
import type { Rule } from "../capability/rule";
import type { TtsrSettings } from "../config/settings";
import type { InjectionRecord, ToolScope, TtsrEntry, TtsrMatchContext, TtsrScope } from "./ttsr-helpers";
import { ABSOLUTE_PATH_IN_TEXT, DEFAULT_SCOPE, DEFAULT_SETTINGS, isInsideRoot } from "./ttsr-helpers";

export type { TtsrMatchSource } from "./ttsr-helpers";
export type { TtsrMatchContext };

export class TtsrManager {
	readonly #settings: Required<TtsrSettings>;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, string>();
	readonly #lastAstSnapshots = new Map<string, string>();
	#messageCount = 0;
	#transcriptResets = 0;
	#canMatchText = false;
	#canMatchThinking = false;

	readonly #getCwd?: () => string;
	readonly #lastMatchedPath = new Map<string, string>();
	readonly #warmupStreams = new Map<string, Set<string>>();
	readonly #warmupAtClaim = new Map<string, Set<string>>();

	constructor(settings?: TtsrSettings, options?: { getCwd?: () => string }) {
		this.#settings = { ...DEFAULT_SETTINGS, ...settings };
		this.#getCwd = options?.getCwd;
	}

	#canTrigger(ruleName: string): boolean {
		const record = this.#injectionRecords.get(ruleName);
		if (!record) {
			return true;
		}

		const rule = this.#rules.get(ruleName)?.rule;
		const repeatMode = rule?.repeatMode ?? this.#settings.repeatMode;
		if (repeatMode === "once" || repeatMode === "per-compact") {
			return false;
		}

		const gap = this.#messageCount - record.lastInjectedAt;
		return gap >= (rule?.repeatGap ?? this.#settings.repeatGap);
	}

	#compileConditions(rule: Rule): RegExp[] {
		const compiled: RegExp[] = [];
		for (const pattern of rule.condition ?? []) {
			if (pattern.trim().length === 0) {
				logger.warn("TTSR condition is blank, skipping condition", { ruleName: rule.name });
				continue;
			}
			try {
				compiled.push(new RegExp(pattern));
			} catch (error) {
				logger.warn("TTSR condition has invalid regex pattern, skipping condition", {
					ruleName: rule.name,
					pattern,
					error: errorMessage(error),
				});
			}
		}

		return compiled;
	}

	#compileGlobalPathGlobs(globs: Rule["globs"]): Bun.Glob[] | undefined {
		if (!globs || globs.length === 0) {
			return undefined;
		}

		const compiled = globs
			.map(glob => glob.trim())
			.filter(glob => glob.length > 0)
			.map(glob => new Bun.Glob(glob));
		return compiled.length > 0 ? compiled : undefined;
	}

	#parseToolScopeToken(token: string): ToolScope | undefined {
		const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
			token,
		);
		if (!match) {
			return undefined;
		}

		const groups = match.groups;
		const hasToolPrefix = groups?.prefix !== undefined;
		const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
		const pathPattern = groups?.path?.trim();

		if (!pathPattern) {
			return { toolName };
		}

		return {
			toolName,
			pathPattern,
			pathGlob: new Bun.Glob(pathPattern),
		};
	}

	#buildScope(rule: Rule): TtsrScope {
		if (!rule.scope || rule.scope.length === 0) {
			return {
				allowText: DEFAULT_SCOPE.allowText,
				allowThinking: DEFAULT_SCOPE.allowThinking,
				allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
				toolScopes: [...DEFAULT_SCOPE.toolScopes],
			};
		}

		const scope: TtsrScope = {
			allowText: false,
			allowThinking: false,
			allowAnyTool: false,
			toolScopes: [],
		};

		for (const rawToken of rule.scope) {
			const token = rawToken.trim();
			const normalizedToken = token.toLowerCase();
			if (token.length === 0) {
				continue;
			}

			if (normalizedToken === "text") {
				scope.allowText = true;
				continue;
			}

			if (normalizedToken === "thinking") {
				scope.allowThinking = true;
				continue;
			}

			if (normalizedToken === "tool" || normalizedToken === "toolcall") {
				scope.allowAnyTool = true;
				continue;
			}

			const toolScope = this.#parseToolScopeToken(token);
			if (!toolScope) {
				logger.warn("TTSR scope token is invalid, skipping token", {
					ruleName: rule.name,
					token: rawToken,
				});
				continue;
			}

			if (!toolScope.toolName && !toolScope.pathGlob) {
				scope.allowAnyTool = true;
				continue;
			}

			scope.toolScopes.push(toolScope);
		}

		return scope;
	}

	#hasReachableScope(scope: TtsrScope): boolean {
		return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
	}

	#bufferKey(context: TtsrMatchContext): string {
		if (context.streamKey && context.streamKey.trim().length > 0) {
			return context.streamKey;
		}
		if (context.source !== "tool") {
			return context.source;
		}
		const toolName = context.toolName?.trim().toLowerCase();
		return toolName ? `tool:${toolName}` : "tool";
	}

	#normalizePath(pathValue: string): string {
		return pathValue.replaceAll("\\", "/");
	}

	#matchesGlob(glob: Bun.Glob, filePaths: string[] | undefined): boolean {
		if (!filePaths || filePaths.length === 0) {
			return false;
		}
		for (const filePath of filePaths) {
			const normalized = this.#normalizePath(filePath);
			if (glob.match(normalized)) {
				return true;
			}
			const slashIndex = normalized.lastIndexOf("/");
			const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
			if (basename !== normalized && glob.match(basename)) {
				return true;
			}
		}

		return false;
	}

	#matchesGlobalPaths(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (!entry.globalPathGlobs || entry.globalPathGlobs.length === 0) {
			return true;
		}

		for (const glob of entry.globalPathGlobs) {
			if (this.#matchesGlob(glob, context.filePaths)) {
				return true;
			}
		}

		return false;
	}

	#matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (context.source === "text") {
			return entry.scope.allowText;
		}

		if (context.source === "thinking") {
			return entry.scope.allowThinking;
		}

		if (entry.scope.allowAnyTool) {
			return true;
		}

		const toolName = context.toolName?.trim().toLowerCase();
		for (const toolScope of entry.scope.toolScopes) {
			if (toolScope.toolName && toolScope.toolName !== toolName) {
				continue;
			}
			if (toolScope.pathGlob && !this.#matchesGlob(toolScope.pathGlob, context.filePaths)) {
				continue;
			}
			return true;
		}

		return false;
	}

	#matchedText(entry: TtsrEntry, streamBuffer: string): string | undefined {
		for (const condition of entry.conditions) {
			condition.lastIndex = 0;
			const match = condition.exec(streamBuffer);
			if (match) {
				return match[0];
			}
		}
		return undefined;
	}

	#satisfiesPathScope(entry: TtsrEntry, matched: string): boolean {
		const scope = entry.rule.pathScope;
		if (!scope) return true;
		const cwd = this.#getCwd?.();
		if (!cwd) {
			logger.debug("TTSR rule has a pathScope but no working directory to compare against", {
				ruleName: entry.rule.name,
				pathScope: scope,
			});
			return false;
		}
		const root = path.resolve(cwd);
		for (const candidate of matched.match(ABSOLUTE_PATH_IN_TEXT) ?? []) {
			const inside = isInsideRoot(root, candidate);
			if (scope === "inside-cwd" ? inside : !inside) {
				this.#lastMatchedPath.set(entry.rule.name, candidate);
				return true;
			}
		}
		return false;
	}

	lastMatchedPath(ruleName: string): string | undefined {
		return this.#lastMatchedPath.get(ruleName);
	}

	addRule(rule: Rule): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		if (this.#rules.has(rule.name)) {
			return false;
		}

		const conditions = this.#compileConditions(rule);
		const astConditions = (rule.astCondition ?? []).map(pattern => pattern.trim()).filter(p => p.length > 0);
		if (conditions.length === 0 && astConditions.length === 0) {
			logger.warn("TTSR rule has no condition or astCondition, never monitored", {
				ruleName: rule.name,
				path: rule.path,
			});
			return false;
		}

		const scope = this.#buildScope(rule);
		if (!this.#hasReachableScope(scope)) {
			logger.warn("TTSR scope excludes all streams, skipping rule", {
				ruleName: rule.name,
				scope: rule.scope,
			});
			return false;
		}
		const globalPathGlobs = this.#compileGlobalPathGlobs(rule.globs);
		this.#rules.set(rule.name, {
			rule,
			conditions,
			astConditions,
			scope,
			globalPathGlobs,
		});
		if (scope.allowText) this.#canMatchText = true;
		if (scope.allowThinking) this.#canMatchThinking = true;

		logger.debug("TTSR rule registered", {
			ruleName: rule.name,
			conditions: rule.condition,
			astConditions: rule.astCondition,
			scope: rule.scope,
			globs: rule.globs,
		});

		return true;
	}

	checkDelta(delta: string, context: TtsrMatchContext): Rule[] {
		if (context.source === "text" && !this.#canMatchText) {
			return [];
		}
		if (context.source === "thinking" && !this.#canMatchThinking) {
			return [];
		}
		const bufferKey = this.#bufferKey(context);
		const nextBuffer = `${this.#buffers.get(bufferKey) ?? ""}${delta}`;
		this.#buffers.set(bufferKey, nextBuffer);
		return this.#matchBuffer(nextBuffer, context);
	}

	checkSnapshot(snapshot: string, context: TtsrMatchContext): Rule[] {
		const bufferKey = this.#bufferKey(context);
		this.#buffers.set(bufferKey, snapshot);
		return this.#matchBuffer(snapshot, context);
	}

	#deriveLang(filePaths: string[] | undefined): string | undefined {
		for (const filePath of filePaths ?? []) {
			const ext = path.extname(this.#normalizePath(filePath));
			if (ext.length > 1) {
				return ext.slice(1).toLowerCase();
			}
		}
		return undefined;
	}

	async checkAstSnapshot(snapshot: string, context: TtsrMatchContext): Promise<Rule[]> {
		if (!this.#settings.enabled || context.source !== "tool") {
			return [];
		}

		const lang = this.#deriveLang(context.filePaths);
		if (!lang) {
			return [];
		}

		const candidates: TtsrEntry[] = [];
		for (const [name, entry] of this.#rules) {
			if (entry.astConditions.length === 0) {
				continue;
			}
			if (
				!this.#canTrigger(name) ||
				!this.#matchesScope(entry, context) ||
				!this.#matchesGlobalPaths(entry, context)
			) {
				continue;
			}
			candidates.push(entry);
		}
		if (candidates.length === 0) {
			return [];
		}

		const bufferKey = this.#bufferKey(context);
		if (this.#lastAstSnapshots.get(bufferKey) === snapshot) {
			return [];
		}
		this.#lastAstSnapshots.set(bufferKey, snapshot);

		const matches: Rule[] = [];
		for (const entry of candidates) {
			if (await this.#astConditionsMatch(entry.astConditions, snapshot, lang)) {
				if (!this.#clearedWarmup(entry.rule, bufferKey)) continue;
				matches.push(entry.rule);
				logger.debug("TTSR ast condition matched", {
					ruleName: entry.rule.name,
					astConditions: entry.rule.astCondition,
					toolName: context.toolName,
					filePaths: context.filePaths,
				});
			}
		}
		return matches;
	}

	async #astConditionsMatch(patterns: string[], source: string, lang: string): Promise<boolean> {
		try {
			const result = await astMatch({
				patterns,
				source,
				lang,
				strictness: AstMatchStrictness.Smart,
				limit: 1,
			});
			return result.totalMatches > 0;
		} catch (error) {
			logger.warn("TTSR ast match failed, treating as no match", {
				patterns,
				lang,
				error: errorMessage(error),
			});
			return false;
		}
	}

	hasAstRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		for (const entry of this.#rules.values()) {
			if (entry.astConditions.length > 0) {
				return true;
			}
		}
		return false;
	}

	#matchBuffer(buffer: string, context: TtsrMatchContext): Rule[] {
		if (!this.#settings.enabled) {
			return [];
		}
		const bufferKey = this.#bufferKey(context);
		const matches: Rule[] = [];
		for (const [name, entry] of this.#rules) {
			if (!this.#canTrigger(name)) {
				continue;
			}
			if (!this.#matchesScope(entry, context)) {
				continue;
			}
			if (!this.#matchesGlobalPaths(entry, context)) {
				continue;
			}
			const matched = this.#matchedText(entry, buffer);
			if (matched === undefined) {
				continue;
			}
			if (!this.#satisfiesPathScope(entry, matched)) {
				continue;
			}
			if (!this.#clearedWarmup(entry.rule, bufferKey)) {
				continue;
			}

			matches.push(entry.rule);
			logger.debug("TTSR condition matched", {
				ruleName: name,
				conditions: entry.rule.condition,
				source: context.source,
				toolName: context.toolName,
				filePaths: context.filePaths,
			});
		}

		return matches;
	}

	#clearedWarmup(rule: Rule, bufferKey: string): boolean {
		const required = rule.warmupMatches ?? 1;
		if (required <= 1) {
			return true;
		}
		let seen = this.#warmupStreams.get(rule.name);
		if (!seen) {
			seen = new Set();
			this.#warmupStreams.set(rule.name, seen);
		}
		if (seen.size >= required) {
			return true;
		}
		seen.add(bufferKey);
		if (seen.size < required) {
			logger.debug("TTSR rule matched but is still warming up", {
				ruleName: rule.name,
				seen: seen.size,
				required,
			});
			return false;
		}
		return true;
	}

	markInjected(rulesToMark: Rule[]): void {
		this.markInjectedByNames(rulesToMark.map(rule => rule.name));
	}

	markInjectedByNames(ruleNames: string[]): void {
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) {
				continue;
			}
			this.#injectionRecords.set(ruleName, {
				lastInjectedAt: this.#messageCount,
				resetAt: this.#transcriptResets,
			});
			const banked = this.#warmupStreams.get(ruleName);
			if (banked) {
				this.#warmupAtClaim.set(ruleName, banked);
				this.#warmupStreams.delete(ruleName);
			}
			logger.debug("TTSR rule marked as injected", {
				ruleName,
				messageCount: this.#messageCount,
				repeatMode: this.#rules.get(ruleName)?.rule.repeatMode ?? this.#settings.repeatMode,
			});
		}
	}

	releaseInjectedByNames(ruleNames: string[]): void {
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) continue;
			if (this.#injectionRecords.delete(ruleName)) {
				const banked = this.#warmupAtClaim.get(ruleName);
				if (banked) {
					this.#warmupStreams.set(ruleName, banked);
					this.#warmupAtClaim.delete(ruleName);
				}
				logger.debug("TTSR claim released without delivery", { ruleName });
			}
		}
	}

	reportUnknownToolScopes(knownToolNames: Iterable<string>): void {
		const known = new Set<string>();
		for (const name of knownToolNames) known.add(name.trim().toLowerCase());
		if (known.size === 0) return;

		for (const [ruleName, entry] of this.#rules) {
			for (const toolScope of entry.scope.toolScopes) {
				const toolName = toolScope.toolName;
				if (toolName === undefined || known.has(toolName)) continue;
				logger.warn("TTSR rule is scoped to a tool that does not exist, so it can never match", {
					ruleName,
					toolName,
					rulePath: entry.rule.path,
					closest: nearestNames(toolName, known, 1)[0],
				});
			}
		}
	}

	getInjectedRuleNames(): string[] {
		return Array.from(this.#injectionRecords.keys());
	}

	restoreInjected(ruleNames: string[]): void {
		for (const name of ruleNames) {
			this.#injectionRecords.set(name, { lastInjectedAt: 0, resetAt: this.#transcriptResets });
		}
		if (ruleNames.length > 0) {
			logger.debug("TTSR injected state restored", { ruleNames });
		}
	}

	clearRules(): void {
		this.#rules.clear();
		this.#buffers.clear();
		this.#lastAstSnapshots.clear();
		this.#lastMatchedPath.clear();
		this.#canMatchText = false;
		this.#canMatchThinking = false;
	}

	resetBuffer(): void {
		this.#buffers.clear();
		this.#lastAstSnapshots.clear();
	}

	resetForCompaction(): void {
		this.#transcriptResets++;
		for (const [ruleName, record] of this.#injectionRecords) {
			const rule = this.#rules.get(ruleName)?.rule;
			const repeatMode = rule?.repeatMode ?? this.#settings.repeatMode;
			if (repeatMode !== "per-compact") continue;
			const period = rule?.repeatCompactions ?? 1;
			if (this.#transcriptResets - record.resetAt >= period) {
				this.#injectionRecords.delete(ruleName);
			}
		}
	}

	hasRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		return this.#rules.size > 0;
	}

	getRules(): Rule[] {
		return Array.from(this.#rules.values(), entry => entry.rule);
	}

	incrementMessageCount(): void {
		this.#messageCount++;
	}

	getMessageCount(): number {
		return this.#messageCount;
	}

	getSettings(): Required<TtsrSettings> {
		return this.#settings;
	}
}
