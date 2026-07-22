import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getImplicitOllamaBaseUrl } from "@veyyon/coding-agent/config/model-discovery";

/**
 * getImplicitOllamaBaseUrl resolves the Ollama endpoint from the environment when no
 * explicit provider base URL is configured. It had no test, yet it decides where every
 * Ollama request goes. The precedence and the OLLAMA_HOST normalization are pinned:
 *   - OLLAMA_BASE_URL wins verbatim (trimmed) when set;
 *   - otherwise OLLAMA_HOST is normalized: a bare host gains an http:// scheme and the
 *     default 11434 port; an explicit port is kept; a leading `//` gets http:; a leading
 *     `:port` binds to 127.0.0.1; an https host keeps its own port rules (no 11434
 *     default, and an explicit :443 collapses to the bare host);
 *   - a blank, unparseable, or non-http(s) OLLAMA_HOST falls through to the built-in
 *     default http://127.0.0.1:11434, as does a fully unset environment.
 */

const originalBaseUrl = Bun.env.OLLAMA_BASE_URL;
const originalHost = Bun.env.OLLAMA_HOST;

function setEnv(baseUrl: string | undefined, host: string | undefined): void {
	if (baseUrl === undefined) delete Bun.env.OLLAMA_BASE_URL;
	else Bun.env.OLLAMA_BASE_URL = baseUrl;
	if (host === undefined) delete Bun.env.OLLAMA_HOST;
	else Bun.env.OLLAMA_HOST = host;
}

beforeEach(() => {
	delete Bun.env.OLLAMA_BASE_URL;
	delete Bun.env.OLLAMA_HOST;
});

afterEach(() => {
	if (originalBaseUrl === undefined) delete Bun.env.OLLAMA_BASE_URL;
	else Bun.env.OLLAMA_BASE_URL = originalBaseUrl;
	if (originalHost === undefined) delete Bun.env.OLLAMA_HOST;
	else Bun.env.OLLAMA_HOST = originalHost;
});

describe("getImplicitOllamaBaseUrl", () => {
	it("returns the built-in default when nothing is set", () => {
		setEnv(undefined, undefined);
		expect(getImplicitOllamaBaseUrl()).toBe("http://127.0.0.1:11434");
	});

	it("prefers a trimmed OLLAMA_BASE_URL over OLLAMA_HOST", () => {
		setEnv("  http://myhost:9999  ", "ignored:1");
		expect(getImplicitOllamaBaseUrl()).toBe("http://myhost:9999");
	});

	it("adds the http scheme and default 11434 port to a bare OLLAMA_HOST", () => {
		setEnv(undefined, "myhost");
		expect(getImplicitOllamaBaseUrl()).toBe("http://myhost:11434");
	});

	it("keeps an explicit port on OLLAMA_HOST", () => {
		setEnv(undefined, "myhost:1234");
		expect(getImplicitOllamaBaseUrl()).toBe("http://myhost:1234");
	});

	it("treats a leading // as an http host and a leading :port as a 127.0.0.1 bind", () => {
		setEnv(undefined, "//myhost:5");
		expect(getImplicitOllamaBaseUrl()).toBe("http://myhost:5");
		setEnv(undefined, ":8080");
		expect(getImplicitOllamaBaseUrl()).toBe("http://127.0.0.1:8080");
	});

	it("keeps https hosts without forcing the 11434 port and collapses an explicit :443", () => {
		setEnv(undefined, "https://secure");
		expect(getImplicitOllamaBaseUrl()).toBe("https://secure");
		setEnv(undefined, "https://secure:443");
		expect(getImplicitOllamaBaseUrl()).toBe("https://secure");
	});

	it("falls back to the default for a blank or non-http(s) OLLAMA_HOST", () => {
		setEnv(undefined, "   ");
		expect(getImplicitOllamaBaseUrl()).toBe("http://127.0.0.1:11434");
		setEnv(undefined, "ftp://x");
		expect(getImplicitOllamaBaseUrl()).toBe("http://127.0.0.1:11434");
	});
});
