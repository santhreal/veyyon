import * as path from "node:path";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

/** Inputs shared by local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Concrete Transformers.js version baked into the tiny-model worker. */
	readonly transformersVersion: string;
	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Match release builds that minify identifiers while retaining names. */
	readonly minifyIdentifiers?: boolean;
	/** Disable Bun's built-in Darwin signing before the caller re-signs. */
	readonly skipBuiltinCodesign?: boolean;
	/**
	 * Precompile the bundle to Bun bytecode (default ON, opt out with
	 * `VEYYON_BUILD_BYTECODE=0`). Skips JS source parsing at every launch —
	 * measured `--version` ~650ms -> ~70ms. Tradeoff: binary grows ~158MB ->
	 * ~288MB. Requires the embedded mupdf runtime (gen:mupdf) because mupdf's
	 * top-level await cannot be bytecode-compiled, and the yargs
	 * `import.meta.resolve` patch plugin below (Bun crashes bytecode binaries
	 * containing `import.meta.resolve`/`env`, oven-sh/bun#21097).
	 */
	readonly bytecode?: boolean;
}

/**
 * Binary builds never bundle the mupdf package: its top-level await is
 * incompatible with bytecode compilation, and the embedded-asset runtime
 * (scripts/embed-mupdf-wasm.ts --generate + markit pdf extract.ts) supersedes
 * it. The `import("mupdf")` fallback branch is unreachable in compiled
 * binaries, so it is replaced with a loud failure instead of dead weight.
 */
function createMupdfStubPlugin(): Bun.BunPlugin {
	return {
		name: "stub-bundled-mupdf",
		setup(build) {
			build.onResolve({ filter: /^mupdf$/ }, () => ({ path: "mupdf-unbundled", namespace: "mupdf-stub" }));
			build.onLoad({ filter: /.*/, namespace: "mupdf-stub" }, () => ({
				contents:
					'throw new Error("mupdf is not bundled in compiled binaries; the embedded mupdf runtime (mupdf-wasm-embed) must be generated at build time. Rebuild with scripts/build-binary.ts, which runs embed-mupdf-wasm --generate.");',
				loader: "js",
			}));
		},
	};
}

/**
 * `import.meta.resolve()` in any bundled module makes Bun 1.3.14 bytecode
 * binaries crash at startup ("Expected CommonJS module to have a function
 * wrapper", oven-sh/bun#21097 — same crash via `import.meta.env`; minimal
 * repro: a one-line `import.meta.resolve("x")` entry under
 * `bun build --compile --bytecode`). The bundle graph has exactly one such
 * call site: yargs' apply-extends.js, where it resolves a
 * `{extends: "<npm-module>"}` yargs config — a feature nothing in the binary
 * uses. This plugin rewrites that call to a loud throw; yargs' own
 * surrounding catch then returns the config unchanged, its documented
 * unresolvable-extends behavior. The build fails closed if a yargs upgrade
 * changes the expected source shape or introduces new `import.meta.resolve`
 * / `import.meta.env` call sites here.
 */
function createYargsImportMetaResolvePatchPlugin(): Bun.BunPlugin {
	return {
		name: "patch-yargs-import-meta-resolve",
		setup(build) {
			build.onLoad({ filter: /[\\/]yargs[\\/]build[\\/]lib[\\/]utils[\\/]apply-extends\.js$/ }, async args => {
				const source = await Bun.file(args.path).text();
				const call = "import.meta.resolve(config.extends)";
				if (!source.includes(call)) {
					throw new Error(
						`patch-yargs-import-meta-resolve: expected ${JSON.stringify(call)} in ${args.path}; the yargs upgrade changed apply-extends.js — re-verify bytecode compatibility and update this plugin.`,
					);
				}
				const patched = source.replace(
					call,
					'(() => { console.error("veyyon compiled binary: yargs `extends` by npm module name is unsupported (import-meta-resolve is incompatible with bytecode builds, oven-sh/bun#21097); the extends directive is ignored."); throw new Error("unsupported yargs extends-by-module-name"); })()',
				);
				if (/import\.meta\.(resolve|env)/.test(patched)) {
					throw new Error(
						`patch-yargs-import-meta-resolve: ${args.path} still contains import.meta.resolve/env after patching; bytecode builds would crash at startup (oven-sh/bun#21097).`,
					);
				}
				return { contents: patched, loader: "js" };
			});
		},
	};
}

/**
 * Compile the coding-agent executable with its legacy Pi compatibility module
 * graph supplied by an in-memory build plugin rather than generated files.
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	// Compiled binaries can only serve the stats dashboard from the embedded
	// archive; an empty placeholder compiles fine and 500s at runtime, so fail
	// the build instead. Callers (build-binary.ts, ci-release-build-binaries.ts)
	// run `gen:stats` first and reset afterwards.
	const statsArchivePath = path.join(options.repoRoot, "packages", "stats", "src", "embedded-client.generated.txt");
	if ((await Bun.file(statsArchivePath).text()).trim().length === 0) {
		throw new Error(
			`Embedded stats client archive is empty (${statsArchivePath}). Run \`bun run gen:stats\` before compiling — a binary built without it serves HTTP 500 for every \`veyyon stats\` dashboard request.`,
		);
	}
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			define: {
				"process.env.VEYYON_COMPILED": JSON.stringify("true"),
				"process.env.VEYYON_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.VEYYON_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
			},
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			...((options.bytecode ?? Bun.env.VEYYON_BUILD_BYTECODE !== "0") ? { bytecode: true } : {}),
			plugins: [
				await createLegacyPiVirtualModulePlugin(),
				createMupdfStubPlugin(),
				createYargsImportMetaResolvePatchPlugin(),
			],
			compile: {
				...(options.target ? { target: options.target } : {}),
				outfile: options.outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
	} finally {
		if (previousCodesignSetting === undefined) {
			delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
		} else {
			Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
		}
	}
}
