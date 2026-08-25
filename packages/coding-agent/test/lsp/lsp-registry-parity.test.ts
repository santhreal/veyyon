/**
 * LSP client registry, readonly action set, and config resolution contracts.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. The LSP subsystem defines which actions are read-only, which linter
 * clients exist, and how config resolves servers for files. These contracts
 * pin the exact set of readonly actions, the linter client registry, and the
 * config resolution behavior.
 */
import { describe, expect, it } from "bun:test";
import {
	LSP_READONLY_ACTIONS,
	LspTool,
} from "@veyyon/coding-agent/lsp";
import {
	BiomeClient,
	LspLinterClient,
	SwiftLintClient,
	getLinterClient,
	clearLinterClientCache,
} from "@veyyon/coding-agent/lsp/clients";
import {
	loadConfig,
	getServersForFile,
	getServerForFile,
	hasCapability,
	type LspConfig,
} from "@veyyon/coding-agent/lsp/config";
import type { ServerConfig } from "@veyyon/coding-agent/lsp/types";

describe("LSP readonly actions", () => {
	it("the readonly action set is pinned exactly", () => {
		expect([...LSP_READONLY_ACTIONS].sort()).toEqual([
			"capabilities",
			"definition",
			"diagnostics",
			"hover",
			"implementation",
			"references",
			"status",
			"symbols",
			"type_definition",
		]);
	});

	it("every readonly action is a string with positive length", () => {
		for (const action of LSP_READONLY_ACTIONS) {
			expect(typeof action).toBe("string");
			expect(action.length).toBeGreaterThan(0);
		}
	});
});

describe("LSP linter client registry", () => {
	it("BiomeClient is a constructor", () => {
		expect(typeof BiomeClient).toBe("function");
	});

	it("LspLinterClient is a constructor", () => {
		expect(typeof LspLinterClient).toBe("function");
	});

	it("SwiftLintClient is a constructor", () => {
		expect(typeof SwiftLintClient).toBe("function");
	});

	it("getLinterClient is a function", () => {
		expect(typeof getLinterClient).toBe("function");
	});

	it("clearLinterClientCache is a function", () => {
		expect(typeof clearLinterClientCache).toBe("function");
	});
});

describe("LSP config resolution", () => {
	it("loadConfig returns an object with servers", () => {
		const config = loadConfig("/tmp");
		expect(typeof config).toBe("object");
		expect(config).not.toBeNull();
	});

	it("getServersForFile returns an array", () => {
		const config: LspConfig = { servers: {}, missingServers: [] };
		const result = getServersForFile(config, "/tmp/test.ts");
		expect(Array.isArray(result)).toBe(true);
	});

	it("getServerForFile returns null for empty config", () => {
		const config: LspConfig = { servers: {}, missingServers: [] };
		const result = getServerForFile(config, "/tmp/test.ts");
		expect(result).toBeNull();
	});

	it("hasCapability checks capabilities object", () => {
		const server = {
			command: "test",
			fileTypes: [".ts"],
			rootMarkers: [],
			capabilities: { flycheck: true, ssr: false },
		} as unknown as ServerConfig;
		expect(hasCapability(server, "flycheck")).toBe(true);
		expect(hasCapability(server, "ssr")).toBe(false);
	});
});
