/**
 * The `/secret` adapter: one implementation, two surfaces.
 *
 * Every rule lives in `secrets/secret-command.ts`, which is pure and tested without a session.
 * This file is the part that needs a session: it builds the vault from the resolved paths,
 * reconciles the RUNNING obfuscator after a change, and puts the agent notice in front of the
 * model. It exists as a helper rather than inline in the builtin registry because the TUI path
 * and the text/ACP path must not drift: the only difference between them is that the TUI can ask
 * for a credential without showing it, and that difference is one injected function
 * ({@link SecretCommandPort.promptForValue}) rather than a second copy of the logic.
 */
import { errorMessage, logger } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import { SecretAuditLog, secretAuditPath } from "../../secrets/audit";
import {
	needsValuePrompt,
	parseSecretCommand,
	resolveDefaultTtl,
	runSecretCommand,
	type SecretCommandResult,
} from "../../secrets/secret-command";
import { normaliseSecretName, resolveVaultLocations, SecretVault, type VaultLocations } from "../../secrets/vault";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";

/** What `/secret` needs from whichever surface invoked it. */
export interface SecretCommandPort {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;
	/** Cross-profile config root and the active profile's directory, already resolved. */
	globalConfigRoot: string;
	agentDir: string;
	/**
	 * Ask the operator for a credential without echoing it, or absent when the surface has no way
	 * to hide what is typed.
	 *
	 * A surface that cannot mask must NOT substitute an unmasked prompt: that would put the value
	 * in the scrollback while looking like the safe path. Absent means "tell them to use
	 * `--from-env`", which is what {@link runSecretCommand} does.
	 *
	 * Takes no name, because there is never one to take: the field is what a bare `/secret` opens,
	 * and the name is asked after the value is in hand.
	 */
	promptForValue?: () => Promise<string | undefined>;
	/**
	 * Ask the operator what to call the secret, AFTER the value has been supplied. Optional input:
	 * empty means "generate one for me".
	 *
	 * THIS FIELD IS NOT MASKED, and that is the point. A name is not a credential, so echoing it
	 * is safe, and the visible difference between this field and the hidden one that may precede
	 * it is what tells the operator which question they are answering. A single masked prompt had
	 * to carry that distinction in its wording alone, and wording lost: "Paste the secret" was
	 * read as "name the secret", and the name was stored as the credential.
	 */
	promptForName?: () => Promise<string | undefined>;
}

/** Result of running the command, for the surface to render. */
export interface SecretCommandOutcome {
	/** Text for the operator. Never contains a credential. */
	message: string;
	/** True when the operator cancelled a prompt, so the surface can stay quiet about it. */
	cancelled?: true;
	/**
	 * True when the operator asked for the manager, which the surface opens itself.
	 *
	 * Returned rather than thrown, and decided HERE rather than by the caller re-reading the
	 * argument line, so `manager` is reserved in exactly one place. A caller that checked the text
	 * itself would be a second parser, and the two would disagree the first time either changed.
	 */
	openManager?: true;
}

/** Vault locations for a port, in ONE place so every path below reads the same files. */
function locationsFor(port: SecretCommandPort): VaultLocations {
	return resolveVaultLocations({
		globalConfigRoot: port.globalConfigRoot,
		agentDir: port.agentDir,
		cwd: port.cwd,
	});
}

/**
 * Run `/secret`, prompting for a value when the surface can do so safely.
 *
 * Throws on anything unparseable, which the caller renders as usage. Every other outcome is a
 * message.
 */
