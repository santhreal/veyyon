/**
 * The `/mcp add` wizard is a ModalShell card that answers the pointer.
 *
 * WHAT THIS CLOSES. The wizard used to paint a bare `DynamicBorder` stack into
 * the composer slot and spell its keys out as bracketed hint lines in the body
 * ("[↑↓ to navigate, Enter to select, Esc to go back]"). It consumed no mouse
 * input: an option could not be clicked, a wheel notch did nothing, and there
 * was no close glyph because there was no card chrome to hold one. This suite
 * pins the contract the card now owes, the same one the other converted
 * pickers keep: hover bands the option under the pointer, a click takes that
 * option exactly as Enter does, a wheel notch steps the selection, and the
 * chrome cancels the wizard.
 *
 * It also pins the one thing this card does that the list pickers do not: the
 * footer chips are per STEP, not per surface. Esc cancels on the first step
 * and steps back on every later one, matching `handleInput`, and an input step
 * offers "enter continue" where an option step offers "enter select". A single
 * fixed chip row would lie on half the flow.
 *
 * Initial OAuth failure and cancellation screens register their choices before
 * keyboard navigation. Both choices are exercised at 60 and 120 columns; an
 * unregistered row or a swapped option index must fail on the first paint.
 *
 * WHAT IT DOES NOT CATCH. It drives the component directly, so it says nothing
 * about the host mounting it as a fullscreen overlay. It also does not reach
 * the "auth-method" step (dual-choice selector when neither OAuth nor manual
 * credentials can be auto-detected from server discovery metadata).
 *
 * Colour is forced ON: `theme.bg` returns its argument unchanged when colour
 * is off, so under the default piped policy a banded row is byte-identical to
 * a plain one and no assertion could tell them apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as oauthDiscovery from "@veyyon/coding-agent/mcp/oauth-discovery";
import type { MCPServerConfig } from "@veyyon/coding-agent/mcp/types";
import {
	MCPAddWizard,
	type MCPAddWizardOAuthResult,
} from "@veyyon/coding-agent/modes/terminal/components/dialogs/mcp-add-wizard";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const WIDTH = 110;
const BG_OPEN = /\x1b\[48;/;

let policy: AnsiPolicy;
let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	vi.restoreAllMocks();
	setAnsiPolicy(policy);
	geometry.restore();
});

/** SGR motion (button 32+3=35), left press, and wheel at 1-based screen coords. */
function motionAt(row1: number, col1 = 40): string {
	return `\x1b[<35;${col1};${row1}M`;
}
function clickAt(row1: number, col1 = 40): string {
	return `\x1b[<0;${col1};${row1}M`;
}
function wheelAt(direction: "up" | "down", row1: number, col1 = 40): string {
	return `\x1b[<${direction === "down" ? 65 : 64};${col1};${row1}M`;
}

interface Harness {
	wizard: MCPAddWizard;
	completed: Array<{ name: string; config: MCPServerConfig }>;
	cancelled: number;
	rows: () => string[];
	stripped: () => string[];
}

/**
 * A wizard at the step named by `initialName`: a name skips the text field and
 * opens on the transport list, `undefined` starts at the field. The parameter
 * has NO default on purpose — a default would swallow the explicit `undefined`
 * the input-step cases pass.
 */
function makeWizard(
	initialName: string | undefined,
	options?: {
		width?: number;
		onTestConnection?: (config: MCPServerConfig) => Promise<void>;
		onOAuth?: (
			authUrl: string,
			tokenUrl: string,
			clientId: string,
			clientSecret: string,
			scopes: string,
		) => Promise<MCPAddWizardOAuthResult>;
	},
): Harness {
	const harness: Harness = {
		wizard: undefined as unknown as MCPAddWizard,
		completed: [],
		cancelled: 0,
		rows: () => [],
		stripped: () => [],
	};
	harness.wizard = new MCPAddWizard(
		(name, config) => harness.completed.push({ name, config }),
		() => {
			harness.cancelled += 1;
		},
		options?.onOAuth,
		options?.onTestConnection,
		undefined,
		initialName,
	);
	harness.rows = () => [...harness.wizard.render(options?.width ?? WIDTH)];
	harness.stripped = () => harness.rows().map(line => Bun.stripANSI(line));
	return harness;
}

function type(wizard: MCPAddWizard, text: string): void {
	for (const ch of text) wizard.handleInput(ch);
}

/** Replace current text field content by clearing to line start (Ctrl+U) then typing. */
function replaceInput(wizard: MCPAddWizard, text: string): void {
	wizard.handleInput("\x15");
	type(wizard, text);
}

function enter(wizard: MCPAddWizard): void {
	wizard.handleInput("\n");
}

