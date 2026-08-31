//! Product content inside the platform titlebar.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{ConnectionState, WorkspaceView},
	navigation::{Overlay, PaletteMode, Route},
};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, owner},
	theme::{Theme, layout, space},
	ui::{Badge, Button, Fill, Icon, Tone, text},
};

use super::status;
use crate::act;

/// What the titlebar's search button opens, named once so the chord it shows
/// and the command it runs cannot disagree.
const PALETTE: UiCommand =
	UiCommand::OpenOverlay(Overlay::CommandPalette { mode: PaletteMode::Commands });

pub fn render(store: &Store, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let workspace = active_workspace(store);
	let route = route_label(store);
	div()
		.id("titlebar-content")
		.flex()
		.flex_1()
		.min_w(px(0.0))
		.h(px(layout::titlebar()))
		.items_center()
		.gap(px(space::X8))
		.child(identity(workspace, route, &theme))
		.child(crate::spaces::space_switcher(store, cx))
		.child(text::spacer())
		.child(
			Button::labelled(
				"command-center",
				owner(OwnerNamespace::Shell, "titlebar", "command-center"),
				"Search",
			)
			.icon(Icon::Search)
			.fill(Fill::Tinted)
			.tone(Tone::Muted)
			.tip("Search commands and resources")
			.chord(&PALETTE)
			.on_click(act::click(PALETTE.clone())),
		)
		.child(text::spacer())
		.child(connection(&store.connection))
		.child(
			Button::new(
				"show-agent-activity",
				owner(OwnerNamespace::Shell, "titlebar", "show-agent-activity"),
				Icon::Activity,
			)
			.tip("Show agent activity")
			.on(matches!(store.frontend.route, Route::Agents))
			.on_click(act::click(UiCommand::Navigate(Route::Agents))),
		)
		.child(
			Button::new(
				"titlebar-sidebar",
				owner(OwnerNamespace::Shell, "titlebar", "titlebar-sidebar"),
				Icon::Panel,
			)
			.tip(if store.frontend.panels.sidebar_open {
				"Hide sidebar"
			} else {
				"Show sidebar"
			})
			.on(store.frontend.panels.sidebar_open)
			.on_click(act::click(UiCommand::ToggleSidebar)),
		)
		.child(
			Button::new(
				"titlebar-inspector",
				owner(OwnerNamespace::Shell, "titlebar", "titlebar-inspector"),
				Icon::Inspector,
			)
			.tip(if store.frontend.panels.inspector_open {
				"Hide inspector"
			} else {
				"Show inspector"
			})
			.on(store.frontend.panels.inspector_open)
			.on_click(act::click(UiCommand::ToggleInspector)),
		)
		.child(
			Button::new(
				"titlebar-dock",
				owner(OwnerNamespace::Shell, "titlebar", "titlebar-dock"),
				Icon::Dock,
			)
			.tip(if store.frontend.panels.bottom_open {
				"Hide bottom dock"
			} else {
				"Show bottom dock"
			})
			.on(store.frontend.panels.bottom_open)
			.on_click(act::click(UiCommand::ToggleBottomDock)),
		)
		.into_any_element()
}

fn identity(workspace: Option<&WorkspaceView>, route: &str, theme: &Theme) -> AnyElement {
	let mut content = div()
		.flex()
		.items_center()
		.min_w(px(0.0))
		.gap(px(space::X6));
	if let Some(workspace) = workspace {
		content = content
			.child(text::label(workspace.name.clone(), theme))
			.children(
				workspace
					.branch
					.as_ref()
					.map(|branch| Badge::new(branch.clone()).icon(Icon::Branch).bare().exact()),
			);
	}
	content
		.child(text::meta(route.to_owned(), theme))
		.into_any_element()
}

fn active_workspace(store: &Store) -> Option<&WorkspaceView> {
	let session = store.frontend.selected_session.as_ref()?;
	let workspace = &store
		.replica
		.sessions
		.sessions
		.readable()?
		.value
		.iter()
		.find(|candidate| candidate.id == *session)?
		.workspace;
	store
		.replica
		.workspaces
		.readable()?
		.value
		.iter()
		.find(|candidate| candidate.id == *workspace)
}

fn route_label(store: &Store) -> &'static str {
	match store.frontend.route {
		Route::Conversation => "Conversation",
		Route::Changes => "Changes",
		Route::Files => "Files",
		Route::Agents => "Agents",
		Route::Settings(_) => "Settings",
		Route::History => "History",
	}
}

fn connection(state: &ConnectionState) -> AnyElement {
	let shown = status::connection(state);
	let Some((tip, command)) = shown.action else {
		return Badge::new(shown.label)
			.icon(Icon::Engine)
			.tone(shown.tone)
			.bare()
			.into_any_element();
	};
	// The one affordance on screen in every route: a state a reader is meant to
	// act on is the control that acts on it, rather than a chip beside a button
	// that is only on some routes.
	Button::labelled(
		"connection",
		owner(OwnerNamespace::Shell, "titlebar", "connection"),
		shown.label,
	)
	.icon(Icon::Engine)
	.fill(Fill::Tinted)
	.tone(shown.tone)
	.tip(tip)
	.on_click(act::click(command))
	.into_any_element()
}