export async function runSecretCommandForSurface(args: string, port: SecretCommandPort): Promise<SecretCommandOutcome> {
	const surface = port.promptForValue === undefined ? "noninteractive" : "tui";
	const request = parseSecretCommand(args, surface);
	// Before the vault is touched at all: the manager reads it for itself, and opening a file here
	// only to hand the screen a second reader would be work whose only effect is a race.
	if (request.subcommand === "manager") return { message: "", openManager: true };
	if (request.name !== undefined) request.name = normaliseSecretName(request.name);
	if (request.subcommand === "add" && request.value !== undefined && port.promptForValue === undefined) {
		throw new Error(
			`This non-interactive client refuses inline credentials because they would be retained in command history. ` +
				`Use /secret add ${request.name ?? "<name>"} --from-env MY_TOKEN instead.`,
		);
	}
	const needsDefaultTtl =
		request.ttl === undefined &&
		(request.subcommand === "add" || (request.subcommand === "extend" && request.name !== undefined));
	// Validate settings before a masked field accepts sensitive bytes. Otherwise a malformed
	// default asks the operator for a credential and only then announces it cannot store it.
	const defaultTtl = needsDefaultTtl ? resolveDefaultTtl(port.settings.get("secrets.defaultTtl")) : null;
	const locations = locationsFor(port);
	const vault = new SecretVault(locations);
	const auditLog = port.settings.get("secrets.auditLog")
		? new SecretAuditLog(secretAuditPath(locations), port.session.operatorNotices)
		: undefined;

	if (needsValuePrompt(request) && port.promptForValue !== undefined) {
		// The masked field is the whole of a bare `/secret`: there is no name yet and nothing else
		// to ask first. Its title has to carry the distinction on its own, which is why
		// `maskedPromptTitle` says "value, not a name" rather than anything shorter.
		const typed = await port.promptForValue();
		if (typed === undefined) return { message: "Cancelled. Nothing was stored.", cancelled: true };
		if (typed.length === 0) return { message: "Nothing was typed, so nothing was stored.", cancelled: true };
		request.value = typed;
		// Recorded so the confirmation does not warn about a scrollback exposure that did not
		// happen. A masked prompt is the one path where the value was never on screen.
		request.maskedEntry = true;
	}

	// THE NAME IS ASKED LAST, AND ONLY EVER LAST. The credential is the thing the operator came to
	// store, so nothing may stand between them and storing it; a label is an afterthought, and one
	// is generated when they decline. Asking first also put the two questions in the order that
	// caused the original bug: the name field came up before anything explained a credential was
	// wanted, and `/secret add ghp_realToken` read as an answer to it.
	//
	// It runs for a pasted value and a masked one alike, because both arrive without a name.
	if (
		request.subcommand === "add" &&
		request.name === undefined &&
		(request.value !== undefined || request.fromEnv !== undefined) &&
		port.promptForName !== undefined
	) {
		const typedName = await port.promptForName();
		// Cancelling here abandons the whole store rather than falling back to a generated name.
		// The operator has an unstored credential on screen and pressed escape; quietly keeping it
		// under a name they never saw is the one reading they did not ask for.
		if (typedName === undefined) return { message: "Cancelled. Nothing was stored.", cancelled: true };
		// Empty keeps the generated name: the field is optional, and someone who just wants to
		// stash a credential should not be forced to invent a label for it. `normaliseSecretName`
		// throws on an unusable one, and the value is already in hand, so the operator is told what
		// is wrong with the name and no credential has been written under a wrong one.
		if (typedName.trim().length > 0) request.name = normaliseSecretName(typedName.trim());
	}

	const result = await runSecretCommand(request, {
		vault,
		readEnv: name => process.env[name],
		defaultTtl,
		now: Date.now(),
		auditLog,
		surface,
	});

	// STORING A CREDENTIAL IS THE OPT-IN. `secrets.enabled` ships off, so before this every
	// first `/secret add` stored a value, said "the model sees #NAME#", and then did nothing:
	// the placeholder was never substituted and the value was never hidden, until the operator
	// went to find a checkbox in another menu. Asking someone to confirm the thing they just
	// asked for is not a safety property, it is a dead end at the exact moment the feature is
	// supposed to start working. Turning it on is also the safe direction, since the only thing
	// it can do is hide more. It is announced in the confirmation rather than done quietly,
	// because it changes what happens to environment variables and `secrets.yml` too, and a
	// setting that changes itself without saying so is its own bug.
	const enabledByThisCommand =
		result.changed && request.subcommand === "add" && port.settings.get("secrets.enabled") !== true;
	/**
	 * WHY THIS FLUSHES RATHER THAN TRUSTING `set`. `Settings.set` only QUEUES a debounced write,
	 * and nothing on this path called `flush`, so any short-lived surface exited before the timer
	 * fired: a `-p` run, an ACP request, any non-interactive client. The credential was durable
	 * and the setting was not, so the next launch came up with protection OFF and a secret already
	 * in the vault, which is the one state this feature exists to prevent. The confirmation below
	 * promises the operator it was "saved for the next one", so this is the line that has to make
	 * that true. A write it cannot complete is reported instead of hidden, because a confirmation
	 * that overstates what was saved is worse than one that admits the gap.
	 */
	let enableSaveFailure: string | undefined;
	if (enabledByThisCommand) {
		port.settings.set("secrets.enabled", true);
		try {
			await port.settings.flush();
		} catch (error) {
			enableSaveFailure = errorMessage(error);
			logger.warn("secrets: could not persist secrets.enabled after /secret add", { error: enableSaveFailure });
		}
	}

	if (result.changed) {
		try {
			await port.session.refreshSecrets();
		} catch (error) {
			// The vault write is already durable. Until a later successful reload,
			// revoke the affected readable placeholder from the old runtime so a
			// failed remove/rotation/extension cannot keep spending stale bytes.
			if (request.name !== undefined) {
				port.session.obfuscator?.forgetNamedSecret(normaliseSecretName(request.name));
			}
			throw new Error(
				`The vault was updated, but the running session could not refresh secret protection: ${errorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	// Delivered BEFORE the protection-off return below, because a revocation must not depend on
	// protection being on. The early return used to swallow every notice, and the one state it
	// swallowed them in is the state a revocation matters most: with no obfuscator, nothing is
	// substituted, so a model still carrying "use #NAME#" writes that literal text straight into a
	// command. A notice that OFFERS a placeholder is withheld there instead, because it would be
	// advertising an expansion the runtime cannot perform.
	//
	// The refresh above reloads every source atomically; patching one vault entry here would leave
	// the rest of the live runtime stale and could not create an obfuscator for a newly enabled
	// session.
	const notice =
		port.session.secretsEnabled || result.agentNoticeIsRevocation === true ? result.agentNotice : undefined;
	if (notice !== undefined) {
		try {
			tellTheAgent(port, notice);
		} catch (error) {
			throw new Error(
				`The vault was updated and secret protection refreshed, but the model notice could not be saved: ${errorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	if (!port.session.secretsEnabled) {
		// Said after the action and authoritative refresh rather than inferred from a settings
		// snapshot: the session runtime is the boundary that determines whether provider traffic
		// is actually protected right now. Reaching this after the block above turned the setting
		// on means the runtime refused it, which the operator has to hear about.
		return {
			message:
				`${result.message}\n\nSecret protection is OFF, so nothing is being obfuscated yet. ` +
				// `/secret` is a text-mode command, so this reaches ACP, where `/settings` is neither
				// advertised nor dispatchable. The config-set spelling is what makes the sentence
				// actionable on a surface with no settings screen.
				`Turn on "Hide Secrets" in /settings, or run: veyyon config set secrets.enabled true.`,
		};
	}

	if (enabledByThisCommand) {
		return {
			message:
				enableSaveFailure === undefined
					? `${result.message}\nSecret protection was off, so it is now on for this session and saved for the next one.`
					: `${result.message}\nSecret protection was off, so it is now on for this session, but it could not be ` +
						`saved for the next one: ${enableSaveFailure}. Turn on "Hide Secrets" in /settings, or run: ` +
						`veyyon config set secrets.enabled true, so it survives a restart.`,
		};
	}

	return { message: result.message };
}

/**
 * Put the notice in front of the model, in both the live conversation and the saved session.
 *
 * Both, because either alone is a bug: only the live agent means a resumed session has a
 * placeholder it was never introduced to, and only the session file means the agent does not
 * learn about the secret until the next restart.
 */
function tellTheAgent(port: SecretCommandPort, text: string): void {
	const message = {
		role: "developer" as const,
		content: [{ type: "text" as const, text }],
		attribution: "user" as const,
		timestamp: Date.now(),
	};
	port.session.agent.appendMessage(message);
	port.sessionManager.appendMessage(message);
}

/**
 * Prompt title for the VISIBLE name field, shown after the value is already in hand.
 *
 * Says the field is optional, because otherwise an operator who has just handed over a credential
 * believes they are now required to invent a label for it and stalls on the one step that has a
 * correct answer waiting.
 */
export function namePromptTitle(): string {
	return "Name this secret, or press enter to have one generated.";
}

/** What the name field IS, as opposed to what to do with it: how the name gets spent later. */
export function namePromptHint(): string {
	return "optional, the model spends it as #NAME#";
}

/**
 * Prompt title for the masked field. The imperative and nothing else.
 *
 * IT SAYS "VALUE" AND SAYS "NOT A NAME" because the field is masked: the operator cannot see what
 * they typed, so a title they can misread is the last thing standing between them and storing the
 * wrong string. "Paste the secret" was read as "name the secret", and the name was then stored as
 * the credential under an invented `SECRET_1`. Nothing downstream can catch that: a name is a
 * perfectly well-formed secret value, and a shape heuristic would refuse real credentials
 * (`AKIAIOSFODNN7EXAMPLE` is a valid AWS key id and looks exactly like a name).
 *
 * WHAT MOVED OUT, and why the correction survived it. This used to carry four clauses in one
 * accent colour: the imperative, the correction, the promise of a later name, and the assurance
 * that typing is hidden and storage encrypted. Every clause was true and every clause was equally
 * weighted, so the sentence read as a paragraph and the operator reported it did not tell them
 * what to do. The two clauses that describe what the FIELD IS, rather than what to DO, are now
 * {@link maskedPromptHint} on the legend row. The correction stays here, in the imperative, since
 * it is the one clause that exists to stop a specific unrecoverable mistake.
 *
 * It takes no name and has no second form. The field is only ever reached by a bare `/secret`,
 * before any name exists, so a "value for X" variant would be dead text that only looked reachable.
 */
export function maskedPromptTitle(): string {
	return "Paste the secret value, not a name. You can name it afterwards.";
}

/** What the masked field IS: the two mechanical promises that make pasting a live credential safe. */
export function maskedPromptHint(): string {
	return "hidden as you type, stored encrypted";
}

export type { SecretCommandResult };
