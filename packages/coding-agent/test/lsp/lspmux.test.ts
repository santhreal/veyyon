import { describe, expect, it } from "bun:test";
import { isLspmuxSupported, wrapWithLspmux } from "@veyyon/coding-agent/lsp/lspmux";

/**
 * lspmux multiplexes several LSP clients over one long-lived server process. These two
 * pure helpers decide whether a spawn request is rewritten to go through the lspmux
 * binary, and they were untested. The rewrite is load-bearing: a wrong branch either
 * starves a supported server of multiplexing or, worse, mangles the argv of a server
 * that lspmux does not understand.
 *
 * The contracts pinned here:
 *  - isLspmuxSupported matches on the command's BASE NAME, so both "rust-analyzer" and
 *    "/usr/bin/rust-analyzer" are supported while any other server is not.
 *  - wrapWithLspmux is a pure passthrough (original command + original args, never an
 *    env injection) whenever lspmux is unavailable, not running, has no binary path, or
 *    the server is unsupported. A passthrough must NOT set LSPMUX_SERVER.
 *  - The default `rust-analyzer` invocation with no args is special-cased to run the
 *    lspmux binary directly with empty args and NO env, because lspmux itself defaults
 *    to rust-analyzer. Any other supported invocation (a full path, or extra args) is
 *    rewritten to the `client` subcommand with LSPMUX_SERVER naming the real server,
 *    and user args are forwarded after a `--` separator.
 */

const running = { available: true, running: true, binaryPath: "/opt/lspmux", config: null };

describe("isLspmuxSupported", () => {
	it("matches the base name so a bare command and a full path both count", () => {
		expect(isLspmuxSupported("rust-analyzer")).toBe(true);
		expect(isLspmuxSupported("/usr/local/bin/rust-analyzer")).toBe(true);
	});

	it("rejects any server not in the supported set", () => {
		expect(isLspmuxSupported("gopls")).toBe(false);
		expect(isLspmuxSupported("typescript-language-server")).toBe(false);
		expect(isLspmuxSupported("/usr/bin/pyright-langserver")).toBe(false);
	});
});

describe("wrapWithLspmux passthrough", () => {
	it("returns the original command and args when lspmux is not available", () => {
		const off = { available: false, running: false, binaryPath: null, config: null };
		expect(wrapWithLspmux("rust-analyzer", ["--foo"], off)).toEqual({
			command: "rust-analyzer",
			args: ["--foo"],
		});
	});

	it("returns the original command when lspmux is available but not running", () => {
		const notRunning = { available: true, running: false, binaryPath: "/opt/lspmux", config: null };
		const result = wrapWithLspmux("rust-analyzer", undefined, notRunning);
		expect(result).toEqual({ command: "rust-analyzer", args: [] });
		expect("env" in result).toBe(false);
	});

	it("passes an unsupported server straight through even while lspmux runs", () => {
		const result = wrapWithLspmux("gopls", ["serve"], running);
		expect(result).toEqual({ command: "gopls", args: ["serve"] });
		expect("env" in result).toBe(false);
	});
});

describe("wrapWithLspmux rewrite", () => {
	it("runs the lspmux binary directly with empty args and no env for default rust-analyzer", () => {
		const result = wrapWithLspmux("rust-analyzer", undefined, running);
		expect(result).toEqual({ command: "/opt/lspmux", args: [] });
		expect("env" in result).toBe(false);
	});

	it("uses the client subcommand and forwards args after -- when the default server gets args", () => {
		expect(wrapWithLspmux("rust-analyzer", ["--log", "trace"], running)).toEqual({
			command: "/opt/lspmux",
			args: ["client", "--", "--log", "trace"],
			env: { LSPMUX_SERVER: "rust-analyzer" },
		});
	});

	it("rewrites a full-path rust-analyzer to the client subcommand naming the real server", () => {
		expect(wrapWithLspmux("/usr/bin/rust-analyzer", undefined, running)).toEqual({
			command: "/opt/lspmux",
			args: ["client"],
			env: { LSPMUX_SERVER: "/usr/bin/rust-analyzer" },
		});
	});
});
