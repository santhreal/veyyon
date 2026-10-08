import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getDocsRsCacheDir, isEnoent, logger, trimTrailingSlashes, truncate, tryParseJson } from "@veyyon/utils";
import { AbortError } from "@veyyon/utils/abortable";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import type { RenderResult, ScraperDegrade, SpecialHandler } from "./types";
import { buildResult, isScraperDegrade, MAX_BYTES, readCappedBody, scraperDegrade, tryParseUrl } from "./types";

// --- Rustdoc JSON types (the subset rendered here; format version 61, older layouts where noted) ---

interface RustdocCrate {
	root: number;
	crate_version: string | null;
	index: Record<string, RustdocItem>;
	paths: Record<string, { crate_id: number; path: string[]; kind: string }>;
	format_version: number;
}

interface RustdocItem {
	name: string | null;
	docs: string | null;
	attrs: string[];
	inner: Record<string, unknown>;
	visibility: string | { restricted: { parent: number; path: string } };
	deprecation: { since: string | null; note: string | null } | null;
}

interface FunctionQualifiers {
	is_const?: boolean;
	is_async?: boolean;
	is_unsafe?: boolean;
}

/** A function; its qualifiers are under `header`, or on the function itself in an older format. */
interface FunctionData extends FunctionQualifiers {
	sig: { inputs: [string, RustType][]; output: RustType | null };
	generics: Generics;
	header?: FunctionQualifiers;
	has_body: boolean;
}

interface Generics {
	params: GenericParam[];
	where_predicates: unknown[];
}

interface GenericParam {
	name: string;
	/** Single-key: `lifetime`, `type` (synthetic for an argument-position `impl Trait`) or `const`. */
	kind: { lifetime?: unknown; type?: { is_synthetic?: boolean }; const?: unknown };
}

// Rustdoc type representation — a union encoded as single-key objects
type RustType = Record<string, unknown>;

/** A path to a type or trait; `name` holds the path in an older format. */
interface RustPath {
	path?: string;
	name?: string;
	args?: { angle_bracketed?: { args: unknown[] } } | null;
}

interface BorrowedRef {
	lifetime: string | null;
	is_mutable: boolean;
	type: RustType;
}

interface ArrayType {
	type: RustType;
	len: string;
}

interface RawPointer {
	is_mutable: boolean;
	type: RustType;
}

interface QualifiedPath {
	name: string;
	self_type: RustType;
	trait: RustPath | RustType | null;
}

interface DynTrait {
	traits: Array<{ trait: RustPath | RustType }>;
	lifetime: string | null;
}

/** `impl` bounds: a trait, a lifetime (`outlives`), or a `use<..>` capture rendered as `?`. */
type ImplTraitBounds = Array<{ trait_bound?: { trait: RustPath | RustType }; outlives?: string }>;

// --- URL parsing ---

/** The `inner` kinds of the item each rustdoc page kind (`struct.Foo.html`) shows. */
const PAGE_ITEM_KINDS: Record<string, readonly string[]> = {
	struct: ["struct"],
	enum: ["enum"],
	union: ["union"],
	trait: ["trait"],
	traitalias: ["trait_alias"],
	fn: ["function"],
	type: ["type_alias"],
	constant: ["constant"],
	static: ["static"],
	macro: ["macro", "proc_macro"],
	attr: ["proc_macro"],
	derive: ["proc_macro"],
	primitive: ["primitive"],
};

interface DocsRsTarget {
	crateName: string;
	version: string;
	/** The module path, crate first: `["serde", "de"]` for a submodule, `["serde"]` for the root. */
	modulePath: string[];
	/** The item an item page shows (`struct.Serialize.html`): its page kind and name; null for a module page. */
	item: { kind: string; name: string } | null;
}

function parseDocsRsUrl(url: string): DocsRsTarget | null {
	const parsed = tryParseUrl(url);
	if (!parsed) return null;
	if (parsed.hostname !== "docs.rs") return null;

	const segments = trimTrailingSlashes(parsed.pathname).split("/").filter(Boolean);

	// Skip /crate/{name}/{version} overview pages — those are docs.rs chrome, not rustdoc
	if (segments[0] === "crate") return null;

	// Rustdoc pages: /{crate}/{version}/{crate_path}/[item.html]
	// Minimum: /{crate}/{version}/{crate}
	if (segments.length < 3) return null;

	const crateName = segments[0];
	const version = segments[1]; // "latest", "1.0.228", etc.

	// The rest is the module path, possibly ending with an item page
	const rest = segments.slice(2);
	let item: DocsRsTarget["item"] = null;

	const last = rest[rest.length - 1];
	const itemMatch = last?.match(/^([a-z]+)\.(.+)\.html$/);
	if (itemMatch && Object.hasOwn(PAGE_ITEM_KINDS, itemMatch[1])) {
		item = { kind: itemMatch[1], name: itemMatch[2] };
		rest.pop();
	} else if (last === "index.html") {
		rest.pop();
	}

	return { crateName, version, modulePath: rest, item };
}

