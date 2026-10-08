/**
 * The secret state of a session: the expansion obfuscator, the SDK runtime lease, the provider
 * redaction paths, and the display expansion that turns a placeholder back into its value on
 * screen.
 *
 * This is a session collaborator. It holds the live obfuscator and lease the SDK installs, and
 * reaches the session through {@link SessionSecretsHost} for the scope-transition queue, the cwd
 * and the system-prompt rebuild.
 *
 * Two authorities are kept apart here. {@link SessionSecrets.expansionObfuscator} is the EXPANSION
 * authority: undefined the moment expansion stops (a `/secret disable`, a cwd move off the vault).
 * {@link SessionSecrets.providerRedactor} and {@link SessionSecrets.hasProviderRedactions} are the
 * REDACTION authority: the runtime lease keeps a redaction-only obfuscator alive across exactly
 * those transitions, so a value the model has already seen as a placeholder never travels back to
 * a provider as plaintext.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import { type CompactionPreparation, hasLegacyArchive, redactLegacyArchiveText } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Context, Message } from "@veyyon/ai";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { errorMessage, logger } from "@veyyon/utils";
import { noteSecretsCondition } from "../../secrets/notices";
import {
	mapAgentMessageStrings,
	mapAssistantContentStrings,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretObfuscator,
} from "../../secrets/obfuscator";
import { PENDING_PLACEHOLDER_RE } from "../../secrets/placeholder";
import { obfuscateProviderPayload } from "../agent-session-provider-request";
import type { AgentSessionConfig, SecretRuntimeLease } from "../agent-session-types";

/** The secret inputs of an {@link AgentSessionConfig}. */
export type SessionSecretsConfig = Pick<
	AgentSessionConfig,
	| "obfuscator"
	| "secretRuntime"
	| "leaseSecretRuntime"
	| "resolveSecretRuntimeLeaseForContext"
	| "refreshSecretRuntime"
>;

export interface SecretsRefreshOptions {
	/** Rebuild the base system prompt after the re-read; default true. */
	refreshPrompt?: boolean;
}

/** What {@link SessionSecrets} needs from the session. */
export interface SessionSecretsHost {
	/** Session id, for diagnostics. */
	sessionId(): string;
	/** Current session cwd; the vault a refresh re-reads is scoped to it. */
	cwd(): string;
	/** Wait until every scope transition initiated before this call has settled. */
	awaitScopeTransitionReady(): Promise<void>;
	/** Queue a secret re-read on the scope-transition tail, behind any cwd move in flight. */
	queueRefresh(options: SecretsRefreshOptions): Promise<void>;
	/** Rebuild the base system prompt after the secret set changed. */
	refreshSystemPrompt(): Promise<void>;
}

export class SessionSecrets {
	#obfuscator: SecretObfuscator | undefined;
	#runtime: SecretRuntimeLease | undefined;
	readonly #lease: (() => Promise<SecretRuntimeLease>) | undefined;
	readonly #reload: ((cwd: string) => Promise<SecretRuntimeLease | SecretObfuscator | undefined>) | undefined;
	/** Recover the lease the SDK attached to a provider context. */
	readonly resolveLeaseForContext: ((context: Context) => SecretRuntimeLease | undefined) | undefined;
	/** Single-flight guard for the out-of-band refresh a stale render schedules. */
	#staleRefreshInFlight = false;
	readonly #host: SessionSecretsHost;

	constructor(config: SessionSecretsConfig, host: SessionSecretsHost) {
		this.#runtime = config.secretRuntime;
		this.#obfuscator = config.secretRuntime?.expansionObfuscator ?? config.obfuscator;
		this.#lease = config.leaseSecretRuntime;
		this.resolveLeaseForContext = config.resolveSecretRuntimeLeaseForContext;
		this.#reload = config.refreshSecretRuntime;
		this.#host = host;
	}

	/**
	 * The expansion authority, when secrets are configured. Undefined once expansion stops. Never
	 * redact through it; {@link providerRedactor} is the redaction authority.
	 */
	get expansionObfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	/**
	 * The live redaction authority, for a consumer that must hold the object.
	 *
	 * Read through a getter rather than captured at construction: a consumer that
	 * snapshots the redactor keeps redacting whatever was configured the moment it
	 * was built, so a secret added mid-session by `/secret add` never reaches it,
	 * and a session that started with no secrets at all never redacts anything.
	 *
	 * READ THIS, NOT `expansionObfuscator`, ON ANY PATH THAT HIDES A VALUE. The
	 * expansion authority is undefined after a `/secret disable` or a cwd move off
	 * the vault, and a redaction path that reads it stops redacting at the moment
	 * less exposure was requested. Use `expansionObfuscator` only to expand a
	 * placeholder or to mutate expansion state.
	 */
	get providerRedactor(): SecretObfuscator | undefined {
		return this.#runtime?.redactionObfuscator ?? this.#obfuscator;
	}

