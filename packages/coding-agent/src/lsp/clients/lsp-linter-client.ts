import { getOrCreateClient, notifySaved, sendRequest, syncContent } from "../../lsp/client";
import { applyTextEditsToString } from "../../lsp/edits";
import { resolveFormatOptions } from "../../lsp/format-options";
import type { Diagnostic, LinterClient, LspClient, ServerConfig, TextEdit } from "../../lsp/types";
import { fileToUri } from "../../lsp/utils";

export class LspLinterClient implements LinterClient {
	#client: LspClient | null = null;

	static create(config: ServerConfig, cwd: string): LinterClient {
		return new LspLinterClient(config, cwd);
	}

	constructor(
		private readonly config: ServerConfig,
		private readonly cwd: string,
	) {}

	async #getClient(): Promise<LspClient> {
		if (!this.#client) {
			this.#client = await getOrCreateClient(this.config, this.cwd);
		}
		return this.#client;
	}

	async format(filePath: string, content: string): Promise<string> {
		const client = await this.#getClient();
		const uri = fileToUri(filePath);

		await syncContent(client, filePath, content);

		const caps = client.serverCapabilities;
		if (!caps?.documentFormattingProvider) {
			return content;
		}

		const edits = (await sendRequest(client, "textDocument/formatting", {
			textDocument: { uri },
			options: resolveFormatOptions(filePath, content),
		})) as TextEdit[] | null;

		if (!edits || edits.length === 0) {
			return content;
		}

		return applyTextEditsToString(content, edits);
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		const client = await this.#getClient();
		const uri = fileToUri(filePath);

		await notifySaved(client, filePath);

		const timeoutMs = 3000;
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const publishedDiagnostics = client.diagnostics.get(uri);
			if (publishedDiagnostics !== undefined) {
				return publishedDiagnostics.diagnostics;
			}
			await Bun.sleep(100);
		}

		return client.diagnostics.get(uri)?.diagnostics ?? [];
	}

	dispose(): void {}
}
