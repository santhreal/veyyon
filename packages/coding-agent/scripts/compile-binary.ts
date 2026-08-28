import * as path from "node:path";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

export interface CodingAgentCompileOptions {
	readonly repoRoot: string;
	readonly entrypoint: string;
	readonly outfile: string;
	readonly transformersVersion: string;
	readonly target?: Bun.Build.CompileTarget;
	readonly minifyIdentifiers?: boolean;
	readonly skipBuiltinCodesign?: boolean;
	readonly bytecode?: boolean;
}

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

export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
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
