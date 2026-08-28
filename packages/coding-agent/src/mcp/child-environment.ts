import type { MCPStdioServerConfig } from "./types";

const POSIX_BASELINE = [
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"TZ",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
] as const;

const WINDOWS_BASELINE = [
	"PATH",
	"PATHEXT",
	"SystemRoot",
	"SystemDrive",
	"windir",
	"ComSpec",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"CommonProgramFiles",
	"CommonProgramFiles(x86)",
	"PSModulePath",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"PROCESSOR_IDENTIFIER",
	"OS",
	"USERNAME",
	"USERDOMAIN",
	"COMPUTERNAME",
] as const;

const NETWORK_BASELINE = [
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
] as const;

const TOOLCHAIN_BASELINE = [
	"NVM_DIR",
	"NVM_BIN",
	"BUN_INSTALL",
	"VOLTA_HOME",
	"ASDF_DIR",
	"ASDF_DATA_DIR",
	"FNM_DIR",
	"MISE_DATA_DIR",
	"PYENV_ROOT",
	"RBENV_ROOT",
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"GOPATH",
	"GOROOT",
	"JAVA_HOME",
] as const;

export function mcpBaselineEnvNames(platform: NodeJS.Platform): readonly string[] {
	const platformNames = platform === "win32" ? WINDOWS_BASELINE : POSIX_BASELINE;
	return [...platformNames, ...NETWORK_BASELINE, ...TOOLCHAIN_BASELINE];
}

export interface McpChildEnvironment {
	env: Record<string, string>;
	withheld: string[];
	inherited: boolean;
}

export type McpChildEnvConfig = Pick<MCPStdioServerConfig, "env" | "envPassthrough" | "inheritEnv">;

export function buildMcpChildEnv(
	config: McpChildEnvConfig,
	ambient: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): McpChildEnvironment {
	const declared = config.env ?? {};
	const present = Object.entries(ambient).filter((entry): entry is [string, string] => entry[1] !== undefined);

	if (config.inheritEnv === true) {
		const env: Record<string, string> = {};
		for (const [name, value] of present) env[name] = value;
		return { env: { ...env, ...declared }, withheld: [], inherited: true };
	}

	const wanted = new Set<string>(mcpBaselineEnvNames(platform).concat(config.envPassthrough ?? []));
	const matches = matcherFor(wanted, platform);

	const env: Record<string, string> = {};
	const withheld: string[] = [];
	for (const [name, value] of present) {
		if (matches(name)) env[name] = value;
		else if (!Object.hasOwn(declared, name)) withheld.push(name);
	}

	return { env: { ...env, ...declared }, withheld: withheld.sort(), inherited: false };
}

function matcherFor(wanted: ReadonlySet<string>, platform: NodeJS.Platform): (name: string) => boolean {
	if (platform !== "win32") return name => wanted.has(name);
	const folded = new Set<string>();
	for (const name of wanted) folded.add(name.toUpperCase());
	return name => folded.has(name.toUpperCase());
}
