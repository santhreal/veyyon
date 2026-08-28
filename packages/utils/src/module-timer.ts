import { plugin } from "bun";
import { moduleLoadBuffer } from "./timing-buffer";

export const MODULE_LOADER_FILTER = /\.[mc]?tsx?$/;
const MODULE_COMPLETE_KEY: symbol = Symbol.for("veyyon.moduleLoadComplete");
const MODULE_BODY_START_KEY: symbol = Symbol.for("veyyon.moduleBodyStart");
export const STATIC_IMPORT_PATTERN =
	/\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

type CompleteStore = Record<symbol, ((path: string) => void) | undefined>;

function bodyStartMarker(path: string): string {
	return `;globalThis[Symbol.for("veyyon.moduleBodyStart")]?.(${JSON.stringify(path)});\n`;
}

function completionMarker(path: string): string {
	return `\n;globalThis[Symbol.for("veyyon.moduleLoadComplete")]?.(${JSON.stringify(path)});\n`;
}

export function instrumentContents(path: string, contents: string): string {
	const start = bodyStartMarker(path);
	const end = completionMarker(path);
	if (!contents.startsWith("#!")) return `${start}${contents}${end}`;
	const newline = contents.indexOf("\n");
	if (newline === -1) return `${contents}\n${start}${end}`;
	return `${contents.slice(0, newline + 1)}${start}${contents.slice(newline + 1)}${end}`;
}
export function importerDir(importer: string): string {
	const slash = importer.lastIndexOf("/");
	if (slash === -1) return ".";
	return importer.slice(0, slash);
}

function childSetFor(importsByPath: Map<string, Set<string>>, path: string): Set<string> {
	let children = importsByPath.get(path);
	if (!children) {
		children = new Set<string>();
		importsByPath.set(path, children);
	}
	return children;
}

export function addImportEdges(importsByPath: Map<string, Set<string>>, importer: string, contents: string): void {
	STATIC_IMPORT_PATTERN.lastIndex = 0;
	for (const match of contents.matchAll(STATIC_IMPORT_PATTERN)) {
		const specifier = match[1] ?? match[2];
		if (!specifier) continue;
		try {
			const resolved = Bun.resolveSync(specifier, importerDir(importer));
			if (MODULE_LOADER_FILTER.test(resolved) && resolved !== importer) {
				childSetFor(importsByPath, importer).add(resolved);
			}
		} catch {}
	}
}

if (process.env.VEYYON_TIMING) {
	const buffer = moduleLoadBuffer();
	const starts = new Map<string, number>();
	const bodyStarts = new Map<string, number>();
	const importsByPath = new Map<string, Set<string>>();
	const store = globalThis as unknown as CompleteStore;
	store[MODULE_BODY_START_KEY] = (path: string): void => {
		bodyStarts.set(path, performance.now());
	};
	store[MODULE_COMPLETE_KEY] = (path: string): void => {
		const start = starts.get(path);
		if (start === undefined) return;
		starts.delete(path);
		const end = performance.now();
		const bodyStart = bodyStarts.get(path);
		bodyStarts.delete(path);
		const imports = importsByPath.get(path);
		buffer.push({
			path,
			start,
			durationMs: end - start,
			bodyMs: bodyStart === undefined ? undefined : end - bodyStart,
			imports: imports ? Array.from(imports) : [],
		});
	};

	plugin({
		name: "pi-module-load-timer",
		setup(build) {
			build.onLoad({ filter: MODULE_LOADER_FILTER }, async args => {
				starts.set(args.path, performance.now());
				childSetFor(importsByPath, args.path);
				const contents = await Bun.file(args.path).text();
				addImportEdges(importsByPath, args.path, contents);
				return {
					contents: instrumentContents(args.path, contents),
					loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
				};
			});
		},
	});
}
