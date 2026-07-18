import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type EditMode, type EditModeSessionLike, resolveEditMode } from "@veyyon/coding-agent/utils/edit-mode";

const originalEditVariant = Bun.env.VEYYON_EDIT_VARIANT;
const originalStrictEditMode = Bun.env.VEYYON_STRICT_EDIT_MODE;

function restoreEnv(): void {
	if (originalEditVariant === undefined) {
		delete Bun.env.VEYYON_EDIT_VARIANT;
	} else {
		Bun.env.VEYYON_EDIT_VARIANT = originalEditVariant;
	}
	if (originalStrictEditMode === undefined) {
		delete Bun.env.VEYYON_STRICT_EDIT_MODE;
	} else {
		Bun.env.VEYYON_STRICT_EDIT_MODE = originalStrictEditMode;
	}
}

function createSession(args: {
	activeModel?: string;
	modelVariant?: EditMode | null;
	settingsMode?: EditMode;
}): EditModeSessionLike {
	return {
		getActiveModelString: () => args.activeModel,
		settings: {
			get: () => args.settingsMode ?? "hashline",
			getEditVariantForModel: () => args.modelVariant ?? null,
		},
	};
}

describe("resolveEditMode", () => {
	beforeEach(() => {
		delete Bun.env.VEYYON_EDIT_VARIANT;
		delete Bun.env.VEYYON_STRICT_EDIT_MODE;
	});

	afterEach(() => {
		restoreEnv();
	});

	test("falls back from hashline to replace for Kimi models", () => {
		delete Bun.env.VEYYON_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe("replace");
	});

	test("does not exclude non-Kimi Moonshot models", () => {
		delete Bun.env.VEYYON_EDIT_VARIANT;

		expect(resolveEditMode(createSession({ activeModel: "moonshot/moonshot-v1-128k" }))).toBe("hashline");
	});

	test("keeps explicit model variants ahead of the Kimi fallback", () => {
		delete Bun.env.VEYYON_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", modelVariant: "hashline" }),
			),
		).toBe("hashline");
	});

	test("keeps VEYYON_EDIT_VARIANT ahead of the Kimi fallback", () => {
		Bun.env.VEYYON_EDIT_VARIANT = "hashline";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});

	test("only falls back when the resolved mode is hashline", () => {
		delete Bun.env.VEYYON_EDIT_VARIANT;

		expect(
			resolveEditMode(
				createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct", settingsMode: "apply_patch" }),
			),
		).toBe("apply_patch");
	});

	test("keeps strict edit mode ahead of the Kimi fallback", () => {
		delete Bun.env.VEYYON_EDIT_VARIANT;
		Bun.env.VEYYON_STRICT_EDIT_MODE = "1";

		expect(resolveEditMode(createSession({ activeModel: "openrouter/moonshotai/Kimi-K2-Instruct" }))).toBe(
			"hashline",
		);
	});
});