// --- Type rendering ---

/** A rustdoc lifetime carries its apostrophe (`'a`); one without it gains one. */
function lifetimeText(lifetime: string): string {
	return lifetime.startsWith("'") ? lifetime : `'${lifetime}`;
}

function renderGenericArg(arg: unknown, depth: number): string {
	if (typeof arg !== "object" || arg === null) return "_";
	const { type, lifetime } = arg as { type?: RustType | null; lifetime?: string };
	if (type !== undefined) return renderType(type, depth + 1);
	return lifetime === undefined ? "_" : lifetimeText(lifetime);
}

function renderPath(path_: RustPath, depth: number): string {
	const name = path_.path ?? path_.name ?? "_";
	const args = path_.args?.angle_bracketed?.args;
	if (!args?.length) return name;
	return `${name}<${args.map(arg => renderGenericArg(arg, depth)).join(", ")}>`;
}

/** A trait in a bound, a `dyn` type or a qualified path: a bare path, or a type wrapping one in an older format. */
function renderTraitPath(trait_: RustPath | RustType, depth: number): string {
	return "resolved_path" in trait_ ? renderType(trait_ as RustType, depth) : renderPath(trait_ as RustPath, depth);
}

/** How each rustdoc type variant renders, keyed by the variant's single key. */
const TYPE_RENDERERS: Record<string, (value: unknown, depth: number) => string> = {
	generic: value => value as string,
	primitive: value => value as string,
	resolved_path: (value, depth) => renderPath(value as RustPath, depth),
	borrowed_ref: (value, depth) =>
		`${refPrefix(value as BorrowedRef)}${renderType((value as BorrowedRef).type, depth + 1)}`,
	tuple: (value, depth) => `(${(value as RustType[]).map(t => renderType(t, depth + 1)).join(", ")})`,
	slice: (value, depth) => `[${renderType(value as RustType, depth + 1)}]`,
	array: (value, depth) => {
		const { type, len } = value as ArrayType;
		return `[${renderType(type, depth + 1)}; ${len}]`;
	},
	raw_pointer: (value, depth) => {
		const { is_mutable, type } = value as RawPointer;
		return `*${is_mutable ? "mut" : "const"} ${renderType(type, depth + 1)}`;
	},
	qualified_path: (value, depth) => {
		const qp = value as QualifiedPath;
		const self_ = renderType(qp.self_type, depth + 1);
		return qp.trait ? `<${self_} as ${renderTraitPath(qp.trait, depth + 1)}>::${qp.name}` : `${self_}::${qp.name}`;
	},
	impl_trait: (value, depth) => {
		const bounds = (value as ImplTraitBounds).map(bound => {
			if (bound.trait_bound) return renderTraitPath(bound.trait_bound.trait, depth + 1);
			return bound.outlives === undefined ? "?" : lifetimeText(bound.outlives);
		});
		return `impl ${bounds.join(" + ")}`;
	},
	dyn_trait: (value, depth) => {
		const { traits, lifetime } = value as DynTrait;
		const parts = traits.map(t => renderTraitPath(t.trait, depth + 1)).join(" + ");
		return `dyn ${parts}${lifetime ? ` + ${lifetimeText(lifetime)}` : ""}`;
	},
	function_pointer: () => "fn(...)",
};

function renderType(ty: RustType | string | null | undefined, depth = 0): string {
	if (!ty || depth > 10) return "_";
	// `infer` is the one unit variant, serialized as a bare string.
	if (typeof ty === "string") return ty === "infer" ? "_" : ty;
	for (const kind in ty) {
		if (Object.hasOwn(TYPE_RENDERERS, kind)) return TYPE_RENDERERS[kind](ty[kind], depth);
	}
	return "_";
}

function renderGenerics(generics: Generics): string {
	const params = generics.params
		.filter(p => p.kind && !("lifetime" in p.kind) && !p.kind.type?.is_synthetic)
		.map(p => p.name);
	return params.length ? `<${params.join(", ")}>` : "";
}

