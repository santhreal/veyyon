//! The harness the §8.10 memory suites drive: a real window on a seeded
//! shell, a store whose active session is the host's, and a keeper over a
//! scratch directory that is removed with the test.

use std::path::PathBuf;

#[allow(unused_imports, reason = "each test target uses a different subset")]
pub use veyyon_desktop::state::{host_shape, session_shape};
use veyyon_desktop::{
	AssetPaths, StartupBundle, load_startup_bundle,
	state::{Keeper, StateDir},
};
use veyyon_desktop_model::{
	PersistedState, SessionId, Store, TextBlockView, ToolPresentation, ToolView,
};
use veyyon_desktop_scene::{Appearance, HeadlessSession, RenderOptions, headless_context};
use veyyon_desktop_surface::{
	Block, ShellState, ShellView, ThemeLibrary, ToolInvocationViews, Turn, fixture,
	install_appearances,
};
use veyyon_desktop_tokens::DEFAULT_APPEARANCE;
use veyyon_gpui::{App, AppContext, Window};
use veyyon_test_scratch::{TempTree, scratch_dir};

/// The two sessions the suites key entries by.
pub const FIRST: &str = "session-first";
pub const SECOND: &str = "session-second";

/// The invocation whose card carries host-generated views, so disclosing it is
/// something the host has to be told about.
pub const CALL_WITH_VIEWS: &str = "call-with-views";

/// A state directory under a scratch tree, removed with it.
pub fn state_dir(label: &str) -> (TempTree, StateDir) {
	let tree = scratch_dir(label);
	let dir = StateDir::at(tree.path().join("desktop"));
	(tree, dir)
}

/// A keeper over `dir` starting from nothing remembered.
pub fn keeper_over(dir: &StateDir) -> Keeper {
	Keeper::new(dir.clone(), PersistedState::new())
}

/// A store whose active session is the one the host reported.
pub fn store_on(session: &str) -> Store {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from(session));
	store
}

/// The shell the suites drive: a populated transcript, an offered drawer with
/// one terminal, and the panel's four tabs.
///
/// The entry ids beside the turns are what the host's own projection produces,
/// and a remembered reading position names one of them.
pub fn seeded() -> ShellState {
	let mut state = fixture::with_drawer();
	state.turn_anchors = (0..state.transcript.len())
		.map(|ix| format!("entry-{ix}"))
		.collect();
	state
}

/// A shell whose transcript is longer than one window, which is the only
/// shape a scroll position means anything in: a transcript that fits draws its
/// whole self and is at the live edge whatever the operator does.
pub fn crowded() -> ShellState {
	let mut state = seeded();
	for ix in 0..40 {
		state
			.transcript
			.push(Turn::Operator(format!("a turn the operator sent, number {ix}")));
		state
			.turn_anchors
			.push(format!("entry-{}", state.transcript.len() - 1));
	}
	state
}

/// The same shell with one tool card whose views the host generated, which is
/// the card a remembered disclosure has to tell the host about.
pub fn disclosed_transcript() -> ShellState {
	let mut state = seeded();
	state.transcript.push(Turn::Agent {
		blocks: vec![Block::Invoke {
			call_id: CALL_WITH_VIEWS.to_owned(),
			tool:    "read".to_owned(),
			target:  "crates/veyyon-desktop/src/state/keeper.rs".to_owned(),
			result:  Some("131 lines".to_owned()),
			views:   ToolInvocationViews {
				call:   None,
				result: Some(std::sync::Arc::new(ToolPresentation {
					expanded: false,
					view:     ToolView::TextBlock(TextBlockView::text("131 lines")),
				})),
			},
		}],
		model:  Some("claude".to_owned()),
	});
	state
		.turn_anchors
		.push(format!("entry-{}", state.transcript.len() - 1));
	state
}

/// The bundled tokens and themes a rendered shell installs.
fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("bundled tokens and themes load")
}

/// Opens a window on `state`, draws one frame so input handlers and focus are
/// registered, then runs `drive` against the live view.
pub fn driven<R>(
	state: ShellState,
	drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("a headless renderer is required to open the window");
	let bundle = startup_assets();
	let options = RenderOptions {
		width: 1440,
		height: 900,
		appearance: Appearance::Dark,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut session =
		HeadlessSession::open(&mut cx, &options, |_window: &mut Window, app: &mut App| {
			// The same install the binary does: every bundled appearance
			// reaches the window, so a page that lists them lists them here
			// too.
			let library =
				ThemeLibrary::new(&bundle.tokens, bundle.themes.clone(), &bundle.surface_path);
			let installed =
				install_appearances(app, library, DEFAULT_APPEARANCE).expect("tokens install");
			app.new(move |_cx| ShellView::new(installed, state))
		})
		.expect("the shell opens a window");
	session.frame().expect("the shell draws its first frame");
	drive(&mut session)
}
