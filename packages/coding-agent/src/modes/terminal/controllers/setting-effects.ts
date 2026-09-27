/**
 * What a flip in the settings UI does beyond storing the value.
 *
 * The selector writes the value through the settings store before it calls
 * {@link settingEffect}, so an effect only moves live state that captured the old value: a
 * session field, a component already drawn, a module-scope preference, a transcript committed to
 * scrollback. A setting with no row here needs nothing beyond the write.
 *
 * WHY THE TABLE IS KEYED BY `SettingPath`. The effects were a `switch` over a bare string, and
 * eighteen of its labels were names no setting has: `autoCompact`, `showImages`, `theme`,
 * `thinkingLevel` and fourteen `statusLine*` spellings from before the settings were
 * namespaced. Three more were declared settings the selector has no row for. `showImages` was
 * the one with a live counterpart: its effect was written for what is now `terminal.showImages`,
 * so turning inline images off left every drawn card showing them. A `discovery.` prefix branch
 * had the opposite defect: it was written for per-provider toggles the selector does not send,
 * and the one `discovery.*` setting it does send, `discovery.importForeignConfig`, was read as a
 * provider named `importForeignConfig`, written into `disabledProviders`, and never applied. A
 * key here that is not a declared setting fails to compile;
 * `a-settings-flip-applies-its-effect-to-the-setting-it-names.test.ts` fails on a declared
 * setting the selector has no row for.
 */