// --- Item rendering ---

/** The `&`, lifetime and `mut` a reference or reference receiver opens with. */
function refPrefix({ lifetime, is_mutable }: BorrowedRef): string {
	return `&${lifetime ? `${lifetimeText(lifetime)} ` : ""}${is_mutable ? "mut " : ""}`;
}

/** A method's receiver: `self`, `&self` or `&'a mut self`, and `self: Box<Self>` for any other type. */
function renderReceiver(ty: RustType): string {
	if (ty.generic === "Self") return "self";
	const ref = ty.borrowed_ref as BorrowedRef | undefined;
	return ref?.type.generic === "Self" ? `${refPrefix(ref)}self` : `self: ${renderType(ty)}`;
}

function renderFunctionSig(name: string, fn_: FunctionData): string {
	const { is_const, is_async, is_unsafe } = fn_.header ?? fn_;
	const qualifiers = `${is_const ? "const " : ""}${is_async ? "async " : ""}${is_unsafe ? "unsafe " : ""}`;
	const inputs = fn_.sig.inputs.map(([arg, ty]) =>
		arg === "self" ? renderReceiver(ty) : `${arg}: ${renderType(ty)}`,
	);
	const output = fn_.sig.output ? ` -> ${renderType(fn_.sig.output)}` : "";
	return `${qualifiers}fn ${name}${renderGenerics(fn_.generics)}(${inputs.join(", ")})${output}`;
}

interface GenericItem {
	generics: Generics;
}

/** The declaration of each item kind that has one, keyed by the kind's `inner` key. */
const DECL_RENDERERS: Record<string, (inner: unknown, name: string) => string> = {
	function: (inner, name) => renderFunctionSig(name, inner as FunctionData),
	struct: (inner, name) => `struct ${name}${renderGenerics((inner as GenericItem).generics)}`,
	enum: (inner, name) => `enum ${name}${renderGenerics((inner as GenericItem).generics)}`,
	union: (inner, name) => `union ${name}${renderGenerics((inner as GenericItem).generics)}`,
	trait: (inner, name) => {
		const trait_ = inner as GenericItem & { is_unsafe: boolean };
		return `${trait_.is_unsafe ? "unsafe " : ""}trait ${name}${renderGenerics(trait_.generics)}`;
	},
	type_alias: (inner, name) => {
		const alias = inner as GenericItem & { type: RustType | null };
		return `type ${name}${renderGenerics(alias.generics)}${alias.type ? ` = ${renderType(alias.type)}` : ""}`;
	},
	// rustdoc gives a declarative macro's source with its patterns stripped.
	macro: (inner, name) => (typeof inner === "string" && inner ? inner : `macro_rules! ${name}`),
	constant: (inner, name) => {
		// The value is under `const`, or on the constant itself in an older format.
		const constant = inner as { type: RustType; const?: { value: string | null }; value?: string | null };
		const { value } = constant.const ?? constant;
		return `const ${name}: ${renderType(constant.type)}${value ? ` = ${value}` : ""}`;
	},
};

function renderItemDecl(item: RustdocItem, name: string): string | null {
	const kind = itemKindFromInner(item.inner);
	return Object.hasOwn(DECL_RENDERERS, kind) ? DECL_RENDERERS[kind](item.inner[kind], name) : null;
}

function itemKindFromInner(inner: Record<string, unknown>): string {
	return Object.keys(inner)[0] ?? "unknown";
}

/** The ids of a module's items; none for an item that is not a module. */
function moduleItemIds(mod_: RustdocItem): number[] {
	return (mod_.inner?.module as { items?: number[] } | undefined)?.items ?? [];
}

/** An item a module exports, under the name the module exports it by. */
interface ModuleMember {
	name: string;
	item: RustdocItem;
}

/** A `use` item: the name it exports and the id of the item it imports, null for an item outside the crate. */
interface RustdocUse {
	name: string;
	id: number | null;
	is_glob: boolean;
}

/**
 * A module's public members. A member that is not `pub` (rustdoc writes `default` for a private one) is
 * left out.
 */
function moduleMembers(
	mod_: RustdocItem,
	index: Record<string, RustdocItem>,
	expanded = new Set<RustdocItem>([mod_]),
): ModuleMember[] {
	return moduleItemIds(mod_).flatMap((id): ModuleMember[] => {
		const member = index[String(id)];
		if (member?.visibility !== "public") return [];
		if ("use" in member.inner) return importedMembers(member.inner.use as RustdocUse, index, expanded);
		return member.name ? [{ name: member.name, item: member }] : [];
	});
}

