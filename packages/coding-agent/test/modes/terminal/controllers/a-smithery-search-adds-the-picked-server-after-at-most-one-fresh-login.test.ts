/**
 * WHY: the Smithery `/mcp` subcommands moved out of `MCPCommandController` into
 * `McpSmitheryCommands`, and the registry auth retry was rewritten in the move.
 * The defect class is a search that logs in on the wrong refusals, retries
 * without a bound, retries with the key it was refused with, or adds a server
 * other than the one picked, under a name or with inputs other than the ones
 * typed.
 *
 * THE INVARIANTS:
 *   1. A refused search logs in again exactly when the registry answers 401,
 *      403 or 429 — swept over every 4xx and 5xx status — and retries once with
 *      the key the login saved. Any other refusal surfaces as the error.
 *   2. The retry is bounded: a second refusal surfaces, and a declined login
 *      surfaces the original refusal without a retry.
 *   3. The picked result is written to the profile's `mcp.json` under the typed
 *      or next free name, with the typed registry inputs folded into a stdio
 *      server's `--config` argument and nothing written on a cancelled prompt.
 *   4. Login and logout report what happened to the cached key.
 *
 * Every Smithery boundary (registry search, CLI auth session, key file) is
 * stubbed; the config writer is the real one, against a temporary profile.
 * What this does not catch: the browser poll cadence and its five-minute
 * deadline, which run on the wall clock.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as smitheryAuth from "@veyyon/coding-agent/mcp/smithery-auth";
import * as smitheryRegistry from "@veyyon/coding-agent/mcp/smithery-registry";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import {
	MCPCommandController,
	type McpCommandControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/mcp-command-controller";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import * as openModule from "@veyyon/coding-agent/utils/open";
import { getMCPConfigPath, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

const originalProjectDir = getProjectDir();
const dirOverrides = captureDirOverrides();

type RegistryResult = smitheryRegistry.SmitherySearchResult;

interface RenderedComponent {
	render(width: number): readonly string[];
}

interface Harness {
	controller: MCPCommandController;
	errors: string[];
	statuses: string[];
	warnings: string[];
	prompts: string[];
	selectorOptions: string[][];
	/** Every presented block rendered as plain text, in order. */
	transcript(): string;
}

interface HarnessOptions {
	/** Answers for successive text prompts; `undefined` is Esc. */
	answers?: (string | undefined)[];
	/** Picks a selector option; `undefined` dismisses the selector. */
	select?: (options: string[]) => string | undefined;
}

function createHarness(options: HarnessOptions = {}): Harness {
	const answers = [...(options.answers ?? [])];
	const presented: RenderedComponent[] = [];
	const harness: Omit<Harness, "controller" | "transcript"> = {
		errors: [],
		statuses: [],
		warnings: [],
		prompts: [],
		selectorOptions: [],
	};
	const ctx = {
		present: (component: RenderedComponent) => {
			presented.push(component);
		},
		ui: { requestRender: () => {} },
		editor: {},
		editorContainer: { children: [] },
		showError: (message: string) => harness.errors.push(message),
		showStatus: (message: string) => harness.statuses.push(message),
		showWarning: (message: string) => harness.warnings.push(message),
		showHookInput: async (prompt: string) => {
			harness.prompts.push(prompt);
			return answers.shift();
		},
		showHookSelector: async (_title: string, choices: string[]) => {
			harness.selectorOptions.push(choices);
			return options.select?.(choices);
		},
		session: {
			obfuscateProviderText: (text: string) => text,
			refreshMCPTools: async () => {},
		},
		mcpManager: {
			invalidateCommandCredentials: () => 0,
			disconnectAll: async () => {},
			discoverAndConnect: async () => ({ errors: new Map<string, string>() }),
			waitForConnection: async () => ({}),
			getConnectionStatus: () => "connected",
			getTools: () => [],
		},
	};
	return {
		...harness,
		controller: new MCPCommandController(ctx as unknown as McpCommandControllerContext),
		transcript: () =>
			presented.map(component => stripVTControlCharacters(component.render(400).join("\n"))).join("\n"),
	};
}

