#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatBytes, isEnoent } from "@veyyon/utils";
import { buildDocsIndexPayload } from "./generate-docs-index";

const packageDir = path.join(import.meta.dir, "..");
const outDir = path.join(packageDir, "dist");
const cliPath = path.join(outDir, "cli.js");
const shebang = "#!/usr/bin/env bun\n";

const ALWAYS_EXTERNAL = [
	"mupdf",
	"@veyyon/natives",
	"@huggingface/transformers",
	"fastembed",
	"onnxruntime-node",
	"veyyon-legacy-pi-modules",
];

const RUNTIME_EXTERNAL = [
	"puppeteer-core",
	"@puppeteer/browsers",
	"@babel/parser",
	"@xterm/headless",
	"turndown",
	"turndown-plugin-gfm",
	"@mozilla/readability",
	"linkedom",
	"@agentclientprotocol/sdk",
];

async function runCommand(command: string[]): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
}

async function ensureShebang(): Promise<void> {
	const text = await Bun.file(cliPath).text();
	if (text.startsWith(shebang)) return;
	const withoutExisting = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;
	await Bun.write(cliPath, shebang + withoutExisting);
}

async function cleanBundleOutputs(): Promise<void> {
	let entries: string[];
	try {
		entries = await fs.readdir(outDir);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	await Promise.all(
		entries
			.filter(entry => entry === "cli.js" || entry.endsWith(".node") || entry.endsWith(".js.map"))
			.map(entry => fs.rm(path.join(outDir, entry), { force: true })),
	);
}

async function main(): Promise<void> {
	const start = Bun.nanoseconds();
	await cleanBundleOutputs();
	await runCommand(["bun", "--cwd=../stats", "run", "gen:stats"]);
	try {
		const output = await Bun.build({
			entrypoints: [path.join(packageDir, "src/cli.ts")],
			outdir: outDir,
			target: "bun",
			external: [...ALWAYS_EXTERNAL, ...RUNTIME_EXTERNAL],
			define: {
				"process.env.VEYYON_BUNDLED": JSON.stringify("true"),
				"process.env.VEYYON_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
			},
			minify: {
				whitespace: true,
				syntax: true,
				identifiers: true,
				keepNames: true,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`CLI bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "run", "gen:stats:reset"]);
	}
	await ensureShebang();
	const stat = await fs.stat(cliPath);
	const elapsedMs = (Bun.nanoseconds() - start) / 1_000_000;
	process.stdout.write(
		`Bundled coding-agent CLI to dist/cli.js (${formatBytes(stat.size)}) in ${elapsedMs.toFixed(0)}ms\n`,
	);
}

await main();