/**
 * The members a `pub use` contributes: the item it imports under its exported name, or for a glob the
 * members of the module it imports, each module expanded once. An import of an item outside the crate's
 * index contributes none.
 */
function importedMembers(
	use_: RustdocUse,
	index: Record<string, RustdocItem>,
	expanded: Set<RustdocItem>,
): ModuleMember[] {
	const item = use_.id == null ? undefined : index[String(use_.id)];
	if (!item) return [];
	if (!use_.is_glob) return [{ name: use_.name, item }];
	if (expanded.has(item)) return [];
	expanded.add(item);
	return moduleMembers(item, index, expanded);
}

const DOCS_RS_CACHE_FILENAME = "rustdoc.json";

/** Hard ceiling for decompressed rustdoc JSON: a 50 MB compressed payload can
 *  expand far enough to block the event loop or OOM without a cap. Exceeding it
 *  throws (RangeError), which the fetch path converts to a degrade. */
export const MAX_RUSTDOC_GUNZIP_BYTES = 256 * 1024 * 1024;

/** Decompress a docs.rs rustdoc gzip payload with the output-size cap applied.
 *  `maxOutputLength` is overridable only for tests exercising the cap contract. */
export function gunzipRustdocJson(compressed: Buffer, maxOutputLength: number = MAX_RUSTDOC_GUNZIP_BYTES): string {
	return gunzipSync(compressed, { maxOutputLength }).toString("utf-8");
}

function sanitizeCacheSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function getDocsRsCacheVersionSegment(version: string, now = new Date()): string {
	if (version !== "latest") return sanitizeCacheSegment(version);
	return now.toISOString().slice(0, 10);
}

function getDocsRsCachePath(target: DocsRsTarget, now = new Date()): string {
	const crate = sanitizeCacheSegment(target.crateName);
	const version = getDocsRsCacheVersionSegment(target.version, now);
	return path.join(getDocsRsCacheDir(), `docsrs_${crate}_${version}`, DOCS_RS_CACHE_FILENAME);
}

async function readCachedRustdocCrate(
	target: DocsRsTarget,
): Promise<{ crate: RustdocCrate; fetchedAt: string } | null> {
	const cachePath = getDocsRsCachePath(target);
	try {
		const [jsonStr, stat] = await Promise.all([Bun.file(cachePath).text(), fs.stat(cachePath)]);
		const crate = tryParseJson<RustdocCrate>(jsonStr);
		if (!crate?.index) return null;
		return { crate, fetchedAt: stat.mtime.toISOString() };
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("Failed to read docs.rs cache", { path: cachePath, error: String(err) });
		return null;
	}
}

async function writeCachedRustdocCrate(target: DocsRsTarget, json: string): Promise<void> {
	const cachePath = getDocsRsCachePath(target);
	try {
		await Bun.write(cachePath, json);
	} catch (err) {
		logger.warn("Failed to write docs.rs cache", { path: cachePath, error: String(err) });
	}
}

/**
 * Fetch a crate's gzipped rustdoc JSON and cache it. A degrade names an HTTP
 * failure, a body over {@link MAX_BYTES}, an unreadable payload or one with no
 * item index; null means the response had no body.
 */
async function fetchRustdocCrate(
	target: DocsRsTarget,
	timeout: number,
	signal?: AbortSignal,
): Promise<RustdocCrate | ScraperDegrade | null> {
	const jsonUrl = `https://docs.rs/crate/${target.crateName}/${target.version}/json.gz`;
	let crate_: RustdocCrate | null;
	// Scoped so the deadline timer is cleared on settle instead of staying
	// armed like a bare AbortSignal.timeout; the fence spans the streamed read.
	const requestTimeout = scopedTimeoutSignal(timeout * 1000, signal);
	try {
		const response = await fetch(jsonUrl, {
			signal: requestTimeout.signal,
			headers: { "User-Agent": "veyyon-web-fetch/1.0", Accept: "application/gzip" },
			redirect: "follow",
		});
		if (!response.ok) return scraperDegrade("docs.rs", `HTTP ${response.status}`);

		const reader = response.body?.getReader();
		if (!reader) return null;
		const body = await readCappedBody(reader, MAX_BYTES);
		if (body.truncated) return scraperDegrade("docs.rs", `rustdoc JSON exceeds ${MAX_BYTES} compressed bytes`);

		const jsonStr = gunzipRustdocJson(body.bytes);
		crate_ = tryParseJson<RustdocCrate>(jsonStr);
		if (crate_?.index) await writeCachedRustdocCrate(target, jsonStr);
	} catch (error) {
		if (signal?.aborted) throw new AbortError(signal);
		return scraperDegrade("docs.rs", error);
	} finally {
		requestTimeout.cancel();
	}
	return crate_?.index ? crate_ : scraperDegrade("docs.rs", "rustdoc JSON had no item index");
}