	/**
	 * Whether anything outbound still needs hiding, live value or tombstone.
	 *
	 * Read this instead of `expansionObfuscator?.hasSecrets()` on any redaction path.
	 */
	get hasProviderRedactions(): boolean {
		return this.#runtime?.hasRedactions ?? this.#obfuscator?.hasSecrets() ?? false;
	}

	/** Live session-lifetime provider redactor, including disable/move tombstones. */
	obfuscateProviderText(text: string): string {
		return this.#runtime?.obfuscateText(text) ?? this.#obfuscator?.obfuscate(text) ?? text;
	}

	/**
	 * The provider text redactor as it stands now. A later install does not reach
	 * the returned function.
	 */
	snapshotProviderTextRedactor(): (text: string) => string {
		const runtime = this.#runtime;
		const fallback = this.#obfuscator;
		return text => runtime?.obfuscateText(text) ?? fallback?.obfuscate(text) ?? text;
	}

	/**
	 * Provider redaction for a whole context, through `runtime` when a request
	 * leased one and through the live session runtime otherwise.
	 */
	obfuscateContext(context: Context, runtime: SecretRuntimeLease | undefined = this.#runtime): Context {
		return runtime ? runtime.obfuscateContext(context) : obfuscateProviderContext(this.#obfuscator, context);
	}

	/** Provider redaction for already-converted messages. */
	obfuscateMessages(messages: Message[]): Message[] {
		const runtime = this.#runtime;
		if (runtime) return runtime.obfuscateMessages(messages);
		return this.#obfuscator ? obfuscateMessages(this.#obfuscator, messages) : messages;
	}

	/** Provider redaction for optional text, skipped when nothing needs hiding. */
	obfuscateTextForProvider(text: string | undefined): string | undefined {
		if (!text || !this.hasProviderRedactions) return text;
		return this.obfuscateProviderText(text);
	}

	/** Provider redaction for a compaction preparation's summary and legacy archive text. */
	obfuscatePreparationForProvider(preparation: CompactionPreparation): CompactionPreparation {
		if (!this.hasProviderRedactions) return preparation;
		const previousSummary = this.obfuscateTextForProvider(preparation.previousSummary);
		// `compact()` folds a prior legacy image-archive's plaintext into the
		// summarization prompt on the legacy-archive→summary migration, so the
		// archive's text regions must be redacted alongside the summary. Only the
		// legacy archive slot's text is rewritten; every other preserveData key —
		// notably the OpenAI remote-compaction `encrypted_content` replay state — is
		// opaque provider-replay data and stays byte-identical.
		const previousPreserveData = this.#obfuscatePreservedArchiveText(preparation.previousPreserveData);
		if (
			previousSummary === preparation.previousSummary &&
			previousPreserveData === preparation.previousPreserveData
		) {
			return preparation;
		}
		return { ...preparation, previousSummary, previousPreserveData };
	}

	/** Redact secrets in a legacy persisted image-archive's plaintext regions
	 *  (`text`/`textHead`/`textTail`) so the legacy-archive→summary migration in
	 *  `compact()` cannot ship raw archived user/tool text to the provider. Every
	 *  non-archive key passes through byte-identical; the same reference is
	 *  returned when nothing changes. Only old sessions still carry such an archive. */
	#obfuscatePreservedArchiveText(
		preserveData: Record<string, unknown> | undefined,
	): Record<string, unknown> | undefined {
		if (!this.hasProviderRedactions || !hasLegacyArchive(preserveData)) return preserveData;
		return redactLegacyArchiveText(preserveData, value => this.obfuscateProviderText(value));
	}

