/**
 * Streams diagrams through the markdown theme's Mermaid resolver the way a transcript draws a fence
 * that is still arriving, one resolve per frame on the text received so far, and prints as JSON the
 * string bytes the resolver left live in the process that runs this file. argv[2] is the number of
 * diagrams to stream.
 */
import { postmortem } from "@veyyon/utils";
import { liveStringBytes } from "../../../utils/test/helpers/live-string-bytes";
import { clearMermaidCache, resolveMermaidAscii } from "../../src/theme/mermaid-cache";

export interface StreamedDiagramGrowth {
	diagrams: number;
	frames: number;
	grown: number;
}

/** Characters each frame adds to the fence, about one streamed delta. */
const CHUNK = 16;
/** The width the transcript draws at, narrower than the as-authored layout of the wider diagrams. */
const WIDTH = 100;

/** A 25-edge flowchart whose labels are unique to `seed`, so no two diagrams share a render. */
function flowchart(seed: number): string {
	const lines = ["graph TD"];
	for (let node = 0; node < 24; node += 1) {
		lines.push(
			`    N${seed}_${node}[Step ${node} of flow ${seed}] --> N${seed}_${node + 1}[Step ${node + 1} of flow ${seed}]`,
		);
	}
	return lines.join("\n");
}

async function measure(diagrams: number): Promise<StreamedDiagramGrowth> {
	// One render of an unrelated diagram loads the renderer's code and tables before the baseline.
	resolveMermaidAscii("graph LR\n  warm[Warm] --> up[Up]", { maxWidth: WIDTH });
	clearMermaidCache();
	const before = await liveStringBytes();
	let frames = 0;
	for (let seed = 0; seed < diagrams; seed += 1) {
		const source = flowchart(seed);
		for (let end = CHUNK; end < source.length + CHUNK; end += CHUNK) {
			resolveMermaidAscii(source.slice(0, end), { maxWidth: WIDTH });
			frames += 1;
		}
	}
	const grown = (await liveStringBytes()) - before;
	return { diagrams, frames, grown };
}

try {
	const diagrams = Number(process.argv[2]);
	if (!Number.isInteger(diagrams) || diagrams < 1) throw new Error("usage: streamed-diagram-growth.ts <diagrams>");
	process.stdout.write(`${JSON.stringify(await measure(diagrams))}\n`);
} finally {
	await postmortem.cleanup();
}