/** The markdown of the module or item a docs.rs URL names; null when the crate has no such path. */
function renderTarget(crate_: RustdocCrate, target: DocsRsTarget): string | null {
	const { index } = crate_;
	let module_ = index[String(crate_.root)];
	if (!module_) return null;

	// The first module path segment is the crate itself.
	for (const segment of target.modulePath.slice(1)) {
		const child = moduleMembers(module_, index).find(m => m.name === segment && "module" in m.item.inner);
		if (!child) return null;
		module_ = child.item;
	}

	const page = target.item;
	if (!page) return renderModule(module_, index, crate_, target);
	// Namespaces differ by kind: `macro.vec.html` and the `vec` module are two items.
	const kinds = PAGE_ITEM_KINDS[page.kind];
	const member = moduleMembers(module_, index).find(
		m => m.name === page.name && kinds.includes(itemKindFromInner(m.item.inner)),
	);
	return member ? renderSingleItem(member, index, crate_) : null;
}

// --- Main handler ---

export const handleDocsRs: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	const target = parseDocsRsUrl(url);
	if (!target) return null;

	const cached = await readCachedRustdocCrate(target);
	if (cached) {
		const md = renderTarget(cached.crate, target);
		const notes = ["Loaded from docs.rs rustdoc JSON cache"];
		return md === null ? null : buildResult(md, { url, method: "docs.rs", fetchedAt: cached.fetchedAt, notes });
	}

	const fetchedAt = new Date().toISOString();
	const crate_ = await fetchRustdocCrate(target, timeout, signal);
	if (crate_ === null || isScraperDegrade(crate_)) return crate_;
	const md = renderTarget(crate_, target);
	const notes = ["Fetched via docs.rs rustdoc JSON"];
	return md === null ? null : buildResult(md, { url, method: "docs.rs", fetchedAt, notes });
};

// --- Rendering ---

interface RustdocImplData {
	trait?: RustPath | null;
	items: number[];
	is_synthetic?: boolean;
	blanket_impl?: RustType | null;
}

/** A bulleted entry: its code, then the first line of its docs. */
function docLine(code: string, docs: string | null): string {
	return `- \`${code}\`${docs ? ` — ${firstLine(docs)}` : ""}`;
}

/** The impl blocks written for a type: neither compiler-synthesized auto-trait impls nor blanket impls. */
function explicitImpls(implIds: number[], index: Record<string, RustdocItem>): RustdocImplData[] {
	const impls: RustdocImplData[] = [];
	for (const implId of implIds) {
		const impl_ = index[String(implId)];
		if (!impl_ || !("impl" in impl_.inner)) continue;
		const data = impl_.inner.impl as RustdocImplData;
		if (!data.is_synthetic && !data.blanket_impl) impls.push(data);
	}
	return impls;
}

function collectInherentMethodLines(impls: RustdocImplData[], index: Record<string, RustdocItem>): string[] {
	const methods: string[] = [];
	for (const impl_ of impls) {
		if (impl_.trait) continue;
		for (const id of impl_.items ?? []) {
			const method = index[String(id)];
			if (!method?.name || !("function" in method.inner)) continue;
			methods.push(docLine(renderFunctionSig(method.name, method.inner.function as FunctionData), method.docs));
		}
	}
	return methods;
}

/** A trait's own items: methods without a body and associated types are required, methods with one provided. */
function renderTraitItems(itemIds: number[], index: Record<string, RustdocItem>): string {
	const required: string[] = [];
	const provided: string[] = [];
	for (const id of itemIds) {
		const child = index[String(id)];
		if (!child) continue;
		if ("function" in child.inner) {
			const fn_ = child.inner.function as FunctionData;
			(fn_.has_body ? provided : required).push(docLine(renderFunctionSig(child.name ?? "?", fn_), child.docs));
		} else if ("assoc_type" in child.inner) {
			required.push(docLine(`type ${child.name}`, child.docs));
		}
	}
	let md = "";
	if (required.length) md += `## Required Methods\n\n${required.join("\n")}\n\n`;
	if (provided.length) md += `## Provided Methods\n\n${provided.join("\n")}\n\n`;
	return md;
}

