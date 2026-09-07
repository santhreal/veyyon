//! WHY THIS SUITE EXISTS:
//! The drawer's two tenants are the host's: a terminal it runs and a process
//! it supervises. Its open state was the window's alone, so a host that
//! offered neither still had a titlebar toggle, a `Primary-J` chord and a
//! `/terminal` command, and pressing any of them opened a blank 80-column
//! grid. §5.13 authors the opposite: a surface absent for want of a capability
//! is not rendered, never rendered empty.
//!
//! THE CLASS THIS CLOSES: a client-owned surface whose presence ignores the
//! capability that fills it, on every route that reaches it. The sweep is the
//! cross product of `CapabilityStatus` over both of the drawer's capabilities,
//! taken from `Capability::ALL` at run time, so a status added to the protocol
//! fails to compile in `offer_of` until it is decided, and each route — the
//! titlebar control, the intent every chord and click dispatches, the palette
//! command, and a drawer already open when the offer is withdrawn — is driven
//! rather than asserted about.
//!
//! `UnknownUntilAttached` offers nothing: a drawer that appears mid-attach is
//! a surface nobody asked for.
//!
//! WHAT IT DOES NOT CATCH: what the drawer draws once offered. The tab
//! projection and the terminal grid are owned by
//! `a-transcript-projects-as-turns-of-blocks.rs` and the drawer's own suites,
//! and the frame comparison here counts a control rather than reading it. It
//! also does not prove the host declares the capability truthfully; the
//! gui-host suites own that.

mod support;

use std::{collections::HashMap, path::PathBuf};

use support::{NOW_MS, terminal};
use veyyon_desktop::{AssetPaths, SessionIndex, load_startup_bundle, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, PROTOCOL_VERSION, ProcessView, QueuePartition,
	SessionId, Store, TerminalStatus,
};
use veyyon_desktop_scene::{
	Appearance, Captured, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItemKind, PaletteMode, PaletteState, ShellState, ShellView,
	install_tokens,
};
use veyyon_gpui::{App, AppContext, Window};

/// The window the frames render at: wide enough for the rail and the panel, so
/// the only control that moves between the two frames is the drawer's.
const WINDOW: (u32, u32) = (1200, 800);

/// Whether a pair of capability statuses offers the drawer.
///
/// Exhaustive over `CapabilityStatus`: a fourth status fails to compile here
/// until somebody decides whether it offers a surface.
const fn offer_of(status: &CapabilityStatus) -> bool {
	match status {
		CapabilityStatus::Available => true,
		CapabilityStatus::UnknownUntilAttached | CapabilityStatus::Unavailable { .. } => false,
	}
}

/// One value of every capability status.
fn statuses() -> Vec<CapabilityStatus> {
	vec![
		CapabilityStatus::UnknownUntilAttached,
		CapabilityStatus::Available,
		CapabilityStatus::Unavailable { reason: "no pty on this host".to_string() },
	]
}

