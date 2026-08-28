import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { Command } from "@veyyon/utils/cli";
import { SETTINGS_SCHEMA } from "../config/settings-schema";
import { SessionManager } from "../session/session-manager";

export const COMPLETE_KINDS = ["models", "sessions", "settings", "setting-values"] as const;

export default class Complete extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		const argv = this.argv.filter(token => token !== "--");
		const kind = argv[0];
		const prefix = argv.length > 1 ? argv[argv.length - 1] : "";
		if (kind === "models") {
			completeModels(prefix);
		} else if (kind === "sessions") {
			await completeSessions(prefix);
		} else if (kind === "settings") {
			completeSettings(prefix);
		} else if (kind === "setting-values") {
			completeSettingValues(argv[1] ?? "", argv.length > 2 ? prefix : "");
		} else {
			process.stderr.write(
				`Error: unknown completion kind ${kind ? `"${kind}"` : "(missing)"}; expected one of ${COMPLETE_KINDS.join(", ")}\n`,
			);
			process.exitCode = 1;
		}
	}
}

function clean(text: string): string {
	return text.replace(/[\t\r\n]+/g, " ").trim();
}

function completeModels(prefix: string): void {
	const needle = prefix.toLowerCase();
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as GeneratedProvider)) {
			const candidates = [`${model.provider}/${model.id}`, model.id];
			for (const candidate of candidates) {
				if (seen.has(candidate)) continue;
				seen.add(candidate);
				if (needle && !candidate.toLowerCase().includes(needle)) continue;
				lines.push(`${candidate}\t${model.provider}`);
			}
		}
	}
	lines.sort();
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

async function completeSessions(prefix: string): Promise<void> {
	const sessions = await SessionManager.list(process.cwd());
	const lines: string[] = [];
	for (const session of sessions) {
		if (prefix && !session.id.startsWith(prefix)) continue;
		const label = clean(session.title ?? session.firstMessage ?? "").slice(0, 72);
		lines.push(`${session.id}\t${label}`);
	}
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

const SCHEMA_ENTRIES = SETTINGS_SCHEMA as unknown as Record<
	string,
	{ type?: string; values?: readonly string[]; ui?: { label?: string; description?: string } } | undefined
>;

function completeSettings(prefix: string): void {
	const needle = prefix.toLowerCase();
	const lines: string[] = [];
	for (const key of Object.keys(SETTINGS_SCHEMA)) {
		if (needle && !key.toLowerCase().startsWith(needle)) continue;
		const ui = SCHEMA_ENTRIES[key]?.ui;
		lines.push(`${key}\t${clean(ui?.description ?? ui?.label ?? "")}`);
	}
	lines.sort();
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

function completeSettingValues(key: string, prefix: string): void {
	const def = SCHEMA_ENTRIES[key];
	if (!def) return;
	const values = def.values ?? (def.type === "boolean" ? ["true", "false"] : undefined);
	if (!values) return;
	const needle = prefix.toLowerCase();
	const lines = values.filter(v => !needle || v.toLowerCase().startsWith(needle)).map(v => `${v}\t${key}`);
	if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}
