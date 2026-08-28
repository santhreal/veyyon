import { Ellipsis, padding, sanitizeSingleLine, truncateToWidth, visibleWidth } from "@veyyon/tui/utils";
import { errorMessage, formatCount } from "@veyyon/utils";
import type { SecretAuditLog, SecretExpansionRecord } from "./audit";
import type { MaskedInventory } from "./obfuscator";
import { MAX_SECRET_NAME_LENGTH } from "./placeholder";
import { planScopeMove } from "./scope-move";
import {
	DEFAULT_LOG_LIMIT,
	OUTPUT_INDENT,
	SCROLLBACK_WARNING,
	SECRET_SUBCOMMAND_SHAPES,
	type SecretCommandRequest,
	type SecretCommandResult,
	type SecretCommandSurface,
	type SecretSlot,
	type SecretSubcommand,
	secretCommandUsage,
	USAGE_ADD_FROM_ENV,
	USAGE_TUI_FROM_ENV,
	USAGE_TUI_INLINE,
	USAGE_TUI_MASKED,
} from "./secret-command-helpers";
import {
	DEFAULT_TTL_MS,
	describeTimeLeft,
	formatTtl,
	isTtlWord,
	normaliseSecretName,
	parseTtl,
	type ScopedVaultEntry,
	type SecretVault,
	VAULT_SCOPES,
	type VaultScope,
	WARN_AT_FRACTIONS,
	warningThresholdCrossed,
} from "./vault";

export {
	DEFAULT_LOG_LIMIT,
	NONINTERACTIVE_SECRET_COMMAND_USAGE,
	needsValuePrompt,
	parseSecretCommand,
	SECRET_COMMAND_USAGE,
	SECRET_ENTRY_COMMANDS,
	SECRET_SUBCOMMAND_SHAPES,
	SECRET_TUI_SUBCOMMANDS,
	SECRET_VERB_SPELLINGS,
	type SecretCommandRequest,
	type SecretCommandResult,
	type SecretCommandSurface,
	type SecretSlot,
	type SecretSubcommand,
	secretCommandUsage,
} from "./secret-command-helpers";

export function matchTrailing(trailing: readonly SecretSlot[], word: string): SecretSlot | undefined {
	const lower = word.toLowerCase();
	if (trailing.includes("scope") && (lower === "profile" || lower === "project" || lower === "global")) {
		return "scope";
	}
	if (trailing.includes("limit") && /^[0-9]+$/.test(word)) return "limit";
	if (trailing.includes("ttl") && (isTtlWord(word) || /^[0-9]/.test(word))) return "ttl";
	if (trailing.includes("variable") && lower === "from-env") return "variable";
	if (trailing.includes("name")) return "name";
	return undefined;
}

export const EVERY_VAULT_WORDS: readonly string[] = ["everywhere", "all", "everything", "every"];

export function assignSlot(
	request: SecretCommandRequest,
	slot: SecretSlot,
	words: readonly string[],
	index: number,
	usageText: string,
): void {
	const word = words[index];
	switch (slot) {
		case "name":
			request.name = request.subcommand === "log" ? normaliseSecretName(word) : word;
			return;
		case "newName":
			request.newName = word;
			return;
		case "variable":
			request.fromEnv = word;
			return;
		case "scope": {
			const scope = word.toLowerCase();
			if (EVERY_VAULT_WORDS.includes(scope) && request.subcommand === "clear") {
				request.allScopes = true;
				return;
			}
			if (scope !== "profile" && scope !== "project" && scope !== "global") {
				throw new Error(
					`Which vault? Write profile, project or global${
						request.subcommand === "clear" ? ", or everywhere for all three" : ""
					}. The word you wrote is not repeated here, in case it is the credential.\n\n${usageText}`,
				);
			}
			request.scope = scope;
			return;
		}
		case "ttl":
			request.ttl = parseTtl(word);
			return;
		case "limit": {
			const limit = Number(word);
			if (!Number.isSafeInteger(limit) || limit <= 0) {
				throw new Error(`How many records? Write a positive whole number, such as /secret log 50.`);
			}
			request.limit = limit;
			return;
		}
	}
}

export function refuseMissingWords(
	subcommand: SecretSubcommand,
	shape: (typeof SECRET_SUBCOMMAND_SHAPES)[SecretSubcommand],
	required: number,
	got: number,
	usageText: string,
): Error {
	const missing = shape.slots.slice(got, required).map(slot => SLOT_WORDS[slot]);
	return new Error(
		`/secret ${subcommand} still needs ${joinWithAnd(missing)}. The words already on the line are not ` +
			`repeated here, in case one of them is the credential.\n\n${usageText}`,
	);
}

