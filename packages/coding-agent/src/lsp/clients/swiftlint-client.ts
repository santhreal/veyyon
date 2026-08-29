import type { Diagnostic, LinterClient, ServerConfig } from "../../lsp/types";
import type { SwiftLintViolation } from "./swiftlint-client-helpers";
import { parseSeverity, runSwiftLint } from "./swiftlint-client-helpers";

export class SwiftLintClient implements LinterClient {
	static create(config: ServerConfig, cwd: string): LinterClient {
		return new SwiftLintClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async format(_filePath: string, content: string): Promise<string> {
		return content;
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		const result = await runSwiftLint(
			["lint", "--quiet", "--reporter", "json", filePath],
			this.cwd,
			this.config.resolvedCommand,
		);

		if (!result.success) {
			return [];
		}

		return this.#parseJsonOutput(result.stdout);
	}

	#parseJsonOutput(jsonOutput: string): Diagnostic[] {
		const diagnostics: Diagnostic[] = [];

		try {
			const violations: SwiftLintViolation[] = JSON.parse(jsonOutput);

			for (const v of violations) {
				const line = Math.max(0, v.line - 1);
				const character = Math.max(0, v.character - 1);

				diagnostics.push({
					range: {
						start: { line, character },
						end: { line, character },
					},
					severity: parseSeverity(v.severity),
					message: v.reason,
					source: "swiftlint",
					code: v.rule_id,
				});
			}
		} catch {}

		return diagnostics;
	}

	dispose(): void {}
}