/** The cached Smithery key, as the stubbed key file holds it. */
let cachedKey: string | undefined;
/** Every registry search, validation probes included: keyword and the key it carried. */
let searches: { keyword: string; apiKey: string | undefined }[];

function stubKeyFile(initial: string | undefined): void {
	cachedKey = initial;
	vi.spyOn(smitheryAuth, "getSmitheryApiKey").mockImplementation(async () => cachedKey);
	vi.spyOn(smitheryAuth, "saveSmitheryApiKey").mockImplementation(async key => {
		cachedKey = key;
	});
}

/** A browser login that approves at once with `key`, or fails to start when `key` is undefined. */
function stubBrowserLogin(key: string | undefined) {
	vi.spyOn(openModule, "openPath").mockImplementation(() => {});
	vi.spyOn(smitheryAuth, "pollSmitheryCliAuthSession").mockResolvedValue({ status: "success", apiKey: key });
	return vi
		.spyOn(smitheryAuth, "createSmitheryCliAuthSession")
		.mockImplementation(async () =>
			key === undefined
				? Promise.reject(new Error("session refused"))
				: { sessionId: "session-1", authUrl: "https://smithery.example.test/authorize" },
		);
}

/** The registry: `search` answers the "redis" keyword; a validation probe ("mcp") accepts every key but "bad-key". */
function stubRegistry(search: (apiKey: string | undefined) => RegistryResult[]): void {
	searches = [];
	vi.spyOn(smitheryRegistry, "searchSmitheryRegistry").mockImplementation(async (keyword, options) => {
		searches.push({ keyword, apiKey: options?.apiKey });
		if (keyword === "mcp") {
			if (options?.apiKey === "bad-key") throw new Error("key rejected");
			return [];
		}
		return search(options?.apiKey);
	});
}

function redisSearches(): (string | undefined)[] {
	return searches.filter(s => s.keyword === "redis").map(s => s.apiKey);
}

function result(name: string, config: MCPServerConfig, requiredInputs: RegistryResult["requiredInputs"] = []) {
	return {
		id: name,
		name,
		display: {
			displayName: name,
			description: "",
			useCount: 5,
			verified: true,
			deployed: true,
			transport: config.type ?? "stdio",
			connectionType: config.type ?? "stdio",
			tools: [],
		},
		sourceType: "package",
		config,
		warnings: [],
		requiredInputs,
	} satisfies RegistryResult;
}

function input(key: string, required: boolean): RegistryResult["requiredInputs"][number] {
	return { key, label: key, type: "string", required, sensitive: false };
}

const STDIO: MCPServerConfig = { type: "stdio", command: "npx", args: ["-y", "@acme/redis-mcp"] };

async function writtenServers(): Promise<Record<string, MCPServerConfig>> {
	const text = await fs.readFile(getMCPConfigPath("user", getProjectDir()), "utf8").catch(() => "{}");
	return (JSON.parse(text) as { mcpServers?: Record<string, MCPServerConfig> }).mcpServers ?? {};
}

async function seedServers(servers: Record<string, MCPServerConfig>): Promise<void> {
	const file = getMCPConfigPath("user", getProjectDir());
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify({ mcpServers: servers }));
}