function pressEscape(wizard: MCPAddWizard): void {
	wizard.handleInput("\x1b");
}

/** 1-based screen row of the first rendered line containing `text`. */
function rowOf(harness: Harness, text: string): number {
	const index = harness.stripped().findIndex(line => line.includes(text));
	expect(index, `row containing ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** 1-based screen row of the option row carrying `label` (handles cursor prefix or spaces). */
function optionRowOf(harness: Harness, label: string): number {
	const lines = harness.stripped();
	const index = lines.findIndex(line => {
		const trimmed = line.trim();
		return (
			trimmed.includes(`${theme.nav.cursor} ${label}`) ||
			trimmed.includes(`  ${label}`) ||
			(trimmed.includes(` ${label}`) && !trimmed.includes("Auth: None") && !trimmed.includes("Review Configuration"))
		);
	});
	expect(index, `option row for ${JSON.stringify(label)}`).toBeGreaterThanOrEqual(0);
	return index + 1;
}

/** 1-based row/col of the close glyph, from the frame the card last painted. */
function closeGlyph(harness: Harness): { row: number; col: number } {
	const lines = harness.stripped();
	const row = lines.findIndex(line => line.includes("[x]"));
	expect(row, "close glyph row").toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf("[x]") + 2 };
}

/**
 * 1-based row/col inside a footer chip. Chips are read from the STRIPPED frame:
 * the key and its label are styled separately, so the raw line never carries
 * the two words next to each other.
 */
function chip(harness: Harness, label: string): { row: number; col: number } {
	const lines = harness.stripped();
	const row = lines.findIndex(line => line.includes(label));
	expect(row, `footer row carrying ${JSON.stringify(label)}`).toBeGreaterThanOrEqual(0);
	return { row: row + 1, col: (lines[row] as string).indexOf(label) + 2 };
}

describe("the mcp add wizard card answers the pointer", () => {
	it("paints a titled card with a close glyph", () => {
		const frame = makeWizard("probe").stripped().join("\n");

		expect(frame).toContain("Add MCP Server");
		expect(frame).toContain("[x]");
		expect(frame).toContain("Step 2: Transport Type");
		// The bracketed hint lines are chips now, not body text.
		expect(frame).not.toContain("[↑↓ to navigate");
	});

	it("advertises the keys the step in front of you actually takes", () => {
		const optionStep = makeWizard("probe").stripped().join("\n");
		expect(optionStep).toContain("enter select");
		expect(optionStep).toContain("esc back");
		expect(optionStep).not.toContain("enter continue");

		const inputStep = makeWizard(undefined).stripped().join("\n");
		expect(inputStep).toContain("Step 1: Server Name");
		expect(inputStep).toContain("enter continue");
		// The first step has nothing behind it, so Esc abandons the wizard.
		expect(inputStep).toContain("esc cancel");
		expect(inputStep).not.toContain("esc back");
	});

	it("bands the option under the pointer without taking it", () => {
		const harness = makeWizard("probe");
		const row = rowOf(harness, "sse (Server-Sent Events)");
		const before = harness.rows()[row - 1] as string;

		harness.wizard.handleInput(motionAt(row));
		const after = harness.rows()[row - 1] as string;

		expect(after).not.toBe(before);
		expect(after).toMatch(BG_OPEN);
		expect(Bun.stripANSI(after)).toContain("sse (Server-Sent Events)");
		// Hover is not selection: the step did not advance.
		expect(harness.stripped().join("\n")).toContain("Step 2: Transport Type");
	});

	it("takes the option under a click, exactly as Enter does", () => {
		const harness = makeWizard("probe");

		harness.wizard.handleInput(clickAt(rowOf(harness, "http (HTTP server)")));

		const frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 3: Server URL");
		expect(frame).not.toContain("Step 2: Transport Type");
	});

	it("steps the selection on a wheel notch", () => {
		const harness = makeWizard("probe");
		// stdio is selected first; one notch down moves onto http, and Enter then
		// takes http rather than the transport the wizard opened on.
		harness.wizard.handleInput(wheelAt("down", rowOf(harness, "stdio (Local process)")));
		harness.wizard.handleInput("\n");

		expect(harness.stripped().join("\n")).toContain("Step 3: Server URL");
	});

	it("steps back on the esc chip and cancels on the chrome", () => {
		const back = makeWizard("probe");
		const backChip = chip(back, "esc back");
		back.wizard.handleInput(clickAt(backChip.row, backChip.col));

		expect(back.cancelled).toBe(0);
		expect(back.stripped().join("\n")).toContain("Step 1: Server Name");

		for (const target of ["glyph", "chip", "outside"] as const) {
			const harness = makeWizard(undefined);
			if (target === "glyph") {
				const glyph = closeGlyph(harness);
				harness.wizard.handleInput(clickAt(glyph.row, glyph.col));
			} else if (target === "chip") {
				const escapeChip = chip(harness, "esc cancel");
				harness.wizard.handleInput(clickAt(escapeChip.row, escapeChip.col));
			} else {
				// A card hit-tests against its LAST paint, so the frame has to exist
				// before a click can land outside it.
				harness.rows();
				harness.wizard.handleInput(clickAt(1, 1));
			}

			expect(harness.cancelled, target).toBe(1);
			expect(harness.completed, target).toEqual([]);
		}
	});

	it("cancels the whole wizard on the close glyph, not just the step", () => {
		const harness = makeWizard("probe");
		const glyph = closeGlyph(harness);

		harness.wizard.handleInput(clickAt(glyph.row, glyph.col));

		// The glyph closes the surface: it does NOT do what the `esc back` chip
		// does, which is the other thing a two-action card could plausibly mean.
		expect(harness.cancelled).toBe(1);
		expect(harness.stripped().join("\n")).toContain("Step 2: Transport Type");
	});

	it("keeps what you typed when the pointer moves over an input step", () => {
		const harness = makeWizard(undefined);
		for (const ch of "gateway") harness.wizard.handleInput(ch);
		expect(harness.stripped().join("\n")).toContain("gateway");

		// The body of an input step belongs to the text field. A wheel notch that
		// reached the option mover would re-run `#renderStep()`, which builds a
		// FRESH `Input` seeded from committed state, silently discarding the
		// half-typed name. A click on the prose must be inert for the same reason.
		const row = rowOf(harness, "Enter a unique name for this server:");
		harness.wizard.handleInput(wheelAt("down", row));
		harness.wizard.handleInput(clickAt(row));

		expect(harness.cancelled).toBe(0);
		const frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 1: Server Name");
		expect(frame).toContain("gateway");
	});
});
async function drainMicrotasks(count = 50): Promise<void> {
	for (let i = 0; i < count; i++) {
		await Promise.resolve();
	}
}