export function refuseRepeatedWord(
	subcommand: SecretSubcommand,
	slot: SecretSlot,
	surface: SecretCommandSurface,
	usageText: string,
): Error {
	return new Error(
		`/secret ${subcommand} reads ${SLOT_WORDS[slot]} once, and this line names one twice. Neither word is ` +
			`repeated here, in case one is the credential: write the line again with the one you meant.` +
			`${valueFormHint(surface)}\n\n${usageText}`,
	);
}

function valueFormHint(surface: SecretCommandSurface): string {
	return surface === "tui"
		? ` If the whole line is itself a credential that begins with a command word, store it with ` +
				`/secret add <value>.`
		: "";
}

const SLOT_WORDS: Record<SecretSlot, string> = {
	name: "a secret name",
	newName: "the new name",
	variable: "an environment variable name",
	scope: "a vault (profile, project or global)",
	ttl: "a lifetime such as 7d",
	limit: "a number of records",
};

export function refuseExtraWord(
	request: SecretCommandRequest,
	shape: (typeof SECRET_SUBCOMMAND_SHAPES)[SecretSubcommand],
	index: number,
	words: readonly string[],
	surface: SecretCommandSurface,
	usageText: string,
): Error {
	const readable = shape.trailing.map(slot => SLOT_WORDS[slot]);
	const counted = /^[0-9]+$/.test(words[index]) ? words[index] : undefined;
	const tail =
		readable.length > 0
			? ` After the required words /secret ${request.subcommand} reads ${joinWithAnd(readable)}, in any order, once each.`
			: ` /secret ${request.subcommand} reads no further words.`;
	const hint =
		counted !== undefined && request.subcommand !== "log" ? ` A bare number is only read by /secret log.` : "";
	const valueHint = valueFormHint(surface);
	const position = index === 0 ? "the first word after the command" : `the word in position ${index + 1}`;
	return new Error(
		`/secret ${request.subcommand} cannot read ${position}, and a word that would be ignored is refused ` +
			`rather than dropped silently. The word itself is not repeated here, in case it is the ` +
			`credential.${tail}${hint}${valueHint}\n\n${usageText}`,
	);
}

export function refuseMissingScope(request: SecretCommandRequest, usageText: string): void {
	if (!SECRET_SUBCOMMAND_SHAPES[request.subcommand].needsScope) return;
	if (request.scope !== undefined || request.allScopes === true) return;
	if (request.subcommand === "scope") {
		throw new Error(
			`/secret scope needs the vault to move the secret INTO, such as /secret scope MY_TOKEN global. ` +
				`There is no default: the vault it is already in is the one answer that cannot be meant.` +
				`\n\n${usageText}`,
		);
	}
	if (request.subcommand === "clear") {
		throw new Error(
			`/secret clear needs the vault to empty, such as /secret clear profile, or /secret clear ` +
				`everywhere for all three. There is no default for one vault: a credential you can reach is ` +
				`the narrowest copy of it, so a guessing /secret clear would empty whichever vault happens ` +
				`to be in front and leave the other two full.` +
				`\n\n${usageText}`,
		);
	}
	if (request.subcommand === "discard") {
		throw new Error(
			`/secret discard needs the vault whose file you want moved aside, such as ` +
				`/secret discard project. There is no default, because discarding a vault you did ` +
				`not mean would move a working file out from under this session.\n\n${usageText}`,
		);
	}
	throw new Error(
		`/secret ${request.subcommand} needs the vault to act on, such as ` +
			`/secret ${request.subcommand} profile. There is no default.\n\n${usageText}`,
	);
}

export function subcommandsWithSlot(slot: SecretSlot): SecretSubcommand[] {
	return (Object.keys(SECRET_SUBCOMMAND_SHAPES) as SecretSubcommand[]).filter(
		candidate =>
			SECRET_SUBCOMMAND_SHAPES[candidate].slots.includes(slot) ||
			SECRET_SUBCOMMAND_SHAPES[candidate].trailing.includes(slot),
	);
}

