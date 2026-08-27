/**
 * What a stdio MCP server is allowed to see of the environment.
 *
 * THE PROBLEM THIS OWNS. An MCP server is a subprocess the operator installed once and then
 * forgot, usually from a package registry, usually updated without being read. It was spawned
 * with the whole ambient environment: every provider key, every CI secret, every token the
 * operator's shell exports. Nothing in the product limited that, and nothing else could — secret
 * obfuscation protects what reaches a MODEL, and a subprocess reads `environ` directly. One
 * compromised or accidentally malicious update therefore exfiltrated credentials for services
 * that server has nothing to do with, and did it without making a single tool call.
 *
 * WHY AN ALLOWLIST, NOT A DENYLIST. A denylist of `*_TOKEN`, `*_KEY`, `*_SECRET` is a guess about
 * naming, and the variable that ends the operator's week is the one named `GH_PAT` or
 * `npm_config__auth`. The baseline below is what a program needs in order to RUN — where its
 * binaries are, where its home and temp directories are, which locale and certificates to use,
 * and where a version manager keeps the toolchain that `npx` resolves through. Anything else is
 * withheld, so a variable nobody thought about is withheld by default rather than forwarded by
 * default.
 *
 * HOW A SERVER GETS A SECRET IT LEGITIMATELY NEEDS. Two ways, both explicit: `env` in the server
 * config sets a value outright (including a `${VAR}` reference resolved before this point), and
 * `envPassthrough` names ambient variables to forward. Naming one is the operator saying "this
 * server may read this", which is the decision that used to be made for every variable at once.
 *
 * THE FULL-INHERITANCE OPT-OUT. `inheritEnv: true` restores the old behavior for one server. It
 * exists because a server that shells out to a toolchain nobody predicted is a real case, and a
 * gate with no exit gets worked around by putting the secrets in the config file instead, where
 * they are worse off. It is per server, never global, and the transport logs a warning naming the
 * server every time it is used, so it cannot be set once and forgotten silently.
 *
 * WINDOWS. Variable names are case-insensitive there and their casing is not stable across
 * shells, so matching is case-insensitive on win32 while the ambient spelling is preserved in the
 * output: `Path` handed back as `PATH` is a variable Windows can no longer find, and `PATHEXT`
 * missing is a command that no longer resolves at all.
 */
import type { MCPStdioServerConfig } from "./types";

/**
 * Ambient variables a program needs to run, on any POSIX host.
 *
 * `TERM` is deliberately absent: an MCP server talks JSON-RPC over stdout, and a server that
 * believes it has a terminal is a server that may colour it.
 */
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

/** Ambient variables Windows itself needs, including the two that make a command resolvable. */
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

/**
 * Certificate and proxy settings, forwarded on every platform.
 *
 * A proxy URL can carry credentials, and it is forwarded anyway: an operator who set it did so
 * for every process on the machine, and a server that cannot reach the network is a server that
 * does not work at all. Documented rather than silently decided.
 */
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

/**
 * Where version managers keep the toolchain a command resolves through.
 *
 * These are directory paths, not credentials, and without them `command: "npx"` under nvm, mise,
 * asdf, volta or fnm resolves to a different runtime than the operator's shell would — or to
 * nothing. The failure that motivates including them looks like a broken MCP server, not like a
 * missing variable, which is exactly the kind of report nobody can act on.
 */
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

/** The baseline for one platform, in the order the groups are documented above. */
export function mcpBaselineEnvNames(platform: NodeJS.Platform): readonly string[] {
	const platformNames = platform === "win32" ? WINDOWS_BASELINE : POSIX_BASELINE;
	return platformNames.concat(NETWORK_BASELINE, TOOLCHAIN_BASELINE);
}

export interface McpChildEnvironment {
	/** What the subprocess will be spawned with. */
	env: Record<string, string>;
	/** Ambient names that were not forwarded, sorted. Names, never values. */
	withheld: string[];
	/** Whether the operator opted this server into the whole ambient environment. */
	inherited: boolean;
}

/** The part of a stdio server's config that decides what it may read. */
export type McpChildEnvConfig = Pick<MCPStdioServerConfig, "env" | "envPassthrough" | "inheritEnv">;

/**
 * Build the environment for one stdio MCP server.
 *
 * Precedence, lowest first: the platform baseline, then `envPassthrough` (which may name a
 * variable the baseline already carries — harmless, and states intent), then `env`, which is the
 * operator writing a value down and therefore wins.
 */
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

/**
 * Name matching, case-insensitive only where the operating system is.
 *
 * Case-folding everywhere would forward `path` on Linux, where `PATH` and `path` are two
 * different variables and the lowercase one is somebody's own.
 */
function matcherFor(wanted: ReadonlySet<string>, platform: NodeJS.Platform): (name: string) => boolean {
	if (platform !== "win32") return name => wanted.has(name);
	const folded = new Set<string>();
	for (const name of wanted) folded.add(name.toUpperCase());
	return name => folded.has(name.toUpperCase());
}
