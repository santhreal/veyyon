//! WHY: the empty states outside the settings sheet were literals beside the
//! branch that drew them, one pair per view. The Usage tenant predicted what
//! would appear instead of stating a step, the clean working tree restated its
//! own condition where the step belongs, and the rail's narrowed state restated
//! its condition and left the step to a button label. Nothing compared the
//! sentences of one surface with another's, so a surface added to the shell
//! drew whatever its author remembered.
//!
//! CLASS CLOSED: every empty state the panel, the rail, the drawer, the palette
//! and the review popover draw is one definition, `empty::EmptySurface`, and
//! the sweep here is over `EmptySurface::iter()`:
//! 1. Every variant states a condition and a step, and the step is distinct
//!    from the condition.
//! 2. A step is a step rather than a prediction or the condition again, judged
//!    by `support::empty_prose`, the one vocabulary the settings sheet's sweep
//!    reads as well: no variant states what will appear, is shown, or is
//!    displayed, which is the defect the Usage tenant shipped, and every step
//!    opens on a verb recorded there, which is what the clean working tree's
//!    second copy of its own condition failed. A new step whose verb is not
//!    recorded turns this red, as does a third variant reporting progress
//!    instead of a step: the two loading panes are pinned by exact equality.
//! 3. Every variant is drawn by the surface it belongs to. The state each one
//!    needs comes from an exhaustive match, so a variant added to the enum does
//!    not compile until a reachable state is stated for it, and a variant whose
//!    sentences no surface draws fails here.
//! 4. A surface with rows draws neither sentence, so the empty state is a
//!    condition rather than a fixture the surface always draws.
//!
//! NOT CAUGHT: the wording of a sentence, which no test can judge; the label on
//! the button the rail offers beside its step, which is the kit's copy rather
//! than an empty state's; the settings sheet's own empty states, which
//! `a-settings-page-with-nothing-on-it-states-the-condition-and-the-step.rs`
//! sweeps; and where on the surface the two lines sit, which the surface
//! ceiling suites measure.

mod support;

use std::path::Path;

