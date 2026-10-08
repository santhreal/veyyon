/**
 * Streams every block shape the streaming lexer freezes on into a `Markdown`, one chunk per frame
 * into a buffer of its own, and prints, as JSON, the string bytes per character of its text one
 * instance holds after a full collection beyond what the same text rendered once holds: while
 * streaming, and once sealed. Each arm is read right after a rendered-once baseline of its own.
 *
 * The figure is the size a heap snapshot gives each string: its cell plus its share of the buffer it
 * reads, so a slice counts the buffer it was cut from. `heapStats().extraMemorySize` also counts the
 * code the JIT compiles, and a tier-up that lands during the builds on one run and after them on
 * another moved that figure by several copies of the text.
 *
 * Each figure is read from a macrotask of its own. The collector scans the native stack
 * conservatively, so a register or a stack slot the builds left behind keeps their garbage alive;
 * from the event loop no frame of the builds is on the stack, and the instances under measurement
 * are reachable through `held` alone.
 *
 * It runs in a process of its own because the figure is the process's string bytes: in a test
 * process shared with other files, their leftover allocations land in the same figure.
 */
import { clearRenderCache, Markdown, type MarkdownTheme } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "../test-themes.js";

const TEXT_CHARS = 32_000;
const CHUNK = 64;
const WIDTH = 80;
const COPIES = 6;

/**
 * One unit of every block shape the streaming lexer freezes on, and of one fence the stream keeps
 * open until its last unit. Units are joined by a blank line; the third field, when present, closes
 * the shape before the closing paragraph.
 */
const SHAPES: ReadonlyArray<readonly [string, (i: number) => string, string?]> = [
	[
		"a paragraph",
		i => `Paragraph ${i} of plain prose that wraps across the terminal width more than once, so it lays out as rows.`,
	],
	["a heading", i => `## Heading number ${i} with a few words`],
	["a fenced code block", i => `\`\`\`ts\nconst value${i} = compute(${i});\nconst other${i} = value${i} * 2;\n\`\`\``],
	["a table", i => `| Column | Value ${i} |\n| --- | --- |\n| row | ${i} |`],
	["a blockquote", i => `> Quoted line ${i} that carries a sentence of prose inside the quote.`],
	["a thematic break", i => `Rule ${i} follows.\n\n---`],
	["a display math block", i => `$$\nx_${i} = \\frac{a}{b}\n$$`],
	["a list closed by a paragraph", i => `- item ${i} one\n- item ${i} two\n\nParagraph after list ${i}.`],
	[
		"a diff fence open until its last line",
		i => `${i === 0 ? "```diff\n" : ""}+ added line ${i} of a patch the stream delivers as one block`,
		"```\n\n",
	],
];

export const SHAPE_NAMES: readonly string[] = SHAPES.map(([name]) => name);

type Arm = "streaming" | "sealed" | "rendered once";

/** Per shape, the string bytes per character one streamed instance holds beyond one rendered once. */
export type RetentionReport = Record<string, Record<"streaming" | "sealed", number>>;

const CLOSING = "A closing paragraph that is still arriving when the stream seals. ".repeat(8);

/**
 * The test theme with a highlighter, so a diff fence streams through the highlighted-row caches.
 * Each row is a string of its own, as the native highlighter returns.
 */
const THEME: MarkdownTheme = {
	...defaultMarkdownTheme,
	highlightCode: code => code.split("\n").map(line => structuredClone(`+${line}`)),
};

function textOf(unit: (i: number) => string, close = ""): string {
	let text = "";
	for (let i = 0; text.length < TEXT_CHARS; i++) text += `${unit(i)}\n\n`;
	return text + close + CLOSING;
}

function build(full: string, arm: Arm): Markdown {
	clearRenderCache();
	const md = new Markdown("", 0, 0, THEME);
	md.transientRenderCache = arm !== "rendered once";
	let text = "";
	for (let pos = 0; pos < full.length; pos += CHUNK) {
		// An append and a read: a new flat buffer per frame, as a provider's accumulated text is.
		text += full.slice(pos, pos + CHUNK);
		if (arm === "rendered once") {
			text.charCodeAt(text.length - 1);
		} else {
			md.setText(text);
			md.render(WIDTH);
		}
	}
	if (arm === "rendered once") {
		md.setText(text);
		md.render(WIDTH);
	} else if (arm === "sealed") {
		md.transientRenderCache = false;
		md.render(WIDTH);
	}
	return md;
}

/** Fields per node of an `Inspector` heap snapshot: id, size, class name index, flags. */
const NODE_FIELDS = 4;

/** The instances under measurement, rooted here and nowhere on the stack. */
const held: Markdown[] = [];

function snapshotStringBytes(): number {
	// Builds the snapshot during a full collection, so only live strings are in it.
	const snapshot = Bun.generateHeapSnapshot();
	if (snapshot.type !== "Inspector") throw new Error(`heap snapshot type ${snapshot.type}, expected Inspector`);
	const stringClass = snapshot.nodeClassNames.indexOf("string");
	if (stringClass < 0) throw new Error("heap snapshot has no string class");
	let bytes = 0;
	for (let i = 0; i < snapshot.nodes.length; i += NODE_FIELDS) {
		if (snapshot.nodes[i + 2] === stringClass) bytes += snapshot.nodes[i + 1];
	}
	return bytes;
}

/** String bytes the heap holds, read from a macrotask of its own. */
function stringBytes(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	setImmediate(() => {
		try {
			resolve(snapshotStringBytes());
		} catch (err) {
			reject(err);
		}
	});
	return promise;
}

/** String bytes one instance built by `arm` holds after a full collection, per character of its text. */
async function heldPerChar(full: string, arm: Arm): Promise<number> {
	// Compiles the paths this arm takes before the baseline is read.
	build(full, arm);
	const before = await stringBytes();
	for (let i = 0; i < COPIES; i++) held.push(build(full, arm));
	const after = await stringBytes();
	held.length = 0;
	return (after - before) / COPIES / full.length;
}

if (import.meta.main) {
	const report: RetentionReport = {};
	for (const [name, unit, close] of SHAPES) {
		const full = textOf(unit, close);
		const excess = async (arm: "streaming" | "sealed"): Promise<number> => {
			const once = await heldPerChar(full, "rendered once");
			return (await heldPerChar(full, arm)) - once;
		};
		report[name] = { streaming: await excess("streaming"), sealed: await excess("sealed") };
	}
	process.stdout.write(JSON.stringify(report));
}
