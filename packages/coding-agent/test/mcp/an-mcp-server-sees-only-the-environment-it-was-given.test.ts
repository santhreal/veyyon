/**
 * WHY. A stdio MCP server used to be spawned with the whole ambient environment
 * (`env = { ...Bun.env, ...config.env }`). An MCP server is third-party code the operator
 * installed once from a registry, so every provider key, CI token and cloud credential exported
 * in that shell was readable by it through `process.env`, with no tool call and nothing in the
 * product limiting it. Secret redaction protects what reaches a MODEL; it does nothing about a
 * subprocess reading `environ`.
 *
 * THE CLASS THIS CLOSES. Not "the reported variable is hidden" — the rule is now an allowlist, so
 * the question is whether a variable NOBODY NAMED can reach a server by any route. These drive the
 * real `StdioTransport` against a real subprocess that reports its own environment, and they
 * enumerate the baseline from source at run time, so adding a name to the baseline turns the sweep
 * red until it is a deliberate decision. The platform half of the rule is exercised directly
 * against `buildMcpChildEnv`, because win32 name folding cannot be spawned from here.
 *
 * WHAT IT DOES NOT CATCH. A server that reads a secret from a file (`~/.aws/credentials`,
 * `~/.netrc`) is untouched by this: the environment is one exfiltration route and this closes that
 * one. Nor does it bound what a server does with a value the operator DID name — `envPassthrough`
 * and `env` are consent, and consent is not supervision. And `inheritEnv: true` is a real escape
 * hatch: the tests pin that it warns, not that it is safe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { buildMcpChildEnv, mcpBaselineEnvNames } from "@veyyon/coding-agent/mcp/child-environment";
import { StdioTransport } from "@veyyon/coding-agent/mcp/transports/stdio";
import type { MCPStdioServerConfig } from "@veyyon/coding-agent/mcp/types";
import { logger } from "@veyyon/utils";

/**
 * A server that reports its own environment as a JSON-RPC notification and then stays alive.
 *
 * Reporting through the transport's own notification path, rather than a temp file, means the
 * bytes under assertion travelled the production route: spawn, stdout, framing, dispatch.
 */
const REPORTING_SERVER = [
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the CHILD interpolates this when it runs
	'process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "env/report", params: process.env })}\\n`);',
	"await Bun.sleep(5000);",
].join("\n");

/**
 * The ambient value of a variable this suite needs to exist.
 *
 * Throwing rather than comparing against `undefined` keeps a host that exports neither PATH nor
 * HOME from producing a green run that proved nothing.
 */
function ambient(name: string): string {
	const value = Bun.env[name];
	if (value === undefined) throw new Error(`this host must export ${name} for this assertion to mean anything`);
	return value;
}

/** Secrets an operator's shell plausibly exports, none of which an MCP server was told about. */
const SEEDED_SECRETS: Record<string, string> = {
	ANTHROPIC_API_KEY: "sk-ant-seeded-value",
	OPENAI_API_KEY: "sk-openai-seeded-value",
	GITHUB_TOKEN: "ghp_seeded_value",
	GH_PAT: "ghp_pat_seeded_value",
	NPM_TOKEN: "npm_seeded_value",
	AWS_SECRET_ACCESS_KEY: "aws-seeded-value",
	CI_JOB_TOKEN: "ci-seeded-value",
	HOMEBREW_GITHUB_API_TOKEN: "ghp_brew_seeded_value",
	VEYYON_INTERNAL_THING: "veyyon-seeded-value",
};

