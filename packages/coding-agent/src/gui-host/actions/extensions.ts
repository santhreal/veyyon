import { errorMessage, getMCPConfigPath } from "@veyyon/utils";
import type { Settings } from "../../config/settings";
import { disableProvider, enableProvider, getAllProvidersInfo, initializeWithSettings } from "../../discovery";
import { buildProviderTabs, loadAllExtensions } from "../../extensibility/extension-state/state-manager";
import type { ExtensionRow } from "../../extensibility/extension-state/types";
import { setMcpServerEnabled } from "../../mcp/config-writer";
import { actingSettings } from "../acting-settings";
import type { ExtensionState, ExtensionsView } from "../wire";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

/**
 * The settings the terminal's `/extensions` dashboard reads and writes, with
 * the discovery layer pointed at them, so a source switched here is persisted
 * to the store this process acts on.
 */
async function extensionSettings(ctx: ActionContext): Promise<Settings> {
	const settings = await actingSettings(ctx);
	initializeWithSettings(settings);
	return settings;
}

/** The item ids switched off, as the dashboard stores them. */
function disabledIds(settings: Settings): string[] {
	return settings.get("disabledExtensions").slice();
}

function itemState(row: ExtensionRow): ExtensionState {
	if (row.state === "active") return "Active";
	if (row.state === "shadowed") return "Shadowed";
	return row.disabledReason === "provider-disabled" ? "SourceDisabled" : "Disabled";
}

/** The dashboard's rows and provider tabs, less its `all` tab, as the window's section. */
function toExtensionsView(rows: ExtensionRow[]): ExtensionsView {
	return {
		sources: buildProviderTabs(rows)
			.filter(tab => tab.id !== "all")
			.map(tab => ({ id: tab.id, name: tab.label, enabled: tab.enabled })),
		items: rows.map(row => ({
			id: row.id,
			kind: row.kind,
			name: row.name,
			description: row.description ?? null,
			trigger: row.trigger ?? null,
			path: row.path,
			source: row.source.provider,
			level: row.source.level,
			state: itemState(row),
			shadowed_by: row.shadowedBy ?? null,
		})),
	};
}

async function publishExtensions(ctx: ActionContext, settings: Settings): Promise<void> {
	const rows = await loadAllExtensions(ctx.cwd, disabledIds(settings));
	ctx.reply.snapshot({ Extensions: toExtensionsView(rows) });
}

/** Every refusal of this page, in the scope the window reports it under. */
function failure(ctx: ActionContext, code: string, message: string): void {
	ctx.reply.failure({ scope: "Extension", code, message, retryable: false });
}

const handleRefreshExtensions: ActionHandler = async ctx => {
	try {
		await publishExtensions(ctx, await extensionSettings(ctx));
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "EXTENSIONS_REFRESH_FAILED", errorMessage(error));
	}
};

interface SetExtensionEnabledPayload {
	id?: string;
	enabled?: boolean;
}

/**
 * An MCP server's row is switched in the MCP configuration, which the MCP
 * runtime and `/mcp` read, and a stale `disabledExtensions` entry for it is
 * dropped on enable, which is what the terminal dashboard does.
 */
async function setMcpItemEnabled(
	ctx: ActionContext,
	settings: Settings,
	row: ExtensionRow,
	enabled: boolean,
): Promise<void> {
	const writable = row.source.provider === "native" || row.source.provider === "mcp-json";
	await setMcpServerEnabled({
		userPath: getMCPConfigPath("user", ctx.cwd),
		projectPath: getMCPConfigPath("project", ctx.cwd),
		sourcePath: writable ? row.path : undefined,
		name: row.name,
		enabled,
	});
	const stored = disabledIds(settings);
	if (enabled && stored.includes(row.id)) {
		settings.set(
			"disabledExtensions",
			stored.filter(id => id !== row.id),
		);
	}
}

const handleSetExtensionEnabled: ActionHandler<SetExtensionEnabledPayload | undefined> = async (ctx, payload) => {
	if (!payload?.id || typeof payload.enabled !== "boolean") {
		failure(ctx, "INVALID_ARGUMENTS", "SetExtensionEnabled requires id and enabled parameters");
		return;
	}
	const { id, enabled } = payload;
	try {
		const settings = await extensionSettings(ctx);
		const rows = await loadAllExtensions(ctx.cwd, disabledIds(settings));
		const row = rows.find(candidate => candidate.id === id);
		if (!row) {
			failure(ctx, "EXTENSION_NOT_FOUND", `No extension, skill or hook is listed as '${id}'`);
			return;
		}
		if (row.kind === "mcp") {
			await setMcpItemEnabled(ctx, settings, row, enabled);
		} else {
			const disabled = disabledIds(settings);
			const listed = disabled.includes(id);
			if (enabled && listed)
				settings.set(
					"disabledExtensions",
					disabled.filter(entry => entry !== id),
				);
			if (!enabled && !listed) settings.set("disabledExtensions", [...disabled, id]);
		}
		await publishExtensions(ctx, settings);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "EXTENSION_TOGGLE_FAILED", errorMessage(error));
	}
};

interface SetExtensionSourceEnabledPayload {
	source?: string;
	enabled?: boolean;
}

const handleSetExtensionSourceEnabled: ActionHandler<SetExtensionSourceEnabledPayload | undefined> = async (
	ctx,
	payload,
) => {
	if (!payload?.source || typeof payload.enabled !== "boolean") {
		failure(ctx, "INVALID_ARGUMENTS", "SetExtensionSourceEnabled requires source and enabled parameters");
		return;
	}
	const { source, enabled } = payload;
	try {
		const settings = await extensionSettings(ctx);
		// `native` is the host's own items, which the dashboard offers no switch for.
		if (source === "native" || !getAllProvidersInfo().some(provider => provider.id === source)) {
			failure(ctx, "EXTENSION_SOURCE_NOT_FOUND", `No extension source is listed as '${source}'`);
			return;
		}
		if (enabled) enableProvider(source);
		else disableProvider(source);
		await publishExtensions(ctx, settings);
		ctx.reply.success();
	} catch (error) {
		failure(ctx, "EXTENSION_SOURCE_TOGGLE_FAILED", errorMessage(error));
	}
};

export const extensionsActionHandlers: ActionHandlersMap = {
	RefreshExtensions: handleRefreshExtensions as ActionHandler<never>,
	SetExtensionEnabled: handleSetExtensionEnabled as ActionHandler<never>,
	SetExtensionSourceEnabled: handleSetExtensionSourceEnabled as ActionHandler<never>,
};
