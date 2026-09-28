/**
 * How the desktop reaches one capability the terminal offers.
 *
 * Every parity table in this directory maps a registry member, enumerated at
 * run time by its sweep, to one carrier. Protocol carriers are typed from the
 * wire, so a table cannot name an action or a snapshot section the protocol
 * does not define.
 */
import type { HostActionTag, SnapshotSectionTag } from "../wire";

export type DesktopCarrier =
	/** The window sends this host action, so the protocol carries the capability. */
	| { action: HostActionTag }
	/** The host publishes this snapshot section and the window draws it. */
	| { section: SnapshotSectionTag }
	/** The capability is a setting path the window edits through `SetSetting`. */
	| { setting: string }
	/** The host answers it for the window: a host command, a card, a frame. */
	| { host: string }
	/** The window answers it alone; the value is the surface that draws it. */
	| { window: string }
	/** The desktop does not offer it; the value is the reason. */
	| { optOut: string }
	/** No desktop surface reaches it yet; the value is the user-facing impact. */
	| { gap: string };

/**
 * The window surfaces a `window` carrier may claim, as the desktop layout lays
 * them out: the sidebar, the thread column and its parts, the right panel's
 * tabs, the terminal drawer, and the overlays.
 */
export const DESKTOP_SURFACES = [
	"Sidebar",
	"Thread header",
	"Transcript",
	"Interaction dock",
	"Composer",
	"Diff panel",
	"Files panel",
	"Agents panel",
	"Todo panel",
	"Diagnostics panel",
	"Usage panel",
	"Terminal drawer",
	"Command palette",
	"Settings",
	"Empty state",
	"Toasts",
] as const;

export type DesktopSurface = (typeof DESKTOP_SURFACES)[number];

/** A surface, optionally narrowed to one part of it: `"Settings, Providers page"`. */
export type SurfaceClaim = DesktopSurface | `${DesktopSurface}, ${string}`;

/** The carrier kinds, in declaration order. */
export type DesktopCarrierKind = "action" | "section" | "setting" | "host" | "window" | "optOut" | "gap";

/** The kind of one carrier. */
export function carrierKind(carrier: DesktopCarrier): DesktopCarrierKind {
	if ("action" in carrier) return "action";
	if ("section" in carrier) return "section";
	if ("setting" in carrier) return "setting";
	if ("host" in carrier) return "host";
	if ("window" in carrier) return "window";
	if ("optOut" in carrier) return "optOut";
	return "gap";
}

/** The keys of a table whose carrier is of `kind`, sorted. */
export function membersCarriedBy(table: Readonly<Record<string, DesktopCarrier>>, kind: DesktopCarrierKind): string[] {
	return Object.entries(table)
		.filter(([, carrier]) => carrierKind(carrier) === kind)
		.map(([member]) => member)
		.sort();
}