/** A struct's, enum's, union's or trait's own items, inherent methods and implemented traits. */
function renderAssociatedItems(
	data: { impls?: number[]; items?: number[] } | undefined,
	index: Record<string, RustdocItem>,
): string {
	let md = renderTraitItems(data?.items ?? [], index);
	const impls = explicitImpls(data?.impls ?? [], index);

	const methods = collectInherentMethodLines(impls, index);
	if (methods.length) md += `## Methods\n\n${methods.join("\n")}\n\n`;

	const traitImpls = new Set<string>();
	for (const impl_ of impls) if (impl_.trait) traitImpls.add(renderPath(impl_.trait, 0));
	if (traitImpls.size) md += `## Trait Implementations\n\n${[...traitImpls].map(t => `- ${t}`).join("\n")}\n\n`;
	return md;
}

function renderSingleItem(
	{ name, item }: ModuleMember,
	index: Record<string, RustdocItem>,
	crate_: RustdocCrate,
): string {
	const kind = itemKindFromInner(item.inner);
	let md = `# ${kind.replaceAll("_", " ")} ${name}\n\n`;
	if (item.deprecation) md += `> **Deprecated**${item.deprecation.note ? `: ${item.deprecation.note}` : ""}\n\n`;

	const decl = renderItemDecl(item, name);
	if (decl) md += `\`\`\`rust\n${decl}\n\`\`\`\n\n`;
	if (item.docs) md += `${item.docs}\n\n`;

	if (kind === "struct" || kind === "enum" || kind === "trait" || kind === "union") {
		md += renderAssociatedItems(item.inner[kind] as { impls?: number[]; items?: number[] } | undefined, index);
	}
	if (kind === "enum") {
		const variants = (item.inner.enum as { variants?: number[] }).variants ?? [];
		const lines = variants.flatMap(id => {
			const variant = index[String(id)];
			return variant?.name ? [docLine(variant.name, variant.docs)] : [];
		});
		if (lines.length) md += `## Variants\n\n${lines.join("\n")}\n\n`;
	}

	if (crate_.crate_version) md += `---\n*${crate_.crate_version}*\n`;
	return md;
}

/** The module listing's sections in display order, each the item kind it lists and its heading. */
const MODULE_SECTIONS: ReadonlyArray<readonly [kind: string, heading: string]> = [
	["module", "Modules"],
	["macro", "Macros"],
	["proc_macro", "Procedural Macros"],
	["struct", "Structs"],
	["enum", "Enums"],
	["union", "Unions"],
	["trait", "Traits"],
	["trait_alias", "Trait Aliases"],
	["function", "Functions"],
	["type_alias", "Type Aliases"],
	["constant", "Constants"],
	["static", "Statics"],
];

/** A module's members as listing lines grouped by item kind, a function as its signature. */
function groupModuleItems(members: ModuleMember[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const { name, item } of members) {
		const kind = itemKindFromInner(item.inner);
		const code = kind === "function" ? `\`${renderItemDecl(item, name)}\`` : `**${name}**`;
		const docs = item.docs ? firstLine(item.docs) : "";
		const line = `- ${code}${docs ? ` — ${docs}` : ""}`;
		const group = groups.get(kind);
		if (group) group.push(line);
		else groups.set(kind, [line]);
	}
	return groups;
}

function renderModule(
	mod_: RustdocItem,
	index: Record<string, RustdocItem>,
	crate_: RustdocCrate,
	target: DocsRsTarget,
): string {
	let md = `# ${target.modulePath.join("::")}\n\n`;
	if (mod_.docs) md += `${mod_.docs}\n\n`;

	const groups = groupModuleItems(moduleMembers(mod_, index));
	for (const [kind, heading] of MODULE_SECTIONS) {
		const lines = groups.get(kind);
		if (lines) md += `## ${heading}\n\n${lines.join("\n")}\n\n`;
	}

	if (crate_.crate_version) md += `---\n*${crate_.crate_version}*\n`;
	return md;
}

function firstLine(s: string): string {
	const end = s.indexOf("\n");
	return truncate((end === -1 ? s : s.slice(0, end)).trim(), 200, "...");
}
