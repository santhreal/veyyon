import { describe, expect, test, vi } from "bun:test";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@veyyon/coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";

/**
 * Issue #1020: `ctx.shutdown()` is a no-op in interactive mode.
 *
 * The `contextActions.shutdown` handler wired by
 * `ExtensionUiController.initializeHookRunner` is supposed to flip
 * `InteractiveMode.shutdownRequested` so the main loop's
 * `checkShutdownRequested()` can drive the graceful shutdown path.
 */
describe("issue #1020 - ctx.shutdown() in interactive mode", () => {
	test("contextActions.shutdown sets InteractiveModeContext.shutdownRequested", () => {
		let capturedContextActions: ExtensionContextActions | undefined;

		const fakeExtensionRunner = {
			initialize(
				_actions: ExtensionActions,
				contextActions: ExtensionContextActions,
				_commandContextActions?: ExtensionCommandContextActions,
				_uiContext?: ExtensionUIContext,
			): void {
				capturedContextActions = contextActions;
			},
		};

		const ctxStub = {
			shutdownRequested: false,
			session: {
				extensionRunner: fakeExtensionRunner,
				// other session fields are only touched lazily by other actions; we
				// only invoke `shutdown`, so leave them out.
			},
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;

		const controller = new ExtensionUiController(ctxStub);
		controller.initializeHookRunner({} as ExtensionUIContext, false);

		expect(capturedContextActions).toBeDefined();
		expect(typeof capturedContextActions?.shutdown).toBe("function");

		capturedContextActions?.shutdown();

		expect(ctxStub.shutdownRequested).toBe(true);
	});

	test("initHooksAndCustomTools wires shutdown to set shutdownRequested", async () => {
		let capturedContextActions: ExtensionContextActions | undefined;

		const fakeExtensionRunner = {
			initialize(
				_actions: ExtensionActions,
				contextActions: ExtensionContextActions,
				_commandContextActions?: ExtensionCommandContextActions,
				_uiContext?: ExtensionUIContext,
			): void {
				capturedContextActions = contextActions;
			},
			onError(_handler: (error: unknown) => void): void {},
			async emit(_event: unknown): Promise<void> {},
		};

		const ctxStub = {
			shutdownRequested: false,
			session: {
				extensionRunner: fakeExtensionRunner,
			},
			setToolUIContext: () => {},
			editor: {
				setText: () => {},
				handleInput: () => {},
				getText: () => "",
			},
			setWorkingMessage: () => {},
			setEditorComponent: () => {},
			toolOutputExpanded: false,
			setToolsExpanded: () => {},
			// Required members of the context. Omitting them used to be tolerated by
			// `?.()` calls in the controller, which meant production silently skipped
			// the composer refresh and the welcome dismissal whenever either was
			// missing. The calls are unconditional now, so the stub supplies them.
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;

		const controller = new ExtensionUiController(ctxStub);
		await controller.initHooksAndCustomTools();

		expect(capturedContextActions).toBeDefined();
		expect(typeof capturedContextActions?.shutdown).toBe("function");

		capturedContextActions?.shutdown();

		expect(ctxStub.shutdownRequested).toBe(true);
	});
});
