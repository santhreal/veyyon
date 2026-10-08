import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { gzipSync } from "node:zlib";
import * as utils from "@veyyon/utils";
import { TempDir } from "@veyyon/utils";
import { AbortError } from "@veyyon/utils/abortable";
import { handleDocsRs } from "../../src/scrapers/docs-rs";
import { isScraperDegrade, MAX_BYTES, type RenderResult, type ScraperDegrade } from "../../src/scrapers/types";

/**
 * WHY: a docs.rs page renders from the crate's rustdoc JSON (format version 61), fetched once and
 * then read from the cache. This suite pins the markdown of a module listing, a single item and
 * every rustdoc type variant, against defects seen in real output: a lifetime rendered with a
 * doubled apostrophe (`''de`), an `impl Trait` or `dyn Trait` bound rendered as `_`, a method
 * receiver rendered as `&Self`, the synthetic generic of an argument-position `impl Trait` listed
 * as a parameter, `async`/`const`/`unsafe` read from where an older format kept them, a constant's
 * value read from where an older format kept it, the `<T as Trait>` of a qualified path dropped,
 * a page resolving to the same-named item of another kind (`macro.make.html` and `fn make`), a
 * `pub use` resolved under the imported name instead of the exported one, a glob re-export listed
 * as one entry instead of the members it imports, and macros, procedural macros and unions missing
 * from a module listing. It also pins the fetch failures that degrade, the cancellation that does
 * not, and the cache round trip.
 *
 * Gap: the fixture follows format version 61 plus the older layouts the renderer accepts (a bound
 * trait wrapped in `resolved_path`, a path under `name`, qualifiers on the function); a format
 * version that moves another field is not covered. An item a glob re-export shadows is listed twice.
 */

const VERSION = "1.2.3";
const BASE = `https://docs.rs/veyyon-fixture/${VERSION}/demo`;
const JSON_URL = `https://docs.rs/crate/veyyon-fixture/${VERSION}/json.gz`;
const FOOTER = `---\n*${VERSION}*`;

const NO_GENERICS = { params: [], where_predicates: [] };
const LIFETIME_A = { name: "'a", kind: { lifetime: { outlives: [] } } };
const TYPE_T = { name: "T", kind: { type: { bounds: [], default: null, is_synthetic: false } } };
const SELF = { generic: "Self" };

function item(name: string | null, inner: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return { name, docs: null, attrs: [], visibility: "public", deprecation: null, inner, ...extra };
}

function fn(inputs: unknown[][], output: unknown, header: Record<string, boolean> = {}, extra = {}) {
	return {
		sig: { inputs, output, is_c_variadic: false },
		generics: NO_GENERICS,
		header: { is_const: false, is_unsafe: false, is_async: false, abi: "Rust", ...header },
		has_body: true,
		...extra,
	};
}

const path = (name: string, args: unknown[] = []) => ({
	path: name,
	id: 0,
	args: args.length ? { angle_bracketed: { args, constraints: [] } } : null,
});
const ref = (type: unknown, lifetime: string | null = null, is_mutable = false) => ({
	borrowed_ref: { lifetime, is_mutable, type },
});
const reexport = (name: string, id: number | null, is_glob = false) =>
	item(null, { use: { source: `crate::${name}`, name, id, is_glob } });
const impl = (trait: unknown, items: number[], extra: Record<string, unknown> = {}) =>
	item(null, {
		impl: { trait, items, is_synthetic: false, blanket_impl: null, generics: NO_GENERICS, ...extra },
	});

let nested: unknown = { primitive: "u8" };
for (let i = 0; i < 12; i++) nested = { slice: nested };

