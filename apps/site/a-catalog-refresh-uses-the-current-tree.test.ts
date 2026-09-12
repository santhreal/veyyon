/**
 * WHY: repository relocation left catalog refresh pointing at a removed CDN path.
 * Execute the shipped page script against its HTML with only fetch replaced. The
 * suite covers live-data precedence, response failure fallbacks, and terminal
 * failure feedback. It does not measure browser layout or real CDN availability.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { Script } from "node:vm";
import { parseHTML } from "linkedom";

const page = readFileSync(new URL("./models.html", import.meta.url), "utf8");
const script = new Script(readFileSync(new URL("./models.js", import.meta.url), "utf8"), {
	filename: "models.js",
});
const liveUrl = "https://cdn.jsdelivr.net/gh/santhreal/veyyon@main/apps/site/models-data.json";
const localUrl = "./models-data.json";
const failureModes = ["http", "json", "network"] as const;
type FailureMode = (typeof failureModes)[number];

function catalog(name: string) {
	return {
		providerCount: 1,
		modelCount: 1,
		generated: "fixture",
		providers: [
			{
				id: "fixture",
				label: "Fixture provider",
				count: 1,
				models: [{ id: "fixture-model", name, ctx: 8192, ci: 0.1, co: 0.2 }],
			},
		],
	};
}

function failure(mode: FailureMode): Response {
	if (mode === "network") throw new Error("Network unavailable");
	return new Response(mode === "json" ? "not JSON" : JSON.stringify(catalog("Unavailable catalog model")), {
		status: mode === "http" ? 503 : 200,
	});
}

async function openCatalog(fetch: (url: string) => Promise<Response>, loading = false) {
	const window = parseHTML(page);
	Object.defineProperty(window.document, "readyState", { value: loading ? "loading" : "complete" });
	script.runInNewContext({ document: window.document, fetch }, { timeout: 1000 });
	if (loading) window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
	// Fetch and Response.json settle before the next event-loop turn.
	await setImmediate();
	return window;
}

describe("catalog refresh and fallback", () => {
	for (const loading of [false, true]) {
		it(`renders current CDN data before the deployed copy (loading=${loading})`, async () => {
			const requests: string[] = [];
			const { document, Event } = await openCatalog(async url => {
				requests.push(url);
				if (url === liveUrl) return Response.json(catalog("Current catalog model"));
				if (url === localUrl) return Response.json(catalog("Deployed catalog model"));
				return new Response("Not found", { status: 404 });
			}, loading);

			expect(requests).toEqual([liveUrl]);
			expect(document.querySelector(".m-name")?.textContent).toContain("Current catalog model");
			expect(document.querySelector("#cat-loading")).toBeNull();
			expect(document.querySelector("#cat-controls")?.hasAttribute("hidden")).toBe(false);
			const header = document.querySelector(".cat-prov-head");
			expect(header?.getAttribute("aria-expanded")).toBe("false");
			header?.dispatchEvent(new Event("click"));
			expect(header?.getAttribute("aria-expanded")).toBe("true");
			expect(header?.nextElementSibling?.hasAttribute("hidden")).toBe(false);
		});
	}

	for (const mode of failureModes) {
		it(`uses the deployed catalog after a CDN ${mode} failure`, async () => {
			const requests: string[] = [];
			const { document } = await openCatalog(async url => {
				requests.push(url);
				return url === localUrl ? Response.json(catalog("Deployed catalog model")) : failure(mode);
			});

			expect(requests).toEqual([liveUrl, localUrl]);
			expect(document.querySelector(".m-name")?.textContent).toContain("Deployed catalog model");
			expect(document.querySelector("#cat-loading")).toBeNull();
		});

		it(`reports unavailable data after both sources have a ${mode} failure`, async () => {
			const requests: string[] = [];
			const { document } = await openCatalog(async url => {
				requests.push(url);
				return failure(mode);
			});

			expect(requests).toEqual([liveUrl, localUrl]);
			expect(document.querySelector("#cat-loading")?.textContent).toBe(
				"Could not load the model catalog. The raw data is at ./models-data.json.",
			);
			expect(document.querySelector("#cat-controls")?.hasAttribute("hidden")).toBe(true);
		});
	}
});
