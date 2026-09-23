/**
 * Profile actions: list what is on disk, and create, rename or delete one.
 *
 * Every effect is the profile store's (`cli/profile-cli.ts`), which the
 * terminal's `/profile` runs through as well. Switching is not here: a host
 * process serves the profile it was started under, so a window reaches another
 * profile by attaching to that profile's host, at the endpoint each row
 * carries.
 */
import { errorMessage, getActiveProfile } from "@veyyon/utils";
import { createProfile, PROFILE_COPY_ITEMS, removeProfile, writeProfileDisplayName } from "../../cli/profile-cli";
import { profilesSection } from "../profiles-view";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

interface CreateProfilePayload {
	name?: string;
	/** Copy-item keys to seed from the active profile; empty creates a blank profile. */
	copy?: string[];
}

interface RenameProfilePayload {
	name?: string;
	display_name?: string;
}

interface DeleteProfilePayload {
	name?: string;
}

/** Restate the profiles and settle the request. */
async function replyWithProfiles(ctx: ActionContext): Promise<void> {
	ctx.reply.snapshot(await profilesSection());
	ctx.reply.success();
}

/** Refuse with the condition and what to send instead. */
function refuse(ctx: ActionContext, code: string, message: string): void {
	ctx.reply.failure({ scope: "Settings", code, message, retryable: false });
}

/** Refuse with what the store said, which names the profile and the reason. */
function refuseFromStore(ctx: ActionContext, code: string, error: unknown): void {
	ctx.reply.failure({
		scope: "Settings",
		code,
		message: errorMessage(error),
		retryable: false,
	});
}

const handleRefreshProfiles: ActionHandler<void> = async ctx => {
	try {
		await replyWithProfiles(ctx);
	} catch (error) {
		refuseFromStore(ctx, "REFRESH_PROFILES_FAILED", error);
	}
};

const handleCreateProfile: ActionHandler<CreateProfilePayload | undefined> = async (ctx, payload) => {
	const name = payload?.name?.trim();
	if (!name) {
		refuse(ctx, "INVALID_ARGUMENTS", "A new profile needs a name. Send CreateProfile with the name to create.");
		return;
	}
	const known = new Set(PROFILE_COPY_ITEMS.map(item => item.key));
	const requested = payload?.copy ?? [];
	const unknown = requested.filter(key => !known.has(key));
	if (unknown.length > 0) {
		refuse(
			ctx,
			"UNKNOWN_COPY_ITEM",
			`No profile item named ${unknown.join(", ")}. The items are ${[...known].join(", ")}.`,
		);
		return;
	}
	try {
		const items = new Set(requested);
		await createProfile(name, items.size > 0 ? (getActiveProfile() ?? "default") : "blank", items);
		await replyWithProfiles(ctx);
	} catch (error) {
		refuseFromStore(ctx, "CREATE_PROFILE_FAILED", error);
	}
};

const handleRenameProfile: ActionHandler<RenameProfilePayload | undefined> = async (ctx, payload) => {
	const name = payload?.name?.trim();
	const display = payload?.display_name?.trim();
	if (!name || !display) {
		refuse(
			ctx,
			"INVALID_ARGUMENTS",
			"A rename needs the profile and the new display name. Send RenameProfile with both.",
		);
		return;
	}
	try {
		await writeProfileDisplayName(name === "default" ? undefined : name, display);
		await replyWithProfiles(ctx);
	} catch (error) {
		refuseFromStore(ctx, "RENAME_PROFILE_FAILED", error);
	}
};

const handleDeleteProfile: ActionHandler<DeleteProfilePayload | undefined> = async (ctx, payload) => {
	const name = payload?.name?.trim();
	if (!name) {
		refuse(ctx, "INVALID_ARGUMENTS", "A delete needs the profile to remove. Send DeleteProfile with its name.");
		return;
	}
	try {
		await removeProfile(name, { yes: true });
		await replyWithProfiles(ctx);
	} catch (error) {
		refuseFromStore(ctx, "DELETE_PROFILE_FAILED", error);
	}
};

export const profileActionHandlers: ActionHandlersMap = {
	RefreshProfiles: handleRefreshProfiles as ActionHandler,
	CreateProfile: handleCreateProfile as ActionHandler,
	RenameProfile: handleRenameProfile as ActionHandler,
	DeleteProfile: handleDeleteProfile as ActionHandler,
};