import {
	applySamplingKnob,
	isSamplingKnob,
	optionalNumber,
	type SamplingKnob,
	toNumberOrUndefined,
} from "@veyyon/kernel/settings/optional-number";
import { errorMessage } from "@veyyon/utils";
import { setTuiTight } from "@veyyon/utils/tight-mode";
import type { SettingPath, SettingValue } from "../../../config/settings-schema";
import { setForeignConfigImport } from "../../../discovery";
import { setMarkdownMermaidRendering } from "../../../theme/markdown-theme";
import {
	FALLBACK_THEME_NAME,
	type SymbolPreset,
	setColorBlindMode,
	setSymbolPreset,
	type ThemeLoadResult,
} from "../../../theme/theme";
import { isImageProviderPreference, setPreferredImageProvider } from "../../../tools/web/image-gen";
import {
	isSearchProviderId,
	isSearchProviderPreference,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "../../../tools/web/search";
import { statusLineSettingsFromConfig } from "../components/status-line/quiet-row";
import { AssistantMessageComponent } from "../components/transcript/assistant-message";
import type { InteractiveModeContext } from "../types";

/** The slice of the interactive context an effect reads and writes. */
export type SettingEffectContext = Pick<
	InteractiveModeContext,
	| "chatContainer"
	| "editor"
	| "effectiveHideThinkingBlock"
	| "hideThinkingBlock"
	| "mcpManager"
	| "proseOnlyThinking"
	| "rebuildChatFromMessages"
	| "session"
	| "showError"
	| "showWarning"
	| "shutdown"
	| "statusLine"
	| "ui"
>;

/**
 * Apply one setting's new value to live state. A returned promise is the transition itself, so a
 * caller that awaits it observes the committed runtime.
 */
export type SettingEffect = (ctx: SettingEffectContext, value: unknown) => void | Promise<void>;

/**
 * Report a theme reload that did not do what was asked. `fellBack` means the user is now looking
 * at a theme they did not pick, so it is always shown; anything else failed without changing what
 * is on screen.
 */
function surfaceThemeResult(ctx: SettingEffectContext, result: ThemeLoadResult, attempted: string): void {
	if (result.success) return;
	const detail = result.error ? `: ${result.error}` : "";
	ctx.showError(
		result.fellBack
			? `Failed to ${attempted}${detail}\nFell back to the ${FALLBACK_THEME_NAME} theme.`
			: `Failed to ${attempted}${detail}`,
	);
}

/**
 * Rebuild the transcript under the new value and retire what is already committed to native
 * scrollback, which a rebuild alone cannot redraw.
 */
function rebuildTranscript(ctx: SettingEffectContext): void {
	ctx.rebuildChatFromMessages();
	ctx.ui.resetDisplay();
}

/** Re-read every status-line setting into the composer's status line and draw it. */
function refreshStatusLine(ctx: SettingEffectContext): void {
	ctx.statusLine.updateSettings(statusLineSettingsFromConfig());
	ctx.ui.requestRender();
}

/** Set a thinking display flag on every drawn assistant message, then replay the transcript. */
function applyThinkingDisplay(ctx: SettingEffectContext, apply: (message: AssistantMessageComponent) => void): void {
	for (const child of ctx.chatContainer.children) {
		if (child instanceof AssistantMessageComponent) apply(child);
	}
	// Full clear + replay so blocks frozen in committed scrollback on ED3-risk terminals retire
	// their stale snapshots too (see InputController.toggleThinkingBlockVisibility).
	ctx.ui.resetDisplay();
}

/** Every sampling knob applies the same way: "unset" is read through the one owner, the rest goes to the agent. */
function applySampling(knob: SamplingKnob): SettingEffect {
	return (ctx, value) => {
		applySamplingKnob(ctx.session.agent, knob, optionalNumber(toNumberOrUndefined(value)));
	};
}

const EFFECTS: { readonly [P in SettingPath]?: SettingEffect } = {
	// Auth storage and the model registry capture the profile-sharing backing store at startup.
	// Persisting a different posture without replacing both atomically would leave the UI
	// claiming one policy while dispatch still reads the old store. Teardown begins synchronously
	// (shutdown marks the context as shutting down before its first await), which makes restart
	// the dispatch barrier.
	profileSharing: ctx => {
		ctx.showWarning(
			"Credential sharing changed. Restart required; this session is shutting down before further model dispatch.",
		);
		return ctx.shutdown().catch(err => {
			ctx.showError(`Failed to shut down after changing credential sharing: ${errorMessage(err)}`);
		});
	},
	"discovery.importForeignConfig": (_ctx, value) => setForeignConfigImport(value === true),

	steeringMode: (ctx, value) => ctx.session.setSteeringMode(value as "all" | "one-at-a-time"),
	followUpMode: (ctx, value) => ctx.session.setFollowUpMode(value as "all" | "one-at-a-time"),
	interruptMode: (ctx, value) => ctx.session.setInterruptMode(value as "immediate" | "wait"),
	"session.instrumentation": (ctx, value) =>
		ctx.session.setInstrumentationLevel(value as SettingValue<"session.instrumentation">),
	autocompleteMaxVisible: (ctx, value) =>
		ctx.editor.setAutocompleteMaxVisible(typeof value === "number" ? value : Number(value)),

	hideThinkingBlock: (ctx, value) => {
		ctx.hideThinkingBlock = value as boolean;
		const hide = ctx.effectiveHideThinkingBlock;
		applyThinkingDisplay(ctx, message => message.setHideThinkingBlock(hide));
	},
	proseOnlyThinking: (ctx, value) => {
		ctx.proseOnlyThinking = value as boolean;
		applyThinkingDisplay(ctx, message => message.setProseOnlyThinking(value as boolean));
	},
	omitThinking: (ctx, value) => {
		ctx.session.agent.hideThinkingSummary = value as boolean;
	},

	// The transcript builder reads each of these while it builds, so a rebuild applies the new
	// value to every block, nested or not, and the reset retires the ones already committed.
	"terminal.showImages": rebuildTranscript,
	"display.cacheMissMarker": rebuildTranscript,
	"display.collapseCompacted": rebuildTranscript,
	// The prompt rebuild is the gate registry's, reached from the session's settings listener. What
	// is left here is the TUI side: the renderer switch and retiring committed blocks.
	"tui.renderMermaid": (ctx, value) => {
		setMarkdownMermaidRendering(value as boolean);
		rebuildTranscript(ctx);
	},
	"tui.tight": (ctx, value) => {
		setTuiTight(value as boolean);
		ctx.ui.invalidate();
		ctx.ui.requestRender();
	},
	"tui.scrollbackRebuild": (ctx, value) => ctx.ui.setScrollbackRebuild(value as boolean),
	"tui.scrollIsolation": (ctx, value) => ctx.ui.setScrollIsolation(value as boolean),

	symbolPreset: (ctx, value) => {
		void setSymbolPreset(value as SymbolPreset).then(result => {
			ctx.statusLine.invalidate();
			ctx.ui.requestRender();
			ctx.ui.invalidate();
			surfaceThemeResult(ctx, result, "apply symbol preset");
		});
	},
	colorBlindMode: (ctx, value) => {
		void setColorBlindMode(value === "true" || value === true).then(result => {
			ctx.ui.invalidate();
			surfaceThemeResult(ctx, result, "apply color-blind mode");
		});
	},

	// The composer reads `statusLine.enabled` on each render, so applying it is a render request;
	// it is here so the row appears or disappears under the open settings screen rather than on the
	// next unrelated frame.
	"git.enabled": refreshStatusLine,
	"statusLine.enabled": refreshStatusLine,
	"statusLine.preset": refreshStatusLine,
	"statusLine.showHookStatus": refreshStatusLine,
	"statusLine.sessionAccent": refreshStatusLine,
	"statusLine.compactThinkingLevel": refreshStatusLine,

	"providers.webSearch": (_ctx, value) => {
		if (typeof value === "string" && isSearchProviderPreference(value)) setPreferredSearchProvider(value);
	},
	"providers.webSearchExclude": (_ctx, value) => {
		if (Array.isArray(value)) setExcludedSearchProviders(value.filter(isSearchProviderId));
	},
	"providers.image": (_ctx, value) => {
		if (isImageProviderPreference(value)) setPreferredImageProvider(value);
	},

	// Live subscribe/unsubscribe of MCP update injection.
	"mcp.notifications": (ctx, value) => ctx.mcpManager?.setNotificationsEnabled(value as boolean),
};

/**
 * Secret settings own live process state, not only persisted configuration. The effect returns
 * the coordinator-backed transition rather than dropping its promise, so rapid toggles keep their
 * initiation order and a caller that awaits the effect observes the committed runtime.
 */
function refreshSecrets(id: string): SettingEffect {
	return ctx =>
		ctx.session.refreshSecrets().catch(err => {
			ctx.showError(`Failed to apply "${id}" to the secret runtime: ${errorMessage(err)}`);
		});
}

/** The live effect of flipping `id` in the settings UI, or `undefined` when storing it is all it needs. */
export function settingEffect(id: string): SettingEffect | undefined {
	// An own-key probe: the table is an object literal, and `toString` is not a setting.
	if (Object.hasOwn(EFFECTS, id)) return EFFECTS[id as SettingPath];
	if (id.startsWith("secrets.")) return refreshSecrets(id);
	if (isSamplingKnob(id)) return applySampling(id);
	return undefined;
}
