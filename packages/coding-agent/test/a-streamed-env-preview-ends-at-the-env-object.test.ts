/**
 * The env a streaming bash preview states is the `env` object and nothing after it.
 *
 * THE DEFECT. `bashEnvForDisplay` reads the raw streamed argument buffer so an assignment shows
 * before the JSON object closes. The scan matched `"env":{` and then took every `"key":"string"`
 * pair to the END OF THE BUFFER as an entry, so a call whose `env` is followed by `command`, `cwd`
 * or the intent key drew `A="1" cwd="/x" ls` on the pending card until the parsed args replaced it.
 * The bash schema orders `command, env, timeout, cwd`, so any call with both `env` and `cwd`
 * reached it on every stream.
 *
 * THE CLASS. A sibling of `env` at the top level of the call read as an entry of it. The sibling
 * keys are taken from the bash tool's OWN wire schema at run time, plus the intent key the harness
 * injects, and every one of them is streamed byte by byte after a closed `env`; a key the schema
 * grows later is swept without anyone editing this file. The buffer is walked as JSON: a `}` inside
 * a value is a character, `"env"` inside the command is a word, and the slice ends at the object's
 * closing brace.
 *
 * WHAT IT DOES NOT CATCH. The settled card: once `tool_execution_start` arrives the parsed args
 * replace the buffer and this path is never read. And the reveal cadence that hands the buffer to
 * the renderer, which is `tool-args-reveal.ts`'s own suite.
 */

import { describe, expect, it } from "bun:test";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { getThemeByName } from "@veyyon/coding-agent/theme/theme";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { bashEnvForDisplay, bashToolView } from "@veyyon/coding-agent/tools/shell/bash-view";
import { isRecord, sanitizeText } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { makeToolSession } from "./helpers/tool-session";

/** The env the preview states for every prefix of a buffer, in arrival order. */
function envAtEveryPrefix(buffer: string): (Record<string, string> | undefined)[] {
	const states: (Record<string, string> | undefined)[] = [];
	for (let end = 1; end <= buffer.length; end++)
		states.push(bashEnvForDisplay({ __partialJson: buffer.slice(0, end) }));
	return states;
}

/** A JSON sample of each type a schema property may declare, so a sibling of any type is streamed. */
function sampleFor(property: unknown): string {
	const type = isRecord(property) ? property.type : undefined;
	switch (type) {
		case "number":
		case "integer":
			return "30";
		case "boolean":
			return "true";
		case "object":
			return '{"NESTED":"value"}';
		case "array":
			return '["value"]';
		default:
			return '"value"';
	}
}

/** The top-level keys of the bash call, with the sample JSON each streams as. */
function siblingKeys(): Record<string, string> {
	const schema = toolWireSchema(new BashTool(makeToolSession()));
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const siblings: Record<string, string> = { [INTENT_FIELD]: '"Listing the tree"' };
	for (const [key, property] of Object.entries(properties)) {
		if (key !== "env") siblings[key] = sampleFor(property);
	}
	return siblings;
}

describe("the streamed env preview ends at the env object", () => {
	const siblings = siblingKeys();

	it("sweeps the schema the tool declares, not a list written here", () => {
		// The schema is the source. A run that found no sibling would pass every loop below with no
		// assertion made, so the set is pinned: a key added to the bash schema lands here by exact
		// equality and the person adding it records that the preview never reads it as an entry.
		expect(Object.keys(siblings).sort()).toEqual(
			["backgroundAfter", "command", "cwd", INTENT_FIELD, "pty", "timeout"].sort(),
		);
	});

	for (const [key, sample] of Object.entries(siblings)) {
		it(`never reads a top-level \`${key}\` after the env object as an assignment`, () => {
			const buffer = `{"env":{"A":"1"},"${key}":${sample}}`;
			const states = envAtEveryPrefix(buffer);
			for (const state of states) {
				if (state === undefined) continue;
				expect(Object.keys(state)).toEqual(["A"]);
			}
			// The object closed before the sibling arrived, so the closed value is the one shown at
			// every later prefix, the reported 30-byte cut included.
			expect(states[states.length - 1]).toEqual({ A: "1" });
			expect(bashEnvForDisplay({ __partialJson: buffer.slice(0, 30) })).toEqual({ A: "1" });
		});
	}

	it("reads the reported buffer as one entry at every prefix", () => {
		const buffer = '{"env":{"A":"1"},"command":"ls -la","i":"Listing"}';
		for (const state of envAtEveryPrefix(buffer)) {
			if (state !== undefined) expect(Object.keys(state)).toEqual(["A"]);
		}
		expect(bashEnvForDisplay({ __partialJson: buffer.slice(0, 30) })).toEqual({ A: "1" });
		expect(bashEnvForDisplay({ __partialJson: buffer })).toEqual({ A: "1" });
	});

	it("keeps reading an env that arrives after the command, and stops at its close", () => {
		const buffer = '{"command":"ls","env":{"A":"1"},"cwd":"/repo"}';
		const states = envAtEveryPrefix(buffer);
		for (const state of states) {
			if (state !== undefined) expect(Object.keys(state)).toEqual(["A"]);
		}
		expect(states[states.length - 1]).toEqual({ A: "1" });
		// The entry shows as soon as its value has a first byte, which is the reason the buffer is read.
		expect(bashEnvForDisplay({ __partialJson: '{"command":"ls","env":{"A":"1' })).toEqual({ A: "1" });
	});

	it("takes a closing brace inside a value as a character, not as the end of the object", () => {
		expect(bashEnvForDisplay({ __partialJson: '{"env":{"A":"}"' })).toEqual({ A: "}" });
		expect(bashEnvForDisplay({ __partialJson: '{"env":{"A":"}","B":"{"},"cwd":"/x"' })).toEqual({ A: "}", B: "{" });
		// An escaped quote inside a value keeps the string open past it.
		expect(bashEnvForDisplay({ __partialJson: '{"env":{"A":"say \\"}\\""},"cwd":"/x"' })).toEqual({ A: 'say "}"' });
	});

	it("takes `env` inside the command's own string as a word, not as the key", () => {
		expect(
			bashEnvForDisplay({ __partialJson: '{"command":"echo \\"env\\": {\\"X\\":\\"1\\"}","cwd":"/x"' }),
		).toBeUndefined();
		expect(bashEnvForDisplay({ __partialJson: '{"command":"env","cwd":"/x"' })).toBeUndefined();
	});

	it("states nothing while the env value has not opened as an object", () => {
		expect(bashEnvForDisplay({ __partialJson: '{"env":' })).toBeUndefined();
		expect(bashEnvForDisplay({ __partialJson: '{"env":{' })).toBeUndefined();
		expect(bashEnvForDisplay({ __partialJson: '{"env":null,"cwd":"/x"' })).toBeUndefined();
	});

	it("draws the pending card lead with the env entries and never the working directory as one", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const view = bashToolView.renderCall(
			{ __partialJson: '{"env":{"A":"1"},"command":"ls -la","cwd":"/srv/app","i":"Listing"}'.slice(0, 44) },
			{ expanded: false, partial: true },
		);
		const rows = sanitizeText(drawToolView(view, theme!).render(120).join("\n"));
		expect(rows).toContain('A="1"');
		expect(rows).not.toContain('command="');
		expect(rows).not.toContain('cwd="');
	});
});
