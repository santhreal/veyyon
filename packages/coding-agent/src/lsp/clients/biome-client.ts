import path from "node:path";
import type { Diagnostic, LinterClient, ServerConfig } from "../../lsp/types";
import type { BiomeDiagnostic, BiomeJsonOutput } from "./biome-client-helpers";
import { offsetsToPositions, parseSeverity, runBiome, warnBiomeOnce } from "./biome-client-helpers";

export class BiomeClient implements LinterClient {
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new BiomeClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async format(filePath: string, content: string): Promise<string> {
		await Bun.write(filePath, content);

		const result = await runBiome(["format", "--write", filePath], this.cwd, this.config.resolvedCommand);

		if (result.success) {
			return await Bun.file(filePath).text();
		}

		return content;
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		const result = await runBiome(["lint", "--reporter=json", filePath], this.cwd, this.config.resolvedCommand);

		if (!result.success && result.stdout.trim().length === 0) {
			warnBiomeOnce(`run:${this.cwd}`, "Biome lint failed; reporting no diagnostics", {
				cwd: this.cwd,
				stderr: result.stderr.slice(0, 500),
			});
			return [];
		}

		return this.#parseJsonOutput(result.stdout, filePath);
	}

	#parseJsonOutput(jsonOutput: string, targetFile: string): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];

		let parsed: BiomeJsonOutput;
		try {
			parsed = JSON.parse(jsonOutput);
		} catch {
			warnBiomeOnce(`parse:${this.cwd}`, "Failed to parse Biome JSON output; reporting no diagnostics", {
				cwd: this.cwd,
				file: targetFile,
			});
			return diagnostics;
		}

		const target = path.resolve(targetFile);
		const relevant: BiomeDiagnostic[] = [];
		const offsetsBySource = new Map<string, number[]>();
		for (const diag of parsed.diagnostics ?? []) {
			const location = diag.location;
			if (!location?.path?.file) continue;

			const diagFile = path.isAbsolute(location.path.file)
				? location.path.file
				: path.join(this.cwd, location.path.file);

			if (path.resolve(diagFile) !== target) {
				continue;
			}

			relevant.push(diag);
			if (location.span && location.sourceCode) {
				const offsets = offsetsBySource.get(location.sourceCode);
				if (offsets) offsets.push(location.span[0], location.span[1]);
				else offsetsBySource.set(location.sourceCode, [location.span[0], location.span[1]]);
			}
		}

		const positionsBySource = new Map<string, Map<number, { line: number; column: number }>>();
		for (const [source, offsets] of offsetsBySource) {
			positionsBySource.set(source, offsetsToPositions(source, offsets));
		}

		for (const diag of relevant) {
			const location = diag.location;
			let startLine = 1;
			let startColumn = 1;
			let endLine = 1;
			let endColumn = 1;

			if (location?.span && location.sourceCode) {
				const positions = positionsBySource.get(location.sourceCode);
				const startPos = positions?.get(location.span[0]);
				const endPos = positions?.get(location.span[1]);
				if (startPos) {
					startLine = startPos.line;
					startColumn = startPos.column;
				}
				if (endPos) {
					endLine = endPos.line;
					endColumn = endPos.column;
				}
			}

			diagnostics.push({
				range: {
					start: { line: startLine - 1, character: startColumn - 1 },
					end: { line: endLine - 1, character: endColumn - 1 },
				},
				severity: parseSeverity(diag.severity),
				message: diag.description,
				source: "biome",
				code: diag.category,
			});
		}

		return diagnostics;
	}

	dispose(): void {}
}