describe("a Smithery search adds the picked server after at most one fresh login", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-smithery-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-smithery-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	describe("a refused search", () => {
		it("logs in again for exactly 401, 403 and 429 across every 4xx and 5xx status", async () => {
			const loggedInOn: number[] = [];
			for (let status = 400; status < 600; status++) {
				stubKeyFile("stale-key");
				const sessions = stubBrowserLogin("fresh-key");
				stubRegistry(apiKey => {
					if (apiKey === "stale-key") throw new smitheryRegistry.SmitheryRegistryError("refused", status);
					return [];
				});
				const harness = createHarness();

				await harness.controller.handle("/mcp smithery-search redis");

				if (sessions.mock.calls.length > 0) {
					loggedInOn.push(status);
					expect(redisSearches()).toEqual(["stale-key", "fresh-key"]);
					expect(cachedKey).toBe("fresh-key");
					expect(harness.errors).toEqual([]);
					const reason = status === 429 ? "rate limited by Smithery" : "forbidden/unauthorized with Smithery";
					expect(harness.transcript()).toContain(`Smithery authentication required (${reason}).`);
					expect(harness.transcript()).toContain('No Smithery results found for "redis".');
				} else {
					expect(redisSearches()).toEqual(["stale-key"]);
					expect(harness.errors).toEqual(["Smithery search failed: refused"]);
				}
				vi.restoreAllMocks();
			}
			expect(loggedInOn).toEqual([401, 403, 429]);
		});

		it("surfaces a refusal that is not a registry status without logging in", async () => {
			stubKeyFile("stale-key");
			const sessions = stubBrowserLogin("fresh-key");
			stubRegistry(() => {
				throw new Error("socket hang up");
			});
			const harness = createHarness();

			await harness.controller.handle("/mcp smithery-search redis");

			expect(sessions).not.toHaveBeenCalled();
			expect(redisSearches()).toEqual(["stale-key"]);
			expect(harness.errors).toEqual(["Smithery search failed: socket hang up"]);
		});

		it("retries once and surfaces the second refusal", async () => {
			stubKeyFile("stale-key");
			const sessions = stubBrowserLogin("fresh-key");
			stubRegistry(() => {
				throw new smitheryRegistry.SmitheryRegistryError("still refused", 401);
			});
			const harness = createHarness();

			await harness.controller.handle("/mcp smithery-search redis");

			expect(sessions).toHaveBeenCalledTimes(1);
			expect(redisSearches()).toEqual(["stale-key", "fresh-key"]);
			expect(harness.errors).toEqual(["Smithery search failed: still refused"]);
		});

		it("surfaces the original refusal when the login is declined", async () => {
			stubKeyFile("stale-key");
			stubBrowserLogin(undefined);
			stubRegistry(() => {
				throw new smitheryRegistry.SmitheryRegistryError("refused", 403);
			});
			const harness = createHarness({ answers: [undefined] });

			await harness.controller.handle("/mcp smithery-search redis");

			expect(redisSearches()).toEqual(["stale-key"]);
			expect(harness.warnings).toEqual(["Browser authorization failed: session refused. Falling back to API key."]);
			expect(harness.prompts).toEqual(["Smithery API key (Esc to cancel)"]);
			expect(harness.errors).toEqual(["Smithery search failed: refused"]);
			expect(cachedKey).toBe("stale-key");
		});
	});

	describe("a search with no cached key", () => {
		it("searches with the key a browser login saved", async () => {
			stubKeyFile(undefined);
			stubBrowserLogin("fresh-key");
			stubRegistry(() => []);
			const harness = createHarness();

			await harness.controller.handle("/mcp smithery-search redis");

			expect(harness.transcript()).toContain("Smithery authentication required (required for smithery-search).");
			expect(searches).toEqual([
				{ keyword: "mcp", apiKey: "fresh-key" },
				{ keyword: "redis", apiKey: "fresh-key" },
			]);
			expect(harness.statuses).toEqual(["Smithery API key saved."]);
		});

		it("re-prompts a pasted key until one validates, then searches with it", async () => {
			stubKeyFile(undefined);
			stubBrowserLogin(undefined);
			stubRegistry(() => []);
			const harness = createHarness({ answers: ["  ", "bad-key", " good-key "] });

			await harness.controller.handle("/mcp smithery-search redis");

			expect(harness.errors).toEqual([
				"Smithery API key cannot be empty.",
				"Smithery API key validation failed: key rejected",
			]);
			expect(redisSearches()).toEqual(["good-key"]);
			expect(cachedKey).toBe("good-key");
		});

		it("never searches when the login is cancelled", async () => {
			stubKeyFile(undefined);
			stubBrowserLogin(undefined);
			stubRegistry(() => []);
			const harness = createHarness({ answers: [undefined] });

			await harness.controller.handle("/mcp smithery-search redis");

			expect(redisSearches()).toEqual([]);
			expect(harness.errors).toEqual([
				"Smithery login cancelled. Run /mcp smithery-login, then retry /mcp smithery-search. Run /mcp smithery-login to authenticate first.",
			]);
		});
	});

	describe("the picked result", () => {
		function searchReturning(results: RegistryResult[]): void {
			stubKeyFile("key");
			stubRegistry(() => results);
		}

		it("is written under the default name with the typed inputs folded into --config", async () => {
			searchReturning([
				result("other", STDIO),
				result("redis", STDIO, [input("token", true), input("region", false), input("db", false)]),
			]);
			const harness = createHarness({
				select: options => options[1],
				answers: ["", " abc ", undefined, "   "],
			});

			await harness.controller.handle("/mcp smithery-search redis");

			expect(harness.selectorOptions).toEqual([["1. other (stdio, uses 5)", "2. redis (stdio, uses 5)"]]);
			expect(harness.prompts).toEqual([
				"Server name for deploy (default: redis)",
				"token (required)",
				"region (optional)",
				"db (optional)",
			]);
			expect(harness.errors).toEqual([]);
			expect(await writtenServers()).toEqual({
				redis: { ...STDIO, args: ["-y", "@acme/redis-mcp", "--config", '{"token":"abc"}'] },
			});
		});

		it("replaces the value of an existing --config argument and fills a trailing one", async () => {
			const withValue = { ...STDIO, args: ["--config", "{}", "--verbose"] };
			const trailing = { ...STDIO, args: ["serve", "--config"] };
			searchReturning([
				result("valued", withValue, [input("k", true)]),
				result("trailing", trailing, [input("k", true)]),
			]);

			await createHarness({ select: options => options[0], answers: ["", "1"] }).controller.handle(
				"/mcp smithery-search redis",
			);
			await createHarness({ select: options => options[1], answers: ["", "2"] }).controller.handle(
				"/mcp smithery-search redis",
			);

			expect(await writtenServers()).toEqual({
				valued: { ...STDIO, args: ["--config", '{"k":"1"}', "--verbose"] },
				trailing: { ...STDIO, args: ["serve", "--config", '{"k":"2"}'] },
			});
		});

		it("leaves a remote server's config as the registry returned it", async () => {
			const remote: MCPServerConfig = { type: "http", url: "https://redis.example.test/mcp" };
			searchReturning([result("remote", remote, [input("token", true)])]);
			const harness = createHarness({ select: options => options[0], answers: ["", "abc"] });

			await harness.controller.handle("/mcp smithery-search redis");

			expect(await writtenServers()).toEqual({ remote });
		});

		const defaults: { taken: string[]; offered: string }[] = [
			{ taken: [], offered: "redis" },
			{ taken: ["redis-2"], offered: "redis" },
			{ taken: ["redis"], offered: "redis-2" },
			{ taken: ["redis", "redis-3"], offered: "redis-2" },
			{ taken: ["redis", "redis-2", "redis-4"], offered: "redis-3" },
		];
		for (const { taken, offered } of defaults) {
			it(`offers ${offered} when [${taken.join(", ")}] are configured`, async () => {
				await seedServers(Object.fromEntries(taken.map(name => [name, STDIO])));
				searchReturning([result("redis", STDIO)]);
				const harness = createHarness({ select: options => options[0], answers: [""] });

				await harness.controller.handle("/mcp smithery-search redis");

				expect(harness.prompts).toEqual([`Server name for deploy (default: ${offered})`]);
				expect(Object.keys(await writtenServers()).sort()).toEqual([...taken, offered].sort());
			});
		}

		it("re-prompts a name already configured", async () => {
			await seedServers({ redis: STDIO, "redis-2": STDIO });
			searchReturning([result("redis", STDIO)]);
			const harness = createHarness({ select: options => options[0], answers: ["redis", "cache"] });

			await harness.controller.handle("/mcp smithery-search redis");

			expect(harness.prompts).toEqual([
				"Server name for deploy (default: redis-3)",
				"Server name for deploy (default: redis-3)",
			]);
			expect(harness.errors).toHaveLength(1);
			expect(harness.errors[0]).toStartWith('Server "redis" already exists in ');
			expect(Object.keys(await writtenServers()).sort()).toEqual(["cache", "redis", "redis-2"]);
		});

		it("resolves a truncated label to the result it was cut from", async () => {
			const long = "x".repeat(130);
			searchReturning([result("short", STDIO), result(long, STDIO)]);
			const harness = createHarness({ select: options => options[1], answers: ["picked"] });

			await harness.controller.handle("/mcp smithery-search redis");

			const label = harness.selectorOptions[0]?.[1] ?? "";
			expect(label).toHaveLength(120);
			expect(label).toEndWith("...");
			expect(await writtenServers()).toEqual({ picked: STDIO });
		});

		const cancellations: { name: string; options: HarnessOptions; status?: string; error?: string }[] = [
			{
				name: "the selector is dismissed",
				options: { select: () => undefined },
				status: "MCP Smithery selection cancelled.",
			},
			{
				name: "the name prompt is dismissed",
				options: { select: o => o[0], answers: [undefined] },
				status: "MCP deploy cancelled.",
			},
			{
				name: "a required input is dismissed",
				options: { select: o => o[0], answers: ["", undefined] },
				status: "MCP deploy cancelled.",
			},
			{
				name: "a required input is blank",
				options: { select: o => o[0], answers: ["", "  "] },
				status: "MCP deploy cancelled.",
				error: 'Missing required value for "token".',
			},
		];
		for (const cancellation of cancellations) {
			it(`writes nothing when ${cancellation.name}`, async () => {
				searchReturning([result("redis", STDIO, [input("token", true)])]);
				const harness = createHarness(cancellation.options);

				await harness.controller.handle("/mcp smithery-search redis");

				expect(await writtenServers()).toEqual({});
				expect(harness.statuses).toEqual(cancellation.status ? [cancellation.status] : []);
				expect(harness.errors).toEqual(cancellation.error ? [cancellation.error] : []);
			});
		}
	});

	describe("login and logout", () => {
		it("saves the key a browser login approves", async () => {
			stubKeyFile(undefined);
			stubBrowserLogin("fresh-key");
			stubRegistry(() => []);
			const harness = createHarness();

			await harness.controller.handle("/mcp smithery-login");

			expect(cachedKey).toBe("fresh-key");
			expect(harness.transcript()).toContain("https://smithery.example.test/authorize");
			expect(harness.statuses).toEqual(["Smithery API key saved."]);
		});

		it("reports a cancelled login and keeps no key", async () => {
			stubKeyFile(undefined);
			stubBrowserLogin(undefined);
			stubRegistry(() => []);
			const harness = createHarness({ answers: [undefined] });

			await harness.controller.handle("/mcp smithery-login");

			expect(cachedKey).toBeUndefined();
			expect(harness.statuses).toEqual(["Smithery login cancelled."]);
		});

		for (const [removed, status] of [
			[true, "Smithery API key removed."],
			[false, "No cached Smithery API key found."],
		] as const) {
			it(`reports "${status}" on logout`, async () => {
				const clear = vi.spyOn(smitheryAuth, "clearSmitheryApiKey").mockResolvedValue(removed);
				const harness = createHarness();

				await harness.controller.handle("/mcp smithery-logout");

				expect(clear).toHaveBeenCalledTimes(1);
				expect(harness.statuses).toEqual([status]);
			});
		}
	});
});