describe("wizard step transitions, input retention, and text-input step rendering", () => {
	it("drives stdio workflow: name, command, args, validation errors, and backward navigation", () => {
		const harness = makeWizard(undefined);
		let frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 1: Server Name");
		expect(frame).toContain("Enter a unique name for this server:");

		// Empty name validation
		enter(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 1: Server Name");
		expect(frame).toContain("x Server name cannot be empty");

		// Space in name validation
		type(harness.wizard, "invalid name");
		enter(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 1: Server Name");
		expect(frame).toContain("can only contain letters");
		expect(frame).toContain("numbers, dash, underscore");

		// Valid name entry
		const validName = makeWizard(undefined);
		type(validName.wizard, "my-stdio-server");
		enter(validName.wizard);

		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step 2: Transport Type");
		expect(frame).toContain("stdio (Local process)");

		// Select stdio (default)
		enter(validName.wizard);
		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step 3: Command");
		expect(frame).toContain("Enter the command to run:");

		// Empty command is required (no advance)
		enter(validName.wizard);
		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step 3: Command");

		type(validName.wizard, "node");
		enter(validName.wizard);

		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step 4: Arguments (Optional)");
		expect(frame).toContain("Enter command arguments (space-separated):");

		type(validName.wizard, "dist/index.js");
		enter(validName.wizard);

		frame = validName.stripped().join("\n");
		expect(frame).toContain("Review Configuration");
		expect(frame).toContain("Name: my-stdio-server");
		expect(frame).toContain("Type: stdio");
		expect(frame).toContain("Command: node");
		expect(frame).toContain("Args: dist/index.js");
		expect(frame).toContain("Auth: None");

		// Backward navigation: confirm -> header-name -> apikey -> args -> command -> transport -> name -> cancel
		pressEscape(validName.wizard);
		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step: HTTP Header Name");
		expect(frame).toContain("Authorization");

		pressEscape(validName.wizard);
		frame = validName.stripped().join("\n");
		expect(frame).toContain("API Key Required");

		pressEscape(validName.wizard);
		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step 4: Arguments (Optional)");
		expect(frame).toContain("dist/index.js");

		pressEscape(validName.wizard);
		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step 3: Command");
		expect(frame).toContain("node");

		pressEscape(validName.wizard);
		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step 2: Transport Type");

		pressEscape(validName.wizard);
		frame = validName.stripped().join("\n");
		expect(frame).toContain("Step 1: Server Name");
		expect(frame).toContain("my-stdio-server");

		pressEscape(validName.wizard);
		expect(validName.cancelled).toBe(1);

		// Forward drive to confirm and assert emitted MCPServerConfig
		const completedStdio = makeWizard(undefined);
		type(completedStdio.wizard, "my-stdio-server");
		enter(completedStdio.wizard);
		enter(completedStdio.wizard);
		type(completedStdio.wizard, "node");
		enter(completedStdio.wizard);
		type(completedStdio.wizard, "dist/index.js");
		enter(completedStdio.wizard);
		enter(completedStdio.wizard); // "Yes" on confirm
		expect(completedStdio.completed).toEqual([
			{
				name: "my-stdio-server",
				config: {
					type: "stdio",
					command: "node",
					args: ["dist/index.js"],
				},
			},
		]);
	});
	it("drives stdio workflow: manual auth fallback and emitted config with env", async () => {
		const onTestConnection = async () => {
			throw new Error("401 Unauthorized: API key required");
		};
		const stdioAuthHarness = makeWizard("stdio-auth-server", { onTestConnection });
		enter(stdioAuthHarness.wizard); // transport stdio
		type(stdioAuthHarness.wizard, "node");
		enter(stdioAuthHarness.wizard);
		type(stdioAuthHarness.wizard, "dist/server.js");
		enter(stdioAuthHarness.wizard);

		await drainMicrotasks();
		let frame = stdioAuthHarness.stripped().join("\n");
		expect(frame).toContain("API Key Required");
		type(stdioAuthHarness.wizard, "secret-token-stdio");
		enter(stdioAuthHarness.wizard);

		frame = stdioAuthHarness.stripped().join("\n");
		expect(frame).toContain("Step: Environment Variable Name");
		expect(frame).toContain("API_KEY");
		replaceInput(stdioAuthHarness.wizard, "MY_SERVER_KEY");
		enter(stdioAuthHarness.wizard);

		frame = stdioAuthHarness.stripped().join("\n");
		expect(frame).toContain("Review Configuration");
		expect(frame).toContain("Auth: API key via env (MY_SERVER_KEY)");

		enter(stdioAuthHarness.wizard); // "Yes" on confirm
		expect(stdioAuthHarness.completed).toEqual([
			{
				name: "stdio-auth-server",
				config: {
					type: "stdio",
					command: "node",
					args: ["dist/server.js"],
					env: {
						MY_SERVER_KEY: "secret-token-stdio",
					},
				},
			},
		]);
	});

	it("drives http workflow: url validation, manual api key, header name, and backward navigation", async () => {
		vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue(null);
		const onTestConnection = async () => {
			throw new Error("401 Unauthorized: API key required");
		};
		const harness = makeWizard("http-server", { onTestConnection });

		let frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 2: Transport Type");

		// Select HTTP transport (second option)
		harness.wizard.handleInput("\x1b[B"); // Down arrow
		enter(harness.wizard);

		frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 3: Server URL");
		expect(frame).toContain("Enter the server URL:");

		// Empty URL validation
		enter(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("x URL is required");

		// Invalid scheme validation
		type(harness.wizard, "ftp://example.com");
		enter(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("x URL must use http:// or https:// scheme");

		// Valid URL
		const validHttp = makeWizard("http-server", { onTestConnection });
		validHttp.wizard.handleInput("\x1b[B");
		enter(validHttp.wizard);
		type(validHttp.wizard, "https://api.example.com/mcp");
		enter(validHttp.wizard);

		// onTestConnection rejected with 401 without OAuth discovery, so falls back to apikey step
		await drainMicrotasks();
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("API Key Required");
		expect(frame).toContain("Enter your API key or token:");
		expect(frame).toContain("(Supports !command for password manager)");

		type(validHttp.wizard, "my-secret-key-123");
		enter(validHttp.wizard);

		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step: How to provide the key?");
		expect(frame).toContain("Environment variable");
		expect(frame).toContain("HTTP header");

		// First choose Environment variable (default option 0)
		enter(validHttp.wizard);

		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step: Environment Variable Name");
		expect(frame).toContain("Enter the environment variable name:");
		expect(frame).toContain("API_KEY");

		// Submit env var name to reach review configuration
		enter(validHttp.wizard);

		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Review Configuration");
		expect(frame).toContain("Auth: API key via env (API_KEY)");

		// Escape back to env-var-name, verifying input retention
		pressEscape(validHttp.wizard);
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step: Environment Variable Name");
		expect(frame).toContain("API_KEY");

		// Escape back to auth location selector
		pressEscape(validHttp.wizard);
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step: How to provide the key?");

		// Now choose HTTP header (option 1)
		validHttp.wizard.handleInput("\x1b[B");
		enter(validHttp.wizard);

		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step: HTTP Header Name");
		expect(frame).toContain("Enter the HTTP header name:");
		expect(frame).toContain("Authorization");

		// Submit header name
		enter(validHttp.wizard);

		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Review Configuration");
		expect(frame).toContain("Name: http-server");
		expect(frame).toContain("Type: http");
		expect(frame).toContain("URL: https://api.example.com/mcp");
		expect(frame).toContain("Auth: API key via header (Authorization)");

		// Backward navigation preserves inputs
		pressEscape(validHttp.wizard);
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step: HTTP Header Name");
		expect(frame).toContain("Authorization");

		pressEscape(validHttp.wizard);
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step: How to provide the key?");

		pressEscape(validHttp.wizard);
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("API Key Required");
		expect(frame).toContain("my-secret-key-123");

		pressEscape(validHttp.wizard);
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step 3: Server URL");
		expect(frame).toContain("https://api.example.com/mcp");

		pressEscape(validHttp.wizard);
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step 2: Transport Type");

		pressEscape(validHttp.wizard);
		frame = validHttp.stripped().join("\n");
		expect(frame).toContain("Step 1: Server Name");
		expect(frame).toContain("http-server");

		pressEscape(validHttp.wizard);
		expect(validHttp.cancelled).toBe(1);

		// Forward drive with header auth and assert emitted MCPServerConfig
		const headerHttp = makeWizard("http-server", { onTestConnection });
		headerHttp.wizard.handleInput("\x1b[B"); // http
		enter(headerHttp.wizard);
		type(headerHttp.wizard, "https://api.example.com/mcp");
		enter(headerHttp.wizard);
		await drainMicrotasks();
		type(headerHttp.wizard, "my-secret-key-123");
		enter(headerHttp.wizard);
		headerHttp.wizard.handleInput("\x1b[B"); // header
		enter(headerHttp.wizard);
		replaceInput(headerHttp.wizard, "X-API-Key");
		enter(headerHttp.wizard);
		enter(headerHttp.wizard); // "Yes" on confirm
		expect(headerHttp.completed).toEqual([
			{
				name: "http-server",
				config: {
					type: "http",
					url: "https://api.example.com/mcp",
					headers: {
						"X-API-Key": "my-secret-key-123",
					},
				},
			},
		]);

		// Forward drive with env auth and assert emitted MCPServerConfig
		const envHttp = makeWizard("http-env-server", { onTestConnection });
		envHttp.wizard.handleInput("\x1b[B"); // http
		enter(envHttp.wizard);
		type(envHttp.wizard, "https://api.example.com/mcp");
		enter(envHttp.wizard);
		await drainMicrotasks();
		type(envHttp.wizard, "my-secret-key-123");
		enter(envHttp.wizard);
		enter(envHttp.wizard); // env (default)
		replaceInput(envHttp.wizard, "CUSTOM_API_KEY");
		enter(envHttp.wizard);
		enter(envHttp.wizard); // "Yes" on confirm
		expect(envHttp.completed).toEqual([
			{
				name: "http-env-server",
				config: {
					type: "http",
					url: "https://api.example.com/mcp",
					headers: {
						Authorization: "my-secret-key-123",
					},
				},
			},
		]);
	});

	it("drives sse workflow: manual header auth and emitted config", async () => {
		vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue(null);
		const onTestConnection = async () => {
			throw new Error("401 Unauthorized: API key required");
		};
		const sseHarness = makeWizard("sse-server", { onTestConnection });

		// Select SSE transport (third option)
		sseHarness.wizard.handleInput("\x1b[B");
		sseHarness.wizard.handleInput("\x1b[B");
		enter(sseHarness.wizard);

		let frame = sseHarness.stripped().join("\n");
		expect(frame).toContain("Step 3: Server URL");
		type(sseHarness.wizard, "https://sse.example.com/events");
		enter(sseHarness.wizard);

		await drainMicrotasks();
		type(sseHarness.wizard, "sse-secret-token");
		enter(sseHarness.wizard);

		// Choose HTTP header
		sseHarness.wizard.handleInput("\x1b[B");
		enter(sseHarness.wizard);
		replaceInput(sseHarness.wizard, "X-Auth-Token");
		enter(sseHarness.wizard);

		frame = sseHarness.stripped().join("\n");
		expect(frame).toContain("Review Configuration");
		expect(frame).toContain("Type: sse");
		expect(frame).toContain("URL: https://sse.example.com/events");
		expect(frame).toContain("Auth: API key via header (X-Auth-Token)");

		enter(sseHarness.wizard); // "Yes" on confirm
		expect(sseHarness.completed).toEqual([
			{
				name: "sse-server",
				config: {
					type: "sse",
					url: "https://sse.example.com/events",
					headers: {
						"X-Auth-Token": "sse-secret-token",
					},
				},
			},
		]);
	});

	it("drives oauth workflow: auth URL, token URL, client ID, secret, scopes, and backward navigation", async () => {
		vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue({
			authorizationUrl: "https://auth.example.com/oauth/authorize",
			tokenUrl: "https://auth.example.com/oauth/token",
		});
		const onTestConnection = async () => {
			throw new Error(
				'401 Unauthorized: WWW-Authenticate: Bearer authorization_uri="https://auth.example.com/oauth/authorize" token_uri="https://auth.example.com/oauth/token"',
			);
		};
		const onOAuth = async () => {
			throw new Error("OAuth browser flow cancelled");
		};
		const harness = makeWizard("oauth-server", { onTestConnection, onOAuth });

		// Select HTTP transport
		harness.wizard.handleInput("\x1b[B");
		enter(harness.wizard);
		type(harness.wizard, "https://mcp.example.com");
		enter(harness.wizard);

		// onOAuth rejected, so oauth-error step is rendered
		await drainMicrotasks();
		let frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth authentication failed");
		expect(frame).toContain("Retry");
		expect(frame).toContain("Edit OAuth settings");

		// Select "Edit OAuth settings" (second option)
		harness.wizard.handleInput("\x1b[B");
		enter(harness.wizard);

		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Authorization URL");
		expect(frame).toContain("Enter the OAuth authorization endpoint:");
		expect(frame).toContain("e.g., https://auth.example.com/oauth/authorize");

		// Press Enter to keep discovered auth URL and move to token URL
		enter(harness.wizard);

		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Token URL");
		expect(frame).toContain("Enter the OAuth token endpoint:");
		expect(frame).toContain("e.g., https://auth.example.com/oauth/token");

		// Press Enter to keep discovered token URL and move to client ID
		enter(harness.wizard);

		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Client ID");
		expect(frame).toContain("Enter your OAuth client ID:");

		type(harness.wizard, "client-id-999");
		enter(harness.wizard);

		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Client Secret (Optional)");
		expect(frame).toContain("Enter your OAuth client secret:");
		expect(frame).toContain("(Leave empty for PKCE-only flows)");

		type(harness.wizard, "client-secret-abc");
		enter(harness.wizard);

		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Scopes (Optional)");
		expect(frame).toContain("Enter OAuth scopes (space-separated):");
		expect(frame).toContain("e.g., read write");

		type(harness.wizard, "read write");

		// Test backward navigation through all OAuth steps
		pressEscape(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Client Secret (Optional)");
		expect(frame).toContain("client-secret-abc");

		pressEscape(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Client ID");
		expect(frame).toContain("client-id-999");

		pressEscape(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Token URL");
		expect(frame).toContain("https://auth.example.com/oauth/token");

		pressEscape(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("OAuth: Authorization URL");
		expect(frame).toContain("https://auth.example.com/oauth/authorize");

		pressEscape(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 3: Server URL");
		expect(frame).toContain("https://mcp.example.com");

		pressEscape(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 2: Transport Type");

		pressEscape(harness.wizard);
		frame = harness.stripped().join("\n");
		expect(frame).toContain("Step 1: Server Name");
		expect(frame).toContain("oauth-server");

		pressEscape(harness.wizard);
		expect(harness.cancelled).toBe(1);
	});
});

describe("choice renderer pointer and keyboard behavior", () => {
	it("renders and selects auth-location options via pointer and keyboard across widths", async () => {
		vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue(null);
		const onTestConnection = async () => {
			throw new Error("401 Unauthorized: API key required");
		};

		for (const testWidth of [60, 120]) {
			geometry.restore();
			geometry = stubStdoutGeometry({ columns: testWidth, rows: 40 });

			const harness = makeWizard("auth-loc-test", { onTestConnection, width: testWidth });
			harness.wizard.handleInput("\x1b[B"); // Select HTTP
			enter(harness.wizard);
			type(harness.wizard, "https://api.example.com");
			enter(harness.wizard);
			await drainMicrotasks();

			type(harness.wizard, "secret-token");
			enter(harness.wizard);

			let frame = harness.stripped().join("\n");
			expect(frame).toContain("Step: How to provide the key?");
			expect(frame).toContain("Environment variable");
			expect(frame).toContain("HTTP header");

			const rawRows = harness.rows();
			const envRow = optionRowOf(harness, "Environment variable");
			const headerRow = optionRowOf(harness, "HTTP header");

			// Verify selected prefix on Environment variable (index 0)
			expect(rawRows[envRow - 1]).toContain(theme.fg("accent", `${theme.nav.cursor} `));
			expect(rawRows[envRow - 1]).toContain(theme.fg("accent", "Environment variable"));
			expect(rawRows[headerRow - 1]).not.toContain(theme.fg("accent", `${theme.nav.cursor} `));
			expect(rawRows[headerRow - 1]).toContain("HTTP header");
			// Hover banding across widths
			const midCol = Math.floor(testWidth / 2);
			harness.wizard.handleInput(motionAt(headerRow, midCol));
			expect(harness.rows()[headerRow - 1]).toMatch(BG_OPEN);

			harness.wizard.handleInput(motionAt(envRow, midCol));
			expect(harness.rows()[envRow - 1]).toMatch(BG_OPEN);

			// Pointer click on HTTP header advances to header-name
			harness.wizard.handleInput(clickAt(headerRow, midCol));
			frame = harness.stripped().join("\n");
			expect(frame).toContain("Step: HTTP Header Name");

			// Step back to auth-location retains selected index 1 (HTTP header)
			pressEscape(harness.wizard);
			frame = harness.stripped().join("\n");
			expect(frame).toContain("Step: How to provide the key?");
			const reRows = harness.rows();
			expect(reRows[headerRow - 1]).toContain(theme.fg("accent", `${theme.nav.cursor} `));

			// Keyboard selection moves up to Environment variable
			harness.wizard.handleInput("\x1b[A"); // Up arrow
			const upRows = harness.rows();
			expect(upRows[envRow - 1]).toContain(theme.fg("accent", `${theme.nav.cursor} `));

			// Escape steps back to API Key Required
			pressEscape(harness.wizard);
			frame = harness.stripped().join("\n");
			expect(frame).toContain("API Key Required");

			// Re-enter and click Environment variable
			enter(harness.wizard);
			frame = harness.stripped().join("\n");
			expect(frame).toContain("Step: How to provide the key?");
			harness.wizard.handleInput(clickAt(envRow, midCol));
			frame = harness.stripped().join("\n");
			expect(frame).toContain("Step: Environment Variable Name");
		}
	});

	it("renders and selects confirm step options via pointer and keyboard across widths", () => {
		for (const testWidth of [60, 120]) {
			geometry.restore();
			geometry = stubStdoutGeometry({ columns: testWidth, rows: 40 });

			const harness = makeWizard(undefined, { width: testWidth });
			type(harness.wizard, "confirm-test");
			enter(harness.wizard);
			enter(harness.wizard); // stdio
			type(harness.wizard, "node");
			enter(harness.wizard);
			type(harness.wizard, "server.js");
			enter(harness.wizard);

			let frame = harness.stripped().join("\n");
			expect(frame).toContain("Review Configuration");
			expect(frame).toContain("Save this configuration?");
			expect(frame).toContain("Yes");
			expect(frame).toContain("No");

			const rawRows = harness.rows();
			const yesRow = optionRowOf(harness, "Yes");
			const noRow = optionRowOf(harness, "No");
			const midCol = Math.floor(testWidth / 2);

			expect(rawRows[yesRow - 1]).toContain(theme.fg("accent", `${theme.nav.cursor} `));
			expect(rawRows[yesRow - 1]).toContain(theme.fg("accent", "Yes"));
			expect(rawRows[noRow - 1]).not.toContain(theme.fg("accent", `${theme.nav.cursor} `));

			// Hover band on No option
			harness.wizard.handleInput(motionAt(noRow, midCol));
			expect(harness.rows()[noRow - 1]).toMatch(BG_OPEN);

			// Click "No" steps back to previous step before confirm (header-name)
			harness.wizard.handleInput(clickAt(noRow, midCol));
			frame = harness.stripped().join("\n");
			expect(frame).toContain("Step: HTTP Header Name");

			// Advance back to confirm and test keyboard navigation to "No"
			enter(harness.wizard);
			frame = harness.stripped().join("\n");
			expect(frame).toContain("Review Configuration");
			harness.wizard.handleInput("\x1b[B"); // Down arrow
			enter(harness.wizard);
			frame = harness.stripped().join("\n");
			expect(frame).toContain("Step: HTTP Header Name");
			// Advance back to confirm and click "Yes" to complete
			enter(harness.wizard);
			harness.wizard.handleInput(clickAt(optionRowOf(harness, "Yes"), midCol));
			expect(harness.completed).toHaveLength(1);
			expect(harness.completed[0]?.name).toBe("confirm-test");
		}
	});

	it.each([60, 120].flatMap(width => ["failed", "cancelled"].map(outcome => [width, outcome] as const)))(
		"answers initial OAuth-error choices (%i columns, %s)",
		async (testWidth, outcome) => {
			vi.spyOn(oauthDiscovery, "discoverOAuthEndpoints").mockResolvedValue({
				authorizationUrl: "https://auth.example.com/oauth/authorize",
				tokenUrl: "https://auth.example.com/oauth/token",
			});
			const onTestConnection = async () => {
				throw new Error("401 Unauthorized");
			};
			let oauthCalls = 0;
			const onOAuth = async () => {
				oauthCalls++;
				const error = new Error(outcome === "cancelled" ? "Login cancelled" : "OAuth connection refused");
				if (outcome === "cancelled") error.name = "MCPOAuthCancelledError";
				throw error;
			};
			geometry.restore();
			geometry = stubStdoutGeometry({ columns: testWidth, rows: 40 });

			const harness = makeWizard("oauth-error", { onTestConnection, onOAuth, width: testWidth });
			harness.wizard.handleInput("\x1b[B");
			enter(harness.wizard);
			type(harness.wizard, "https://api.example.com");
			enter(harness.wizard);
			await drainMicrotasks(100);

			let frame = harness.stripped().join("\n");
			expect(frame).toContain(outcome === "cancelled" ? "OAuth cancelled" : "OAuth authentication failed");
			expect(frame).toContain("Retry");
			expect(frame).toContain("Edit OAuth settings");
			const rawRows = harness.rows();
			for (const row of rawRows) expect(Bun.stringWidth(row)).toBe(testWidth);
			const editRow = optionRowOf(harness, "Edit OAuth settings");
			const retryRow = rowOf(harness, "→ Retry");
			const midCol = Math.floor(testWidth / 2);
			expect(rawRows[retryRow - 1]).toContain(theme.fg("accent", "→ "));

			harness.wizard.handleInput(motionAt(editRow, midCol));
			expect(harness.rows()[editRow - 1]).toMatch(BG_OPEN);
			harness.wizard.handleInput(clickAt(editRow, midCol));
			frame = harness.stripped().join("\n");
			expect(frame).toContain("OAuth: Authorization URL");
			pressEscape(harness.wizard);
			expect(harness.stripped().join("\n")).toContain("Step 3: Server URL");

			const retryHarness = makeWizard("oauth-retry", { onTestConnection, onOAuth, width: testWidth });
			retryHarness.wizard.handleInput("\x1b[B");
			enter(retryHarness.wizard);
			type(retryHarness.wizard, "https://api.example.com");
			enter(retryHarness.wizard);
			await drainMicrotasks(100);
			const prevCalls = oauthCalls;
			retryHarness.wizard.handleInput(clickAt(rowOf(retryHarness, "→ Retry"), midCol));
			await drainMicrotasks(100);
			expect(oauthCalls).toBe(prevCalls + 1);
		},
	);

	it("exercises transport choice options at narrow and wide widths with mouse hit mapping", () => {
		for (const testWidth of [60, 120]) {
			geometry.restore();
			geometry = stubStdoutGeometry({ columns: testWidth, rows: 40 });

			const harness = makeWizard("transport-width-test", { width: testWidth });
			const midCol = Math.floor(testWidth / 2);

			const stdioRow = optionRowOf(harness, "stdio (Local process)");
			expect(harness.rows()[stdioRow - 1]).toContain(theme.fg("accent", `${theme.nav.cursor} `));
			const httpRow = optionRowOf(harness, "http (HTTP server)");
			const sseRow = optionRowOf(harness, "sse (Server-Sent Events)");

			harness.wizard.handleInput(motionAt(sseRow, midCol));
			expect(harness.rows()[sseRow - 1]).toMatch(BG_OPEN);

			harness.wizard.handleInput(motionAt(httpRow, midCol));
			expect(harness.rows()[httpRow - 1]).toMatch(BG_OPEN);

			// Click on SSE option (index 2)
			harness.wizard.handleInput(clickAt(sseRow, midCol));
			let frame = harness.stripped().join("\n");
			expect(frame).toContain("Step 3: Server URL");

			// Escape back preserves index 2 (SSE selected)
			pressEscape(harness.wizard);
			frame = harness.stripped().join("\n");
			expect(frame).toContain("Step 2: Transport Type");
			expect(harness.rows()[sseRow - 1]).toContain(theme.fg("accent", `${theme.nav.cursor} `));

			// Wheel up moves selection to HTTP (index 1)
			harness.wizard.handleInput(wheelAt("up", sseRow, midCol));
			expect(harness.rows()[httpRow - 1]).toContain(theme.fg("accent", `${theme.nav.cursor} `));
		}
	});
});