export function joinWithAnd(items: readonly string[]): string {
	return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export async function runSecretCommand(
	request: SecretCommandRequest,
	context: {
		vault: SecretVault;
		readEnv: (name: string) => string | undefined;
		defaultTtl: number | null;
		now: number;
		auditLog?: SecretAuditLog;
		surface?: SecretCommandSurface;
		masked?: MaskedInventory;
	},
): Promise<SecretCommandResult> {
	switch (request.subcommand) {
		case "help":
			return { message: secretCommandUsage(context.surface ?? "tui"), changed: false };
		case "add":
		case "from-env":
			return await addSecret(request, context);
		case "list":
			return await listSecrets(context);
		case "rm":
			return await removeSecret(request, context);
		case "clear":
			return await clearVaultScope(request, context);
		case "extend":
			return await extendSecret(request, context);
		case "log":
			return await showLog(request, context);
		case "discard":
			return await discardVaultScope(request, context);
		case "rename":
			return await renameSecret(request, context);
		case "value":
			return await replaceSecretValue(request, context);
		case "scope":
			return await moveSecretScope(request, context);
		case "copy":
			return await copyPlaceholder(request, context);
	}
}

async function discardVaultScope(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.scope === undefined) throw new Error("Which vault? /secret discard project");

	const { movedTo } = await context.vault.discardUnreadableScope(request.scope);
	return {
		message:
			`Moved the unreadable ${request.scope} vault to ${sanitizeSingleLine(movedTo)}, so that scope works ` +
			`again. The file still holds your sealed entries, so re-add the secrets it held rather than ` +
			`assuming they are gone.`,
		changed: true,
	};
}

async function addSecret(
	request: SecretCommandRequest,
	context: {
		vault: SecretVault;
		readEnv: (name: string) => string | undefined;
		defaultTtl: number | null;
		now: number;
		surface?: SecretCommandSurface;
	},
): Promise<SecretCommandResult> {
	if (request.fromEnv !== undefined && request.value !== undefined) {
		throw new Error("Give either an environment variable or a value, not both.");
	}

	let value: string;
	let typedOnScreen: boolean;
	if (request.fromEnv !== undefined) {
		value = readEnvCredential(request.fromEnv, context.readEnv);
		typedOnScreen = false;
	} else if (request.value !== undefined) {
		value = request.value;
		typedOnScreen = request.maskedEntry !== true;
	} else {
		if (context.surface === "noninteractive") {
			throw new Error(
				`No value given, and this client cannot prompt for one without showing it. ` +
					`Name an environment variable to read it from:\n` +
					`  /secret from-env MY_TOKEN ${request.name ?? "<name>"}`,
			);
		}
		throw new Error(
			`No value given, and this client cannot prompt for one without showing it. ` +
				`Name an environment variable to read it from:\n` +
				`  /secret from-env MY_TOKEN\n` +
				`or type the value after /secret add, keeping in mind it stays visible in your scrollback.`,
		);
	}

	const ttl = request.ttl === undefined ? context.defaultTtl : request.ttl;
	const entry = await context.vault.add({ name: request.name, value, scope: request.scope, ttl });

	const lines = entry.replaced
		? [
				`Replaced ${entry.name} in the ${entry.scope} vault, ${describeTimeLeft(entry, context.now)}.`,
				`The previous value is gone. #${entry.name}# now spends the credential you just stored.`,
			]
		: [
				`Stored ${entry.name} in the ${entry.scope} vault, ${describeTimeLeft(entry, context.now)}.`,
				`The model sees #${entry.name}# and never the value. Write that placeholder where the credential goes.`,
			];
	if (typedOnScreen) {
		lines.push(SCROLLBACK_WARNING);
	}

	return {
		message: lines.join("\n"),
		agentNotice:
			`The user has stored a secret for you to use. Reference it as #${entry.name}# wherever the ` +
			`credential belongs, for example inside a command's arguments. The placeholder is replaced with the ` +
			`real value locally, just before the command runs, so you never see the value itself and must not ` +
			`ask for it. Do not write #${entry.name}# into a file or a message where it is not needed.`,
		changed: true,
	};
}

const LIST_GUTTER = 2;

const MAX_LIST_CELL_WIDTH = MAX_SECRET_NAME_LENGTH + 2;

const LIST_HEADINGS = ["PLACEHOLDER", "SCOPE", "EXPIRES", "STATUS"] as const;

const LIST_EXPIRY_FOOTER = "Extend one before it lapses: /secret extend <name> 7d.";

const LIST_STATUS_LABEL: Record<ExpiryUrgency, string> = { soon: "expires soon", halfway: "past halfway" };

const EMPTY_VAULT_LEAD_NOTHING_MASKED = "No active secrets. Nothing is being substituted right now.";
const EMPTY_VAULT_LEAD_WITH_MASKED = "No stored secrets, so nothing has a placeholder the agent can spend.";

