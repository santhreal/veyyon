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
			// Whitespace and syntax minification are startup latency, not disk
			// hygiene. Bun's standalone loader links the whole bytecode blob
			// before the entry's first statement, so the blob's size is the time
			// the operator waits for the launch card: turning both on takes the
			// local binary from 303.9MB to 296.9MB and the window before the
			// entry's first statement from 82-88ms to 73.6ms, with the card
			// landing at 119-128ms instead of 124-138ms. `keepNames` stays on
			// either way, so a stack trace still names its functions, and
			// `--smoke-test`, `--version` and `--help` are unchanged.
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				whitespace: true,
				syntax: true,
				keepNames: true,
			},
			// One chunk per dynamic-import boundary instead of one chunk for the
			// product. Bun's standalone loader maps and links a chunk before the
			// first statement in it runs, so a single chunk makes the launch card
			// wait for the bytecode of every subcommand, every tool and the whole
			// agent runtime — none of which the card draws. Split, the entry
			// chunk carries the CLI entry and the prologue, and the rest is
			// linked at the `import()` that needs it.
			//
			// Measured on this machine, warm, on a pty with the kernel's own echo
			// disabled: the binary goes from 296.9MB to 231.7MB and the launch
			// card's first byte from 138-151ms to 67-74ms, with the first
			// keystroke echoing at 131ms instead of 188-207ms. A binary built
			// from a launch-path-only entry reaches its first byte in 47ms, which
			// is the floor this approach converges on as more of the runtime
			// moves behind an `import()`.
			//
			// `format: "esm"` is not a preference: Bun rejects `splitting` for any
			// other format. Bytecode still applies, per chunk.
			splitting: true,
			format: "esm",
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
