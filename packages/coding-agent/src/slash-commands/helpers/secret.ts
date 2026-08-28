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

export interface SecretCommandPort {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	cwd: string;
	globalConfigRoot: string;
	agentDir: string;
	promptForValue?: () => Promise<string | undefined>;
	promptForName?: () => Promise<string | undefined>;
	copy?: (text: string) => Promise<void>;
}

export interface SecretCommandOutcome {
	message: string;
	cancelled?: true;
}

function locationsFor(port: SecretCommandPort): VaultLocations {
	return resolveVaultLocations({
		globalConfigRoot: port.globalConfigRoot,
		agentDir: port.agentDir,
		cwd: port.cwd,
	});
}

export async function runSecretCommandForSurface(args: string, port: SecretCommandPort): Promise<SecretCommandOutcome> {
	const surface = port.promptForValue === undefined ? "noninteractive" : "tui";
	const request = parseSecretCommand(args, surface);
	if (request.name !== undefined) request.name = normaliseSecretName(request.name);
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
	const defaultTtl = needsDefaultTtl ? resolveDefaultTtl(port.settings.get("secrets.defaultTtl")) : null;
	const locations = locationsFor(port);
	const vault = new SecretVault(locations);
	const auditLog = port.settings.get("secrets.auditLog")
		? new SecretAuditLog(secretAuditPath(locations), port.session.operatorNotices)
		: undefined;

	if (needsValuePrompt(request) && port.promptForValue !== undefined) {
		const typed = await port.promptForValue();
		if (typed === undefined) return { message: "Cancelled. Nothing was stored.", cancelled: true };
		if (typed.length === 0) return { message: "Nothing was typed, so nothing was stored.", cancelled: true };
		request.value = typed;
		request.maskedEntry = true;
	}

	if (
		request.subcommand === "add" &&
		request.name === undefined &&
		(request.value !== undefined || request.fromEnv !== undefined) &&
		port.promptForName !== undefined
	) {
		const typedName = await port.promptForName();
		if (typedName === undefined) return { message: "Cancelled. Nothing was stored.", cancelled: true };
		if (typedName.trim().length > 0) request.name = normaliseSecretName(typedName.trim());
	}

	const result = await runSecretCommand(request, {
		vault,
		readEnv: name => process.env[name],
		defaultTtl,
		now: Date.now(),
		auditLog,
		surface,
		masked: port.session.obfuscator?.maskedInventory(),
	});

	if (result.copyText !== undefined && port.copy !== undefined) {
		try {
			await port.copy(result.copyText);
			result.message = `Copied ${result.copyText} to the clipboard. ${result.message}`;
		} catch (error) {
			result.message = `${result.message}\nIt could not be put on the clipboard: ${errorMessage(error)}`;
		}
	}

	const enabledByThisCommand =
		result.changed &&
		SECRET_ENTRY_COMMANDS.includes(request.subcommand) &&
		port.settings.get("secrets.enabled") !== true;
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
			if (request.name !== undefined) {
				port.session.obfuscator?.forgetNamedSecret(normaliseSecretName(request.name));
			}
			throw new Error(
				`The vault was updated, but the running session could not refresh secret protection: ${errorMessage(error)}`,
				{ cause: error },
			);
		}
	}

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
		return {
			message:
				`${result.message}\n\nSecret protection is OFF, so nothing is being obfuscated yet. ` +
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

export function namePromptTitle(): string {
	return "Name it, or press enter to skip.";
}

export function namePromptHint(): string {
	return "optional, the model spends it as #NAME#";
}

export function maskedPromptTitle(): string {
	return "Paste the secret value here. You can name it afterwards.";
}

export function maskedPromptHint(): string {
	return "the value, not a name · hidden as you type, stored encrypted";
}

export type { SecretCommandResult };

export type SecretPortHost = Pick<InteractiveModeContext, "session" | "sessionManager" | "settings" | "showHookInput">;

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
		promptForName: () => ctx.showHookInput(namePromptTitle(), undefined, { hint: namePromptHint() }),
		copy: copyToClipboard,
	};
}
