/**
 * WHY: every user-visible provider name in this product is derived from a slug by
 * `formatProviderName`, and it used to derive them by title-casing each `-`/`_` segment. That is a
 * defect for any vendor whose own spelling title case cannot reach, and it shipped: the account
 * manager card lists EVERY provider, so a real recording of it read `Openai Codex`,
 * `Cloudflare Ai Gateway`, `Github Copilot`, `Deepseek`, `Google Gemini Cli`, `Xai Oauth`,
 * `Minimax Cn` and `Nvidia` down the sidebar, with `/usage`, the usage CLI and the status line
 * repeating them.
 *
 * The class is "a provider label rendered from a slug", not "the eight names someone noticed", so
 * these tests never name a provider. They enumerate the catalog at run time - the bundled provider
 * keys and the descriptor table - and they take the CASING AUTHORITY from the catalog too, via each
 * descriptor's own `catalogDiscovery.label`. A provider added tomorrow whose descriptor spells a
 * segment differently from the renderer turns this suite red without anyone editing it.
 *
 * What it does NOT catch: a brand-new vendor whose correct spelling appears nowhere in this repo
 * (no descriptor label, no table entry). Nothing in the tree knows that name, so nothing can assert
 * it; the mechanical fallback renders it and a human has to notice. It also cannot catch a WRONG
 * table value that agrees with a wrong descriptor label, because then the repo has one consistent
 * spelling and the disagreement this suite looks for does not exist.
 */
import { describe, expect, it } from "bun:test";
import { getBundledProviders } from "@veyyon/catalog/models";
import { CATALOG_PROVIDERS, getCatalogProviderEntry } from "@veyyon/catalog/provider-models/descriptors";
import { formatProviderName, PROVIDER_NAME_SEGMENTS } from "@veyyon/coding-agent/slash-commands/helpers/format";

/** Every provider id the product can be asked to render, from both catalog authorities. */
function providerIds(): string[] {
	const ids = new Set<string>(getBundledProviders() as readonly string[]);
	for (const provider of CATALOG_PROVIDERS) ids.add(provider.id);
	return [...ids].sort();
}

function segmentsOf(id: string): string[] {
	return id.split(/[-_]/g).filter(part => part.length > 0);
}

/** The rule as it was: the thing every assertion below has to be able to reject. */
function mechanicalName(id: string): string {
	return id
		.split(/[-_]/g)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

function containsWord(haystack: string, word: string): boolean {
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(haystack);
}

describe("a provider name rendered from its slug", () => {
	it("covers the whole catalog, so the sweeps below cannot be empty", () => {
		const ids = providerIds();

		expect(ids.length).toBeGreaterThan(50);
		expect(ids.every(id => formatProviderName(id).length > 0)).toBe(true);
	});

	/**
	 * The table is the product's answer for a segment; this asserts the answer actually reaches the
	 * rendered label for every id that contains the segment, and that the mechanical spelling is
	 * nowhere in it. `Openai Codex` fails on both halves at once.
	 */
	it("spells every tabled segment the way the table spells it, in every id that carries one", () => {
		const wrong: string[] = [];
		let checked = 0;
		for (const id of providerIds()) {
			const rendered = formatProviderName(id);
			for (const segment of segmentsOf(id)) {
				const vendor = PROVIDER_NAME_SEGMENTS.get(segment);
				if (!vendor) continue;
				checked += 1;
				if (!containsWord(rendered, vendor)) wrong.push(`${id}: expected ${vendor}, got ${rendered}`);
				const mechanical = segment[0].toUpperCase() + segment.slice(1);
				if (mechanical !== vendor && containsWord(rendered, mechanical)) {
					wrong.push(`${id}: still renders ${mechanical} in ${rendered}`);
				}
			}
		}

		expect(wrong).toEqual([]);
		// A table whose keys hit nothing would pass the loop above vacuously.
		expect(checked).toBeGreaterThan(20);
	});

	/**
	 * The catalog descriptor is the one in-repo authority for how a provider writes its name, so the
	 * renderer must not disagree with it. This is the half that fails by default: a new provider
	 * arrives with a descriptor label, and if its casing needs a table entry that nobody added, the
	 * disagreement is reported here without this file changing.
	 */
	it("agrees with each descriptor's own catalog label wherever both name the same word", () => {
		const disagreements: string[] = [];
		let compared = 0;
		for (const id of providerIds()) {
			const label = getCatalogProviderEntry(id)?.catalogDiscovery?.label;
			if (!label) continue;
			// A label word, or the whole label with its separators dropped, keyed by how the slug would
			// spell it: "Hugging Face" answers for the segment `huggingface`, "CoreWeave Serverless
			// Inference" answers for `coreweave` through its first word.
			const authority = new Map<string, string>();
			const compact = label.replace(/[^A-Za-z0-9]/g, "");
			if (compact) authority.set(compact.toLowerCase(), label);
			for (const word of label.split(/\s+/)) {
				const bare = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.]+$/g, "");
				const key = bare.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
				if (key) authority.set(key, bare);
			}
			const rendered = formatProviderName(id);
			for (const segment of segmentsOf(id)) {
				const vendor = authority.get(segment);
				// Nothing to learn from a label word the mechanical rule already reaches; every other
				// word is a casing fact the renderer has to reproduce.
				if (!vendor || vendor === segment[0].toUpperCase() + segment.slice(1)) continue;
				compared += 1;
				if (!containsWord(rendered, vendor)) {
					disagreements.push(`${id}: catalog says "${label}", renderer says "${rendered}"`);
				}
			}
		}

		expect(disagreements).toEqual([]);
		expect(compared).toBeGreaterThan(5);
	});

	/**
	 * A table entry that matches no provider id is dead: it cannot be exercised, and it survives the
	 * removal of the provider it was written for. Every key must be reachable from a real slug.
	 */
	it("carries no segment the catalog never produces", () => {
		const live = new Set(providerIds().flatMap(segmentsOf));

		expect([...PROVIDER_NAME_SEGMENTS.keys()].filter(key => !live.has(key))).toEqual([]);
	});

	/**
	 * The self-falsification control. Reverting `formatProviderName` to the mechanical rule must be a
	 * visible change on real catalog ids, otherwise the sweeps above are green for no reason.
	 */
	it("differs from the mechanical rule on many real provider ids", () => {
		const changed = providerIds().filter(id => mechanicalName(id) !== formatProviderName(id));

		expect(changed.length).toBeGreaterThan(10);
	});
});
