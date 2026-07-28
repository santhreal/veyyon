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
	const request = parseSecretCommand(args);
	if (request.subcommand === "add" && request.value !== undefined && port.promptForValue === undefined) {
		throw new Error(
			`This non-interactive client refuses inline credentials because they would be retained in command history. ` +
				`Use /secret add ${request.name ?? "<name>"} --from-env MY_TOKEN instead.`,
		);
	}
	const locations = locationsFor(port);
	const vault = new SecretVault(locations);
	const auditLog = port.settings.get("secrets.auditLog")
		? new SecretAuditLog(secretAuditPath(locations), port.session.operatorNotices)
		: undefined;

	if (needsValuePrompt(request) && port.promptForValue !== undefined) {
		// NORMALISED BEFORE THE PROMPT, for two reasons. The prompt names the secret, and naming it
		// `github-token` when the model will see `#GITHUB_TOKEN#` teaches the wrong placeholder. And
		// `normaliseSecretName` throws on a name that cannot be used, so an unusable name is refused
		// BEFORE the operator pastes a credential rather than after: prompting first would take a
		// live credential, put it in memory, and then throw the request away.
		if (request.name !== undefined) request.name = normaliseSecretName(request.name);
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
		defaultTtl:
			(request.subcommand === "add" || request.subcommand === "extend") && request.ttl === undefined
				? resolveDefaultTtl(port.settings.get("secrets.defaultTtl"))
				: null,
		now: Date.now(),
		auditLog,
	});

	if (result.changed) await port.session.refreshSecrets();

	if (!port.session.secretsEnabled) {
		// Said after the action and authoritative refresh rather than inferred from a settings
		// snapshot: the session runtime is the boundary that determines whether provider traffic
		// is actually protected right now.
		return {
			message:
				`${result.message}\n\nSecret protection is OFF, so nothing is being obfuscated yet. ` +
				`Turn on "Hide Secrets" in /settings.`,
		};
	}

	// Refresh above reloads every source atomically; patching one vault entry here would leave the
	// rest of the live runtime stale and would not be able to create an obfuscator for a newly
	// enabled session.
	if (result.agentNotice !== undefined) tellTheAgent(port, result.agentNotice);
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

/** Prompt title for the masked field. States what is about to happen to what is typed. */
export function maskedPromptTitle(name: string | undefined): string {
	return name === undefined
		? "Paste the secret. It is hidden as you type and stored encrypted."
		: `Paste the value for ${name}. It is hidden as you type and stored encrypted.`;
}

export type { SecretCommandResult };