const EMPTY_VAULT_INVITE = [
	"",
	"Store one and the agent can spend it by writing #NAME#, never seeing the value itself:",
];

function emptyVaultHelp(surface: SecretCommandSurface, anyMasked: boolean): string {
	const forms = surface === "tui" ? [USAGE_TUI_MASKED, USAGE_TUI_INLINE, USAGE_TUI_FROM_ENV] : [USAGE_ADD_FROM_ENV];
	return [
		anyMasked ? EMPTY_VAULT_LEAD_WITH_MASKED : EMPTY_VAULT_LEAD_NOTHING_MASKED,
		...EMPTY_VAULT_INVITE,
		...forms.map(form => `${OUTPUT_INDENT}${form}`),
	].join("\n");
}

async function listSecrets(context: {
	vault: SecretVault;
	now: number;
	surface?: SecretCommandSurface;
	masked?: MaskedInventory;
}): Promise<SecretCommandResult> {
	let entries: readonly ScopedVaultEntry[] = [];
	let everywhere: readonly ScopedVaultEntry[] = [];
	let unreadable: readonly VaultScope[] = [];
	try {
		entries = await context.vault.load();
		everywhere = await context.vault.loadEverywhere();
		unreadable = context.vault.unreadableScopes();
	} catch (error) {
		unreadable = await context.vault.noteFailedLoad(error);
	}
	return {
		message: renderSecretList(entries, {
			now: context.now,
			surface: context.surface,
			unreadable,
			everywhere,
			masked: context.masked,
		}),
		changed: false,
	};
}

export function renderSecretList(
	entries: readonly ScopedVaultEntry[],
	options: {
		now: number;
		surface?: SecretCommandSurface;
		unreadable?: readonly VaultScope[];
		everywhere?: readonly ScopedVaultEntry[];
		masked?: MaskedInventory;
	},
): string {
	const surface = options.surface ?? "tui";
	const broken = describeUnreadableScopes(options.unreadable ?? []);
	const shadowed = describeShadowedCopies(entries, options.everywhere ?? entries);
	const masked = describeMaskedValues(options.masked);
	if (entries.length === 0) {
		if (broken !== undefined) return masked === undefined ? broken : `${broken}\n\n${masked}`;
		const help = emptyVaultHelp(surface, masked !== undefined);
		return masked === undefined ? help : `${masked}\n\n${help}`;
	}

	const sorted = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
	const rows = sorted.map(entry => {
		const urgency = expiryUrgency(entry, options.now);
		return [
			`#${entry.name}#`,
			entry.scope,
			describeTimeLeft(entry, options.now),
			urgency === null ? "" : LIST_STATUS_LABEL[urgency],
		];
	});
	const nearExpiry = rows.some(row => row[3] !== "");
	const columns = nearExpiry ? LIST_HEADINGS.length : LIST_HEADINGS.length - 1;
	const cells = [LIST_HEADINGS, ...rows].map(row =>
		row
			.slice(0, columns)
			.map(cell => truncateToWidth(sanitizeSingleLine(cell), MAX_LIST_CELL_WIDTH, Ellipsis.Unicode)),
	);
	const widths = cells[0].map((_, column) => Math.max(...cells.map(row => visibleWidth(row[column]))));

	const lines = [
		`${formatCount("active secret", sorted.length)}. The agent spends one by writing its placeholder; the value is never shown.`,
		...cells.map(row => renderListRow(row, widths)),
	];
	if (nearExpiry) lines.push(LIST_EXPIRY_FOOTER);
	if (shadowed !== undefined) lines.push(shadowed);
	if (masked !== undefined) lines.push(masked);
	if (broken !== undefined) lines.push(broken);
	return lines.join("\n");
}

function describeShadowedCopies(
	entries: readonly ScopedVaultEntry[],
	everywhere: readonly ScopedVaultEntry[],
): string | undefined {
	const effective = new Map(entries.map(entry => [entry.name, entry.scope]));
	const hidden = everywhere.filter(entry => {
		const winner = effective.get(entry.name);
		return winner !== undefined && winner !== entry.scope;
	});
	if (hidden.length === 0) return undefined;
	return hidden
		.flatMap(entry => {
			const winner = effective.get(entry.name);
			return [
				`${OUTPUT_INDENT}#${entry.name}# is also stored in the ${entry.scope} vault, shadowed by the ${winner} one.`,
				`${OUTPUT_INDENT}Only the ${winner} copy is spent. Remove it with /secret rm ${entry.name} ${entry.scope}.`,
			];
		})
		.join("\n");
}

