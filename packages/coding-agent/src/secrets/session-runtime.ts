/**
 * The secret runtime one agent session holds: the obfuscator its requests redact with,
 * the vault its placeholders expand against, the audit log a spend is recorded in, and
 * the immutable lease each admitted request pins.
 *
 * A request pins one lease so that a disable or a scope move cannot change what an
 * already-admitted request uses. A reload replaces the committed lease in one
 * synchronous step, and the constructed session is told about every commit.
 */

import * as path from "node:path";
import type { Context, Message } from "@veyyon/ai";
import type { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { errorMessage, logger } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import { type JsonWithOptionalFields, mapJsonStrings } from "../json-transform";
import { obfuscateProviderPayload } from "../session/agent-session-provider-request";
import type { SecretRuntimeLease } from "../session/agent-session-types";
import { secretProtectionUnavailableMessage } from "../session/factory-notices";
import { collectEnvSecrets, loadSecrets } from ".";
import { buildExpansionRecord, SecretAuditLog, secretAuditPath } from "./audit";
import { buildEnvSecretPattern, loadEnvSecretKeywords } from "./env-keywords";
import { SECRET_SPEND_NOTICE_SOURCE } from "./notices";
import {
	deobfuscateToolArguments,
	describeSecretExpiry,
	obfuscateMessages,
	obfuscateProviderContext,
	type SecretEntry,
	SecretObfuscator,
} from "./obfuscator";
import { isSecretPlaceholder, PLACEHOLDER_RE } from "./placeholder";
import { describeSecretRejection } from "./policy";
import { expiryWarnings } from "./secret-command";
import { secretSpendMarker } from "./spend-marker";
import { resolveVaultLocations, type ScopedVaultEntry, SecretVault, vaultPathFor } from "./vault";
import { loadOrCreateVaultKey } from "./vault-crypto";

/** What the runtime reads to load and report. */
export interface SessionSecretRuntimeOptions {
	/** Settings of the directory the session started in. */
	settings: Settings;
	globalConfigRoot: string;
	agentDir: string;
	operatorNotices: OperatorNotices;
	/** The session's live working directory. */
	getCwd: () => string;
}

/** What the runtime reaches on the constructed session. */
export interface SecretRuntimeSession {
	installSecretRuntime(runtime: SecretRuntimeLease): void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
}

/** One load of every secret source. */
interface LoadedSecretRuntime {
	obfuscator: SecretObfuscator | undefined;
	vault: SecretVault | undefined;
	auditLog: SecretAuditLog | undefined;
	vaultRevision: string | undefined;
}

/**
 * Whether a vault that will not open degrades the load or fails it.
 *
 * At STARTUP a vault that will not open has to degrade, because `/secret discard` repairs
 * it and lives inside the session this would otherwise abort. On a RELOAD it has to throw:
 * the reload exists to prove a captured snapshot still matches the vault before a live
 * `#NAME#` is expanded, so a swallowed failure there is a placeholder expanded against a
 * vault nobody could read. Same loader, opposite correct answers, so the caller states
 * which one it is asking for.
 */
type UnreadableVaultPolicy = "degrade" | "throw";

/** An unreadable-scope condition, described in the words an operator is shown. */
interface UnreadableVaultReport {
	/** The lease whose vault was consulted, which is the live one whenever it still applies. */
	readonly authority: SecretRuntimeLease;
	/** Every unreadable scope with its path, for a message that has to say WHICH file. */
	readonly broken: string;
	/** The repair, worded to match the notice `noteUnreadableVault` prints for the same state. */
	readonly repair: string;
}

/** The expansion inputs one lease was built from. */
interface LeaseSource {
	revision: number;
	cwd: string;
	expansionObfuscator: SecretObfuscator | undefined;
	redactor: SecretObfuscator | undefined;
	vault: SecretVault | undefined;
	vaultRevision: string | undefined;
	auditLog: SecretAuditLog | undefined;
}

/**
 * Load every secret source for `runtimeCwd`.
 *
 * There is one loader for startup, runtime toggles, command reconciliation, and cwd
 * moves. Replacing the complete runtime prevents project-scoped names and values from
 * surviving a move into another project.
 */
async function loadSecretRuntime(
	options: SessionSecretRuntimeOptions,
	runtimeCwd: string,
	runtimeSettings: Settings,
	onUnreadableVault: UnreadableVaultPolicy,
): Promise<LoadedSecretRuntime> {
	if (!runtimeSettings.get("secrets.enabled")) {
		return { obfuscator: undefined, vault: undefined, auditLog: undefined, vaultRevision: undefined };
	}
	const { globalConfigRoot, agentDir, operatorNotices } = options;
	// The key read depends only on `globalConfigRoot`, so start it before the
	// secrets/env/vault entry loads below. Capture either outcome immediately:
	// the independent reads can span multiple event-loop turns, and a raw
	// rejection before the later await would otherwise be reported as unhandled.
	const placeholderKeyResultPromise = logger
		.time("loadSecretPlaceholderKey", () => loadOrCreateVaultKey(globalConfigRoot))
		.then(
			value => ({ ok: true as const, value }),
			error => ({ ok: false as const, error }),
		);

	const fileEntries = await logger.time("loadSecrets", loadSecrets, runtimeCwd, agentDir);
	const envKeywords = await logger.time("loadEnvSecretKeywords", () =>
		loadEnvSecretKeywords({ cwd: runtimeCwd, agentDir }),
	);
	const envEntries = collectEnvSecrets(buildEnvSecretPattern(envKeywords));
	const vaultLocations = resolveVaultLocations({ globalConfigRoot, agentDir, cwd: runtimeCwd });
	const vault = new SecretVault(vaultLocations);
	const auditLog = runtimeSettings.get("secrets.auditLog")
		? new SecretAuditLog(secretAuditPath(vaultLocations), operatorNotices)
		: undefined;
	// A VAULT THAT CANNOT BE READ MUST NOT STOP THE SESSION STARTING, because the repair for
	// one lives inside the product this throw was preventing from starting. `load()` still
	// refuses the read (its narrow catch is a security boundary and is untouched); what
	// changes is that the refusal no longer takes the process with it. `noteFailedLoad` marks
	// every scope holding a file unreadable, which is what keeps this from becoming "the
	// vault is empty": the spend seam refuses those placeholders instead of passing them
	// through, and the operator is told, with a repair that runs on this surface.
	//
	// The interactive client already survived this and a `-p` run did not, so the same broken
	// vault was a warning in one place and a fatal error in the other. One loader, one answer.
	//
	// ONLY at startup. A reload rethrows, because its caller is about to expand a live
	// placeholder and needs the failure, not an empty runtime. Absorbing it here for every
	// caller silently turned the expansion lease's fail-closed refusal into a successful
	// expansion; the reload rows in the lease suite catch that and must stay red for it.
	let liveVaultEntries: ScopedVaultEntry[] = [];
	try {
		liveVaultEntries = await logger.time("loadVault", () => vault.load());
	} catch (error) {
		await vault.noteFailedLoad(error);
		if (onUnreadableVault === "throw") throw error;
	}
	const vaultEntries: SecretEntry[] = liveVaultEntries.map(secret => ({
		type: "plain",
		content: secret.value,
		name: secret.name,
		expiresAt: secret.expiresAt,
		// Stored in the vault precisely so the value is never shown. `mayRestoreForDisplay`
		// restores only `type: "regex"` + `origin: "config"`, so declaring the true
		// provenance here is what keeps a stored credential from being painted back onto
		// the screen out of model-authored prose or a tool-call argument.
		origin: "vault",
	}));

	// Both unprompted expiry warnings answer to this one setting: the startup sweep below and
	// the obfuscator's mid-session `onExpiry`. Gating one and not the other would leave the
	// session still interrupting about expiry with the warnings switched off, which is the
	// same defect under a different trigger.
	//
	// `/secret list` and the status-line chip are NOT gated: the operator asked for those by
	// opening the list or by looking at the line, and answering a question with silence is a
	// different feature from not interrupting.
	const warnAboutExpiry = runtimeSettings.get("secrets.expiryWarnings");
	if (warnAboutExpiry) {
		for (const warning of expiryWarnings(liveVaultEntries, Date.now())) {
			operatorNotices.warn("secrets", warning);
		}
	}

	const placeholderKeyResult = await placeholderKeyResultPromise;
	if (!placeholderKeyResult.ok) {
		throw new Error(secretProtectionUnavailableMessage(globalConfigRoot), { cause: placeholderKeyResult.error });
	}
	const vaultRevision = vault.revision();
	const obfuscator = new SecretObfuscator(envEntries.concat(fileEntries, vaultEntries), {
		placeholderKey: placeholderKeyResult.value,
		onRejection: rejection => operatorNotices.warn("secrets", describeSecretRejection(rejection)),
		// A notice only. The placeholder is already forgotten by the time this fires, so
		// silencing it withdraws the interruption and nothing else.
		onExpiry: warnAboutExpiry ? expiry => operatorNotices.warn("secrets", describeSecretExpiry(expiry)) : undefined,
	});
	return { obfuscator, vault, vaultRevision, auditLog };
}

/**
 * Whether any string inside a tool call's arguments would actually be expanded.
 *
 * The same bounded JSON walk `deobfuscateToolArguments` uses, with the mapper replaced by
 * the non-throwing predicate that mirrors `deobfuscate`'s rule. The identity return keeps
 * the walk allocation-free: `mapJsonStrings` hands back the original reference when no
 * string changed.
 */
function toolArgumentsCarryLivePlaceholder(expansion: SecretObfuscator, args: Record<string, unknown>): boolean {
	let carries = false;
	mapJsonStrings(args as JsonWithOptionalFields, text => {
		if (!carries && expansion.containsLivePlaceholder(text)) carries = true;
		return text;
	});
	return carries;
}

/**
 * The first placeholder-shaped token in a tool call's arguments that this runtime cannot
 * resolve, or `undefined` when every one of them resolves.
 *
 * Only consulted while a vault scope is unreadable. An unparseable vault never says which
 * names it held, so there is no list to check a token against and the shape is the only
 * signal available. `isSecretPlaceholder` is the test rather than the looser
 * `PLACEHOLDER_RE` alone, so a four-character token like `#TODO#` is not mistaken for a
 * name (names start with a letter and run at least five characters).
 *
 * A private regex, not the shared `PLACEHOLDER_RE`: that one is global and carries
 * `lastIndex` across every module that touches it, so borrowing it here would couple this
 * walk to whether some other caller reset it.
 */
function firstUnresolvedPlaceholder(
	expansion: SecretObfuscator | undefined,
	args: Record<string, unknown>,
): string | undefined {
	const scan = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
	let orphan: string | undefined;
	mapJsonStrings(args as JsonWithOptionalFields, text => {
		if (orphan !== undefined || !text.includes("#")) return text;
		scan.lastIndex = 0;
		for (;;) {
			const match = scan.exec(text);
			if (match === null) break;
			const token = match[0];
			if (isSecretPlaceholder(token) && expansion?.knowsPlaceholder(token) !== true) {
				orphan = token;
				break;
			}
		}
		return text;
	});
	return orphan;
}

export class SessionSecretRuntime {
	readonly #options: SessionSecretRuntimeOptions;
	/** Live expansion authority. Undefined when expansion is disabled. */
	#obfuscator: SecretObfuscator | undefined;
	/** Redaction authority, which outlives expansion across a disable or a scope move. */
	#redactionObfuscator: SecretObfuscator | undefined;
	#vault: SecretVault | undefined;
	#vaultRevision: string | undefined;
	#auditLog: SecretAuditLog | undefined;
	#runtimeCwd: string;
	#latestRequest = 0;
	#pending: { revision: number; cwd: string; work: Promise<SecretRuntimeLease | undefined> } | undefined;
	#lease: SecretRuntimeLease;
	#session: SecretRuntimeSession | undefined;
	readonly #auditLogByLease = new WeakMap<object, SecretAuditLog | undefined>();
	/**
	 * The vault each lease was built from, so the spend seam can ask whether a scope is
	 * currently unreadable. Keyed like the audit log because it answers the same kind of
	 * question: which load produced the authority about to be used.
	 */
	readonly #vaultByLease = new WeakMap<object, SecretVault>();

	/** Load the runtime a session starts with. The only load that may start without a vault. */
	static async load(options: SessionSecretRuntimeOptions, cwd: string): Promise<SessionSecretRuntime> {
		return new SessionSecretRuntime(options, cwd, await loadSecretRuntime(options, cwd, options.settings, "degrade"));
	}

	private constructor(options: SessionSecretRuntimeOptions, cwd: string, initial: LoadedSecretRuntime) {
		this.#options = options;
		this.#obfuscator = initial.obfuscator;
		this.#redactionObfuscator = initial.obfuscator;
		this.#vault = initial.vault;
		this.#vaultRevision = initial.vaultRevision;
		this.#auditLog = initial.auditLog;
		this.#runtimeCwd = path.resolve(cwd);
		this.#lease = this.#createLease({
			revision: 0,
			cwd,
			expansionObfuscator: initial.obfuscator,
			redactor: initial.obfuscator,
			vault: initial.vault,
			vaultRevision: initial.vaultRevision,
			auditLog: initial.auditLog,
		});
	}

	/** The committed lease: the authority a request admitted now would pin. */
	get lease(): SecretRuntimeLease {
		return this.#lease;
	}

	/**
	 * The live expansion obfuscator. Read at each use rather than captured, so a revoked or
	 * expired credential leaves the prompt on the next rebuild.
	 */
	get obfuscator(): SecretObfuscator | undefined {
		return this.#obfuscator;
	}

	/** Report every later commit to the constructed session. */
	attachSession(session: SecretRuntimeSession): void {
		this.#session = session;
	}

	/** Redact `text` with the committed lease. */
	obfuscateText(text: string): string {
		return this.#lease.obfuscateText(text);
	}

	/**
	 * Flush queued audit records. The log queues its appends so a tool call is never blocked
	 * by a write, so an exit that does not wait for the queue loses the records still in it.
	 */
	async flushAuditLog(): Promise<void> {
		await this.#auditLog?.flush();
	}

	/**
	 * The lease a request should pin: the committed one, after any reload in flight lands
	 * and after a reload for a vault that moved on disk.
	 */
	async acquire(): Promise<SecretRuntimeLease> {
		for (;;) {
			const pending = this.#pending;
			if (pending) {
				await pending.work;
				if (this.#pending !== pending) continue;
			}
			if (this.#vault && this.#vaultRevision !== undefined && this.#vault.revision() !== this.#vaultRevision) {
				return await this.refresh(this.#options.getCwd());
			}
			return this.#lease;
		}
	}

	/** Reload every secret source for `runtimeCwd` and commit it when it is still authoritative. */
	refresh(runtimeCwd: string): Promise<SecretRuntimeLease> {
		const revision = ++this.#latestRequest;
		const normalizedRuntimeCwd = path.resolve(runtimeCwd);
		const work = this.#reload(revision, normalizedRuntimeCwd);
		const pending = { revision, cwd: normalizedRuntimeCwd, work };
		this.#pending = pending;
		return this.#settle(pending);
	}

	async #reload(revision: number, normalizedRuntimeCwd: string): Promise<SecretRuntimeLease | undefined> {
		const { settings, getCwd } = this.#options;
		const runtimeSettings =
			normalizedRuntimeCwd === this.#runtimeCwd || path.resolve(settings.getCwd()) === normalizedRuntimeCwd
				? settings
				: await settings.cloneForCwd(normalizedRuntimeCwd);
		const next = await loadSecretRuntime(this.#options, normalizedRuntimeCwd, runtimeSettings, "throw");

		const isAuthoritative = (): boolean =>
			revision === this.#latestRequest && path.resolve(getCwd()) === normalizedRuntimeCwd;
		if (!isAuthoritative()) return undefined;

		if (next.obfuscator && this.#redactionObfuscator) {
			// Expansion never crosses snapshots, but redaction tombstones and retired-name
			// refusals cross every refresh and cwd move.
			next.obfuscator.retainRedactionsFrom(this.#redactionObfuscator);
		} else if (this.#redactionObfuscator) {
			// Disabling expansion does not erase the names already advertised in this process.
			// Mark them on the redaction-only authority so stale tool calls fail before execution.
			this.#redactionObfuscator.markAllPlaceholdersRetired();
		}
		await this.#auditLog?.flush();
		if (!isAuthoritative()) return undefined;

		const nextRedactor = next.obfuscator ?? this.#redactionObfuscator;
		const nextLease = this.#createLease({
			revision,
			cwd: normalizedRuntimeCwd,
			expansionObfuscator: next.obfuscator,
			redactor: nextRedactor,
			vault: next.vault,
			vaultRevision: next.vaultRevision,
			auditLog: next.auditLog,
		});

		// One synchronous commit updates every reader and the AgentSession view. No await is
		// permitted in this block.
		this.#obfuscator = next.obfuscator;
		this.#redactionObfuscator = nextRedactor;
		this.#vault = next.vault;
		this.#vaultRevision = next.vaultRevision;
		this.#auditLog = next.auditLog;
		this.#runtimeCwd = normalizedRuntimeCwd;
		this.#lease = nextLease;
		this.#session?.installSecretRuntime(nextLease);
		return nextLease;
	}

	async #settle(pending: {
		revision: number;
		cwd: string;
		work: Promise<SecretRuntimeLease | undefined>;
	}): Promise<SecretRuntimeLease> {
		try {
			const committed = await pending.work;
			if (committed) return committed;
			if (this.#pending === pending) this.#pending = undefined;
			return await this.acquire();
		} catch (error) {
			if (pending.revision !== this.#latestRequest) return await this.acquire();
			throw error;
		} finally {
			if (this.#pending === pending) this.#pending = undefined;
		}
	}

	/**
	 * Schedule the reload a stale lease needs, honouring the two rules that keep refreshes
	 * from fighting each other.
	 *
	 * A lease may outlive a cwd transition because one admitted request keeps its immutable
	 * authority. Such an old lease must not supersede the destination refresh by scheduling
	 * work for the directory being left. And once the committed lease already answers
	 * correctly there is nothing left to fix: a revision that moved because THIS session
	 * wrote the vault therefore cannot feed a reload storm, because the write is already
	 * reflected in the lease every later request reads.
	 */
	#scheduleStaleRefresh(normalizedCwd: string): void {
		if (path.resolve(this.#options.getCwd()) !== normalizedCwd) return;
		if (this.#pending?.cwd === normalizedCwd) return;
		if (this.#lease.cwd === normalizedCwd && this.#lease.isFreshForExpansion()) return;
		void this.refresh(normalizedCwd).catch(error => {
			logger.warn("Failed to refresh a stale secret runtime", { cwd: normalizedCwd, error: errorMessage(error) });
		});
	}

	/**
	 * The lease that may expand right now, or undefined when no fresh authority exists yet.
	 *
	 * A request pins one immutable lease so that a disable or a scope move cannot change what
	 * an already-admitted request uses. That rule protects redaction. For EXPANSION a reload
	 * that already landed on the same directory is strictly better authority: it resolves the
	 * placeholder against the vault as it is now instead of against a snapshot a rotation has
	 * moved past. Preferring it is how a stale revision recovers instead of refusing.
	 */
	#freshExpansionAuthority(requested: SecretRuntimeLease): SecretRuntimeLease | undefined {
		if (requested.isFreshForExpansion()) return requested;
		const live = this.#lease;
		if (live === requested || live.cwd !== requested.cwd) return undefined;
		if (live.expansionObfuscator?.hasSecrets() !== true) return undefined;
		return live.isFreshForExpansion() ? live : undefined;
	}

	/**
	 * The unreadable scopes that currently speak for `requested`'s directory, and the words
	 * that tell an operator how to fix them.
	 *
	 * The repair is worded in ONE place. The same condition is also reported by
	 * `noteUnreadableVault` in vault.ts, and an operator hitting a corrupt vault sees both
	 * within a minute of each other; two descriptions of one repair is how someone concludes
	 * there are two problems. Keep this clause and that notice's in step.
	 */
	#unreadableVaultReport(requested: SecretRuntimeLease): UnreadableVaultReport | undefined {
		// A repaired vault stops refusing the moment its reload lands: the live lease holds a
		// different SecretVault whose own load found every scope readable.
		const live = this.#lease;
		const authority = live.cwd === requested.cwd ? live : requested;
		const unreadable = this.#vaultByLease.get(authority)?.unreadableScopes() ?? [];
		if (unreadable.length === 0) return undefined;
		const { globalConfigRoot, agentDir } = this.#options;
		const locations = resolveVaultLocations({ globalConfigRoot, agentDir, cwd: authority.cwd });
		const broken = unreadable.map(scope => `${scope} (${vaultPathFor(locations, scope)})`).join(", ");
		// MOVES the file, so say "aside" rather than "delete": it still holds real credentials
		// sealed with a key that is still on disk, the damage may be a truncated tail with
		// recoverable entries behind it, and someone told it was deleted finds out otherwise at
		// the worst possible moment.
		const commands = unreadable.map(scope => `/secret discard ${scope}`).join(" and ");
		return {
			authority,
			broken,
			repair: `Run ${commands} to move the unreadable file aside. Then store the secrets it held again.`,
		};
	}

	/**
	 * THE FOURTH REFUSAL CONDITION: an unreadable vault scope plus a placeholder nothing can
	 * resolve.
	 *
	 * A vault whose bytes exist but do not parse is skipped by `load()` so launch survives,
	 * which leaves this hole: `revision()` fingerprints file STATS and never parses, so the
	 * corrupt file's revision matches the captured one and the freshness conditions are all
	 * satisfied. `containsLivePlaceholder` is false too, because the obfuscator never learned
	 * the name the file held. Every other check says yes and `bash echo #TOKEN#` RUNS, passing
	 * the literal characters `#TOKEN#` where a credential belongs. That is worse than the
	 * crash it replaced: a dead TUI is loud, a command that quietly executes against a live
	 * endpoint with a placeholder for its credential is not.
	 *
	 * The rule cannot be name-specific. An unparseable vault never says which names it held,
	 * so there is no list to check against; while ANY scope is unreadable, a
	 * placeholder-shaped token that does not resolve is refused instead of passed through.
	 * With every scope healthy this does nothing at all, so an unknown `#WORD#` keeps
	 * behaving exactly as it does today.
	 *
	 * OUTSIDE the `hasSecrets()` condition that covers the rest of the spend seam. In the case
	 * this exists for, the corrupt scope is often the only source of secrets, so the
	 * obfuscator holds nothing, `hasSecrets()` is false, and a check placed inside that
	 * condition would never run.
	 */
	#assertNoOrphanPlaceholderWhileVaultUnreadable(requested: SecretRuntimeLease, args: Record<string, unknown>): void {
		const report = this.#unreadableVaultReport(requested);
		if (report === undefined) return;
		const orphan = firstUnresolvedPlaceholder(report.authority.expansionObfuscator, args);
		if (orphan === undefined) return;
		throw new Error(
			`Secret expansion was refused because ${orphan} does not resolve and the vault could not be read, so there is no way to tell whether it is a credential this session should have expanded. Unreadable: ${report.broken}. ${report.repair} Nothing was run.`,
		);
	}

	/**
	 * The arguments a tool call executes with, with every live placeholder expanded against
	 * `requestRuntime`, the lease the request pinned.
	 *
	 * EXECUTION ONLY. The substituted text is a live credential, so the tool gets it and
	 * nothing else does: `display` keeps the placeholder, which is what reaches the rendered
	 * tool card, `tool_execution_start`, the telemetry span and the session file. A renderer
	 * cannot leak a value it was never handed. Returns `display` itself when nothing expands.
	 */
	deobfuscateForExecution(
		requestRuntime: SecretRuntimeLease,
		display: Record<string, unknown>,
		toolName: string,
		sessionId: string | undefined,
	): Record<string, unknown> {
		const requestObfuscator = requestRuntime.expansionObfuscator;
		if (requestObfuscator === undefined && requestRuntime.redactionObfuscator) {
			mapJsonStrings(display as JsonWithOptionalFields, text => {
				requestRuntime.redactionObfuscator?.assertNoRetiredPlaceholder(text);
				return text;
			});
		}
		// Before the `hasSecrets()` check on purpose: when the unreadable scope was the only
		// source of secrets there is nothing in the obfuscator and that check is false, which
		// is exactly the case this has to catch.
		this.#assertNoOrphanPlaceholderWhileVaultUnreadable(requestRuntime, display);
		if (!requestObfuscator?.hasSecrets()) return display;

		// Freshness is a question about THIS payload, not about the session. The revision
		// compare is the cheap half, so it runs first; only when it fails is walking the
		// arguments worth its cost. A payload that carries no placeholder this runtime would
		// substitute expands to itself, so a moved revision cannot make it wrong and must not
		// cost it a refusal. That is the whole reason a placeholder-free `bash` call used to be
		// rejected out of a session holding any secret.
		let expansionLease = requestRuntime;
		let expansionObfuscator = requestObfuscator;
		if (!requestRuntime.isFreshForExpansion() && toolArgumentsCarryLivePlaceholder(requestObfuscator, display)) {
			const fresh = this.#freshExpansionAuthority(requestRuntime);
			if (fresh === undefined) {
				// Schedules the reload the retry will expand against, then refuses this one call
				// rather than spending a value the vault may already have replaced. The agent loop
				// turns this into a failed tool result, never an unwound session.
				requestRuntime.assertFreshForExpansion();
			} else {
				expansionLease = fresh;
				expansionObfuscator = fresh.expansionObfuscator ?? requestObfuscator;
			}
		}
		const knows = (placeholder: string): boolean => expansionObfuscator.knowsPlaceholder(placeholder);
		// The audit log travels with whichever lease supplied the expansion authority, because
		// both were built by the same load: a log that named a placeholder the other snapshot
		// resolved would describe an event that never happened.
		const requestAuditLog = this.#auditLogByLease.get(expansionLease);
		if (requestAuditLog !== undefined) {
			const record = buildExpansionRecord({
				args: display,
				tool: toolName,
				session: sessionId,
				at: Date.now(),
				known: knows,
				obfuscate: value => requestRuntime.obfuscateText(value),
			});
			if (record !== null) requestAuditLog.record(record);
		}
		// The operator-visible half of the same fact, on the session's notice event so the
		// transcript carries it in EVERY approval mode. The audit log is a file read afterwards
		// and the secret-use boundary is skipped under yolo / the `/yolo` bypass, which is the
		// configuration most likely to be running unattended: this is the only thing that says
		// a credential left the vault while it happens. Read BEFORE expansion, because after it
		// there is no placeholder left to name, and never conditioned on `secrets.auditLog` —
		// recording a spend and showing one are separate obligations.
		const spend = secretSpendMarker(display, toolName, knows);
		if (spend !== undefined) this.#session?.emitNotice("info", spend, SECRET_SPEND_NOTICE_SOURCE);
		return deobfuscateToolArguments(expansionObfuscator, display);
	}

	#createLease(source: LeaseSource): SecretRuntimeLease {
		const { revision, expansionObfuscator, redactor, vault, vaultRevision } = source;
		const normalizedCwd = path.resolve(source.cwd);
		/**
		 * Nothing this lease could get wrong about `text`.
		 *
		 * A moved vault revision is a cache miss, not a security event, and it is only a miss
		 * at all for text carrying a placeholder this snapshot would substitute. `deobfuscate`
		 * leaves every other string byte-identical, so a payload without a live placeholder is
		 * safe whatever the vault did on disk. The payload check runs BEFORE the revision
		 * compare because `revision()` costs a stat per vault path and almost every payload
		 * expands to itself.
		 */
		const settledForExpansion = (text: string | undefined): boolean => {
			if (!vault || vaultRevision === undefined) return true;
			if (text !== undefined && expansionObfuscator?.containsLivePlaceholder(text) !== true) return true;
			return vault.revision() === vaultRevision;
		};
		const lease: SecretRuntimeLease = Object.freeze({
			revision,
			cwd: normalizedCwd,
			expansionObfuscator,
			redactionObfuscator: redactor,
			hasRedactions: redactor?.hasSecrets() ?? false,
			obfuscateText: (text: string) => redactor?.obfuscate(text) ?? text,
			obfuscateMessages: (messages: Message[]) => (redactor ? obfuscateMessages(redactor, messages) : messages),
			obfuscateContext: (context: Context) => (redactor ? obfuscateProviderContext(redactor, context) : context),
			obfuscatePayload: (payload: unknown) => obfuscateProviderPayload(payload, redactor),
			isFreshForExpansion: (text?: string) => settledForExpansion(text),
			ensureFreshForExpansion: (text?: string) =>
				this.#ensureFreshForExpansion(normalizedCwd, text, settledForExpansion),
			assertFreshForExpansion: (text?: string) => {
				if (settledForExpansion(text)) return;
				this.#scheduleStaleRefresh(normalizedCwd);
				throw new Error(
					path.resolve(this.#options.getCwd()) === normalizedCwd
						? "Secret expansion was refused because the vault on disk no longer matches the snapshot this request is pinned to, so a placeholder could resolve to a value the vault has already replaced. A reload is under way; retry this call, and check what is stored with /secret list if it keeps failing."
						: `Secret expansion was refused because the vault changed under a lease pinned to ${normalizedCwd}, a directory the session has already left; the destination's own reload is the authority. Retry once the directory change has finished.`,
				);
			},
		});
		this.#auditLogByLease.set(lease, source.auditLog);
		if (vault) this.#vaultByLease.set(lease, vault);
		return lease;
	}

	async #ensureFreshForExpansion(
		normalizedCwd: string,
		text: string | undefined,
		settledForExpansion: (text: string | undefined) => boolean,
	): Promise<void> {
		if (settledForExpansion(text)) return;
		if (path.resolve(this.#options.getCwd()) !== normalizedCwd) {
			// Pinned to a directory the session has left. Scheduling a reload here would
			// supersede the destination refresh, so wait for whatever is already in flight and
			// re-ask instead.
			await this.#pending?.work.catch(() => undefined);
			if (settledForExpansion(text)) return;
			throw new Error(
				`Secret expansion was refused because the vault changed under a lease pinned to ${normalizedCwd}, a directory the session has already left, so that project's vault cannot be reloaded for it. Retry once the directory change has finished.`,
			);
		}
		let refreshed: SecretRuntimeLease | undefined;
		let reloadError: unknown;
		try {
			refreshed = await this.refresh(normalizedCwd);
		} catch (error) {
			reloadError = error;
		}
		// Exactly one attempt. A reload that keeps losing to a revision that will not settle
		// must surface as one actionable refusal rather than spin the loader.
		if (refreshed?.isFreshForExpansion(text) === true) return;
		if (settledForExpansion(text)) return;
		const detail = reloadError === undefined ? "" : ` Reload failed: ${errorMessage(reloadError)}.`;
		throw new Error(
			`Secret expansion was refused: reloading the secret vault for ${normalizedCwd} did not produce a runtime that can resolve this text's placeholders, so no current value is available.${detail} Check what is stored with /secret list, then retry.`,
		);
	}
}
