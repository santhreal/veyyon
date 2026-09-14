/**
 * WHY:
 *
 * The desktop palette's Content Search mode had no action behind it. Its rows
 * were projected from `SearchResults`, the file-NAME search domain, so the mode
 * listed paths with no line number and no matched text, and no host action ever
 * read a file's contents. `SearchContent` answers it with `ContentMatches`.
 *
 * THE CLASS THIS CLOSES: a palette lookup whose answer carries less than the
 * row draws, and an unbounded workspace search. The suite drives the real
 * socket protocol against a live filesystem and asserts the answer carries the
 * path, the 1-indexed line and the matched text, that the query is matched
 * literally rather than as a regular expression, that gitignored files are not
 * searched, that a query nobody typed is refused, and that the match set is
 * bounded and says so.
 *
 * WHAT IT DOES NOT CATCH: how the rows are drawn, which
 * `crates/veyyon-desktop/tests/a-content-search-lists-the-lines-the-host-found.rs`
 * owns, and searching a remote filesystem, which is a separate subsystem.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { SEARCH_CONTENT_MAX_MATCHES } from "../../src/gui-host/actions/files";
import type { ContentMatchesView } from "../../src/gui-host/wire";
import { TestSocketClient } from "./test-client";

describe("a content search answers with the lines it matched", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-content-search-"));

		await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored/\n", "utf8");
		await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
		await fs.writeFile(
			path.join(tempDir, "src", "app.ts"),
			"const first = 1;\n// todo: name the error\nconst last = 2;\n",
			"utf8",
		);
		await fs.writeFile(
			path.join(tempDir, "src", "queue.ts"),
			"// TODO: bound the queue\nexport const q = [];\n",
			"utf8",
		);
		// A line whose text is a regular expression, to prove the query is literal.
		await fs.writeFile(path.join(tempDir, "src", "glob.ts"), 'const pattern = "a(b|c)*";\n', "utf8");
		await fs.mkdir(path.join(tempDir, "ignored"), { recursive: true });
		await fs.writeFile(path.join(tempDir, "ignored", "secret.ts"), "// todo: never searched\n", "utf8");
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	});

	const matchesOf = (frames: Array<{ Snapshot?: { ContentMatches?: unknown } }>): ContentMatchesView => {
		const view = frames.find(frame => frame.Snapshot?.ContentMatches)?.Snapshot?.ContentMatches as
			| ContentMatchesView
			| undefined;
		expect(view).toBeDefined();
		return view as ContentMatchesView;
	};

	test("a match states its file, its line number and the text of the line", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();

		const { frames, outcome } = await client.request(1, { SearchContent: { query: "todo" } });
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const view = matchesOf(frames);
		expect(view.query).toBe("todo");
		expect(view.truncated).toBeFalse();
		expect(view.matches).toContainEqual({
			path: "src/app.ts",
			line: 2,
			preview: "// todo: name the error",
		});
		// The search is case-insensitive, so the same word in another case is
		// one of the rows an operator expects to see.
		expect(view.matches).toContainEqual({
			path: "src/queue.ts",
			line: 1,
			preview: "// TODO: bound the queue",
		});
		// A gitignored file is not part of the workspace being searched.
		expect(view.matches.some(match => match.path.startsWith("ignored/"))).toBeFalse();

		client.destroy();
	});

	test("the query is matched literally, not as a regular expression", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();

		// As a regular expression this is a group and an alternation, and it
		// would match neither the line that contains it nor anything else.
		const { frames, outcome } = await client.request(1, { SearchContent: { query: "a(b|c)*" } });
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });
		expect(matchesOf(frames).matches).toEqual([
			{ path: "src/glob.ts", line: 1, preview: 'const pattern = "a(b|c)*";' },
		]);

		client.destroy();
	});

	test("a query nobody typed is refused rather than searched for", async () => {
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();

		const { outcome } = await client.request(1, { SearchContent: { query: "   " } });
		expect(outcome).toEqual({
			RequestFailed: {
				request: 1,
				error: expect.objectContaining({
					scope: "File",
					code: "INVALID_ARGUMENTS",
					retryable: false,
				}),
			},
		});

		client.destroy();
	});

	test("a search that matches everything is bounded and says it was cut short", async () => {
		const lines = Array.from({ length: SEARCH_CONTENT_MAX_MATCHES + 40 }, (_, i) => `// todo ${i}`);
		// One file cannot exhaust the budget alone, so the corpus is spread
		// across enough files that the global cap is what stops the search.
		for (let file = 0; file < 30; file++) {
			await fs.writeFile(path.join(tempDir, `many-${file}.ts`), lines.slice(0, 20).join("\n"), "utf8");
		}

		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();

		const { frames, outcome } = await client.request(1, { SearchContent: { query: "todo" } });
		expect(outcome).toEqual({ RequestSucceeded: { request: 1 } });

		const view = matchesOf(frames);
		expect(view.matches.length).toBe(SEARCH_CONTENT_MAX_MATCHES);
		expect(view.truncated).toBeTrue();

		client.destroy();
	});
});
