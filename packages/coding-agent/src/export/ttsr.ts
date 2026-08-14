/**
 * Time Traveling Stream Rules (TTSR) Manager
 *
 * Manages rules that get injected mid-stream when their condition pattern matches
 * the agent's output. When a match occurs, the stream is aborted, the rule is
 * injected as a system reminder, and the request is retried.
 */
import * as path from "node:path";
import { AstMatchStrictness, astMatch } from "@veyyon/natives";
import { errorMessage, logger, nearestNames } from "@veyyon/utils";
import type { Rule } from "../capability/rule";
import type { TtsrSettings } from "../config/settings";

export type TtsrMatchSource = "text" | "thinking" | "tool";

/** Context about the stream content currently being checked against TTSR rules. */
export interface TtsrMatchContext {
	source: TtsrMatchSource;
	/** Tool name for tool argument deltas, e.g. "edit" or "write". */
	toolName?: string;
	/** Candidate file paths associated with the current stream chunk. */
	filePaths?: string[];
	/** Stable key to isolate buffering (for example a tool call ID). */
	streamKey?: string;
}

interface ToolScope {
	toolName?: string;
	pathGlob?: Bun.Glob;
	pathPattern?: string;
}

interface TtsrScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

interface TtsrEntry {
	rule: Rule;
	conditions: RegExp[];
	/** ast-grep pattern strings; matched only against edit/write tool snapshots. */
	astConditions: string[];
	scope: TtsrScope;
	globalPathGlobs?: Bun.Glob[];
}

/** Tracks when a rule was last injected (for repeat gating). */
interface InjectionRecord {
	/** Message count (turn index) when the rule was last injected. */
	lastInjectedAt: number;
	/**
	 * Transcript-reset count when the rule was last injected, so a `per-compact`
	 * rule can require several of them before it says the same thing again.
	 */
	resetAt: number;
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
	enabled: true,
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
	builtinRules: true,
	disabledRules: [],
	// Empty by default: an experimental rule ships off until named here.
	experimentalRules: [],
};

/**
 * Absolute paths inside a matched fragment.
 *
 * Deliberately loose about what a path segment may contain and strict about the leading slash, so
 * a URL (`https://host/a/b`) is not read as a filesystem path. Used only to decide which side of
 * the working directory a match fell on.
 */
const ABSOLUTE_PATH_IN_TEXT = /\/(?:[\w.@+-]+\/)*[\w.@+-]+/g;

/** True when `candidate` resolves inside `root`, compared on paths rather than string prefixes. */
function isInsideRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, path.resolve(candidate));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const DEFAULT_SCOPE: TtsrScope = {
	allowText: true,
	allowThinking: false,
	allowAnyTool: true,
	toolScopes: [],
};

export class TtsrManager {
	readonly #settings: Required<TtsrSettings>;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, string>();
	/** Last snapshot evaluated for AST conditions, keyed by stream key, to dedupe matcher runs. */
	readonly #lastAstSnapshots = new Map<string, string>();
	#messageCount = 0;
	/**
	 * How many times the transcript has been replaced under this session:
	 * compaction, a history rewrite, a rewind, a shake. Every one of them takes
	 * an injected reminder out of the model's view, which is why they share a
	 * counter — from a rule's side they are the same event.
	 */
	#transcriptResets = 0;
	#canMatchText = false;
	#canMatchThinking = false;

	/**
	 * Reads the session's CURRENT working directory, for rules that carry a `pathScope`.
	 *
	 * A getter rather than a value: `set_cwd` moves the working directory mid-session, and the
	 * rule most likely to carry a `pathScope` is the one telling the model to call it. A snapshot
	 * taken at construction would go stale exactly when the advice was followed.
	 */
	readonly #getCwd?: () => string;
	/**
	 * The path a `pathScope` rule last matched, keyed by rule name.
	 *
	 * Recorded here rather than returned, so the `check*` methods keep handing back `Rule[]` and
	 * every existing caller is unaffected. The injected body reads it to name the directory it is
	 * talking about: advice to re-root that does not say WHERE is advice the model has to guess at,
	 * and it guesses the file's own directory rather than the project root.
	 */
	readonly #lastMatchedPath = new Map<string, string>();
	/**
	 * Distinct streams a warm-up rule has matched in since it was last injected,
	 * keyed by rule name.
	 *
	 * A claim is taken the moment a rule is bucketed and delivered later, so this is
	 * set aside at the claim rather than deleted, and put back if the claim is
	 * released undelivered. An aborted turn otherwise costs the reminder AND the
	 * evidence for it, which is the "it just does not fire" failure wearing a
	 * warm-up.
	 */
	readonly #warmupStreams = new Map<string, Set<string>>();
	/**
	 * The warm-up each rule had banked when its claim was taken.
	 *
	 * At most one set per rule that has ever been claimed, and each holds at most
	 * the rule's own `warmupMatches` keys, so it is bounded by the rule set rather
	 * than by the length of the session.
	 */
	readonly #warmupAtClaim = new Map<string, Set<string>>();

