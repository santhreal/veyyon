import { describe, expect, it } from "bun:test";
import {
	DEFAULT_STATS_DASHBOARD_PORT,
	parseStatsDashboardArgs,
} from "../../src/slash-commands/helpers/stats-dashboard";

/**
 * parseStatsDashboardArgs parses the argument string of the `/stats` slash command
 * into a port (or an error message shown to the user). It had no test despite being
 * pure and the sole gate on the launch port. The contracts:
 *   - no args uses the default port;
 *   - the port is accepted as `--port N`, `-p N`, or `--port=N`;
 *   - a missing value after `--port`/`-p` is a "Missing port" error;
 *   - a non-numeric or out-of-range value (> 65535) is an "Invalid port" error,
 *     while 0 and 65535 are in range;
 *   - a leading-zero value is parsed numerically ("080" -> 80);
 *   - any other token is an "Unknown option" error.
 * A regression here would launch the dashboard on the wrong port or reject a valid
 * invocation.
 */

describe("parseStatsDashboardArgs", () => {
	it("uses the default port when no arguments are given", () => {
		expect(parseStatsDashboardArgs("")).toEqual({ port: DEFAULT_STATS_DASHBOARD_PORT });
		expect(DEFAULT_STATS_DASHBOARD_PORT).toBe(3847);
	});

	it("accepts --port, -p, and --port= forms", () => {
		expect(parseStatsDashboardArgs("--port 8080")).toEqual({ port: 8080 });
		expect(parseStatsDashboardArgs("-p 8080")).toEqual({ port: 8080 });
		expect(parseStatsDashboardArgs("--port=8080")).toEqual({ port: 8080 });
	});

	it("reports a missing port value after --port", () => {
		expect(parseStatsDashboardArgs("--port")).toEqual({
			error: "Missing port. Usage: /stats [--port <port>]",
		});
	});

	it("reports a non-numeric port as invalid", () => {
		expect(parseStatsDashboardArgs("--port abc")).toEqual({ error: "Invalid port: abc" });
	});

	it("reports a negative-looking port as invalid (the leading minus fails the digit check)", () => {
		expect(parseStatsDashboardArgs("--port -5")).toEqual({ error: "Invalid port: -5" });
	});

	it("rejects a port above 65535 but accepts the 65535 boundary and 0", () => {
		expect(parseStatsDashboardArgs("--port 65536")).toEqual({ error: "Invalid port: 65536" });
		expect(parseStatsDashboardArgs("--port 65535")).toEqual({ port: 65535 });
		expect(parseStatsDashboardArgs("--port 0")).toEqual({ port: 0 });
	});

	it("parses a leading-zero value numerically", () => {
		expect(parseStatsDashboardArgs("--port 080")).toEqual({ port: 80 });
	});

	it("reports any other token as an unknown option", () => {
		expect(parseStatsDashboardArgs("--bogus")).toEqual({
			error: "Unknown option: --bogus. Usage: /stats [--port <port>]",
		});
		expect(parseStatsDashboardArgs("extra")).toEqual({
			error: "Unknown option: extra. Usage: /stats [--port <port>]",
		});
	});
});
