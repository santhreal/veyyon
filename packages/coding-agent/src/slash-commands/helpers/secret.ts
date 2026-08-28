/** The `/secret` adapter: one implementation, two surfaces. Every rule lives in `secrets/secret-command.ts`, which is pure and tested without a session. */
import { DEFAULT_MASK_CHAR } from "@veyyon/tui";
import { errorMessage, getAgentDir, getGlobalConfigRootDir, logger } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import type { InteractiveModeContext } from "../../modes/types";
import { SecretAuditLog, secretAuditPath } from "../../secrets/audit";
import {
	needsValuePrompt,
	parseSecretCommand,
	resolveDefaultTtl,
	runSecretCommand,
	SECRET_ENTRY_COMMANDS,
	type SecretCommandResult,
} from "../../secrets/secret-command";
import { normaliseSecretName, resolveVaultLocations, SecretVault, type VaultLocations } from "../../secrets/vault";
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import { copyToClipboard } from "../../utils/clipboard";

/** What `/secret` needs from whichever surface invoked it. */
export interface SecretCommandPort {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;
	/** Cross-profile config root and the active profile's directory, already resolved. */
	globalConfigRoot: string;
	agentDir: string;
	/** Ask the operator for a credential without echoing it, or absent when the surface has no way to hide what is typed. */
	promptForValue?: () => Promise<string | undefined>;
	/** Ask the operator what to call the secret, AFTER the value has been supplied. Optional input: empty means "generate one for me". */
	promptForName?: () => Promise<string | undefined>;
	/** Put text on the clipboard, or absent when the surface has none. Used by `copy`, and it never carries a value: the command layer sets `copyText` to a */
	copy?: (text: string) => Promise<void>;
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

/** Run `/secret`, prompting for a value when the surface can do so safely. Throws on anything unparseable, which the caller renders as usage. Every other outcome is a */
export async function runSecretCommandForSurface(args: string, port: SecretCommandPort): Promise<SecretCommandOutcome> {
	const surface = port.promptForValue === undefined ? "noninteractive" : "tui";
	const request = parseSecretCommand(args, surface);
	if (request.name !== undefined) request.name = normaliseSecretName(request.name);
	// A GUARD, NOT GRAMMAR. `parseSecretCommand` refuses an inline credential on this surface before it can reach here, for both verbs that carry one: `add` takes no words at all on a client, and
	if (
		(request.subcommand === "add" || request.subcommand === "value") &&
		request.value !== undefined &&
		port.promptForValue === undefined
	) {
		throw new Error(
			`This client refuses an inline credential, because the line carrying it is retained in the client's ` +
				`own request history. Nothing was stored. Read the value out of the environment instead: ` +
				`/secret from-env MY_TOKEN ${request.name ?? "<name>"}.`,
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
		// The masked field is the whole of `/secret add` with nothing after it: there is no name yet
		// and nothing else to ask first. Its title has to carry the distinction on its own, which is
		// why `maskedPromptTitle` says "value, not a name" rather than anything shorter.
		const typed = await port.promptForValue();
		if (typed === undefined) return { message: "Cancelled. Nothing was stored.", cancelled: true };
		if (typed.length === 0) return { message: "Nothing was typed, so nothing was stored.", cancelled: true };
		request.value = typed;
		// Recorded so the confirmation does not warn about a scrollback exposure that did not
		// happen. A masked prompt is the one path where the value was never on screen.
		request.maskedEntry = true;
	}

	// THE NAME IS ASKED LAST, AND ONLY EVER LAST. The credential is the thing the operator came to store, so nothing may stand between them and storing it; a label is an afterthought, and one
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
		// Empty keeps the generated name: the field is optional, and someone who just wants to stash a credential should not be forced to invent a label for it. `normaliseSecretName`
		if (typedName.trim().length > 0) request.name = normaliseSecretName(typedName.trim());
	}

	const result = await runSecretCommand(request, {
		vault,
		readEnv: name => process.env[name],
		defaultTtl,
		now: Date.now(),
		auditLog,
		surface,
		// THE FOOTER'S OWN COUNTER. The composer chip reads `liveSecrets()` off this same obfuscator,
		// so `list` reading `maskedInventory()` off it is what makes the two agree; a second count
		// derived anywhere else is the defect being fixed, not a fix.
		masked: port.session.obfuscator?.maskedInventory(),
	});

	// THE CLIPBOARD BELONGS TO THE SURFACE. The command layer decides what is worth copying and never touches a clipboard itself, which is what keeps it testable without one and incapable of
	if (result.copyText !== undefined && port.copy !== undefined) {
		try {
			await port.copy(result.copyText);
			result.message = `Copied ${result.copyText} to the clipboard. ${result.message}`;
		} catch (error) {
			result.message = `${result.message}\nIt could not be put on the clipboard: ${errorMessage(error)}`;
		}
	}

	// STORING A CREDENTIAL IS THE OPT-IN. `secrets.enabled` ships off, so before this every first `/secret add` stored a value, said "the model sees #NAME#", and then did nothing:
	const enabledByThisCommand =
		result.changed &&
		SECRET_ENTRY_COMMANDS.includes(request.subcommand) &&
		port.settings.get("secrets.enabled") !== true;
	/** and nothing on this path called `flush`, so any short-lived surface exited before the timer fired: a `-p` run, an ACP request, any non-interactive client. The credential was durable */
	let enableSaveFailure: string | undefined;
	if (enabledByThisCommand) {
		port.settings.set("secrets.enabled", true);
		try {
			await port.settings.flush();
		} catch (error) {
			enableSaveFailure = errorMessage(error);
			logger.warn("secrets: could not persist secrets.enabled after storing a credential", {
				command: request.subcommand,
				error: enableSaveFailure,
			});
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

	// Delivered BEFORE the protection-off return below, because a revocation must not depend on protection being on. The early return used to swallow every notice, and the one state it
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
		// Said after the action and authoritative refresh rather than inferred from a settings snapshot: the session runtime is the boundary that determines whether provider traffic
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

/** Put the notice in front of the model, in both the live conversation and the saved session. Both, because either alone is a bug: only the live agent means a resumed session has a */
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

/** Prompt title for the VISIBLE name field, shown after the value is already in hand. ONE LINE, AND IT NAMES THE WAY OUT. The operator has just handed over a credential and the work */
export function namePromptTitle(): string {
	return "Name it, or press enter to skip.";
}

/** What the name field IS, as opposed to what to do with it: how the name gets spent later. */
export function namePromptHint(): string {
	return "optional, the model spends it as #NAME#";
}

/** Prompt title for the masked field: the imperative, and the promise that the name comes later. TWO SENTENCES, BECAUSE IT IS THE FIRST THING `/secret add` DOES. The field is what a valueless */
export function maskedPromptTitle(): string {
	return "Paste the secret value here. You can name it afterwards.";
}

/** What the masked field IS: the correction, and the two promises that make pasting a live credential safe. */
export function maskedPromptHint(): string {
	return "the value, not a name · hidden as you type, stored encrypted";
}

export type { SecretCommandResult };

/** What a surface must offer before it can host the interactive `/secret`: a session, its manager, settings, and one question-asking primitive. Stated as the four members rather than the whole */
export type SecretPortHost = Pick<InteractiveModeContext, "session" | "sessionManager" | "settings" | "showHookInput">;

/** The port for a terminal session: the ONE description of what the interactive `/secret` can do. Two callers need it, `/secret` itself and the footline's secrets chip, and a second copy would be */
export function interactiveSecretPort(ctx: SecretPortHost): SecretCommandPort {
	return {
		session: ctx.session,
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
		cwd: ctx.sessionManager.getCwd(),
		globalConfigRoot: getGlobalConfigRootDir(),
		agentDir: getAgentDir(),
		promptForValue: () =>
			ctx.showHookInput(maskedPromptTitle(), undefined, { mask: DEFAULT_MASK_CHAR, hint: maskedPromptHint() }),
		// Deliberately unmasked: a name is not a credential, and the operator seeing this field echo
		// after the hidden one is what distinguishes the two questions.
		promptForName: () => ctx.showHookInput(namePromptTitle(), undefined, { hint: namePromptHint() }),
		copy: copyToClipboard,
	};
}
