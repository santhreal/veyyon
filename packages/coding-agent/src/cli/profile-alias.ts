import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "@veyyon/utils/atomic-write";
import { normalizeProfileName } from "@veyyon/utils/dirs";
import { withFileLock } from "@veyyon/utils/file-lock";
import { isEnoent } from "@veyyon/utils/fs-error";

export type ProfileAliasShell = "bash" | "zsh" | "fish" | "powershell" | "pwsh";

function quoteForShell(pathValue: string): string {
	return `'${pathValue.replace(/'/g, `'"'"'`)}'`;
}

function quoteForPowerShell(pathValue: string): string {
	return `'${pathValue.replace(/'/g, `''`)}'`;
}

export interface ProfileAliasCommand {
	display: string;
	posix: string;
	fish: string;
	powerShell: string;
}

const DEFAULT_ALIAS_COMMAND: ProfileAliasCommand = {
	display: "veyyon",
	posix: "veyyon",
	fish: "veyyon",
	powerShell: "veyyon",
};

export interface ProfileAliasInstallOptions {
	profile: string;
	aliasName: string;
	shellPath?: string;
	platform?: NodeJS.Platform;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	readFile?: (filePath: string) => Promise<string>;
	command?: ProfileAliasCommand;
	writeFile?: (filePath: string, content: string) => Promise<void>;
}

export interface ProfileAliasInstallResult {
	shell: ProfileAliasShell;
	configPath: string;
	aliasName: string;
	profile: string;
	command: string;
	reloadedWith: string;
}

const ALIAS_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const POSIX_RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"case",
	"coproc",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"select",
	"then",
	"time",
	"until",
	"while",
]);
const FISH_RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"and",
	"begin",
	"break",
	"builtin",
	"case",
	"command",
	"continue",
	"else",
	"end",
	"exec",
	"for",
	"function",
	"if",
	"not",
	"or",
	"return",
	"switch",
	"while",
]);
const POWERSHELL_RESERVED_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"begin",
	"break",
	"catch",
	"class",
	"continue",
	"data",
	"do",
	"dynamicparam",
	"else",
	"elseif",
	"end",
	"enum",
	"exit",
	"filter",
	"finally",
	"for",
	"foreach",
	"from",
	"function",
	"if",
	"in",
	"param",
	"process",
	"return",
	"switch",
	"throw",
	"trap",
	"try",
	"until",
	"using",
	"var",
	"while",
	"workflow",
]);

function getReservedAliasNames(shell: ProfileAliasShell): ReadonlySet<string> {
	switch (shell) {
		case "bash":
		case "zsh":
			return POSIX_RESERVED_ALIAS_NAMES;
		case "fish":
			return FISH_RESERVED_ALIAS_NAMES;
		case "powershell":
		case "pwsh":
			return POWERSHELL_RESERVED_ALIAS_NAMES;
	}
}

function validateAliasName(aliasName: string, shell: ProfileAliasShell): string {
	const normalized = aliasName.trim();
	if (!ALIAS_NAME_RE.test(normalized)) {
		throw new Error(`Invalid alias "${aliasName}". Alias names must match ${ALIAS_NAME_RE.source}.`);
	}
	if (normalized.toLowerCase() === "veyyon" || normalized.toLowerCase() === "omp") {
		throw new Error('Invalid alias "veyyon". Refusing to shadow the base veyyon command.');
	}
	if (getReservedAliasNames(shell).has(normalized.toLowerCase())) {
		throw new Error(`Invalid alias "${aliasName}". Refusing to create a ${shell} reserved word.`);
	}
	return normalized;
}

function detectWindowsPowerShell(env: NodeJS.ProcessEnv): ProfileAliasShell {
	const modulePath = env.PSModulePath ?? env.PSMODULEPATH ?? env.psmodulepath ?? "";
	if (/[\\/]PowerShell[\\/]/i.test(modulePath)) return "pwsh";
	if (env.POWERSHELL_DISTRIBUTION_CHANNEL) return "pwsh";
	return "powershell";
}

function normalizeShellName(
	shellPath: string | undefined,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): ProfileAliasShell {
	const shell = path
		.basename(shellPath ?? "")
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (shell === "zsh") return "zsh";
	if (shell === "bash") return "bash";
	if (shell === "fish") return "fish";
	if (shell === "pwsh") return "pwsh";
	if (shell === "powershell") return "powershell";
	if (platform === "win32") return detectWindowsPowerShell(env);
	throw new Error(`Unsupported shell${shell ? ` "${shell}"` : ""}. Supported shells: bash, zsh, fish, PowerShell.`);
}

export function resolveProfileAliasCommandFromProcess(
	argv: readonly string[] = process.argv,
	cwd: string = process.cwd(),
): ProfileAliasCommand {
	const runtime = argv[0];
	const script = argv[1];
	if (!runtime || !script || !/\.[cm]?[jt]s$/.test(script)) return DEFAULT_ALIAS_COMMAND;

	const scriptPath = path.resolve(cwd, script);
	const posixScriptPath = scriptPath.replace(/\\/g, "/");
	const posixRuntime = runtime.replace(/\\/g, "/");
	const posix = `${quoteForShell(posixRuntime)} ${quoteForShell(posixScriptPath)}`;
	return {
		display: `${posixRuntime} ${posixScriptPath}`,
		posix,
		fish: posix,
		powerShell: `${quoteForPowerShell(runtime)} ${quoteForPowerShell(scriptPath)}`,
	};
}

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

