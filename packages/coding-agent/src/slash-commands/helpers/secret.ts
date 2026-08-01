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
	 */
	promptForValue?: (name: string | undefined) => Promise<string | undefined>;
	/**
	 * Ask the operator what to call the secret, before the masked field opens. Optional input:
	 * empty means "generate one for me".
	 *
	 * THIS FIELD IS NOT MASKED, and that is the point. A name is not a credential, so echoing it
	 * is safe, and the visible difference between this field and the hidden one that follows is
	 * what tells the operator which question they are answering. A single masked prompt had to
	 * carry that distinction in its wording alone, and wording lost: "Paste the secret" was read
	 * as "name the secret", and the name was stored as the credential.
	 */
	promptForName?: () => Promise<string | undefined>;
}

/** Result of running the command, for the surface to render. */
export interface SecretCommandOutcome {
	/** Text for the operator. Never contains a credential. */
	message: string;
	/** True when the operator cancelled a prompt, so the surface can stay quiet about it. */
	cancelled?: true;
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
		// THE NAME IS ASKED FIRST, in its own visible field, when the command did not carry one.
		// One prompt cannot ask two questions: the single masked field had to mean "value" by
		// wording alone, and an operator who read it as "name" stored the name as the credential
		// with nothing on screen to contradict them. Splitting the questions makes the mistake
		// unavailable rather than merely discouraged, and the unmasked field is self-evidently not
		// the one that wants a credential.
		if (request.subcommand === "add" && request.name === undefined && port.promptForName !== undefined) {
			const typedName = await port.promptForName();
			if (typedName === undefined) return { message: "Cancelled. Nothing was stored.", cancelled: true };
			// Empty keeps the generated name: the field is optional, and someone who just wants to
			// stash a credential should not be forced to invent a label for it.
			// `normaliseSecretName` throws on an unusable one, which still happens BEFORE the masked
			// field opens, so a bad name never costs the operator a live credential.
			if (typedName.trim().length > 0) request.name = normaliseSecretName(typedName.trim());
		}
		// The name was normalised before settings validation and before the prompt: the title must
		// teach the placeholder the model will actually see, and every unusable input must fail
		// before the operator pastes a live credential.
		const typed = await port.promptForValue(request.name);
		if (typed === undefined) return { message: "Cancelled. Nothing was stored.", cancelled: true };
		if (typed.length === 0) return { message: "Nothing was typed, so nothing was stored.", cancelled: true };
		request.value = typed;
		// Recorded so the confirmation does not warn about a scrollback exposure that did not
		// happen. A masked prompt is the one path where the value was never on screen.
		request.maskedEntry = true;
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
				`Turn on "Hide Secrets" in /settings.`,
		};
	}

	if (enabledByThisCommand) {
		return {
			message:
				enableSaveFailure === undefined
					? `${result.message}\nSecret protection was off, so it is now on for this session and saved for the next one.`
					: `${result.message}\nSecret protection was off, so it is now on for this session, but it could not be ` +
						`saved for the next one: ${enableSaveFailure}. Turn on "Hide Secrets" in /settings so it survives a restart.`,
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
 * Prompt title for the VISIBLE name field, shown before the masked one.
 *
 * Says the field is optional and says what happens if you leave it empty, so nobody has to invent
 * a label to store a credential. It names the placeholder form too, because the name chosen here
 * is the token the model will write.
 */
export function namePromptTitle(): string {
	return "Name this secret (optional). The model spends it by writing #NAME#. Leave empty to have one generated.";
}

/**
 * Prompt title for the masked field. States what is about to happen to what is typed.
 *
 * BOTH FORMS SAY "VALUE" because the field is masked: the operator cannot see what they typed, so
 * a title they can misread is the last thing standing between them and storing the wrong string.
 * "Paste the secret" was read as "name the secret", and `/secret add` with no name then stored the
 * NAME as the credential under an invented `SECRET_1`. Nothing downstream can catch that: a name
 * is a perfectly well-formed secret value, and a shape heuristic would refuse real credentials
 * (`AKIAIOSFODNN7EXAMPLE` is a valid AWS key id and looks exactly like a name).
 *
 * The structural fix is the separate visible name field that now runs first; this wording is the
 * second line of defence for surfaces that only implement the masked prompt.
 */
export function maskedPromptTitle(name: string | undefined): string {
	return name === undefined
		? "Paste the secret value, not a name. A name is generated for you. It is hidden as you type and stored encrypted."
		: `Paste the value for ${name}. It is hidden as you type and stored encrypted.`;
}

export type { SecretCommandResult };