	/**
	 * Install the SDK coordinator's winning snapshot.
	 *
	 * Synchronous: the coordinator updates its closure authority and this view in
	 * the same commit turn. An older revision than the installed one is ignored.
	 */
	install(runtime: SecretRuntimeLease): void {
		if (this.#runtime && runtime.revision < this.#runtime.revision) return;
		this.#runtime = runtime;
		this.#obfuscator = runtime.expansionObfuscator;
	}

	/** Admit one immutable request runtime after the winning scope is ready. */
	async lease(): Promise<SecretRuntimeLease> {
		await this.#host.awaitScopeTransitionReady();
		if (this.#lease) {
			const runtime = await this.#lease();
			this.install(runtime);
			return runtime;
		}
		if (this.#runtime) return this.#runtime;

		const obfuscator = this.#obfuscator;
		return {
			revision: 0,
			cwd: this.#host.cwd(),
			expansionObfuscator: obfuscator,
			redactionObfuscator: obfuscator,
			hasRedactions: obfuscator?.hasSecrets() ?? false,
			obfuscateText: text => obfuscator?.obfuscate(text) ?? text,
			obfuscateMessages: messages => (obfuscator ? obfuscateMessages(obfuscator, messages) : messages),
			obfuscateContext: context => (obfuscator ? obfuscateProviderContext(obfuscator, context) : context),
			obfuscatePayload: payload => obfuscateProviderPayload(payload, obfuscator),
			// No vault revision was ever captured on this path, so nothing here can
			// go stale and every freshness member is a no-op.
			isFreshForExpansion: () => true,
			ensureFreshForExpansion: async () => undefined,
			assertFreshForExpansion: () => undefined,
		};
	}

	/**
	 * Re-read config/env/vault state for the current cwd and install the result.
	 *
	 * Runs the re-read directly. A caller outside a scope transition goes through
	 * the session's queued `refreshSecrets` instead.
	 */
	async refresh(options?: SecretsRefreshOptions): Promise<void> {
		if (!this.#reload) return;
		const refreshed = await this.#reload(this.#host.cwd());
		if (refreshed && "revision" in refreshed) {
			this.install(refreshed);
		} else {
			this.#runtime = undefined;
			this.#obfuscator = refreshed;
		}
		if (options?.refreshPrompt !== false) await this.#host.refreshSystemPrompt();
	}

	/**
	 * One string in display form, or the text unchanged when it cannot be
	 * expanded. NEVER throws, for any codec or freshness reason.
	 *
	 * Every caller is a display or render path, not a tool call. An exception
	 * raised while turning a stored `#HASH#` back into plaintext does not fail one
	 * operation, it unwinds whatever was rendering (the event fan-out, a TUI
	 * repaint, the agent-state rebuild after a compaction or a resume) and the
	 * session is gone. A placeholder left on screen literally is cosmetic, so
	 * degrading is always the right trade here.
	 *
	 * The DISPLAY-RESTORABLE test comes FIRST and is the whole gate.
	 * `hasSecrets()` answers "this session has a secret", which is not the
	 * question, and `containsLivePlaceholder` answers "would expansion change
	 * this", which is no longer the question either: a vault-backed credential is
	 * NOT restorable on screen, so text whose only placeholders are withheld has
	 * nothing to expand and must not consult the vault revision or report a
	 * degraded render.
	 */
	expandForDisplay(text: string): string {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.containsDisplayRestorablePlaceholder(text)) return text;
		if (!this.#freshForDisplay()) return text;
		return this.#expandLivePlaceholders(obfuscator, text) ?? text;
	}

	/**
	 * Provider text on its way to a streamed delta: the display form, cut before
	 * a placeholder the stream has only started, so a half-received `#HASH`
	 * never reaches the screen.
	 */
	providerTextReadyForDelta(text: string): string {
		const deobfuscated = this.expandForDisplay(text);
		if (!this.#obfuscator?.hasSecrets()) return deobfuscated;
		const pendingPlaceholderStart = deobfuscated.match(PENDING_PLACEHOLDER_RE);
		if (pendingPlaceholderStart?.index === undefined) return deobfuscated;
		return deobfuscated.slice(0, pendingPlaceholderStart.index);
	}

	/**
	 * Per-string expander for one display pass over a structured payload (a
	 * transcript, one assistant message's content), or undefined when the session
	 * has no expansion authority and the caller should skip the walk and keep its
	 * own reference.
	 *
	 * Freshness is resolved lazily, on the first string that carries a live
	 * placeholder, and then memoized FOR THIS PASS ONLY: the freshness probe
	 * reads the vault's revision off disk, and a transcript rebuild walks every
	 * model-authored string in the branch. A later pass resolves it again, so a
	 * refresh that landed in between is picked up.
	 */
	displayExpander(): ((text: string) => string) | undefined {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return undefined;
		let fresh: boolean | undefined;
		return (text: string): string => {
			if (!obfuscator.containsDisplayRestorablePlaceholder(text)) return text;
			fresh ??= this.#freshForDisplay();
			if (!fresh) return text;
			return this.#expandLivePlaceholders(obfuscator, text) ?? text;
		};
	}

	/**
	 * Per-string, never-throwing stand-in for `deobfuscateSessionContext` on
	 * render paths: the same transcript walk, and the same
	 * same-reference-when-nothing-changed contract.
	 */
	deobfuscateSessionContextForDisplay(context: SessionContext): SessionContext {
		const expand = this.displayExpander();
		if (expand === undefined) return context;
		const messages = mapAgentMessageStrings(context.messages, expand);
		return messages === context.messages ? context : { ...context, messages };
	}

	/**
	 * {@link SecretObfuscator.deobfuscateForDisplay} with a refused expansion demoted to a literal
	 * render AND reported to the operator.
	 *
	 * NOT `deobfuscate`. A stored credential must never be drawn, so the display codec restores
	 * only what may be shown and leaves a withheld placeholder standing.
	 *
	 * The refusal arrives as UNCHANGED TEXT, not as a throw. The display codec swallows its own cap
	 * refusals by design, since its caller is drawing a frame. Without the comparison a refused
	 * expansion is indistinguishable on screen from having nothing to expand, and the operator is
	 * left with a placeholder and no reason for it.
	 *
	 * PRECONDITION, and the equality check is sound ONLY because of it: every caller has already
	 * established, via `containsDisplayRestorablePlaceholder`, that this text holds a placeholder the
	 * codec would expand. Given that, identical text can only mean the codec declined. Reuse this
	 * check anywhere that precondition does not hold and it reads "refused" for the ordinary case of
	 * text with nothing to expand, which is a silent false notice on every render.
	 */
	#expandLivePlaceholders(obfuscator: SecretObfuscator, text: string): string | undefined {
		try {
			const expanded = obfuscator.deobfuscateForDisplay(text);
			if (expanded !== text) return expanded;
			this.#noteDegraded(
				"A secret placeholder is shown unexpanded because the expansion was refused.",
				"A display expansion returned unchanged text for a restorable placeholder; rendering it literally",
			);
			return undefined;
		} catch (error) {
			// BACKSTOP, not a live path: the display codec is documented never to throw. Kept because
			// every display path funnels through here, and a throw would unwind the TUI.
			this.#noteDegraded(
				"A secret placeholder is shown unexpanded because the expansion was refused.",
				"Refused a secret expansion on a display path; rendering the placeholder literally",
				error,
			);
			return undefined;
		}
	}

	/**
	 * Expand one string for an INTERNAL COMPARISON against bytes on disk, or report that it cannot
	 * be expanded. Never throws.
	 *
	 * The one expansion that is neither a spend nor a display, and the one that still needs the
	 * REAL value: the streaming-edit guard matches the model's removed lines against the file's
	 * content, which holds the credential in cleartext. Routing it through the display codec would
	 * leave `#HASH#` in the comparison text, no removed line would ever match, and every edit
	 * touching a secret would look like a failed patch preview.
	 *
	 * Nothing expanded here may be rendered or logged. The result is compared and discarded.
	 */
	expandForDiskComparison(text: string): string | undefined {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.containsLivePlaceholder(text)) return text;
		if (!this.#freshForDisplay()) return undefined;
		try {
			return obfuscator.deobfuscate(text);
		} catch (error) {
			logger.warn("Refused a secret expansion for a streaming-edit disk comparison; skipping the check", {
				sessionId: this.#host.sessionId(),
				error: errorMessage(error),
			});
			return undefined;
		}
	}

	/**
	 * One line of model-authored text, safe to put in a log.
	 *
	 * Re-redacts through the live obfuscator, turning any expanded credential back into its
	 * placeholder. Used where a diagnostic quotes text that has ALREADY been expanded for an
	 * internal comparison: the log file outlives the terminal, so a credential written there is a
	 * longer-lived exposure than a screen leak. Falls back to a fixed marker rather than the raw
	 * text, because a redactor that fails open is not one.
	 */
	redactForLog(text: string): string {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return text;
		try {
			return obfuscator.obfuscate(text);
		} catch {
			return "<redacted: could not be safely rendered>";
		}
	}

	/** Whether any model-authored string in this assistant content carries a display-restorable placeholder. */
	contentCarriesLivePlaceholder(content: AssistantMessage["content"]): boolean {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return false;
		let found = false;
		mapAssistantContentStrings(
			content,
			text => {
				found ||= obfuscator.containsDisplayRestorablePlaceholder(text);
				return text;
			},
			{ includeToolMetadata: true },
		);
		return found;
	}

	/** Whether any model-authored string in this transcript carries a display-restorable placeholder. */
	messagesCarryLivePlaceholder(messages: AgentMessage[]): boolean {
		const obfuscator = this.#obfuscator;
		if (obfuscator === undefined || !obfuscator.hasSecrets()) return false;
		let found = false;
		mapAgentMessageStrings(messages, text => {
			found ||= obfuscator.containsDisplayRestorablePlaceholder(text);
			return text;
		});
		return found;
	}

	/**
	 * Await the recovery a stale runtime needs, on a render path that happens to
	 * be async, and never fail the caller for it.
	 *
	 * The two async render sites (the ephemeral turn's final message, the
	 * transcript rebuild after a branch move) can do better than degrade: they are
	 * already inside an await, so they can wait for the vault re-read and then
	 * expand from the fresh runtime that refresh installs. A refresh that fails
	 * still only degrades, because a codec problem must not become a failed
	 * navigation or a dead recap.
	 */
	async awaitRefreshForRender(carriesLivePlaceholder: boolean): Promise<void> {
		const runtime = this.#runtime;
		if (!carriesLivePlaceholder || runtime === undefined) return;
		try {
			await runtime.ensureFreshForExpansion();
		} catch (error) {
			this.#noteDegraded(
				"The secret vault changed in another session or process and could not be re-read, so secret placeholders are shown unexpanded.",
				"Failed to refresh a stale secret runtime before a render expansion",
				error,
			);
		}
	}