/** Every rustdoc type variant as a function input, with the text it renders as. */
const KITCHEN_INPUTS: Array<[name: string, type: unknown, rendered: string]> = [
	["a", { generic: "T" }, "T"],
	["b", "infer", "_"],
	[
		"c",
		{ resolved_path: path("Vec", [{ type: { primitive: "u8" } }, { lifetime: "'a" }, { const: { expr: "3" } }]) },
		"Vec<u8, 'a, _>",
	],
	["d", ref({ primitive: "str" }, "'a", true), "&'a mut str"],
	["e", { tuple: [{ primitive: "u8" }, { generic: "T" }] }, "(u8, T)"],
	["f", { slice: { primitive: "u8" } }, "[u8]"],
	["g", { array: { type: { primitive: "u8" }, len: "4" } }, "[u8; 4]"],
	["h", { raw_pointer: { is_mutable: false, type: { primitive: "u8" } } }, "*const u8"],
	[
		"i",
		{ qualified_path: { name: "Item", args: null, self_type: { generic: "T" }, trait: path("Iterator") } },
		"<T as Iterator>::Item",
	],
	["j", { qualified_path: { name: "Assoc", args: null, self_type: SELF, trait: null } }, "Self::Assoc"],
	[
		"k",
		{
			impl_trait: [
				{ trait_bound: { trait: path("AsRef", [{ type: { resolved_path: path("Path") } }]), modifier: "none" } },
				{ outlives: "'static" },
				{ use: ["'a"] },
			],
		},
		"impl AsRef<Path> + 'static + ?",
	],
	[
		"l",
		{ dyn_trait: { traits: [{ trait: path("Fn") }, { trait: path("Send") }], lifetime: "'static" } },
		"dyn Fn + Send + 'static",
	],
	[
		"m",
		{ impl_trait: [{ trait_bound: { trait: { resolved_path: { name: "Display", id: 0, args: null } } } }] },
		"impl Display",
	],
	["n", { function_pointer: { sig: {} } }, "fn(...)"],
	["o", { pat: { type: { primitive: "u8" } } }, "_"],
	["p", nested, `${"[".repeat(11)}_${"]".repeat(11)}`],
	["q", { constructor: {} }, "_"],
];

const KITCHEN_SIG = `async unsafe fn kitchen<T, N>(${KITCHEN_INPUTS.map(([name, , text]) => `${name}: ${text}`).join(", ")}) -> Result<(), Error>`;

function fixtureCrate() {
	const index: Record<string, unknown> = {
		0: item(
			"demo",
			{ module: { items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24, 25, 999] } },
			{
				docs: "Demo crate.\nSecond line.",
			},
		),
		// `inner` and `prelude` glob-import each other; each is expanded once.
		1: item("inner", { module: { items: [21, 22] } }, { docs: "Inner module." }),
		21: item("Deep", { struct: { generics: NO_GENERICS, impls: [] } }, { docs: "Deep doc." }),
		22: reexport("prelude", 17, true),
		17: item("prelude", { module: { items: [23] } }, { docs: "Common imports." }),
		23: reexport("inner", 1, true),
		19: reexport("alias", 1),
		20: { ...reexport("Private", 21), visibility: "default" },
		24: item("Secret", { struct: { generics: NO_GENERICS, impls: [] } }, { visibility: "default" }),
		2: item(
			"Point",
			{
				struct: {
					generics: { params: [LIFETIME_A, TYPE_T], where_predicates: [] },
					impls: [30, 31, 32, 33, 34],
				},
			},
			{ docs: "A point.\nMore detail.", deprecation: { since: "1.0", note: "use Vec2" } },
		),
		30: impl(null, [40, 41, 42, 43, 44]),
		40: item(
			"new",
			{ function: fn([["x", { primitive: "i32" }]], SELF, { is_const: true }) },
			{
				docs: "Make one.\nDetails.",
			},
		),
		41: item("len", { function: fn([["self", ref(SELF)]], { primitive: "usize" }) }),
		42: item("consume", { function: fn([["self", SELF]], null) }),
		43: item("boxed", { function: fn([["self", { resolved_path: path("Box", [{ type: SELF }]) }]], null) }),
		44: item("edit", {
			function: fn(
				[
					["self", ref(SELF, "'a", true)],
					["v", { primitive: "u8" }],
				],
				null,
			),
		}),
		31: impl(path("Deserialize", [{ lifetime: "'de" }]), [45]),
		45: item("deserialize", { function: fn([["d", { generic: "D" }]], SELF) }),
		32: impl(path("Send"), [], { is_synthetic: true }),
		33: impl(path("Into", [{ type: { generic: "U" } }]), [], { blanket_impl: { generic: "T" } }),
		34: impl(path("Deserialize", [{ lifetime: "'de" }]), []),
		3: item(
			"kitchen",
			{
				function: {
					...fn(
						KITCHEN_INPUTS.map(([name, type]) => [name, type]),
						{
							resolved_path: path("Result", [
								{ type: { tuple: [] } },
								{ type: { resolved_path: path("Error") } },
							]),
						},
						{ is_async: true, is_unsafe: true },
					),
					generics: {
						params: [
							LIFETIME_A,
							TYPE_T,
							{ name: "impl AsRef<Path>", kind: { type: { bounds: [], default: null, is_synthetic: true } } },
							{ name: "N", kind: { const: { type: { primitive: "usize" }, default: null } } },
						],
						where_predicates: [],
					},
				},
			},
			{ docs: "Kitchen sink.\nEvery type." },
		),
		4: reexport("Reexported", 21),
		5: item("Hidden", { struct: { generics: NO_GENERICS, impls: [] } }, { visibility: "crate" }),
		6: item(
			"Shape",
			{
				trait: { is_auto: false, is_unsafe: true, items: [50, 51, 52], generics: NO_GENERICS, implementations: [] },
			},
			{ docs: "A shape." },
		),
		50: item(
			"area",
			{ function: fn([["self", ref(SELF)]], { primitive: "f64" }, {}, { has_body: false }) },
			{
				docs: "Area.\nMore.",
			},
		),
		51: item("name", { function: fn([["self", ref(SELF)]], { resolved_path: path("String") }) }),
		52: item("Unit", { assoc_type: { generics: NO_GENERICS, bounds: [], type: null } }, { docs: "Unit of measure." }),
		7: item("Color", { enum: { generics: NO_GENERICS, variants: [60, 61, 62], impls: [] } }),
		60: item("Red", { variant: { kind: "plain" } }, { docs: "Warm." }),
		61: item("Green", { variant: { kind: "plain" } }),
		8: item("make", { macro: "macro_rules! make {\n    () => { ... };\n}" }, { docs: "Makes things." }),
		18: item("make", { function: fn([], { primitive: "u8" }) }),
		9: item("LIMIT", {
			constant: { type: { primitive: "u32" }, const: { expr: "10", value: "10u32", is_literal: true } },
		}),
		// An older format keeps the value on the constant itself.
		25: item("OLD", { constant: { type: { primitive: "u8" }, expr: "1", value: "1u8", is_literal: true } }),
		10: item("Bits", { union: { generics: NO_GENERICS, fields: [], impls: [] } }, { docs: "Bits." }),
		11: item("Pair", {
			type_alias: { type: { tuple: [{ generic: "T" }, { generic: "T" }] }, generics: NO_GENERICS },
		}),
		12: item("GLOBAL", { static: { type: { primitive: "u8" }, is_mutable: false, is_unsafe: false, expr: "0" } }),
		13: reexport("my_i32", null),
		14: item("Derive", { proc_macro: { kind: "derive", helpers: [] } }, { docs: "Derives." }),
		15: item("legacy", {
			function: { sig: { inputs: [], output: null }, generics: NO_GENERICS, is_async: true, has_body: true },
		}),
		16: item(
			"Restricted",
			{ struct: { generics: NO_GENERICS, impls: [] } },
			{
				visibility: { restricted: { parent: 0, path: "crate::inner" } },
			},
		),
	};
	return { root: 0, crate_version: VERSION, index, paths: {}, format_version: 61 };
}

