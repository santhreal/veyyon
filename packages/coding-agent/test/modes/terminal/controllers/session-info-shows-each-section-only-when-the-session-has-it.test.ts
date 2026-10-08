/**
 * `/session` info (`CommandController.handleSessionCommand`) prints the session's file, provider, message
 * counts, append-only mode, tokens, cost, language servers and MCP servers. Several sections and lines are
 * conditional, and each condition decides whether a reader sees a zero or nothing.
 *
 * Contracts:
 *  - the file line reads "In-memory" for a session without a file;
 *  - the provider section reads "No model selected" without a model, and lists the model's fields with one;
 *  - the append-only line states whether the mode is active and the setting, naming the provider under auto;
 *  - cache read and write lines appear only above zero;
 *  - the cost section appears only when cost or premium requests are above zero, premium requests rounded to
 *    cents and read from the usage log when the stats carry none;
 *  - the LSP section appears only with servers, each status in its colour and an error with its message;
 *  - the MCP section appears only with a manager, "None connected" without servers, and each server's tools.
 *
 * Gap: provider detail fields beyond their presence are owned by `getProviderDetails` and asserted there.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { CommandController } from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { useTruecolorTheme } from "../../../helpers/theme-assertions";

// Colour is part of the contract for the language-server statuses, so the theme must paint.
useTruecolorTheme("dark");

interface SessionFixture {
	sessionFile?: string;
	premiumRequests?: unknown;
	usageLogPremiumRequests?: number;
	cost?: number;
	cacheRead?: number;
	cacheWrite?: number;
	model?: { id: string; api: string; provider: string; baseUrl: string };
	appendOnly?: "auto" | "on" | "off";
	lspServers?: {
		name: string;
		status: "connecting" | "ready" | "error" | "available";
		fileTypes: string[];
		error?: string;
	}[];
	mcp?: { name: string; tools?: object[]; connected: boolean }[];
}

const MODEL = { id: "model-x", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.example.test" };

async function sessionInfo(fixture: SessionFixture = {}): Promise<string> {
	let presented: { render(width: number): string[] }[] = [];
	const stats: Record<string, unknown> = {
		sessionFile: fixture.sessionFile,
		sessionId: "session-1",
		userMessages: 3,
		assistantMessages: 4,
		toolCalls: 5,
		toolResults: 6,
		totalMessages: 18,
		tokens: {
			input: 1200,
			output: 340,
			reasoning: 0,
			cacheRead: fixture.cacheRead ?? 0,
			cacheWrite: fixture.cacheWrite ?? 0,
			total: 1540,
		},
		cost: fixture.cost ?? 0,
	};
	if ("premiumRequests" in fixture) stats.premiumRequests = fixture.premiumRequests;
	const settings: Record<string, unknown> = { "provider.appendOnlyContext": fixture.appendOnly };
	const mcp = fixture.mcp;
	const ctx = {
		session: {
			getSessionStats: () => stats,
			sessionManager: { getUsageStatistics: () => ({ premiumRequests: fixture.usageLogPremiumRequests ?? 0 }) },
			model: fixture.model,
			modelRegistry: {
				authStorage: {
					hasOAuth: () => true,
					has: () => false,
					hasAuth: () => true,
					describeCredentialSource: () => "auth.json",
				},
			},
			providerSessionState: new Map(),
		},
		settings: { get: (key: string) => settings[key] },
		lspServers: fixture.lspServers,
		mcpManager: mcp && {
			getConnectedServers: () => mcp.map(server => server.name),
			getConnection: (name: string) => {
				const server = mcp.find(entry => entry.name === name);
				return server?.connected ? { tools: server.tools } : undefined;
			},
		},
		present: (blocks: { render(width: number): string[] }[]) => {
			presented = blocks;
		},
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleSessionCommand();
	return presented.flatMap(block => block.render(200)).join("\n");
}

async function infoLines(fixture: SessionFixture = {}): Promise<string[]> {
	return stripVTControlCharacters(await sessionInfo(fixture))
		.split("\n")
		.map(line => line.trim());
}

describe("session and provider", () => {
	it("names the session file, or In-memory without one", async () => {
		expect(await infoLines({ sessionFile: "/sessions/s.jsonl" })).toContain("File: /sessions/s.jsonl");
		expect(await infoLines()).toContain("File: In-memory");
		expect(await infoLines()).toContain("ID: session-1");
	});

	it("reads No model selected without a model and lists the model's fields with one", async () => {
		const without = await infoLines();
		expect(without).toContain("No model selected");
		const withModel = await infoLines({ model: MODEL });
		expect(withModel).not.toContain("No model selected");
		expect(withModel).toContain("Model: model-x");
		expect(withModel).toContain("Auth: oauth");
		expect(withModel).toContain("Source: auth.json");
	});

	it("lists the message counts", async () => {
		const lines = await infoLines();
		const start = lines.indexOf("Messages");
		expect(lines.slice(start, start + 6)).toEqual([
			"Messages",
			"User: 3",
			"Assistant: 4",
			"Tool Calls: 5",
			"Tool Results: 6",
			"Total: 18",
		]);
	});

	it("states whether append-only context is active and its setting, naming the provider under auto", async () => {
		const appendOnly = async (fixture: SessionFixture) =>
			(await infoLines(fixture)).find(line => line.startsWith("Append-Only:"));
		expect(await appendOnly({ appendOnly: "on", model: MODEL })).toBe("Append-Only: active (setting: on)");
		expect(await appendOnly({ appendOnly: "off", model: MODEL })).toBe("Append-Only: inactive (setting: off)");
		expect(await appendOnly({ model: MODEL })).toBe("Append-Only: inactive (setting: auto (anthropic))");
		expect(await appendOnly({})).toBe("Append-Only: inactive (setting: auto (?))");
		expect(await appendOnly({ model: { ...MODEL, provider: "deepseek" } })).toBe(
			"Append-Only: active (setting: auto (deepseek))",
		);
		const raw = await sessionInfo({ appendOnly: "on" });
		expect(raw).toContain(theme.fg("success", "active"));
	});

	it("prints its sections in a fixed order", async () => {
		const lines = await infoLines({
			model: MODEL,
			cost: 1,
			lspServers: [{ name: "ts", status: "ready", fileTypes: [".ts"] }],
			mcp: [],
		});
		const headings = ["Session Info", "Provider", "Messages", "Tokens", "Cost", "LSP Servers", "MCP Servers"];
		const positions = headings.map(heading => lines.indexOf(heading));
		expect(positions.every(position => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		const appendOnly = lines.findIndex(line => line.startsWith("Append-Only:"));
		expect(appendOnly).toBeGreaterThan(positions[2]!);
		expect(appendOnly).toBeLessThan(positions[3]!);
	});
});

describe("tokens and cost", () => {
	it("lists cache reads and writes only above zero", async () => {
		const none = await infoLines();
		expect(none.some(line => line.startsWith("Cache"))).toBe(false);
		const both = await infoLines({ cacheRead: 2500, cacheWrite: 7 });
		expect(both).toContain(`Cache Read: ${(2500).toLocaleString()}`);
		expect(both).toContain("Cache Write: 7");
		const readOnly = await infoLines({ cacheRead: 9 });
		expect(readOnly).toContain("Cache Read: 9");
		expect(readOnly.some(line => line.startsWith("Cache Write"))).toBe(false);
	});

	it("prints a cost section only when cost or premium requests are above zero", async () => {
		expect(await infoLines({ premiumRequests: 0 })).not.toContain("Cost");
		const costOnly = await infoLines({ premiumRequests: 0, cost: 0.123456 });
		expect(costOnly.slice(costOnly.indexOf("Cost"), costOnly.indexOf("Cost") + 2)).toEqual(["Cost", "Total: 0.1235"]);
		expect(costOnly.some(line => line.startsWith("Premium Requests"))).toBe(false);
		const premiumOnly = await infoLines({ premiumRequests: 2 });
		expect(premiumOnly.slice(premiumOnly.indexOf("Cost"), premiumOnly.indexOf("Cost") + 2)).toEqual([
			"Cost",
			"Premium Requests: 2",
		]);
	});

	it("rounds premium requests to cents, so a fraction under half a cent prints no cost", async () => {
		expect(await infoLines({ premiumRequests: 0.004 })).not.toContain("Cost");
		expect(await infoLines({ premiumRequests: 0.006 })).toContain("Premium Requests: 0.01");
	});

	it("reads premium requests from the usage log when the stats carry no number", async () => {
		expect(await infoLines({ usageLogPremiumRequests: 3 })).toContain("Premium Requests: 3");
		expect(await infoLines({ premiumRequests: "7", usageLogPremiumRequests: 4 })).toContain("Premium Requests: 4");
		expect(await infoLines({ premiumRequests: 5, usageLogPremiumRequests: 4 })).toContain("Premium Requests: 5");
	});
});

describe("servers", () => {
	it("prints no LSP section without language servers", async () => {
		expect(await infoLines()).not.toContain("LSP Servers");
		expect(await infoLines({ lspServers: [] })).not.toContain("LSP Servers");
	});

	it("prints each language server's status in its colour and an error with its message", async () => {
		const raw = await sessionInfo({
			lspServers: [
				{ name: "ts", status: "ready", fileTypes: [".ts", ".tsx"] },
				{ name: "py", status: "available", fileTypes: [".py"] },
				{ name: "rs", status: "connecting", fileTypes: [".rs"] },
				{ name: "go", status: "error", fileTypes: [".go"], error: "spawn failed" },
				{ name: "c", status: "error", fileTypes: [".c"] },
				{ name: "md", status: "ready", fileTypes: [".md"], error: "stale" },
			],
		});
		const lines = stripVTControlCharacters(raw)
			.split("\n")
			.map(line => line.trim());
		const start = lines.indexOf("LSP Servers");
		expect(lines.slice(start, start + 7)).toEqual([
			"LSP Servers",
			"ts: ready (.ts, .tsx)",
			"py: available (.py)",
			"rs: connecting (.rs)",
			"go: error: spawn failed (.go)",
			"c: error (.c)",
			"md: ready (.md)",
		]);
		expect(raw).toContain(theme.fg("success", "ready"));
		expect(raw).toContain(theme.fg("dim", "available"));
		expect(raw).toContain(theme.fg("warning", "connecting"));
		expect(raw).toContain(theme.fg("error", "error: spawn failed"));
	});

	it("prints MCP servers only with a manager, None connected without servers", async () => {
		expect(await infoLines()).not.toContain("MCP Servers");
		const empty = await infoLines({ mcp: [] });
		expect(empty.slice(empty.indexOf("MCP Servers"), empty.indexOf("MCP Servers") + 2)).toEqual([
			"MCP Servers",
			"None connected",
		]);
	});

	it("prints each MCP server's tool count, zero for a server without a connection or tools", async () => {
		const lines = await infoLines({
			mcp: [
				{ name: "files", tools: [{}, {}, {}], connected: true },
				{ name: "search", connected: true },
				{ name: "gone", tools: [{}], connected: false },
			],
		});
		const start = lines.indexOf("MCP Servers");
		expect(lines.slice(start, start + 4)).toEqual([
			"MCP Servers",
			"files: connected (3 tools)",
			"search: connected (0 tools)",
			"gone: connected (0 tools)",
		]);
	});
});