	constructor(settings?: TtsrSettings, options?: { getCwd?: () => string }) {
		this.#settings = { ...DEFAULT_SETTINGS, ...settings };
		this.#getCwd = options?.getCwd;
	}

	/**
	 * Check if a rule can be triggered, honouring its own repeat policy before the global one.
	 *
	 * The global default is `once`: a rule fires at most once per session, and the record survives a
	 * resume. That is right for a rule stating a coding convention — saying it twice adds nothing —
	 * and wrong for a NAVIGATIONAL rule, where the same advice applies again to a different
	 * directory. `cwd-reroot` is the second kind, and under the global default it fired for the first
	 * foreign project a session touched and then stayed silent for every later one, which reads as
	 * the rule simply not working.
	 *
	 * So a rule may carry its own `repeatMode` / `repeatGap`. Per-rule wins, because the rule author
	 * knows whether the advice is repeatable and the global setting is a preference about noise.
	 */
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
				// `new RegExp("")` matches EVERY stream, so a blank condition compiled into a catch-all:
				// a rule whose frontmatter said `condition: ""` fired on every delta rather than never,
				// which is the loudest possible reading of the quietest possible mistake. `astCondition`
				// has always filtered blanks; this is the same rule for the same reason, in one place.
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

	/**
	 * The text a condition matched, or undefined when none did.
	 *
	 * The matched text rather than a boolean, because {@link Rule.pathScope} needs to ask where
	 * the match actually pointed. Matching the buffer and then testing the WHOLE buffer for a
	 * path outside the working directory would fire on any absolute path anywhere in the stream,
	 * which is the imprecision this exists to remove.
	 */
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

	/**
	 * Whether the matched text satisfies the rule's `pathScope`.
	 *
	 * Absent scope means every match counts, which is every rule that does not opt in. With a
	 * scope, at least one absolute path in the matched text has to be on the right side of the
	 * working directory. Fails CLOSED when the working directory is unknown (no `getCwd` was
	 * supplied): a rule that asked to be filtered must not fire unfiltered, because firing
	 * unfiltered is the behaviour it was written to stop.
	 */
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

	/** The path this rule last matched, for a body that names the directory it is advising about. */
	lastMatchedPath(ruleName: string): string | undefined {
		return this.#lastMatchedPath.get(ruleName);
	}

	/** Add a TTSR rule to be monitored. */
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
			// LOUD, because it is indistinguishable from a rule that simply never matches: a rule with
			// no trigger is registered by the provider, listed by `/rules`, and silently never monitored.
			// `argot-load-nudge` shipped in that state, and this is the check that would have said so.
			// A rule that declares no condition and no astCondition is a mistake in the rule file, not a
			// rule that opted out of TTSR: an always-apply rule reaches the model through the system
			// prompt and is never handed to `addRule`.
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

	/**
	 * Add a stream chunk to its scoped buffer and return matching rules.
	 *
	 * Buffers are isolated by source/tool key so matches don't bleed across
	 * assistant prose, thinking text, and unrelated tool argument streams.
	 */
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

	/**
	 * Replace the scoped buffer with a tool-provided normalized snapshot and
	 * return matching rules.
	 *
	 * Used for tools exposing `matcherDigest`: the digest is recomputed from the
	 * full (partial) arguments on every delta, so it replaces the buffer instead
	 * of being appended to it.
	 */
	checkSnapshot(snapshot: string, context: TtsrMatchContext): Rule[] {
		const bufferKey = this.#bufferKey(context);
		this.#buffers.set(bufferKey, snapshot);
		return this.#matchBuffer(snapshot, context);
	}

