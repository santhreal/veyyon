import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { handleHuggingFace } from "../../src/scrapers/huggingface";
import * as scraperTypes from "../../src/scrapers/types";

/**
 * WHY: every Hub resource kind (model, dataset, space) is rendered from two fetches, the API
 * record and the README, through one loader. This suite pins what that loader owes each kind: the
 * record fields the markdown states, the README section under the kind's own heading, the API
 * page's final URL, and the degrade when the record is missing or is not JSON. A README that is
 * absent or blank produces no section at all.
 *
 * It does not cover the single-segment `model_or_user` fallback, which fetches sequentially.
 */

type Page = Pick<scraperTypes.LoadPageResult, "content" | "ok" | "status">;

function servePages(pages: Record<string, Page>): { mockRestore: () => void } {
	return spyOn(scraperTypes, "loadPage").mockImplementation(async url => {
		const page = pages[url];
		if (!page) {
			return { content: "", contentType: "text/plain", finalUrl: url, ok: false, status: 404 };
		}
		return {
			content: page.content,
			contentType: "application/json",
			finalUrl: url,
			ok: page.ok,
			status: page.status,
		};
	});
}

function json(record: unknown): Page {
	return { content: JSON.stringify(record), ok: true, status: 200 };
}

function render(result: scraperTypes.RenderResult | scraperTypes.ScraperDegrade | null): scraperTypes.RenderResult {
	if (result === null || scraperTypes.isScraperDegrade(result)) {
		throw new Error(`expected a render, got ${JSON.stringify(result)}`);
	}
	return result;
}

describe("a Hugging Face resource renders its API record and README", () => {
	let loadPageSpy: { mockRestore: () => void } | null = null;

	afterEach(() => {
		loadPageSpy?.mockRestore();
		loadPageSpy = null;
	});

	it("renders a model from its record with the model card under its own heading", async () => {
		loadPageSpy = servePages({
			"https://huggingface.co/api/models/org/demo": json({
				modelId: "org/demo",
				pipeline_tag: "text-generation",
				library_name: "transformers",
				downloads: 950,
				likes: 7,
				gated: "auto",
				cardData: { license: "mit", language: ["en", "fr"], datasets: ["org/corpus"], metrics: ["accuracy"] },
				tags: ["pytorch", "safetensors"],
			}),
			"https://huggingface.co/org/demo/raw/main/README.md": { content: "Card body\n", ok: true, status: 200 },
		});

		const result = render(await handleHuggingFace("https://huggingface.co/org/demo", 10));

		expect(result.method).toBe("huggingface");
		expect(result.finalUrl).toBe("https://huggingface.co/api/models/org/demo");
		expect(result.content).toBe(
			[
				"# org/demo",
				"",
				"**Task:** text-generation",
				"**Library:** transformers",
				"**Downloads:** 950",
				"**Likes:** 7",
				"**Access:** Gated",
				"**License:** mit",
				"**Language:** en, fr",
				"**Datasets:** org/corpus",
				"**Metrics:** accuracy",
				"**Tags:** pytorch, safetensors",
				"",
				"## Model Card",
				"",
				"Card body",
			].join("\n"),
		);
	});

	it("renders a dataset from its record with the dataset card under its own heading", async () => {
		loadPageSpy = servePages({
			"https://huggingface.co/api/datasets/squad": json({
				id: "squad",
				description: "Reading comprehension.",
				downloads: 120,
				likes: 3,
				private: true,
				cardData: { license: "cc-by-4.0", language: "en", task_categories: ["question-answering"] },
			}),
			"https://huggingface.co/datasets/squad/raw/main/README.md": { content: "Dataset body", ok: true, status: 200 },
		});

		const result = render(await handleHuggingFace("https://huggingface.co/datasets/squad", 10));

		expect(result.finalUrl).toBe("https://huggingface.co/api/datasets/squad");
		expect(result.content).toBe(
			[
				"# squad",
				"",
				"Reading comprehension.",
				"",
				"**Downloads:** 120",
				"**Likes:** 3",
				"**Visibility:** Private",
				"**License:** cc-by-4.0",
				"**Language:** en",
				"**Tasks:** question-answering",
				"",
				"## Dataset Card",
				"",
				"Dataset body",
			].join("\n"),
		);
	});

	it("renders a space from its record with the space info under its own heading", async () => {
		loadPageSpy = servePages({
			"https://huggingface.co/api/spaces/gradio/hello_world": json({
				id: "gradio/hello_world",
				title: "Hello World",
				author: "gradio",
				sdk: "gradio",
				likes: 42,
				cardData: { license: "apache-2.0", app_file: "app.py" },
			}),
			"https://huggingface.co/spaces/gradio/hello_world/raw/main/README.md": {
				content: "Space body",
				ok: true,
				status: 200,
			},
		});

		const result = render(await handleHuggingFace("https://huggingface.co/spaces/gradio/hello_world", 10));

		expect(result.finalUrl).toBe("https://huggingface.co/api/spaces/gradio/hello_world");
		expect(result.content).toBe(
			[
				"# gradio/hello_world",
				"",
				"Hello World",
				"",
				"**Author:** gradio",
				"**SDK:** gradio",
				"**Likes:** 42",
				"**License:** apache-2.0",
				"**App File:** app.py",
				"",
				"## Space Info",
				"",
				"Space body",
			].join("\n"),
		);
	});

	it("omits the README section when the README is missing or blank", async () => {
		loadPageSpy = servePages({
			"https://huggingface.co/api/models/org/bare": json({ modelId: "org/bare", likes: 1 }),
			"https://huggingface.co/api/models/org/blank": json({ modelId: "org/blank", likes: 1 }),
			"https://huggingface.co/org/blank/raw/main/README.md": { content: "  \n\t\n", ok: true, status: 200 },
		});

		const bare = render(await handleHuggingFace("https://huggingface.co/org/bare", 10));
		const blank = render(await handleHuggingFace("https://huggingface.co/org/blank", 10));

		expect(bare.content).toBe("# org/bare\n\n**Likes:** 1");
		expect(blank.content).toBe("# org/blank\n\n**Likes:** 1");
	});

	it("degrades with the HTTP status when the API record cannot be fetched", async () => {
		loadPageSpy = servePages({
			"https://huggingface.co/org/gone/raw/main/README.md": { content: "orphan readme", ok: true, status: 200 },
		});

		const result = await handleHuggingFace("https://huggingface.co/org/gone", 10);

		expect(scraperTypes.isScraperDegrade(result)).toBe(true);
		if (!scraperTypes.isScraperDegrade(result)) return;
		expect(result.note).toBe("huggingface scraper failed (HTTP 404); fell back to a generic fetch");
	});

	it("degrades when the API record is not JSON", async () => {
		loadPageSpy = servePages({
			"https://huggingface.co/api/datasets/broken": { content: "<html>rate limited</html>", ok: true, status: 200 },
		});

		const result = await handleHuggingFace("https://huggingface.co/datasets/broken", 10);

		expect(scraperTypes.isScraperDegrade(result)).toBe(true);
		if (!scraperTypes.isScraperDegrade(result)) return;
		expect(result.note).toBe("huggingface scraper failed (unexpected response shape); fell back to a generic fetch");
	});
});
