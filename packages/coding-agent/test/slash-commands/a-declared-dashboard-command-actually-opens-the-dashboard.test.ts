/**
 * `/stats` is reachable. Declaring a parser is not shipping a command.
 *
 * THE DEFECT THIS CLOSES. `parseStatsDashboardArgs` and `launchStatsDashboard`
 * were written, exported, and covered by a suite that opens with the words "the
 * argument string of the `/stats` slash command" — and NOTHING in the product
 * called either one. There was no `stats` entry in the declarations and none in
 * the registry, so `/stats` was an unknown command: the usage string
 * `Usage: /stats [<port>]` named a command that did not exist, every refusal it
 * could produce was unreachable, and the dashboard was only openable as
 * `veyyon stats` from a shell. A parser with a full test suite and no caller
 * reads exactly like a finished feature, which is why it survived.
 *
 * WHY THE EXISTING SUITE COULD NOT SEE IT. `stats-dashboard-args.test.ts` calls
 * the parser directly, as a unit, so it passes identically whether or not any
 * command routes to it. Its own "what this does not catch" note lists the launch,
 * not the wiring — the possibility that no surface reached the parser at all was
 * never in view. This file drives the real ACP dispatcher instead, so it fails if
 * the declaration, the registry entry, or the handler goes away.
 *
 * WHAT THIS DOES NOT CATCH. Only the REFUSAL paths are driven. A successful
 * `/stats 8080` binds a port, starts a server and opens a browser, none of which
 * belongs in a test process, so the happy path is proved by `veyyon stats` and by
 * `launchStatsDashboard`'s own contract rather than here. That means this suite
 * would stay green if the handler parsed correctly and then failed to launch. It
 * also asserts nothing about the TUI: `/stats` has no controller and no
 * `handleTui`, so both surfaces run the one handler driven below, and if a
 * `handleTui` is ever added it needs its own case.
 */
import { describe, expect, it } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/acp-builtins";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS } from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

/**
 * The real dispatcher, with output collected the way an ACP client receives it.
 *
 * No settings store is supplied because every line below is refused before the
 * launch, and a launch is the only thing that would read one. If a case is ever
 * added that reaches `launchStatsDashboard`, it needs a real one.
 */
async function dispatch(text: string): Promise<{ output: string; handled: boolean }> {
	const output: string[] = [];
	const runtime = {
		cwd: process.cwd(),
		output: (line: string) => {
			output.push(line);
		},
		session: { modelRegistry: { authStorage: undefined } },
	} as unknown as SlashCommandRuntime;
	const result = await executeAcpBuiltinSlashCommand(text, runtime);
	// `false` means no builtin matched, which is the defect this file exists for;
	// it must be distinguished from a match that consumed the input.
	const handled = result !== false && "consumed" in result && result.consumed === true;
	return { output: output.join("\n"), handled };
}

describe("a declared dashboard command actually opens the dashboard", () => {
	// The declaration is the surface that lists the command, and the picker and the
	// inline hint read it. Derived from the live table rather than restated, so
	// renaming the command fails here instead of leaving a stale assertion passing.
	it("is declared, with the plain-word port as its hint", () => {
		const declaration = BUILTIN_SLASH_COMMAND_DECLARATIONS.find(entry => entry.name === "stats");
		expect(declaration).toBeDefined();
		expect(declaration?.inlineHint).toBe("[<port>]");
		expect(declaration?.allowArgs).toBe(true);
		// A hint that offered a dashed spelling would be teaching a grammar the
		// parser refuses; the whole point of the hint is that it is typed next.
		expect(declaration?.inlineHint).not.toContain("-");
	});

	// THE ASSERTION THAT WAS RED BEFORE THE WIRING. `/stats` answered
	// "Unknown command" here, because nothing dispatched it.
	it("is dispatched rather than refused as an unknown command", async () => {
		const { output, handled } = await dispatch("/stats 65536");
		expect(handled).toBe(true);
		expect(output).not.toContain("Unknown command");
		// It reached the parser, and the parser's own refusal came back out.
		expect(output).toContain("Invalid port: 65536");
		expect(output).toContain("Usage: /stats [<port>]");
	});

	it("carries a removed option spelling's refusal out to the client", async () => {
		const { output } = await dispatch("/stats --port 9000");
		expect(output).toContain("--port is gone");
		expect(output).toContain("write the port as a plain word");
	});

	it("carries the plain word's refusal out to the client", async () => {
		const { output } = await dispatch("/stats port 9000");
		expect(output).toContain("port is gone");
		expect(output).toContain("write the port as a plain word");
	});

	it("refuses a second word instead of ignoring it", async () => {
		const { output } = await dispatch("/stats 8080 9090");
		expect(output).toContain("Unknown argument: 9090");
	});
});