function describeMaskedValues(masked: MaskedInventory | undefined): string | undefined {
	if (masked === undefined || masked.count === 0) return undefined;
	const lines = [
		`${OUTPUT_INDENT}${formatCount("value", masked.count)} masked in what is sent, detected rather than declared.`,
		`${OUTPUT_INDENT}The agent cannot spend ${masked.count === 1 ? "it" : "them"}: only a stored secret has a placeholder.`,
	];
	if (masked.sources.length > 0) {
		const shown = masked.sources.map(source =>
			truncateToWidth(sanitizeSingleLine(source), MAX_LIST_CELL_WIDTH, Ellipsis.Unicode),
		);
		lines.push(`${OUTPUT_INDENT}From: ${shown.join(", ")}.`);
	}
	if (masked.unlabelled > 0) {
		lines.push(
			`${OUTPUT_INDENT}${formatCount("value", masked.unlabelled)} ${masked.unlabelled === 1 ? "was" : "were"} declared without a source and can only be counted.`,
		);
	}
	lines.push(`${OUTPUT_INDENT}To stop masking one, unset the variable or narrow the keywords in env-keywords.yml.`);
	return lines.join("\n");
}

function describeUnreadableScopes(unreadable: readonly VaultScope[]): string | undefined {
	if (unreadable.length === 0) return undefined;
	const many = unreadable.length > 1;
	const scopes = unreadable.join(" and ");
	const commands = unreadable.map(scope => `/secret discard ${scope}`).join(" and ");
	return (
		`${OUTPUT_INDENT}Your ${scopes} ${many ? "vaults" : "vault"} could not be read, so anything stored in ` +
		`${many ? "them is" : "it is"} missing from this list and cannot be spent.\n${OUTPUT_INDENT}` +
		`${many ? "They are" : "It is"} encrypted, so a hand edit cannot repair ${many ? "them" : "it"}. ` +
		`Run ${commands} to move the unreadable ${many ? "files" : "file"} aside, then re-add the secrets ` +
		`${many ? "they" : "it"} held.`
	);
}

function renderListRow(row: readonly string[], widths: readonly number[]): string {
	let line = OUTPUT_INDENT;
	for (const [column, cell] of row.entries()) {
		line += column === row.length - 1 ? cell : cell + padding(widths[column] - visibleWidth(cell) + LIST_GUTTER);
	}
	return line.trimEnd();
}

async function removeSecret(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret rm <name>");

	const name = normaliseSecretName(request.name);
	const spentBefore = (await context.vault.load()).find(entry => entry.name === name);
	const scope = await context.vault.remove(request.name, request.scope);
	if (scope === null) {
		const where = request.scope === undefined ? "is stored" : `is stored in the ${request.scope} vault`;
		throw new Error(`No secret named ${name} ${where}. Run /secret list to see what is.`);
	}
	const spentNow = (await context.vault.load()).find(entry => entry.name === name);
	if (spentNow === undefined) {
		return {
			message: `Removed ${name} from the ${scope} vault.`,
			agentNotice:
				`The user has revoked the secret ${name}, so #${name}# is no longer available and you must ` +
				`stop using it. It is no longer replaced with a real value: writing it now sends the literal ` +
				`text #${name}# rather than a credential, which will fail instead of authenticating. Do not ` +
				`write #${name}# into a command, a file, or a message, and do not ask for the value.`,
			agentNoticeIsRevocation: true,
			changed: true,
		};
	}
	if (spentBefore?.scope === scope) {
		return {
			message:
				`Removed ${name} from the ${scope} vault. A ${spentNow.scope} secret of the same name was ` +
				`underneath it, so #${name}# still spends a credential, now that one. ` +
				`Run /secret rm ${name} ${spentNow.scope} to remove that one too.`,
			agentNotice:
				`The secret ${name} now refers to a different stored credential: the ${scope} one was removed ` +
				`and a ${spentNow.scope} one of the same name is now what #${name}# spends. It is still a real ` +
				`credential, so keep writing #${name}# where that credential belongs, and be aware it may ` +
				`authenticate as a different identity than it did earlier in this session.`,
			changed: true,
		};
	}
	return {
		message:
			`Removed ${name} from the ${scope} vault. It was shadowed by the ${spentNow.scope} secret of the ` +
			`same name, so #${name}# spends what it spent before.`,
		changed: true,
	};
}