use strum::IntoEnumIterator;
use support::empty_prose::{Prose, judge, squeezed};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::ChangeScope;
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	ConnectionPhase, DiffStatus, DrawerContent, DrawerTab, Keymap, Overlay, PanelContent, PanelTab,
	Row, Section, ShellState, ShellView, TreeContent, TreeStatus,
	empty::{EmptyCopy, EmptySurface},
	install_tokens,
	palette::{PaletteMode, PaletteState},
	right_panel::highlight_source,
};
use veyyon_gpui::{App, AppContext, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The variants that state what is underway instead of a step. A read in
/// flight is not something to act on, and telling an operator to wait is not a
/// step either.
fn states_progress() -> Vec<EmptySurface> {
	vec![EmptySurface::DiffLoading, EmptySurface::TreeLoading]
}

/// The panel showing `tab` with nothing in it.
fn panel_with(tab: PanelTab, panel: PanelContent) -> ShellState {
	ShellState {
		connection: ConnectionPhase::Attached,
		panel: PanelContent { tabs: vec![tab], active_tab: tab, ..panel },
		..ShellState::default()
	}
}

/// The diff tenant with no file and `status` reported for the read.
fn diff_state(status: DiffStatus) -> ShellState {
	panel_with(PanelTab::Diff, PanelContent { diff_status: status, ..PanelContent::default() })
}

/// The tree tenant with no row and `status` reported for the walk.
fn tree_state(status: TreeStatus) -> ShellState {
	panel_with(PanelTab::Tree, PanelContent {
		tree: TreeContent { status, ..TreeContent::default() },
		..PanelContent::default()
	})
}

/// The palette open on `palette`, narrowed by `query`. Setting the query ranks
/// the rows, which is what a narrowed palette draws from.
fn palette_state(mut palette: PaletteState, query: &str) -> ShellState {
	palette.set_query(query);
	ShellState {
		connection: ConnectionPhase::Attached,
		overlay: Some(Overlay::Palette(palette)),
		..ShellState::default()
	}
}

/// One session for the rail to hold, which a filter then narrows away.
fn rail_row() -> Row {
	Row {
		id: 7,
		title: "first".to_owned(),
		subtitle: String::new(),
		badge: None,
		meta: None,
		placement: Section::Live,
		..Default::default()
	}
}

/// The shell with `sections` in its rail and nothing open.
fn rail_state(sections: Vec<(Section, Vec<Row>)>) -> ShellState {
	ShellState { connection: ConnectionPhase::Attached, sections, ..ShellState::default() }
}

/// A state each variant's surface is drawn from, with nothing in it.
///
/// Exhaustive on purpose: a variant added to the enum does not compile until
/// it states where an operator reaches it.
fn state_for(surface: EmptySurface) -> ShellState {
	match surface {
		EmptySurface::DiffUnloaded => diff_state(DiffStatus::Unloaded),
		EmptySurface::DiffLoading => diff_state(DiffStatus::Loading),
		EmptySurface::DiffClean => diff_state(DiffStatus::Loaded),
		EmptySurface::DiffFailed => diff_state(DiffStatus::Failed),
		EmptySurface::FileNone => {
			panel_with(PanelTab::File, PanelContent { file: None, ..PanelContent::default() })
		},
		EmptySurface::FileBinary => panel_with(PanelTab::File, PanelContent {
			file: Some(highlight_source("assets/icon.png", "\u{0}\u{1}", false, true)),
			..PanelContent::default()
		}),
		EmptySurface::TreeUnloaded => tree_state(TreeStatus::Unloaded),
		EmptySurface::TreeLoading => tree_state(TreeStatus::Loading),
		EmptySurface::TreeEmpty => tree_state(TreeStatus::Loaded),
		EmptySurface::TreeFailed => tree_state(TreeStatus::Failed),
		EmptySurface::Usage => {
			panel_with(PanelTab::Usage, PanelContent { usage: None, ..PanelContent::default() })
		},
		EmptySurface::PanelUnavailable => ShellState {
			connection: ConnectionPhase::Attached,
			panel: PanelContent {
				tabs: Vec::new(),
				unavailable_reason: None,
				..PanelContent::default()
			},
			..ShellState::default()
		},
		EmptySurface::ProcessList => ShellState {
			connection: ConnectionPhase::Attached,
			drawer_open: true,
			drawer: DrawerContent {
				tabs: vec![DrawerTab::Processes],
				active_tab: 0,
				tab_chosen: true,
				processes: Vec::new(),
				offered: true,
				..DrawerContent::default()
			},
			..ShellState::default()
		},
		EmptySurface::PaletteNoModels => palette_state(PaletteState::new(PaletteMode::Models), ""),
		EmptySurface::PaletteNoMatch => {
			palette_state(PaletteState::commands(), "no-command-carries-this")
		},
		EmptySurface::ReviewThreads => ShellState {
			connection: ConnectionPhase::Attached,
			panel: PanelContent {
				review_repository: Some(("/repo".to_owned(), ChangeScope::WorkingTree)),
				..PanelContent::default()
			},
			..ShellState::default()
		},
		// The rail is drawn at every width this suite renders at, so a state
		// with no row in it reaches the empty view. A filter that matches
		// nothing narrows a rail that does have a row.
		EmptySurface::QueueFiltered => {
			let mut state = rail_state(vec![(Section::Live, vec![rail_row()])]);
			state.keymap.queue_filter = Some("no-session-carries-this".to_owned());
			state
		},
		EmptySurface::QueueEmpty => rail_state(Vec::new()),
		EmptySurface::Welcome => {
			let mut state = rail_state(Vec::new());
			state.providers = vec![veyyon_desktop_model::ProviderView {
				id:            "anthropic".to_owned(),
				name:          "Anthropic".to_owned(),
				authenticated: true,
				oauth:         false,
				api_key:       true,
			}];
			state
		},
		EmptySurface::WelcomeNoProvider => rail_state(Vec::new()),
	}
}

/// Draws one frame of `state`, opening the review popover first when the
/// variant is drawn inside it.
fn drawn(state: ShellState, opens_review: bool) -> Captured {
	let mut cx = headless_context().expect("headless renderer available");
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let theme = load_bundled_theme("dark").expect("bundled theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the window opens");
	if opens_review {
		// The popover is placed against the box the last frame measured, so the
		// window is drawn once before it opens.
		session.frame().expect("the window renders");
		session
			.update(|view, window, cx| {
				view.open_review_threads(None, Point { x: px(600.0), y: px(400.0) }, window, cx);
			})
			.expect("the review popover opens");
	}
	session.frame().expect("the surface renders")
}

/// Every word the frame drew, with the spaces taken out, so a sentence the
/// column wrapped is one string again.
fn drawn_text(captured: &Captured) -> String {
	captured
		.text_runs
		.iter()
		.flat_map(|run| run.text.as_ref().chars())
		.filter(|character| !character.is_whitespace())
		.collect()
}

#[test]
fn every_surface_states_a_condition_and_a_step_distinct_from_it() {
	// The Usage tenant shipped "will appear after the first turn", which an
	// operator can do nothing with, and the clean working tree shipped "No
	// uncommitted modifications in this workspace", which is the condition
	// again in other words. `support::empty_prose` looks for both classes
	// rather than the two sentences they were written in, and the settings
	// sheet's sweep judges its pages against the same vocabulary.
	let mut progress: Vec<EmptySurface> = Vec::new();
	for surface in EmptySurface::iter() {
		let EmptyCopy { condition, action } = surface.copy();
		if judge(&format!("{surface:?}"), condition, action) == Prose::Progress {
			progress.push(surface);
		}
	}
	assert_eq!(
		progress,
		states_progress(),
		"the surfaces that report progress instead of a step are a decision, and this is the record \
		 of it"
	);
}

#[test]
fn every_surface_draws_the_sentences_declared_for_it() {
	for surface in EmptySurface::iter() {
		let EmptyCopy { condition, action } = surface.copy();
		let opens_review = surface == EmptySurface::ReviewThreads;
		let text = drawn_text(&drawn(state_for(surface), opens_review));
		assert!(
			text.contains(&squeezed(condition)),
			"{surface:?} drew no condition; it was expected to state {condition:?}"
		);
		assert!(
			text.contains(&squeezed(action)),
			"{surface:?} stated no step; it was expected to state {action:?}"
		);
	}
}

#[test]
fn a_surface_with_rows_draws_neither_sentence() {
	let cases: [(EmptySurface, ShellState); 4] = [
		(
			EmptySurface::TreeEmpty,
			panel_with(PanelTab::Tree, PanelContent {
				tree: TreeContent {
					rows: vec![veyyon_desktop_surface::TreeRowItem {
						path:        "src".to_owned(),
						name:        "src".to_owned(),
						depth:       0,
						is_dir:      true,
						is_expanded: false,
						changed:     None,
					}],
					status: TreeStatus::Loaded,
					..TreeContent::default()
				},
				..PanelContent::default()
			}),
		),
		(
			EmptySurface::Usage,
			panel_with(PanelTab::Usage, PanelContent {
				usage: Some(veyyon_desktop_model::UsageTotals {
					input_tokens:         1_200,
					output_tokens:        340,
					cache_read_tokens:    0,
					cache_write_tokens:   0,
					orchestration_tokens: 0,
					premium_requests:     0,
					cost_microusd:        Some(4_100),
				}),
				..PanelContent::default()
			}),
		),
		(EmptySurface::PaletteNoMatch, palette_state(PaletteState::commands(), "")),
		(EmptySurface::Welcome, rail_state(vec![(Section::Live, vec![rail_row()])])),
	];
	for (surface, state) in cases {
		let text = drawn_text(&drawn(state, false));
		let EmptyCopy { condition, action } = surface.copy();
		assert!(
			!text.contains(&squeezed(condition)),
			"{surface:?} drew {condition:?} over the rows the surface was given"
		);
		assert!(
			!text.contains(&squeezed(action)),
			"{surface:?} drew {action:?} over the rows the surface was given"
		);
	}
}
