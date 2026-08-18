import { describe, expect, it } from "bun:test";
import {
	DEFAULT_STATS_DASHBOARD_PORT,
	parseStatsDashboardArgs,
} from "../../src/slash-commands/helpers/stats-dashboard";

/**
 * `parseStatsDashboardArgs` parses the argument string of the `/stats` slash
 * command into a port, or the error message shown to the user. It is the sole gate
 * on the launch port.
 *
 * WHAT THIS CLOSES. `/stats` used to read `--port N`, `-p N` and `--port=N`, and a
 * slash command's arguments are plain words. The grammar is now `/stats [<port>]`:
 * one optional argument, recognized by its own shape because there is nothing else
 * for `/stats` to read and therefore nothing an integer could be confused with.
 *
 * The contracts:
 *   - no args uses the default port;
 *   - a bare integer is the port, including the 0 and 65535 boundaries;
 *   - a leading-zero value is parsed numerically ("080" -> 80);
 *   - a non-integer word is refused, naming the word and the usage;
 *   - a second word is refused rather than ignored;
 *   - every removed option spelling is refused, naming the plain word, and the
 *     refusal never advertises the spelling as a way in.
 *
 * WHAT IT DOES NOT CATCH: whether the port reaches `stats.startServer`. That is
 * `launchStatsDashboard`'s contract, not this parser's.
 */

const USAGE = "Usage: /stats [<port>]";

describe("parseStatsDashboardArgs", () => {
	it("uses the default port when no arguments are given", () => {
		expect(parseStatsDashboardArgs("")).toEqual({ port: DEFAULT_STATS_DASHBOARD_PORT });
		expect(parseStatsDashboardArgs("   ")).toEqual({ port: DEFAULT_STATS_DASHBOARD_PORT });
		expect(DEFAULT_STATS_DASHBOARD_PORT).toBe(3847);
	});

	it("reads a bare integer as the port", () => {
		expect(parseStatsDashboardArgs("8080")).toEqual({ port: 8080 });
		expect(parseStatsDashboardArgs("  8080  ")).toEqual({ port: 8080 });
	});

	it("accepts the 0 and 65535 boundaries and rejects 65536", () => {
		expect(parseStatsDashboardArgs("0")).toEqual({ port: 0 });
		expect(parseStatsDashboardArgs("65535")).toEqual({ port: 65535 });
		expect(parseStatsDashboardArgs("65536")).toEqual({ error: `Invalid port: 65536. ${USAGE}` });
	});

	it("parses a leading-zero value numerically", () => {
		expect(parseStatsDashboardArgs("080")).toEqual({ port: 80 });
	});

	it("refuses a word that is not an integer", () => {
		expect(parseStatsDashboardArgs("abc")).toEqual({ error: `Invalid port: abc. ${USAGE}` });
		expect(parseStatsDashboardArgs("80.5")).toEqual({ error: `Invalid port: 80.5. ${USAGE}` });
	});

	it("refuses a second word instead of ignoring it", () => {
		expect(parseStatsDashboardArgs("8080 extra")).toEqual({ error: `Unknown argument: extra. ${USAGE}` });
		expect(parseStatsDashboardArgs("8080 9090")).toEqual({ error: `Unknown argument: 9090. ${USAGE}` });
	});

	/**
	 * The removed spellings must be REFUSED, not silently accepted and not silently
	 * dropped: a `/stats --port 9000` that launched on 3847 would be a lie, and one
	 * that launched on 9000 would keep a grammar nobody can see.
	 */
	it.each(["--port 9000", "-p 9000", "--port=9000", "--port", "-p", "--bogus"])(
		"refuses the removed option spelling %p and names the plain word",
		args => {
			const result = parseStatsDashboardArgs(args);
			expect(result).not.toHaveProperty("port");
			expect(result).toHaveProperty("error");
			const message = "error" in result ? result.error : "";
			expect(message).toContain(args.split(/\s+/)[0]);
			expect(message).toContain(USAGE);
		},
	);

	it("tells a removed port option to write the port as a plain word", () => {
		expect(parseStatsDashboardArgs("--port 9000")).toEqual({
			error: `--port is gone: write the port as a plain word, as in \`/stats 8080\`.\n${USAGE}`,
		});
		expect(parseStatsDashboardArgs("-p 9000")).toEqual({
			error: `-p is gone: write the port as a plain word, as in \`/stats 8080\`.\n${USAGE}`,
		});
		expect(parseStatsDashboardArgs("--port=9000")).toEqual({
			error: `--port=9000 is gone: write the port as a plain word, as in \`/stats 8080\`.\n${USAGE}`,
		});
	});

	it("names no dash spelling in the usage it advertises", () => {
		const result = parseStatsDashboardArgs("abc");
		const message = "error" in result ? result.error : "";
		expect(message).toContain(USAGE);
		expect(USAGE).not.toContain("-");
	});
});
