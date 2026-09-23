/**
 * The profiles section: what is on disk, and where a window attaches for each.
 *
 * A profile is a configuration root, and a host process serves exactly the one
 * it was started under. A window therefore reaches another profile by
 * attaching to that profile's own host rather than by asking this one to
 * become it, so every row carries the endpoint that host binds — computed by
 * `guiHostSocketPath`, the same rule the host itself binds by and the desktop
 * client mirrors in `endpoint/socket_path.rs`.
 *
 * The profile store is `cli/profile-cli.ts` and `@veyyon/utils`. Nothing here
 * creates, renames or deletes a directory; the handlers in `actions/profiles`
 * call that store.
 */
import { errorMessage, getActiveProfile, listProfiles } from "@veyyon/utils";
import { PROFILE_COPY_ITEMS, readProfileDisplayName } from "../cli/profile-cli";
import { guiHostSocketPath } from "./socket-path";
import type { ProfileCopyItemView, ProfilesView, ProfileView } from "./wire";

/** The directory name of the default profile, which `getActiveProfile` spells as undefined. */
const DEFAULT_PROFILE = "default";

/** Copy items in declaration order, as a window offers them. */
const COPY_ITEMS: readonly ProfileCopyItemView[] = PROFILE_COPY_ITEMS.map(item => ({
	key: item.key,
	label: item.label,
	description: item.description,
}));

/** The endpoint a window attaches to for `agentDir`, or why there is none. */
function endpointFor(agentDir: string): Pick<ProfileView, "endpoint" | "endpoint_error"> {
	try {
		return { endpoint: `unix:${guiHostSocketPath(agentDir)}`, endpoint_error: null };
	} catch (error) {
		return { endpoint: null, endpoint_error: errorMessage(error) };
	}
}

/** Every profile on disk, the active one marked, with what a create may copy. */
export async function profilesView(): Promise<ProfilesView> {
	const active = getActiveProfile() ?? DEFAULT_PROFILE;
	const entries: ProfileView[] = [];
	for (const profile of listProfiles()) {
		const display = await readProfileDisplayName(profile.name === DEFAULT_PROFILE ? undefined : profile.name);
		entries.push({
			name: profile.name,
			display_name: display && display !== profile.name ? display : profile.name,
			root_dir: profile.rootDir,
			...endpointFor(profile.agentDir),
			is_active: profile.name === active,
		});
	}
	return { active, entries, copy_items: [...COPY_ITEMS] };
}

/** The section a window decodes, built from what is on disk right now. */
export async function profilesSection(): Promise<{ Profiles: ProfilesView }> {
	return { Profiles: await profilesView() };
}