async function clearVaultScope(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.allScopes === true) return await clearEveryVault(context);
	if (request.scope === undefined) {
		throw new Error("Which vault? /secret clear profile");
	}
	const scope = request.scope;
	const removed = [...(await context.vault.clear(scope))].sort();
	if (removed.length === 0) {
		return { message: `The ${scope} vault holds no secrets, so nothing was removed.`, changed: false };
	}
	const live = new Set((await context.vault.load()).map(entry => entry.name));
	const revoked = removed.filter(name => !live.has(name));
	const shadowing = removed.filter(name => live.has(name));
	const count = `${removed.length} ${removed.length === 1 ? "secret" : "secrets"}`;
	const lines = [`Removed ${count} from the ${scope} vault: ${removed.join(", ")}.`];
	if (shadowing.length > 0) {
		lines.push(
			`${shadowing.join(", ")} ${shadowing.length === 1 ? "is" : "are"} also stored in another vault, so ` +
				`${shadowing.length === 1 ? "that placeholder" : "those placeholders"} still spend a credential. ` +
				`Clear that scope too to end ${shadowing.length === 1 ? "it" : "them"}.`,
		);
	}
	if (revoked.length === 0) {
		return { message: lines.join("\n"), changed: true };
	}
	return {
		message: lines.join("\n"),
		agentNotice: revocationNotice(revoked, `the ${scope} secret vault`),
		agentNoticeIsRevocation: true,
		changed: true,
	};
}

async function clearEveryVault(context: { vault: SecretVault }): Promise<SecretCommandResult> {
	const perScope: { scope: VaultScope; names: readonly string[] }[] = [];
	for (const scope of VAULT_SCOPES) {
		perScope.push({ scope, names: [...(await context.vault.clear(scope))].sort() });
	}
	const removed = perScope.flatMap(entry => entry.names);
	if (removed.length === 0) {
		return {
			message: `No vault holds a secret, so nothing was removed. All three are already empty.`,
			changed: false,
		};
	}
	const lines = [`Removed ${formatCount("secret", removed.length)} from every vault.`];
	for (const { scope, names } of perScope) {
		lines.push(`${OUTPUT_INDENT}${scope}: ${names.length === 0 ? "nothing stored" : names.join(", ")}.`);
	}
	const live = Array.from(new Set((await context.vault.load()).map(entry => entry.name))).sort();
	if (live.length > 0) {
		lines.push(
			`${live.join(", ")} ${live.length === 1 ? "is" : "are"} still stored and still spendable. ` +
				`Run /secret list to see where, and /secret clear everywhere again.`,
		);
	}
	const revoked = removed.filter(name => !live.includes(name));
	if (revoked.length === 0) return { message: lines.join("\n"), changed: true };
	return {
		message: lines.join("\n"),
		agentNotice: revocationNotice(revoked, "every secret vault"),
		agentNoticeIsRevocation: true,
		changed: true,
	};
}

function revocationNotice(revoked: readonly string[], where: string): string {
	const names = revoked.map(name => `#${name}#`).join(", ");
	const one = revoked.length === 1;
	return (
		`The user has cleared ${where}, so ${names} ${one ? "is" : "are"} no ` +
		`longer available and you must stop using ${one ? "it" : "them"}. ` +
		`${one ? "It is" : "They are"} no longer replaced with a real value: writing ` +
		`${one ? "it" : "one"} now sends the literal placeholder text rather than a ` +
		`credential, which will fail instead of authenticating. Do not write ${names} into a command, a file, ` +
		`or a message, and do not ask for the value.`
	);
}

async function extendSecret(
	request: SecretCommandRequest,
	context: { vault: SecretVault; defaultTtl: number | null; now: number },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret extend <name> 7d");

	const ttl = request.ttl === undefined ? context.defaultTtl : request.ttl;
	const entry = await context.vault.extend(request.name, ttl);
	if (entry === null) {
		throw new Error(
			`No secret named ${normaliseSecretName(request.name)} is stored. Run /secret list to see what is.`,
		);
	}
	return {
		message:
			`${entry.name} in the ${entry.scope} vault now lasts ${formatTtl(ttl)} from now ` +
			`(${describeTimeLeft(entry, context.now)}).`,
		agentNotice:
			`The user has refreshed the lifetime of the secret ${entry.name}. #${entry.name}# is still ` +
			`available, so keep referencing that placeholder wherever the credential belongs.`,
		changed: true,
	};
}