describe("a stdio MCP server sees only the environment it was given", () => {
	let open: StdioTransport[];
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;
	let debugs: Array<{ message: string; fields: Record<string, unknown> }>;
	let restoreEnv: Array<[string, string | undefined]>;

	beforeEach(() => {
		open = [];
		warnings = [];
		debugs = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
		vi.spyOn(logger, "debug").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			debugs.push({ message, fields: fields ?? {} });
		});
		restoreEnv = [];
		for (const [name, value] of Object.entries(SEEDED_SECRETS)) seed(name, value);
	});

	afterEach(async () => {
		for (const transport of open) await transport.close().catch(() => {});
		for (const [name, value] of restoreEnv) {
			if (value === undefined) delete Bun.env[name];
			else Bun.env[name] = value;
		}
		vi.restoreAllMocks();
	});

	/** Set one ambient variable for this test only; `afterEach` puts the old value back. */
	function seed(name: string, value: string): void {
		restoreEnv.push([name, Bun.env[name]]);
		Bun.env[name] = value;
	}

	/** Spawn the reporting server under `config` and resolve with the environment it saw. */
	async function environmentSeenBy(config: Partial<MCPStdioServerConfig>): Promise<Record<string, string>> {
		const transport = new StdioTransport({
			type: "stdio",
			command: process.execPath,
			args: ["-e", REPORTING_SERVER],
			...config,
		});
		open.push(transport);
		const reported = Promise.withResolvers<Record<string, string>>();
		transport.onNotification = (method: string, params: unknown) => {
			if (method === "env/report") reported.resolve(params as Record<string, string>);
		};
		await transport.connect();
		return reported.promise;
	}

	it("withholds every ambient secret nobody named, and still hands over what a program needs to run", async () => {
		const seen = await environmentSeenBy({});

		for (const name of Object.keys(SEEDED_SECRETS)) expect(seen[name]).toBeUndefined();
		// The baseline is not "nothing": a server that cannot find its own interpreter is a
		// server that does not run, and a gate that breaks every server gets turned off.
		expect(seen.PATH).toBe(ambient("PATH"));
		expect(seen.HOME).toBe(ambient("HOME"));
	});

	it("forwards every name the baseline claims, enumerated from source so a new one cannot slip in untested", async () => {
		// Fails by default: add a name to a baseline group without it reaching the child and this
		// goes red, rather than the addition being believed because it is written down.
		const baseline = mcpBaselineEnvNames(process.platform);
		expect(baseline.length).toBeGreaterThan(20);
		const marked = baseline.filter(name => Bun.env[name] === undefined);
		for (const name of marked) seed(name, `baseline-marker-${name}`);

		const seen = await environmentSeenBy({});

		const missing = baseline.filter(name => seen[name] !== Bun.env[name]);
		expect(missing).toEqual([]);
	});

	it("withholds TERM, so a server does not decide it is talking to a terminal", () => {
		// A deliberate omission, pinned by equality rather than by a comment: the child's stdout
		// is a JSON-RPC stream and a coloured one is a broken one.
		expect(mcpBaselineEnvNames("linux")).not.toContain("TERM");
		expect(mcpBaselineEnvNames("win32")).not.toContain("TERM");
		expect(buildMcpChildEnv({}, { TERM: "xterm-256color" }, "linux").env.TERM).toBeUndefined();
	});

	it("hands over a declared value, and lets it win over the ambient one", async () => {
		// The collision is on a BASELINE name on purpose. A declared name nobody forwards cannot
		// prove precedence, because there is nothing for it to win against.
		seed("TZ", "Etc/Ambient");

		const seen = await environmentSeenBy({ env: { MCP_TOKEN: "declared-token", TZ: "Etc/Declared" } });

		expect(seen.MCP_TOKEN).toBe("declared-token");
		expect(seen.TZ).toBe("Etc/Declared");
	});

	it("forwards exactly the ambient names the operator listed, and no sibling of them", async () => {
		seed("GITHUB_TOKEN_ADMIN", "ghp_admin_seeded_value");

		const seen = await environmentSeenBy({ envPassthrough: ["GITHUB_TOKEN"] });

		expect(seen.GITHUB_TOKEN).toBe(SEEDED_SECRETS.GITHUB_TOKEN);
		// The neighbouring tokens are the whole point: naming one variable is not naming a
		// category, a prefix, or the longer name that starts with it.
		expect(seen.GITHUB_TOKEN_ADMIN).toBeUndefined();
		expect(seen.GH_PAT).toBeUndefined();
		expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("matches a name exactly, so a variable that merely resembles an allowed one stays behind", () => {
		// `HOMEBREW_GITHUB_API_TOKEN` is the shape of the real accident: a credential whose name
		// begins with the name of a variable every program is given.
		const built = buildMcpChildEnv(
			{},
			{
				PATH: "/bin",
				HOME: "/home/op",
				HOMEBREW_GITHUB_API_TOKEN: "ghp_brew",
				PATH_TO_SECRET: "/etc/keys",
				TZ_TOKEN: "tz-secret",
			},
			"linux",
		);

		expect(built.env).toEqual({ PATH: "/bin", HOME: "/home/op" });
		expect(built.withheld).toEqual(["HOMEBREW_GITHUB_API_TOKEN", "PATH_TO_SECRET", "TZ_TOKEN"]);
	});

	it("says which names it withheld, without saying what they were", async () => {
		await environmentSeenBy({});

		const bounded = debugs.find(entry => entry.message === "MCP server environment bounded");
		expect(bounded).toBeDefined();
		const withheld = bounded?.fields.withheld as string[];
		expect(withheld).toContain("ANTHROPIC_API_KEY");
		expect(withheld).toContain("GH_PAT");
		// A diagnostic that prints the value it protected is the leak it was reporting.
		const rendered = JSON.stringify(bounded?.fields);
		for (const value of Object.values(SEEDED_SECRETS)) expect(rendered).not.toContain(value);
	});

	it("hands over everything when the operator asks for it, and warns on that spawn", async () => {
		const seen = await environmentSeenBy({ inheritEnv: true });

		expect(seen.ANTHROPIC_API_KEY).toBe(SEEDED_SECRETS.ANTHROPIC_API_KEY);
		expect(seen.AWS_SECRET_ACCESS_KEY).toBe(SEEDED_SECRETS.AWS_SECRET_ACCESS_KEY);
		const warned = warnings.find(entry => entry.message === "MCP server spawned with the whole environment");
		expect(warned).toBeDefined();
		expect(warned?.fields.command).toBe(process.execPath);
		// An escape hatch that is silent is an escape hatch nobody remembers taking.
		expect(String(warned?.fields.reason)).toContain("inheritEnv");
	});

	it("keeps a declared value on top even under full inheritance", () => {
		const built = buildMcpChildEnv(
			{ inheritEnv: true, env: { ANTHROPIC_API_KEY: "overridden" } },
			{ ANTHROPIC_API_KEY: "ambient", PATH: "/bin" },
			"linux",
		);

		expect(built.env.ANTHROPIC_API_KEY).toBe("overridden");
		expect(built.inherited).toBe(true);
		// Nothing was withheld, so nothing is reported as withheld: the log must not imply a
		// bound that is not there.
		expect(built.withheld).toEqual([]);
	});

	it("matches names case-insensitively only where the operating system does", () => {
		const ambient = { Path: "C:\\Windows", PATHEXT: ".COM;.EXE", ANTHROPIC_API_KEY: "secret" };

		const windows = buildMcpChildEnv({}, ambient, "win32");
		// The ambient SPELLING survives: `Path` handed back as `PATH` is a variable Windows can no
		// longer find, and a missing PATHEXT is a command that no longer resolves.
		expect(windows.env.Path).toBe("C:\\Windows");
		expect(windows.env.PATH).toBeUndefined();
		expect(windows.env.PATHEXT).toBe(".COM;.EXE");
		expect(windows.env.ANTHROPIC_API_KEY).toBeUndefined();

		const posix = buildMcpChildEnv({}, { path: "/bin", PATH: "/usr/bin" }, "linux");
		// On Linux `path` and `PATH` are two variables and the lowercase one is somebody's own.
		expect(posix.env.PATH).toBe("/usr/bin");
		expect(posix.env.path).toBeUndefined();
	});

	it("does not turn an unset ambient variable into an empty one", () => {
		const built = buildMcpChildEnv({}, { PATH: "/bin", HOME: undefined }, "linux");

		expect(Object.hasOwn(built.env, "HOME")).toBe(false);
		// An unset variable is not a withheld one, so it does not pad the diagnostic either.
		expect(built.withheld).toEqual([]);
	});

	it("does not report a name as withheld when the config replaced it", () => {
		const built = buildMcpChildEnv(
			{ env: { ANTHROPIC_API_KEY: "declared" } },
			{ ANTHROPIC_API_KEY: "ambient", GH_PAT: "leaked" },
			"linux",
		);

		expect(built.env.ANTHROPIC_API_KEY).toBe("declared");
		expect(built.withheld).toEqual(["GH_PAT"]);
	});
});