/// An attached store holding one terminal and one supervised process, so a
/// drawer the host offers has something in it and one it does not is denied
/// for want of the capability rather than for want of content.
fn attached(terminals: &CapabilityStatus, processes: &CapabilityStatus) -> Store {
	let mut store = Store::new();
	store.connection = ConnectionState::Connected {
		endpoint: "127.0.0.1:47000".to_string(),
		protocol: PROTOCOL_VERSION,
	};
	store
		.sessions
		.insert(support::session("sess-1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from("sess-1"));
	store
		.capabilities
		.set(Capability::Terminals, terminals.clone());
	store
		.capabilities
		.set(Capability::ProcessSupervisor, processes.clone());
	store
		.domains
		.terminals
		.push(terminal("term-1", TerminalStatus::Running));
	store.domains.processes.push(ProcessView {
		name:          "web".to_string(),
		pid:           Some(1),
		status:        "running".to_string(),
		application:   "sh".to_string(),
		args:          Vec::new(),
		cwd:           "/repo".to_string(),
		lifetime:      "last-client-exit".to_string(),
		started_at_ms: NOW_MS - 1_000,
		exit_code:     None,
		terminated_by: None,
	});
	store
}

/// The window state after a projection, with the drawer opened first the way
/// the chord opens it.
fn projected(store: &Store) -> ShellState {
	let mut state = ShellState::default();
	let mut index = SessionIndex::new();
	project(store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	Intent::SetDrawer { open: true }.apply(&mut state);
	state
}

fn startup_assets() -> veyyon_desktop::StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("bundled tokens and themes load")
}

/// One frame of the shell in the state given.
fn render(state: ShellState) -> Captured {
	let mut cx = headless_context().expect("headless context");
	let bundle = startup_assets();
	let options = RenderOptions {
		width: WINDOW.0,
		height: WINDOW.1,
		appearance: Appearance::Dark,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	render_view_captured(&mut cx, &options, move |_window: &mut Window, app: &mut App| {
		let installed = install_tokens(app, &bundle.tokens, &bundle.theme, &bundle.surface_path)
			.expect("tokens install");
		app.new(move |_cx| ShellView::new(installed, state))
	})
	.expect("the shell renders with and without a drawer")
}

#[test]
fn the_drawer_opens_only_where_the_host_runs_one_of_its_tenants() {
	for terminals in statuses() {
		for processes in statuses() {
			let offered = offer_of(&terminals) || offer_of(&processes);
			let state = projected(&attached(&terminals, &processes));

			assert_eq!(
				state.drawer.offered, offered,
				"terminals {terminals:?} and processes {processes:?} offer the drawer: {offered}"
			);
			assert_eq!(
				state.drawer_open, offered,
				"the chord opened a drawer the host does not offer (terminals {terminals:?}, \
				 processes {processes:?})"
			);
		}
	}
}

#[test]
fn a_drawer_left_open_closes_when_the_offer_is_withdrawn() {
	let offering = attached(&CapabilityStatus::Available, &CapabilityStatus::Available);
	let mut state = projected(&offering);
	assert!(state.drawer_open, "the drawer opens while both tenants are offered");

	let withdrawn = attached(
		&CapabilityStatus::Unavailable { reason: "no pty on this host".to_string() },
		&CapabilityStatus::Unavailable { reason: "no supervisor".to_string() },
	);
	project(&withdrawn, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert!(
		!state.drawer_open,
		"a drawer open when the host stopped offering one stands over an empty grid"
	);
}

#[test]
fn closing_the_drawer_always_lands() {
	let mut state = projected(&attached(&CapabilityStatus::Available, &CapabilityStatus::Available));
	Intent::SetDrawer { open: false }.apply(&mut state);
	assert!(!state.drawer_open, "the drawer must always be closable");
}

#[test]
fn the_command_to_open_it_is_absent_with_the_surface() {
	for offered in [false, true] {
		let store = if offered {
			attached(&CapabilityStatus::Available, &CapabilityStatus::UnknownUntilAttached)
		} else {
			attached(&CapabilityStatus::UnknownUntilAttached, &CapabilityStatus::UnknownUntilAttached)
		};

		let mut state = ShellState {
			overlay: Some(Overlay::Palette(PaletteState::commands())),
			..ShellState::default()
		};
		project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

		let Some(Overlay::Palette(palette)) = &state.overlay else {
			panic!("the palette stays open across a projection");
		};
		let drawer_commands = palette
			.items
			.iter()
			.filter(|item| {
				matches!(
					&item.kind,
					PaletteItemKind::Command { intent }
						if matches!(**intent, Intent::SetDrawer { open: true })
				)
			})
			.count();

		assert_eq!(
			drawer_commands,
			usize::from(offered),
			"a host offering the drawer: {offered}, so `/terminal` count must match"
		);
		assert_eq!(
			palette.mode,
			PaletteMode::Commands,
			"the filter must not change what the palette is listing"
		);
		assert!(palette.items.len() > 3, "the other commands stay: {} left", palette.items.len());
	}
}

#[test]
fn the_titlebar_control_leaves_with_the_surface() {
	let offered =
		render(projected(&attached(&CapabilityStatus::Available, &CapabilityStatus::Available)));
	let mut denied_state = projected(&attached(
		&CapabilityStatus::Unavailable { reason: "no pty on this host".to_string() },
		&CapabilityStatus::Unavailable { reason: "no supervisor".to_string() },
	));
	// Both frames render the drawer closed, so the one control that differs is
	// the titlebar toggle rather than the drawer's own chrome.
	denied_state.drawer_open = false;
	let mut offered_closed =
		projected(&attached(&CapabilityStatus::Available, &CapabilityStatus::Available));
	offered_closed.drawer_open = false;
	let offered_closed = render(offered_closed);
	let denied = render(denied_state);

	assert_eq!(
		offered_closed.hitboxes.len(),
		denied.hitboxes.len() + 1,
		"the offered window answers one more click than the denied one: the drawer toggle"
	);
	assert!(
		offered.hitboxes.len() > offered_closed.hitboxes.len(),
		"an open drawer answers more clicks than a closed one, so the frames are real"
	);
}
