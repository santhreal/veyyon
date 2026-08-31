/**
 * WHY: `read` is exempt from the shared spill layer by design, because it is
 * bounded by the lines its caller asked for. That exemption makes every surface
 * `read` renders itself responsible for its own budget, and two of them had
 * none: the PDF image-member list, which a scanned document fills with
 * thousands of entries, and an `agent://<id>/<field>` extraction, which returns
 * one JSON field whole and rejects the line selector that would page it.
 *
 * The class this closes: a `read`-owned surface that returns a whole collection
 * whose size the file or the artifact decides, rather than the caller. Both
 * cases assert the same three things a capped read owes: the result fits the
 * configured budget, lowering the setting lowers the cost, and what was dropped
 * is stated rather than silently missing.
 *
 * What it does not catch: a `skill://` read, which is exempt on purpose so an
 * instruction file is never cut mid-instruction, and the file window, summary,
 * directory and archive listings, which their own suites cover.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resetRegisteredArtifactDirsForTests } from "@veyyon/coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { createTools, type Tool } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

/** Enough members that the list passes every budget under test. */
const MEMBER_COUNT = 2000;
/** One extracted field larger than every budget under test. */
const FIELD_BYTES = 200 * 1024;

let dir: string;
let artifactsDir: string;

async function toolFor(thresholdKb: number): Promise<Tool> {
	const settings = Settings.isolated();
	settings.set("tools.artifactSpillThreshold", thresholdKb);
	const session = makeToolSession({
		cwd: dir,
		settings,
		skipPythonPreflight: true,
		getArtifactsDir: () => artifactsDir,
	});
	const tools = await createTools(session, ["read"]);
	const read = tools.find(tool => tool.name === "read");
	if (!read) throw new Error("read tool missing");
	return read;
}

async function readText(tool: Tool, target: string): Promise<string> {
	const result = await tool.execute("probe", { path: target } as never, undefined, undefined, undefined);
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block)
		.map(block => block.text)
		.join("\n");
}

/** The cache directory `read` derives for a PDF's extracted images. */
function pdfImageCacheDir(absolutePdfPath: string): string {
	const basename = path.basename(absolutePdfPath).replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(artifactsDir, "read-pdf-images", `${basename}-${Bun.hash(absolutePdfPath).toString(36)}`);
}

describe("a listing read owns its own budget", () => {
	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "listing-budget-"));
		artifactsDir = path.join(dir, "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });

		// A PDF whose images are already extracted: the marker file makes the
		// production path read the cache instead of running a converter, so the
		// list under test is the real one the tool renders.
		const pdfPath = path.join(dir, "scan.pdf");
		await fs.writeFile(pdfPath, "%PDF-1.4\n");
		const imageDir = pdfImageCacheDir(pdfPath);
		await fs.mkdir(imageDir, { recursive: true });
		await fs.writeFile(path.join(imageDir, ".extracted"), "ok");
		await Promise.all(
			Array.from({ length: MEMBER_COUNT }, (_, index) =>
				fs.writeFile(path.join(imageDir, `image-${String(index).padStart(5, "0")}-${"p".repeat(40)}.png`), "x"),
			),
		);
	});

	afterAll(async () => {
		await removeWithRetries(dir);
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("holds a PDF image-member list to the configured budget and names what it dropped", async () => {
		const small = await readText(await toolFor(8), "scan.pdf:");
		const large = await readText(await toolFor(64), "scan.pdf:");
		expect(Buffer.byteLength(small, "utf-8")).toBeLessThan(8 * 1024 + 512);
		expect(Buffer.byteLength(large, "utf-8")).toBeGreaterThan(Buffer.byteLength(small, "utf-8") * 4);

		const notice = /\[(\d+) more lines? of members;/.exec(small);
		expect(notice).not.toBeNull();
		const shown = small.split("\n").filter(line => line.startsWith("- read ")).length;
		expect(Number(notice?.[1])).toBe(MEMBER_COUNT - shown);
	});

	it("holds an extracted agent field to the configured budget and states its full size", async () => {
		const sessionFile = path.join(dir, "conv.jsonl");
		const agentDir = sessionFile.slice(0, -6);
		await fs.mkdir(agentDir, { recursive: true });
		AgentRegistry.global().register({
			id: "conv",
			displayName: "main",
			kind: "main",
			session: { sessionManager: { getArtifactsDir: () => agentDir } } as unknown as AgentSession,
			sessionFile,
			scope: "session-a",
		});
		await fs.writeFile(path.join(agentDir, "Worker.md"), JSON.stringify({ report: "r".repeat(FIELD_BYTES) }));

		const small = await readText(await toolFor(8), "agent://Worker/report");
		expect(Buffer.byteLength(small, "utf-8")).toBeLessThan(8 * 1024 + 512);
		expect(small).toContain("output budget");
		expect(small).toContain("200.0KB in total");
		expect(small).toContain("Read agent://Worker/report without the extraction to page it");

		const large = await readText(await toolFor(64), "agent://Worker/report");
		expect(Buffer.byteLength(large, "utf-8")).toBeGreaterThan(Buffer.byteLength(small, "utf-8") * 4);
		expect(Buffer.byteLength(large, "utf-8")).toBeLessThan(64 * 1024 + 512);
	});

	it("leaves an extracted field inside the budget whole and unannotated", async () => {
		const sessionFile = path.join(dir, "conv2.jsonl");
		const agentDir = sessionFile.slice(0, -6);
		await fs.mkdir(agentDir, { recursive: true });
		AgentRegistry.global().register({
			id: "conv2",
			displayName: "main",
			kind: "main",
			session: { sessionManager: { getArtifactsDir: () => agentDir } } as unknown as AgentSession,
			sessionFile,
			scope: "session-b",
		});
		await fs.writeFile(path.join(agentDir, "Small.md"), JSON.stringify({ report: "ok" }));

		const text = await readText(await toolFor(8), "agent://Small/report");
		expect(text).toContain("ok");
		expect(text).not.toContain("output budget");
	});
});