function posixJoinUnc(...segments: string[]): string {
	const joined = path.posix.join(...segments);
	if (segments.some(s => s.startsWith("//") && !s.startsWith("///"))) {
		return `/${joined}`;
	}
	return joined;
}

function resolveShellConfigPath(
	shell: ProfileAliasShell,
	homeDir: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
): string {
	const posixHome = toPosix(homeDir);
	switch (shell) {
		case "zsh":
			return posixJoinUnc(env.ZDOTDIR ? toPosix(env.ZDOTDIR) : posixHome, ".zshrc");
		case "bash":
			return platform === "darwin" ? posixJoinUnc(posixHome, ".bash_profile") : posixJoinUnc(posixHome, ".bashrc");
		case "fish": {
			const configHome = env.XDG_CONFIG_HOME ? toPosix(env.XDG_CONFIG_HOME) : posixJoinUnc(posixHome, ".config");
			return posixJoinUnc(configHome, "fish", "conf.d", "veyyon-profiles.fish");
		}
		case "pwsh":
			return platform === "win32"
				? path.join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")
				: posixJoinUnc(posixHome, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
		case "powershell":
			return path.join(homeDir, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
	}
}

function renderAliasBlock(
	shell: ProfileAliasShell,
	aliasName: string,
	profile: string,
	command: ProfileAliasCommand,
): { block: string; command: string } {
	const profiledCommand = `${command.display} --profile=${profile}`;
	const start = `# >>> veyyon profile alias: ${aliasName} >>>`;
	const end = `# <<< veyyon profile alias: ${aliasName} <<<`;
	let body: string;
	switch (shell) {
		case "fish":
			body = [
				`function ${aliasName} --wraps ${command.fish} --description 'Veyyon profile ${profile}'`,
				`    command ${command.fish} --profile=${profile} $argv`,
				"end",
			].join("\n");
			break;
		case "powershell":
		case "pwsh":
			body = [`function ${aliasName} {`, `    & ${command.powerShell} --profile=${profile} @args`, "}"].join("\n");
			break;
		default:
			body = [`${aliasName}() {`, `    command ${command.posix} --profile=${profile} "$@"`, "}"].join("\n");
			break;
	}
	return { block: `${start}\n${body}\n${end}`, command: profiledCommand };
}

function upsertBlock(content: string, aliasName: string, block: string): string {
	const start = `# >>> veyyon profile alias: ${aliasName} >>>`;
	const end = `# <<< veyyon profile alias: ${aliasName} <<<`;
	const startIndex = content.indexOf(start);
	if (startIndex !== -1) {
		const endIndex = content.indexOf(end, startIndex + start.length);
		if (endIndex === -1) {
			throw new Error(
				`Found "${start}" without a matching "${end}" in the shell config. ` +
					`The managed alias block is malformed; remove the stale marker line and rerun --alias.`,
			);
		}
		const afterEnd = endIndex + end.length;
		const prefix = content.slice(0, startIndex).replace(/[\t ]*\n?$/, "");
		const suffix = content.slice(afterEnd).replace(/^\n?/, "");
		return [prefix, block, suffix].filter(Boolean).join("\n\n").replace(/\n*$/, "\n");
	}
	const trimmed = content.replace(/\s*$/, "");
	return `${trimmed}${trimmed ? "\n\n" : ""}${block}\n`;
}

function readAliasConfigText(filePath: string): Promise<string> {
	return Bun.file(filePath).text();
}

export async function readProfileAliasConfigFile(
	filePath: string,
	readText: (filePath: string) => Promise<string> = readAliasConfigText,
): Promise<string> {
	try {
		return await readText(filePath);
	} catch (error) {
		if (isEnoent(error)) return "";
		throw error;
	}
}

export async function installProfileAlias(options: ProfileAliasInstallOptions): Promise<ProfileAliasInstallResult> {
	const profile = normalizeProfileName(options.profile);
	if (!profile) {
		throw new Error("--alias requires a named --profile value.");
	}
	const platform = options.platform ?? process.platform;
	const homeDir = options.homeDir ?? os.homedir();
	const env = options.env ?? process.env;
	const shell = normalizeShellName(options.shellPath ?? env.SHELL, platform, env);
	const aliasName = validateAliasName(options.aliasName, shell);
	const configPath = resolveShellConfigPath(shell, homeDir, platform, env);
	const { block, command } = renderAliasBlock(shell, aliasName, profile, options.command ?? DEFAULT_ALIAS_COMMAND);

	const usingDefaultIO = options.readFile === undefined && options.writeFile === undefined;
	const readFile = options.readFile ?? readProfileAliasConfigFile;
	const writeFile = options.writeFile ?? ((filePath, content) => atomicWriteFile(filePath, content, { mode: 0o644 }));

	const applyBlock = async () => {
		const current = await readFile(configPath);
		await writeFile(configPath, upsertBlock(current, aliasName, block));
	};

	if (usingDefaultIO) {
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await withFileLock(configPath, applyBlock);
	} else {
		await applyBlock();
	}

	return {
		shell,
		configPath,
		aliasName,
		profile,
		command,
		reloadedWith:
			shell === "fish"
				? `source ${quoteForShell(configPath)}`
				: shell === "powershell" || shell === "pwsh"
					? `. ${quoteForPowerShell(configPath)}`
					: `. ${quoteForShell(configPath)}`,
	};
}