const DEEP_LISTING = `## Structs\n\n- **Deep** — Deep doc.\n\n${FOOTER}`;
const INNER_LISTING = `# demo::inner\n\nInner module.\n\n${DEEP_LISTING}`;

const { preconnect } = globalThis.fetch;
let cacheDir: TempDir;
let fetched: string[];

/** Serve `body` as the rustdoc JSON download, honouring the request's abort signal, and record every request. */
function serveJson(body: Uint8Array | string | ReadableStream<Uint8Array>, status = 200): void {
	const serve = async (input: string | URL | Request, init?: RequestInit) => {
		fetched.push(String(input instanceof Request ? input.url : input));
		init?.signal?.throwIfAborted();
		return new Response(body, { status });
	};
	spyOn(globalThis, "fetch").mockImplementation(Object.assign(serve, { preconnect }));
}

function render(result: RenderResult | ScraperDegrade | null): RenderResult {
	if (result === null || isScraperDegrade(result)) throw new Error(`expected a render, got ${JSON.stringify(result)}`);
	return result;
}

async function page(suffix: string): Promise<string> {
	return render(await handleDocsRs(`${BASE}/${suffix}`, 10)).content;
}

beforeEach(async () => {
	cacheDir = await TempDir.create("@docs-rs-cache-");
	fetched = [];
	spyOn(utils, "getDocsRsCacheDir").mockReturnValue(cacheDir.path());
});

afterEach(async () => {
	vi.restoreAllMocks();
	await cacheDir.remove();
});