	/** Derive an ast-grep language alias from candidate paths (bare extension, e.g. "ts"), if any. */
	#deriveLang(filePaths: string[] | undefined): string | undefined {
		for (const filePath of filePaths ?? []) {
			const ext = path.extname(this.#normalizePath(filePath));
			if (ext.length > 1) {
				return ext.slice(1).toLowerCase();
			}
		}
		return undefined;
	}

	/**
	 * Evaluate ast-grep `astCondition` rules against a reconstructed tool snapshot.
	 *
	 * Only edit/write tool streams reach here (AST conditions need a language, which
	 * we infer from the file extension on the tool's path argument). The snapshot is
	 * matched in memory by the native engine (`astMatch`), so this is async and
	 * intentionally throttled: identical consecutive snapshots (the common case when
	 * only non-source arguments change between deltas) are skipped.
	 */
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

		// Throttle: skip re-running the matcher when the source content is unchanged.
		const bufferKey = this.#bufferKey(context);
		if (this.#lastAstSnapshots.get(bufferKey) === snapshot) {
			return [];
		}
		this.#lastAstSnapshots.set(bufferKey, snapshot);

		const matches: Rule[] = [];
		for (const entry of candidates) {
			if (await this.#astConditionsMatch(entry.astConditions, snapshot, lang)) {
				// A warm-up belongs to the rule, not to the condition dialect it is
				// written in, or an author moving a rule from regex to ast-grep would
				// silently lose it.
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

	/** True when any registered rule carries ast-grep conditions. */
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

	/**
	 * Whether a rule with a warm-up has now seen enough distinct streams to speak.
	 *
	 * The unit is the STREAM, not the match: one tool call is re-matched on every
	 * delta it streams, so counting matches would clear a warm-up of three inside
	 * a single call and the rule would still fire on the first reach. Stream keys
	 * are per tool call (`toolcall:<id>`), which is exactly one invocation.
	 *
	 * Counting stops at the threshold, so the set holds at most `warmupMatches`
	 * keys however long the session runs, and the rule keeps matching every later
	 * delta the way a rule with no warm-up does — the repeat policy, not this, is
	 * what stops it saying the same thing twice.
	 */
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

	/** Mark rules as injected (won't trigger again until conditions allow). */
	markInjected(rulesToMark: Rule[]): void {
		this.markInjectedByNames(rulesToMark.map(rule => rule.name));
	}

	/** Mark rule names as injected (won't trigger again until conditions allow). */
	markInjectedByNames(ruleNames: string[]): void {
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) {
				continue;
			}
			// One write rather than create-or-update: the record IS the last injection,
			// on both fields, and a branch that updated only one of them was a way for the
			// message stamp and the reset stamp to describe different moments.
			this.#injectionRecords.set(ruleName, {
				lastInjectedAt: this.#messageCount,
				resetAt: this.#transcriptResets,
			});
			// The pattern has to be established again before the rule says it again, which
			// is what keeps a warm-up rule from turning into a per-match rule the moment
			// its repeat policy re-arms it. Set aside rather than dropped: this claim may
			// still be released without ever reaching the model.
			const banked = this.#warmupStreams.get(ruleName);
			if (banked) {
				this.#warmupAtClaim.set(ruleName, banked);
				this.#warmupStreams.delete(ruleName);
			}
			logger.debug("TTSR rule marked as injected", {
				ruleName,
				messageCount: this.#messageCount,
				// The EFFECTIVE mode, since a rule may override the global one; logging the global
				// setting here reported a suppression that was not going to happen.
				repeatMode: this.#rules.get(ruleName)?.rule.repeatMode ?? this.#settings.repeatMode,
			});
		}
	}

	/**
	 * Give back a claim that was taken but never delivered.
	 *
	 * A tool-scoped reminder is claimed the moment it is bucketed, so a sibling tool call in the
	 * same turn cannot re-match the same rule. Delivery happens later, in `afterToolCall`, and a turn
	 * that is aborted or errors never gets there — the bucket is dropped. Without this, the claim
	 * outlived the reminder: under the default `repeatMode: "once"` the rule was marked as injected,
	 * nothing was ever shown to the model, and it could not fire again for the rest of the session.
	 * That is the "it just does not fire" failure, and it is invisible, because the state that
	 * suppresses the rule looks exactly like the state after a successful injection.
	 *
	 * Only a claim that has not yet been persisted should be released. A persisted injection did
	 * reach the model.
	 */
	releaseInjectedByNames(ruleNames: string[]): void {
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) continue;
			if (this.#injectionRecords.delete(ruleName)) {
				// The reminder was never read, so the reaches that earned it still count.
				const banked = this.#warmupAtClaim.get(ruleName);
				if (banked) {
					this.#warmupStreams.set(ruleName, banked);
					this.#warmupAtClaim.delete(ruleName);
				}
				logger.debug("TTSR claim released without delivery", { ruleName });
			}
		}
	}

	/**
	 * Report every rule whose scope names a tool that does not exist.
	 *
	 * A bare scope token is read as a TOOL NAME, so `scope: "tool:raed"` parses cleanly and registers a
	 * rule that can never match. That is the same invisible failure as a rule with no condition -- the
	 * rule loads, `/rules` lists it, and nothing ever fires -- and `addRule` cannot catch it, because a
	 * `TtsrManager` has no idea what tools exist.
	 *
	 * So the check lives here and is CALLED from where the fact is known: `sdk.ts`, once the tool
	 * registry is complete, including MCP and extension tools. It never refuses the rule. A tool can be
	 * registered later in a session, and refusing would break a rule that is scoped to one deliberately.
	 * The closest registered name is offered, because the overwhelmingly likely cause is a typo.
	 */
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

	/** Get names of all injected rules (for persistence). */
	getInjectedRuleNames(): string[] {
		return Array.from(this.#injectionRecords.keys());
	}

	/** Restore injected state from a list of rule names. */
	restoreInjected(ruleNames: string[]): void {
		for (const name of ruleNames) {
			this.#injectionRecords.set(name, { lastInjectedAt: 0, resetAt: this.#transcriptResets });
		}
		if (ruleNames.length > 0) {
			logger.debug("TTSR injected state restored", { ruleNames });
		}
	}

	/**
	 * Remove every monitored rule before a working-directory re-scope installs
	 * the destination rule set. Injection history remains session-scoped so a
	 * once-only rule does not fire again merely because the session moved away
	 * and back.
	 */
	clearRules(): void {
		this.#rules.clear();
		this.#buffers.clear();
		this.#lastAstSnapshots.clear();
		this.#lastMatchedPath.clear();
		this.#canMatchText = false;
		this.#canMatchThinking = false;
	}

	/** Reset stream buffers (called on new turn). */
	resetBuffer(): void {
		this.#buffers.clear();
		this.#lastAstSnapshots.clear();
	}

	/**
	 * The transcript was replaced. Re-arm the `per-compact` rules that have waited
	 * long enough, and count the event for the ones that have not.
	 *
	 * `per-compact` used to mean "fires again after the very next reset", and five
	 * call sites reach this — compaction, a history rewrite, a rewind, a shake —
	 * so a rule with standing advice said the same thing over and over on a long
	 * session. `commit-drift` is the one that showed it: uncommitted work is a
	 * standing state rather than an event, so its condition is true again the
	 * moment it is re-armed, and re-arming it that often is how a reminder becomes
	 * something the reader learns to skip.
	 *
	 * So a rule states its own period in `repeatCompactions`, and one reset stays
	 * the default. The counter is shared by all five call sites deliberately: each
	 * takes the injected reminder out of the model's view, which is the only
	 * property that matters to a rule deciding whether it still has been heard.
	 */
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

	/** Check if any TTSR rules are registered. */
	hasRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		return this.#rules.size > 0;
	}

	/** All rules currently registered for TTSR monitoring, in registration order. */
	getRules(): Rule[] {
		return Array.from(this.#rules.values(), entry => entry.rule);
	}

	/** Increment message counter (call after each turn). */
	incrementMessageCount(): void {
		this.#messageCount++;
	}

	/** Get current message count. */
	getMessageCount(): number {
		return this.#messageCount;
	}

	/** Get settings. */
	getSettings(): Required<TtsrSettings> {
		return this.#settings;
	}
}
