/**
 * Builds a system prompt the way a launch does, then prints, as JSON, each host fact the prompt's
 * `<workstation>` block shows and the most bytes any string holding that value keeps alive beyond
 * its own characters. A JSC substring's snapshot size is the parent it slices, so a fact cut from a
 * file and cached for the process life reports the whole file.
 *
 * Run in a fresh process: the snapshot reads the whole heap, and a test runner's heap holds whatever
 * the files before it left behind.
 */
import { buildSystemPrompt } from "../../src/system-prompt";

export interface HostFact {
	label: string;
	value: string;
	/** False for a value too long for the snapshot to show whole, which the fixture cannot match. */
	measurable: boolean;
	/** String cells in the heap whose value is this fact. */
	cells: number;
	/** The most snapshot bytes one of those cells holds beyond its own characters. */
	pinned: number;
}

/** V8-format snapshots cut a string's value at this many characters. */
const VALUE_CAP = 1024;
/** A flat string cell's header, over its one or two bytes per character. */
const STRING_HEADER = 64;

/**
 * Label and UTF-8 value of each `- Label: value` line in the prompt's workstation block. The values
 * are bytes, not strings, so no string this fixture holds is one of the cells the snapshot counts.
 */
async function workstationFacts(): Promise<Array<{ label: string; bytes: Uint8Array }>> {
	const prompt = await buildSystemPrompt({
		resolvedCustomPrompt: "Base prompt",
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: {
			rootPath: import.meta.dirname,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		activeRepoContext: null,
	});
	const block = /<workstation>\n([\s\S]*?)\n<\/workstation>/.exec(prompt.systemPrompt.join("\n"))?.[1] ?? "";
	const encoder = new TextEncoder();
	return [...block.matchAll(/^- ([^:]+): (.+)$/gm)].map(([, label, value]) => ({
		label: JSON.parse(JSON.stringify(label)) as string,
		bytes: encoder.encode(value),
	}));
}

const found = await workstationFacts();
Bun.gc(true);
const snapshot = JSON.parse(Bun.generateHeapSnapshot("v8")) as {
	snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
	nodes: number[];
	strings: string[];
};
const decoder = new TextDecoder();
const facts: HostFact[] = found.map(({ label, bytes }) => {
	const value = decoder.decode(bytes);
	return { label, value, measurable: value.length < VALUE_CAP, cells: 0, pinned: 0 };
});
const fields = snapshot.snapshot.meta.node_fields;
const stride = fields.length;
const TYPE = fields.indexOf("type");
const NAME = fields.indexOf("name");
const SIZE = fields.indexOf("self_size");
const stringType = snapshot.snapshot.meta.node_types[0].indexOf("string");
const byValue = new Map(facts.filter(fact => fact.measurable).map(fact => [fact.value, fact]));
for (let at = 0; at < snapshot.nodes.length; at += stride) {
	if (snapshot.nodes[at + TYPE] !== stringType) continue;
	const fact = byValue.get(snapshot.strings[snapshot.nodes[at + NAME]!]!);
	if (!fact) continue;
	fact.cells++;
	fact.pinned = Math.max(fact.pinned, snapshot.nodes[at + SIZE]! - (fact.value.length * 2 + STRING_HEADER));
}
process.stdout.write(JSON.stringify(facts));