describe("a docs.rs page renders from the crate's rustdoc JSON", () => {
	beforeEach(() => serveJson(gzipSync(JSON.stringify(fixtureCrate()))));

	it("lists a module's public members by kind, each re-export under its exported name", async () => {
		const result = render(await handleDocsRs(`${BASE}/`, 10));

		expect({ method: result.method, notes: result.notes }).toEqual({
			method: "docs.rs",
			notes: ["Fetched via docs.rs rustdoc JSON"],
		});
		expect(fetched).toEqual([JSON_URL]);
		expect(result.content).toBe(
			[
				"# demo",
				"",
				"Demo crate.\nSecond line.",
				"",
				"## Modules\n\n- **inner** — Inner module.\n- **prelude** — Common imports.\n- **alias** — Inner module.",
				"",
				"## Macros\n\n- **make** — Makes things.",
				"",
				"## Procedural Macros\n\n- **Derive** — Derives.",
				"",
				"## Structs\n\n- **Point** — A point.\n- **Reexported** — Deep doc.",
				"",
				"## Enums\n\n- **Color**",
				"",
				"## Unions\n\n- **Bits** — Bits.",
				"",
				"## Traits\n\n- **Shape** — A shape.",
				"",
				`## Functions\n\n- \`${KITCHEN_SIG}\` — Kitchen sink.\n- \`async fn legacy()\`\n- \`fn make() -> u8\``,
				"",
				"## Type Aliases\n\n- **Pair**",
				"",
				"## Constants\n\n- **LIMIT**\n- **OLD**",
				"",
				"## Statics\n\n- **GLOBAL**",
				"",
				FOOTER,
			].join("\n"),
		);
	});

	it("walks into a submodule, a glob re-export's members and a re-exported module", async () => {
		expect(await page("inner/index.html")).toBe(INNER_LISTING);
		expect(await page("prelude/")).toBe(`# demo::prelude\n\nCommon imports.\n\n${DEEP_LISTING}`);
		expect(await page("alias/")).toBe(`# demo::alias\n\nInner module.\n\n${DEEP_LISTING}`);
		expect(await page("prelude/struct.Deep.html")).toBe(
			`# struct Deep\n\n\`\`\`rust\nstruct Deep\n\`\`\`\n\nDeep doc.\n\n${FOOTER}`,
		);
	});

	it.each([
		["a path through an item that is not a module", "Point/"],
		["an item the module does not export", "struct.Missing.html"],
		["a crate-private item", "struct.Hidden.html"],
		["a path-restricted item", "struct.Restricted.html"],
		["a private item", "struct.Secret.html"],
		["a private import", "struct.Private.html"],
		["an item of another kind", "trait.Point.html"],
		["an import of an item outside the crate", "struct.my_i32.html"],
		// `make` exists, so a page kind the table lacks reaches the kind lookup rather than a name miss.
		["a page kind no crate item has", "keyword.make.html"],
	])("finds no page for %s", async (_label, suffix) => {
		expect(await handleDocsRs(`${BASE}/${suffix}`, 10)).toBeNull();
	});

	it("renders a struct with its deprecation, methods and receivers, and explicit trait implementations", async () => {
		expect(await page("struct.Point.html")).toBe(
			[
				"# struct Point",
				"",
				"> **Deprecated**: use Vec2",
				"",
				"```rust\nstruct Point<T>\n```",
				"",
				"A point.\nMore detail.",
				"",
				"## Methods",
				"",
				"- `const fn new(x: i32) -> Self` — Make one.",
				"- `fn len(&self) -> usize`",
				"- `fn consume(self)`",
				"- `fn boxed(self: Box<Self>)`",
				"- `fn edit(&'a mut self, v: u8)`",
				"",
				"## Trait Implementations\n\n- Deserialize<'de>",
				"",
				FOOTER,
			].join("\n"),
		);
	});

	it("renders a trait's required and provided items, an enum's variants and a procedural macro", async () => {
		expect(await page("trait.Shape.html")).toBe(
			[
				"# trait Shape",
				"",
				"```rust\nunsafe trait Shape\n```",
				"",
				"A shape.",
				"",
				"## Required Methods\n\n- `fn area(&self) -> f64` — Area.\n- `type Unit` — Unit of measure.",
				"",
				"## Provided Methods\n\n- `fn name(&self) -> String`",
				"",
				FOOTER,
			].join("\n"),
		);
		expect(await page("enum.Color.html")).toBe(
			`# enum Color\n\n\`\`\`rust\nenum Color\n\`\`\`\n\n## Variants\n\n- \`Red\` — Warm.\n- \`Green\`\n\n${FOOTER}`,
		);
		expect(await page("derive.Derive.html")).toBe(`# proc macro Derive\n\nDerives.\n\n${FOOTER}`);
	});

	it("resolves a page to the item of its kind when a macro and a function share a name", async () => {
		expect(await page("macro.make.html")).toBe(
			`# macro make\n\n\`\`\`rust\nmacro_rules! make {\n    () => { ... };\n}\n\`\`\`\n\nMakes things.\n\n${FOOTER}`,
		);
		expect(await page("fn.make.html")).toBe(`# function make\n\n\`\`\`rust\nfn make() -> u8\n\`\`\`\n\n${FOOTER}`);
	});

	it("renders every rustdoc type variant in a signature, and constant, union and alias declarations", async () => {
		expect(await page("fn.kitchen.html")).toBe(
			`# function kitchen\n\n\`\`\`rust\n${KITCHEN_SIG}\n\`\`\`\n\nKitchen sink.\nEvery type.\n\n${FOOTER}`,
		);
		expect(await page("constant.LIMIT.html")).toBe(
			`# constant LIMIT\n\n\`\`\`rust\nconst LIMIT: u32 = 10u32\n\`\`\`\n\n${FOOTER}`,
		);
		expect(await page("constant.OLD.html")).toBe(
			`# constant OLD\n\n\`\`\`rust\nconst OLD: u8 = 1u8\n\`\`\`\n\n${FOOTER}`,
		);
		expect(await page("union.Bits.html")).toBe(
			`# union Bits\n\n\`\`\`rust\nunion Bits\n\`\`\`\n\nBits.\n\n${FOOTER}`,
		);
		expect(await page("type.Pair.html")).toBe(
			`# type alias Pair\n\n\`\`\`rust\ntype Pair = (T, T)\n\`\`\`\n\n${FOOTER}`,
		);
	});

	it("renders a re-exported item under its exported name", async () => {
		expect(await page("struct.Reexported.html")).toBe(
			`# struct Reexported\n\n\`\`\`rust\nstruct Reexported\n\`\`\`\n\nDeep doc.\n\n${FOOTER}`,
		);
	});

	it("caches the JSON and serves the next page from the cache", async () => {
		const first = render(await handleDocsRs(`${BASE}/`, 10));
		const second = render(await handleDocsRs(`${BASE}/inner/`, 10));

		expect(fetched).toEqual([JSON_URL]);
		expect(first.notes).toEqual(["Fetched via docs.rs rustdoc JSON"]);
		expect(second.notes).toEqual(["Loaded from docs.rs rustdoc JSON cache"]);
		expect(second.content).toBe(INNER_LISTING);
	});

	it("rethrows a cancellation instead of degrading, and caches nothing", async () => {
		const pending = handleDocsRs(`${BASE}/`, 10, AbortSignal.abort());

		await expect(pending).rejects.toBeInstanceOf(AbortError);
		expect(await fs.readdir(cacheDir.path(), { recursive: true })).toEqual([]);
	});
});

