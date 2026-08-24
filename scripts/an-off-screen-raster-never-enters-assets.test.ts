// WHY THIS EXISTS
//
// `scripts/demos/render-proof.ts` draws a component's ANSI into a PNG without a
// display. That is a fast way to look at a fill or a ground WHILE YOU WORK, and it
// is not evidence: it draws a fixture written by hand, at a chosen width, through a
// constructed call, so it cannot show that the surface is reachable, that the state
// is real, or that the block is positioned and clipped the way a session draws it.
// `docs/handbook/src/foundations/verification.md` is the authority and says so; a
// dark fill that was invisible in one of these rasters shipped as a black slab on a
// real terminal, which is the incident behind the rule.
//
// THE CLASS THIS CLOSES. Not "those two pictures": any raster reaching a published
// surface. `render-proof.ts` writes exactly `<out>-grey.png` and `<out>-black.png`,
// so the suffix pair IS the detector, and it cannot be evaded without renaming the
// tool's own output. The set is read off the filesystem at run time and compared to
// a pinned list by exact equality, so a NEW raster fails this suite rather than
// landing quietly, and a driver that starts publishing one fails with it.
//
// THE PINNED SET IS LEGACY AND SHRINK-ONLY. The 24 files below were committed under
// an earlier rule that sanctioned them. They are not evidence and no document may
// cite them; each is replaced by a real capture when its feature is next touched,
// and every removal shrinks this list. Adding a line to it is the one edit that is
// not allowed.
//
// WHAT IT DOES NOT CATCH. A raster committed under some other name — `foo-dark.png`,
// or a hand-cropped copy — is invisible here, because nothing in the bytes says how
// the picture was made. It also cannot see a raster published outside `assets/`;
// citations are the other half and are covered by the doc-link checks.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const ASSETS = path.join(import.meta.dirname, "..", "assets");

// Every off-screen raster in `assets/` today. Shrink this list; never grow it.
const LEGACY_RASTERS = [
	"cache-block-settings-off-black.png",
	"cache-block-settings-off-grey.png",
	"cache-block-settings-on-black.png",
	"cache-block-settings-on-grey.png",
	"default-effort-ownership-black.png",
	"default-effort-ownership-grey.png",
	"effort-variants-black.png",
	"effort-variants-grey.png",
	"model-chain-editor-black.png",
	"model-chain-editor-grey.png",
	"model-effort-two-tier-black.png",
	"model-effort-two-tier-grey.png",
	"model-effort-wide-ladder-black.png",
	"model-effort-wide-ladder-grey.png",
	"rules-experimental-off-black.png",
	"rules-experimental-off-grey.png",
	"rules-experimental-on-black.png",
	"rules-experimental-on-grey.png",
	"rules-section-typescript-black.png",
	"rules-section-typescript-grey.png",
	"setup-subagents-default-black.png",
	"setup-subagents-default-grey.png",
	"setup-subagents-specialists-black.png",
	"setup-subagents-specialists-grey.png",
];

async function rastersUnder(dir: string, prefix = ""): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			found.push(...(await rastersUnder(path.join(dir, entry.name), rel)));
			continue;
		}
		if (entry.name.endsWith("-grey.png") || entry.name.endsWith("-black.png")) found.push(rel);
	}
	return found.sort();
}

describe("off-screen rasters and the assets directory", () => {
	// Exact equality in both directions: a new raster fails it, and so does deleting
	// one without striking its line, which is what keeps the list shrinking with the
	// files rather than drifting into a list of names that are no longer there.
	it("holds exactly the legacy rasters and no new one", async () => {
		expect(await rastersUnder(ASSETS)).toEqual([...LEGACY_RASTERS].sort());
	});

	it("keeps every demo driver from publishing one", async () => {
		const demos = path.join(import.meta.dirname, "demos");
		const publishing: string[] = [];
		for (const entry of await fs.readdir(demos, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const source = await fs.readFile(path.join(demos, entry.name), "utf8");
			// A driver that pipes a render into `render-proof.ts` and names `assets/`
			// on the same line is writing a raster into the published directory.
			for (const line of source.split("\n")) {
				if (line.includes("render-proof.ts") && line.includes("assets/")) publishing.push(entry.name);
			}
		}
		expect(publishing).toEqual([]);
	});
});