function readEnvCredential(variable: string, readEnv: (name: string) => string | undefined): string {
	const value = readEnv(variable);
	if (value === undefined) {
		throw new Error(
			`The environment variable ${variable} is not set in this process, so there is nothing to store. ` +
				`Note that it must be set for the veyyon process, not only in a shell you opened afterwards.`,
		);
	}
	if (value.length === 0) {
		throw new Error(
			`The environment variable ${variable} is set but empty, so there is no credential to store. ` +
				`Check where it is exported: an assignment such as ${variable}= sets it to nothing.`,
		);
	}
	if (value.trim().length === 0) {
		throw new Error(
			`The environment variable ${variable} contains only whitespace, so there is no credential to ` +
				`store. Storing it would create a placeholder that spends blank text.`,
		);
	}
	return value;
}

async function renameSecret(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.name === undefined || request.newName === undefined) {
		throw new Error("Which secret, and to what? /secret rename <name> <new-name>");
	}
	const from = normaliseSecretName(request.name);
	const to = normaliseSecretName(request.newName);
	if (from === to) return { message: `${from} already has that name, so nothing was changed.`, changed: false };
	const renamed = await context.vault.rename(from, to);
	if (renamed === null) throw new Error(`No secret named ${from} is stored. Run /secret list to see what is.`);
	return {
		message:
			`${from} is now ${renamed.name} in the ${renamed.scope} vault, with the same value and the same ` +
			`lifetime. #${from}# no longer expands.`,
		agentNotice:
			`The user has renamed the secret ${from} to ${renamed.name}. #${from}# is no longer replaced with ` +
			`a value: writing it now sends the literal text #${from}# rather than a credential. The same ` +
			`credential is available as #${renamed.name}#, so use that placeholder wherever you used the old one.`,
		changed: true,
	};
}

async function replaceSecretValue(
	request: SecretCommandRequest,
	context: {
		vault: SecretVault;
		readEnv: (name: string) => string | undefined;
		now: number;
		surface?: SecretCommandSurface;
	},
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret value <name>");
	if (request.fromEnv !== undefined && request.value !== undefined) {
		throw new Error("Give either an environment variable or a value, not both.");
	}
	const name = normaliseSecretName(request.name);
	let value: string;
	let typedOnScreen = false;
	if (request.fromEnv !== undefined) {
		value = readEnvCredential(request.fromEnv, context.readEnv);
	} else if (request.value !== undefined) {
		value = request.value;
		typedOnScreen = request.maskedEntry !== true;
	} else {
		throw new Error(
			`No value given, and this client cannot prompt for one without showing it. ` +
				`Name an environment variable to read it from:\n  /secret value ${name} from-env MY_TOKEN`,
		);
	}
	const entry = await context.vault.replaceValue(name, value);
	if (entry === null) throw new Error(`No secret named ${name} is stored. Run /secret list to see what is.`);
	const lines = [
		`${entry.name} in the ${entry.scope} vault has a new value, ${describeTimeLeft(entry, context.now)}.`,
		`The name and the lifetime are unchanged, so #${entry.name}# now spends what you just gave it.`,
	];
	if (typedOnScreen) lines.push(SCROLLBACK_WARNING);
	return {
		message: lines.join("\n"),
		changed: true,
	};
}

async function moveSecretScope(
	request: SecretCommandRequest,
	context: { vault: SecretVault; now: number },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret scope <name> profile|project|global");
	if (request.scope === undefined) throw new Error("Which vault? /secret scope <name> profile|project|global");
	const name = normaliseSecretName(request.name);
	const everywhere = await context.vault.loadEverywhere();
	const entry = everywhere.find(candidate => candidate.name === name);
	if (entry === undefined) throw new Error(`No secret named ${name} is stored. Run /secret list to see what is.`);
	if (entry.expiresAt !== null && entry.expiresAt <= context.now) {
		throw new Error(
			`${name} has expired, so there is nothing to move: it would arrive in the ${request.scope} vault ` +
				`already lapsed. Store it again in that vault instead: /secret from-env MY_TOKEN ${name} ${request.scope}.`,
		);
	}
	const { plan, refusal } = planScopeMove(entry, request.scope, everywhere);
	if (plan === null) throw new Error(refusal ?? `${name} cannot move to the ${request.scope} vault.`);
	const ttl = entry.expiresAt === null ? null : entry.expiresAt - context.now;
	const moved = await context.vault.add({ name: entry.name, value: entry.value, scope: plan.to, ttl });
	await context.vault.remove(entry.name, plan.from);
	return {
		message:
			`Moved #${moved.name}# from the ${plan.from} vault to the ${plan.to} vault, ` +
			`${describeTimeLeft(moved, context.now)}. The value and the deadline are unchanged.`,
		changed: true,
	};
}