	/**
	 * Whether a display pass may expand live placeholders, plus the recovery when
	 * it may not.
	 *
	 * A stale captured revision means the vault changed under this session, so the
	 * cached map can hold a value that has since been rotated or deleted and
	 * expanding from it would put a superseded secret on screen. Show the
	 * placeholder, report it once, and start the refresh that makes the NEXT
	 * render correct. Refusing to render is never one of the options.
	 */
	#freshForDisplay(): boolean {
		const runtime = this.#runtime;
		if (runtime === undefined) return true;
		let fresh: boolean;
		try {
			fresh = runtime.isFreshForExpansion();
		} catch (error) {
			// Documented pure, but it reads the vault's revision off disk. An
			// unreadable vault degrades the render; it never ends it.
			this.#noteDegraded(
				"Secret placeholders are shown unexpanded because the vault revision could not be read.",
				"Could not read the vault revision while rendering; showing placeholders literally",
				error,
			);
			return false;
		}
		if (fresh) return true;
		this.#scheduleStaleRefresh();
		this.#noteDegraded(
			"The secret vault changed in another session or process, so secret placeholders are shown unexpanded until the refresh lands.",
			"Rendering secret placeholders literally because the captured vault revision is stale",
		);
		return false;
	}

	/**
	 * Recover a stale secret runtime out of band, so the next render expands.
	 *
	 * Single-flight because the callers are renders: a transcript rebuild reaches
	 * this from the first placeholder it walks and a repaint can run on every
	 * keystroke, while each refresh re-reads the whole vault.
	 *
	 * Goes through the host's queued refresh, not {@link refresh}, so this
	 * re-read is queued on the scope-transition tail like every other one: a cwd
	 * move in flight is not raced, and a spend that runs right after a degraded
	 * render waits for this refresh through `awaitScopeTransitionReady` instead of
	 * re-reading the vault a second time. The system-prompt rebuild is skipped
	 * because a render must not rewrite the prompt as a side effect.
	 */
	#scheduleStaleRefresh(): void {
		if (this.#staleRefreshInFlight || this.#reload === undefined) return;
		this.#staleRefreshInFlight = true;
		void this.#host
			.queueRefresh({ refreshPrompt: false })
			.catch(error => {
				logger.warn("Failed to refresh a stale secret runtime for display", { error: errorMessage(error) });
			})
			.finally(() => {
				this.#staleRefreshInFlight = false;
			});
	}

	/**
	 * Report a degraded render to the operator, and log the detail.
	 *
	 * Goes through the secrets notice sink every other machine-state condition in
	 * this subsystem uses, so the host renders it the same way as a tightened key
	 * directory or a superseded vault binding. NEVER carries a secret value: the
	 * notice states the condition and the log holds the error text.
	 */
	#noteDegraded(notice: string, logMessage: string, error?: unknown): void {
		logger.warn(logMessage, {
			sessionId: this.#host.sessionId(),
			...(error === undefined ? {} : { error: errorMessage(error) }),
		});
		noteSecretsCondition(notice);
	}
}