describe("a docs.rs download that cannot be rendered degrades", () => {
	it.each([
		["an HTTP failure", () => serveJson("missing", 404), "HTTP 404"],
		[
			"JSON with no item index",
			() => serveJson(gzipSync(JSON.stringify({ root: 0 }))),
			"rustdoc JSON had no item index",
		],
		[
			"a body over the download cap",
			() => {
				const chunk = new Uint8Array(1024 * 1024);
				let sent = 0;
				serveJson(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							sent += chunk.length;
							if (sent > MAX_BYTES + chunk.length) controller.close();
							else controller.enqueue(chunk);
						},
					}),
				);
			},
			`rustdoc JSON exceeds ${MAX_BYTES} compressed bytes`,
		],
	])("degrades on %s and caches nothing", async (_label, serve, reason) => {
		serve();

		expect(await handleDocsRs(`${BASE}/`, 10)).toEqual({
			scraperDegrade: true,
			note: `docs.rs scraper failed (${reason}); fell back to a generic fetch`,
		});
		expect(await fs.readdir(cacheDir.path(), { recursive: true })).toEqual([]);
	});

	it("degrades on a payload that is not gzip", async () => {
		serveJson("not gzip");

		expect(await handleDocsRs(`${BASE}/`, 10)).toEqual({
			scraperDegrade: true,
			note: expect.stringMatching(/^docs\.rs scraper failed \(.+\); fell back to a generic fetch$/),
		});
	});
});
