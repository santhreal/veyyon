/**
 * WHY:
 * A tool result that carries a picture also carries a sentence to the model about
 * whether the user saw it. The session wrote that sentence by reading
 * `TERMINAL.imageProtocol` out of the TUI package, which was wrong twice: it made
 * the conversation engine unusable without a terminal, and in a run with no
 * terminal it answered from whatever the singleton happened to hold. A `-p` run
 * in a Kitty window emits text to a pipe and draws nothing, and the model was
 * told the picture was on screen.
 *
 * The class this suite closes: the engine deciding a CLIENT capability for
 * itself. The capability is now installed by the front end that has it
 * (`setImageDisplayProbe`), the default is "draws nothing", and the sweeps below
 * derive their variant space from the image-protocol enum at run time so a fourth
 * protocol reds this suite until someone decides what it means.
 *
 * What it does not catch: whether a terminal that claims a protocol actually put
 * pixels on the screen, which only that terminal can answer; the WORDING of the
 * sentence the model receives, which
 * `a-model-is-told-when-the-user-cannot-see-the-image.test.ts` owns; and a front
 * end that installs a probe and then draws nothing anyway, which is a lie the
 * engine cannot detect by construction.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	currentImageDisplayState,
	type ImageDisplayState,
	imageVisibilityNotice,
	setImageDisplayProbe,
} from "@veyyon/coding-agent/session/image-visibility";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { ImageProtocol, imageFallback, setTerminalImageProtocol, TERMINAL } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { IMAGE_FALLBACK_REASONS } from "@veyyon/utils/image-fallback";

let authStorage: AuthStorage | undefined;
let mode: InteractiveMode | undefined;
let session: AgentSession | undefined;
let tempDir: TempDir | undefined;
let originalProtocol: ImageProtocol | null = null;

/** The state read once per protocol the TUI knows, keyed by protocol. */
function stateForEachProtocol(): Map<ImageProtocol, ImageDisplayState> {
	const seen = new Map<ImageProtocol, ImageDisplayState>();
	for (const protocol of Object.values(ImageProtocol)) {
		setTerminalImageProtocol(protocol);
		seen.set(protocol, currentImageDisplayState());
	}
	return seen;
}

/**
 * A real terminal front end over a real session, built the way the other
 * interactive-mode suites build one. Constructing it is the act under test: the
 * probe is installed while the front end resolves its terminal capabilities, so a
 * deleted install line reds the cases below.
 */
async function startTerminalFrontEnd(): Promise<void> {
	tempDir = TempDir.createSync("@pi-image-probe-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
	session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
		settings: Settings.isolated(),
		modelRegistry,
	});
	mode = new InteractiveMode(session, "test");
}

beforeAll(() => {
	initTheme();
	originalProtocol = TERMINAL.imageProtocol;
});

beforeEach(() => {
	resetSettingsForTest();
	// No front end has spoken yet. This is the state a `-p`, rpc or acp run stays
	// in for its whole life, and the state every case starts from.
	setImageDisplayProbe(undefined);
});

afterEach(async () => {
	mode?.stop();
	mode = undefined;
	await session?.dispose();
	session = undefined;
	authStorage?.close();
	authStorage = undefined;
	tempDir?.removeSync();
	tempDir = undefined;
	setTerminalImageProtocol(originalProtocol);
	setImageDisplayProbe(undefined);
	resetSettingsForTest();
});

describe("only the front end says whether a picture reached the screen", () => {
	/**
	 * The variant space, pinned by equality. Every sweep below iterates the enum, so
	 * a protocol added to the TUI silently joins them; this is the case that stops
	 * it joining without a decision.
	 */
	it("sweeps every image protocol the TUI knows", () => {
		expect(Object.values(ImageProtocol).sort()).toEqual(
			[ImageProtocol.Iterm2, ImageProtocol.Kitty, ImageProtocol.Sixel].sort(),
		);
	});

	/**
	 * The other variant space: why a client did not draw. Both surfaces have to name
	 * every cause — the session in the sentence it sends the model, the renderer in
	 * the placeholder row the user reads — and a fifth cause added with one of them
	 * left out is the failure this sweeps for. `IMAGE_FALLBACK_REASONS` is a value
	 * so that the sweep exists at all.
	 */
	it("gives every fallback cause its own sentence to the model and its own placeholder row", () => {
		const sentences = IMAGE_FALLBACK_REASONS.map(reason => imageVisibilityNotice({ shown: false, reason }, 1));
		const rows = IMAGE_FALLBACK_REASONS.map(reason => imageFallback({ mimeType: "image/png", reason }));

		expect(IMAGE_FALLBACK_REASONS).toEqual(["no-protocol", "images-off", "over-budget", "unsupported-format"]);
		expect(sentences.filter(sentence => sentence !== undefined)).toHaveLength(IMAGE_FALLBACK_REASONS.length);
		expect(new Set(sentences).size).toBe(IMAGE_FALLBACK_REASONS.length);
		expect(new Set(rows).size).toBe(IMAGE_FALLBACK_REASONS.length);
	});

	/**
	 * The defect, from the reporting end. A process with no front end installed is
	 * a headless run, and it draws nothing whatever the terminal singleton says.
	 */
	it("says the picture never reached the screen when nothing claimed to draw it", () => {
		const seen = stateForEachProtocol();

		for (const [protocol, state] of seen) {
			expect(state, `protocol ${JSON.stringify(protocol)}`).toEqual({ shown: false, reason: "no-protocol" });
		}
	});

	it("says the picture never reached the screen when the terminal singleton is empty too", () => {
		setTerminalImageProtocol(null);

		expect(currentImageDisplayState()).toEqual({ shown: false, reason: "no-protocol" });
	});

	/**
	 * The wiring, driven rather than described: the terminal front end installs the
	 * answer as it starts, and from then on the engine follows the terminal's
	 * protocol without importing it.
	 */
	it("follows the terminal once the terminal front end has started", async () => {
		await startTerminalFrontEnd();

		const seen = stateForEachProtocol();

		for (const [protocol, state] of seen) {
			expect(state, `protocol ${JSON.stringify(protocol)}`).toEqual({ shown: true });
		}
	});

	it("reports no protocol once the terminal front end has started in a terminal that has none", async () => {
		await startTerminalFrontEnd();
		setTerminalImageProtocol(null);

		expect(currentImageDisplayState()).toEqual({ shown: false, reason: "no-protocol" });
	});

	/**
	 * Precedence. The capability is asked first, so a client that cannot draw is
	 * never described as one whose user turned images off.
	 */
	it("prefers the setting's reason over the capability's when both would fire", async () => {
		await startTerminalFrontEnd();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		Settings.instance.set("terminal.showImages", false);

		expect(currentImageDisplayState()).toEqual({ shown: false, reason: "images-off" });

		Settings.instance.set("terminal.showImages", true);
		setTerminalImageProtocol(null);

		expect(currentImageDisplayState()).toEqual({ shown: false, reason: "no-protocol" });
	});

	/**
	 * The probe is asked on every call, not read once and cached, and it is
	 * removable. A front end that shuts down leaves the engine in the headless
	 * state rather than in its last answer — which is also what keeps this suite
	 * from poisoning the next one.
	 */
	it("stops following the terminal when the front end withdraws its answer", async () => {
		await startTerminalFrontEnd();
		setTerminalImageProtocol(ImageProtocol.Kitty);
		expect(currentImageDisplayState()).toEqual({ shown: true });

		setImageDisplayProbe(undefined);

		expect(currentImageDisplayState()).toEqual({ shown: false, reason: "no-protocol" });
	});
});