async function copyPlaceholder(
	request: SecretCommandRequest,
	context: { vault: SecretVault },
): Promise<SecretCommandResult> {
	if (request.name === undefined) throw new Error("Which secret? /secret copy <name>");
	const name = normaliseSecretName(request.name);
	const entry = (await context.vault.load()).find(candidate => candidate.name === name);
	if (entry === undefined) throw new Error(`No secret named ${name} is stored. Run /secret list to see what is.`);
	return {
		message: `#${entry.name}# is the placeholder for the ${entry.scope} secret. The value is never copied.`,
		copyText: `#${entry.name}#`,
		changed: false,
	};
}

async function showLog(
	request: SecretCommandRequest,
	context: { auditLog?: SecretAuditLog; now: number },
): Promise<SecretCommandResult> {
	if (context.auditLog === undefined) {
		return {
			message:
				`Secret use is not being recorded, so there is no log to show. ` +
				`Turn on "Record Secret Use" in /settings (secrets.auditLog) to start recording.`,
			changed: false,
		};
	}

	const limit = request.limit ?? DEFAULT_LOG_LIMIT;
	const wanted = request.name;
	const { records, malformed } = await context.auditLog.read(wanted === undefined ? { limit } : undefined);
	const shown =
		wanted === undefined ? records : records.filter(record => record.secrets.includes(`#${wanted}#`)).slice(-limit);
	const rendered = renderLog(shown, { malformed, path: context.auditLog.path, now: context.now });
	if (wanted === undefined) return { message: rendered, changed: false };
	return { message: `Uses of #${wanted}#:\n${rendered}`, changed: false };
}

export function renderLog(
	records: readonly SecretExpansionRecord[],
	options: { malformed: number; path: string; now: number },
): string {
	const lines: string[] = [];
	if (records.length === 0) {
		lines.push(`No secret has been used yet. The log is ${options.path}.`);
	} else {
		lines.push(`${records.length} most recent use(s), oldest first:`);
		for (const record of records) {
			const ago = describeAgo(options.now - record.at);
			const omitted = record.omittedSecrets === undefined ? "" : ` +${record.omittedSecrets} omitted`;
			lines.push(`  ${ago}  ${record.tool}  ${record.secrets.join(" ")}${omitted}`);
			lines.push(`    ${record.command}`);
		}
	}
	const sessions = new Set(records.map(record => record.session).filter(session => session !== undefined));
	if (sessions.size > 1) {
		lines.push(`These records come from ${sessions.size} sessions sharing this profile's log.`);
	}
	if (options.malformed > 0) {
		lines.push(`${options.malformed} line(s) in ${options.path} could not be read and are not shown above.`);
	}
	return lines.join("\n");
}

export function describeAgo(elapsedMs: number): string {
	if (elapsedMs < 60_000) return "just now";
	const minutes = Math.round(elapsedMs / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(elapsedMs / 3_600_000);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(elapsedMs / 86_400_000)}d ago`;
}

export function resolveDefaultTtl(setting: string | undefined): number | null {
	if (setting === undefined || setting.trim().length === 0) return DEFAULT_TTL_MS;
	try {
		return parseTtl(setting);
	} catch (error) {
		throw new Error(
			`The secrets.defaultTtl setting is "${setting}", which is not a lifetime ` +
				`(${errorMessage(error)}). ` +
				`Fix it in /settings. Until then no default can be applied.`,
		);
	}
}

type ExpiryUrgency = "soon" | "halfway";

function expiryUrgency(entry: ScopedVaultEntry, now: number): ExpiryUrgency | null {
	const crossed = warningThresholdCrossed(entry, now);
	if (crossed === null) return null;
	return crossed >= WARN_AT_FRACTIONS[WARN_AT_FRACTIONS.length - 1] ? "soon" : "halfway";
}

export function expiryWarnings(entries: readonly ScopedVaultEntry[], now: number): string[] {
	const warnings: string[] = [];
	for (const entry of entries) {
		const urgency = expiryUrgency(entry, now);
		if (urgency === null) continue;
		const phrase = urgency === "soon" ? "expires soon" : "is over halfway through its lifetime";
		warnings.push(
			`#${entry.name}# ${phrase}, ${describeTimeLeft(entry, now)}. ` +
				`Extend it with /secret extend ${entry.name} 7d, or it will be deleted.`,
		);
	}
	return warnings;
}
