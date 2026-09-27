/**
 * WHY: the MiniWoB++ site appends a setup script (seed the problem, lift the time limit, post the
 * first score) to a task page, `miniwob/<task>.html` under the pages' root. It chose the pages by
 * looking for `/miniwob/` anywhere in the file's absolute path, and the root itself is
 * `datasets/miniwob/html`, so every HTML file under it got the script: a page with no MiniWoB++ core
 * then threw on load, and any page that loaded `core.js` posted a score of its own. The choice now
 * reads the path relative to the root.
 *
 * Also held here: a request path that climbs out of the root serves nothing outside it.
 *
 * Not caught: whether the script scores a real MiniWoB++ page; that needs the upstream pages, which
 * the repository does not hold.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { serveFile } from "../../../suites/miniwob/main";

const PAGE = "<html><body><p>page</p></body></html>";

describe("the MiniWoB++ site", () => {
	it("appends the setup script to a task page and to nothing else under the root", async () => {
		await using dir = await TempDir.create("@evals-miniwob-pages-");
		// Laid out as the suite expects: the root is a `miniwob/html` directory.
		const root = dir.join("miniwob", "html");
		for (const file of ["miniwob/enter-text.html", "core/help.html", "index.html", "miniwob/nested/other.html"]) {
			await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
			await fs.writeFile(path.join(root, file), PAGE);
		}
		const served: Record<string, boolean> = {};
		for (const pathname of [
			"/miniwob/enter-text.html",
			"/core/help.html",
			"/index.html",
			"/miniwob/nested/other.html",
		]) {
			const response = await serveFile(root, pathname);
			const body = typeof response.body === "string" ? response.body : new TextDecoder().decode(response.body);
			if (body !== PAGE) expect(body).toContain('fetch("/reward"');
			served[pathname] = body !== PAGE;
		}
		expect(served).toEqual({
			"/miniwob/enter-text.html": true,
			"/core/help.html": false,
			"/index.html": false,
			"/miniwob/nested/other.html": false,
		});
	});

	it("serves nothing from outside the root", async () => {
		await using dir = await TempDir.create("@evals-miniwob-pages-");
		const root = dir.join("miniwob", "html");
		await fs.mkdir(root, { recursive: true });
		await fs.writeFile(dir.join("miniwob", "secret.txt"), "not-a-real-secret");
		for (const pathname of ["/../secret.txt", "/..%2Fsecret.txt", "/%2E%2E/secret.txt", "/..%5Csecret.txt"]) {
			const response = await serveFile(root, pathname);
			const body = typeof response.body === "string" ? response.body : new TextDecoder().decode(response.body);
			expect([pathname, response.status ?? 200, body.includes("not-a-real-secret")]).toEqual([pathname, 404, false]);
		}
	});
});
