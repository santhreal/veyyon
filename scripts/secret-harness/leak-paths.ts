/**
 * Report WHERE a credential appears in a JSON event stream, never what it is.
 *
 * `leak/json-event-stream-never-prints-a-value` can only say yes or no, and "the
 * value is somewhere in twenty events" is not something anyone can act on. This
 * walks every parsed event and prints the dotted path of each string that contains
 * the seed, so the harness reports `tool_execution_start.args.command` instead of a
 * boolean. Array indices collapse to `[]` because the interesting fact is which
 * FIELD carries a credential, not which element of one turn did.
 *
 * The seed arrives in `HARNESS_SEED` and is never echoed: the whole point of the
 * digest-and-path discipline in this harness is that its own output can be pasted
 * into a bug report.
 */

import { readFileSync } from "node:fs";

const seed = process.env.HARNESS_SEED;
if (seed === undefined || seed === "") {
	process.stderr.write("leak-paths: HARNESS_SEED must be set to the value to locate\n");
	process.exit(2);
}

const file = process.argv[2];
if (file === undefined) {
	process.stderr.write("leak-paths: expected a JSONL file argument\n");
	process.exit(2);
}

const counts = new Map<string, number>();

const record = (path: string): void => {
	counts.set(path, (counts.get(path) ?? 0) + 1);
};

const walk = (node: unknown, path: string): void => {
	if (typeof node === "string") {
		if (node.includes(seed)) record(path);
		return;
	}
	if (Array.isArray(node)) {
		for (const item of node) walk(item, `${path}[]`);
		return;
	}
	if (node !== null && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) walk(value, path === "" ? key : `${path}.${key}`);
	}
};

const text = readFileSync(file, "utf8");
for (const line of text.split("\n")) {
	if (line.trim() === "") continue;
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		// A line the stream emitted as something other than one JSON object still
		// matters if it carries the value: report it as an opaque location rather
		// than dropping it, because an unparseable sink is the easiest one to miss.
		if (line.includes(seed)) record("(non-json output line)");
		continue;
	}
	const type = event !== null && typeof event === "object" && "type" in event ? String(event.type) : "(untyped)";
	walk(event, type);
}

const paths = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
for (const [path, count] of paths) process.stdout.write(count > 1 ? `${path} x${count}\n` : `${path}\n`);
