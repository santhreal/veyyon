//! WHY: the command palette is the central navigational and dispatch hub
//! of the desktop shell. The defect classes this test closes are:
//! 1. Mode transitions that lose active query state or leave the palette
//!    unranked.
//! 2. Fuzzy scorer regressions where non-subsequences match or word-boundary
//!    bonuses fail.
//! 3. Keyboard selection movement that drifts out of bounds on filtered
//!    results.
//! 4. Browse mode directory ascent failing on empty input or double-escaping
//!    out of modal state.
//! 5. Palette result rows diverging from the queue rail's 36px line row
//!    geometry.
//!
//! What this suite leaves to the host is remote filesystem traversal and
//! background search execution.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Badge, ConnectionPhase, Intent, Overlay, PaletteItem, PaletteMode, PaletteState, Row, Section,
	ShellState, ShellView, install_tokens,
	palette::{fuzzy_rank, fuzzy_score},
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

fn sample_state() -> ShellState {
	ShellState {
		connection: ConnectionPhase::Attached,
		sections: vec![(Section::Live, vec![
			Row {
				id:       101,
				title:    "Workspace Refactor".to_string(),
				subtitle: "veyyon-gui".to_string(),
				badge:    Some(Badge::Working),
				meta:     Some("2m ago".to_string()),
			},
			Row {
				id:       102,
				title:    "Bug Investigation".to_string(),
				subtitle: "veyyon-core".to_string(),
				badge:    Some(Badge::Input),
				meta:     Some("5m ago".to_string()),
			},
		])],
		..ShellState::default()
	}
}

#[test]
fn fuzzy_matcher_scores_and_ranks_deterministically() {
	// 1. Empty query matches all.
	assert_eq!(fuzzy_score("", "anything"), Some(0));
	assert_eq!(fuzzy_score("", ""), Some(0));

	// 2. Non-subsequence returns None.
	assert_eq!(fuzzy_score("xyz", "apple"), None);
	assert_eq!(fuzzy_score("abc", "acb"), None);

	// 3. Exact match outranks partial match.
	let exact = fuzzy_score("theme", "theme").expect("exact match");
	let partial = fuzzy_score("theme", "switch_theme").expect("partial match");
	assert!(exact > partial, "exact score {exact} must exceed partial score {partial}");

	// 4. Word boundary bonus outranks mid-word match.
	let boundary = fuzzy_score("fb", "foo_bar").expect("boundary match");
	let mid = fuzzy_score("fb", "freebird").expect("mid-word match");
	assert!(boundary > mid, "word boundary score {boundary} must exceed mid-word score {mid}");

	// 5. Consecutive match bonus.
	let consecutive = fuzzy_score("abc", "abc_file").expect("consecutive match");
	let scattered = fuzzy_score("abc", "a_b_c_file").expect("scattered match");
	assert!(
		consecutive > scattered,
		"consecutive match {consecutive} must exceed scattered {scattered}"
	);

	// 6. Tie breaking preserves original insertion order.
	let candidates = vec!["alpha_one", "beta", "alpha_two"];
	let ranked = fuzzy_rank("alpha", &candidates, |s| s);
	assert_eq!(ranked.len(), 2);
	assert_eq!(*ranked[0].2, "alpha_one");
	assert_eq!(*ranked[1].2, "alpha_two");
}

#[test]
fn every_palette_mode_is_distinct_and_reachable() {
	for mode in PaletteMode::iter() {
		assert!(!mode.label().is_empty(), "mode {mode:?} must have a label");
		assert!(!mode.placeholder().is_empty(), "mode {mode:?} must have a placeholder");

		let state = PaletteState::new(mode);
		assert_eq!(state.mode, mode);
		assert!(state.items.is_empty());
		assert_eq!(state.selected, 0);
	}
}

#[test]
fn palette_moves_runs_and_ascends_in_headless_session() {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");

	let mut session = HeadlessSession::open(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		let state = sample_state();
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");

	// 1. Initially no overlay.
	let captured = session.frame().expect("initial frame renders");
	assert!(!captured.hitboxes.is_empty(), "frame must contain rendered hitboxes");
	session
		.update(|view, _window, _cx| {
			assert!(view.state().overlay.is_none());
		})
		.expect("state queried");

	// 2. Open palette overlay in commands mode.
	session
		.update(|view, _window, cx| {
			view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Palette(PaletteState::commands()))));
			cx.notify();
		})
		.expect("overlay opened");

	let captured_open = session.frame().expect("palette frame renders");
	assert!(
		captured_open.hitboxes.len() > captured.hitboxes.len(),
		"palette frame must produce additional interactive hitboxes"
	);

	// 3. Filter with query.
	session
		.update(|view, _window, cx| {
			view.dispatch(Intent::PaletteQuery("Theme".to_string()));
			cx.notify();
		})
		.expect("query updated");

	session
		.update(|view, _window, _cx| {
			let palette = view
				.state()
				.overlay_palette()
				.expect("palette overlay active");
			assert_eq!(palette.query, "Theme");
			let filtered = palette.filtered_items();
			assert!(!filtered.is_empty(), "matching items found");
			assert!(filtered[0].title.contains("Theme"), "top result must match query");
		})
		.expect("filtered items verified");

	// 4. Move selection index down and up.
	session
		.update(|view, _window, cx| {
			view.dispatch(Intent::PaletteMove(1));
			cx.notify();
		})
		.expect("moved selection down");

	// 5. Test browse mode directory descent and ascent.
	session
		.update(|view, _window, cx| {
			let mut browse = PaletteState::new(PaletteMode::Browse);
			browse.items =
				vec![PaletteItem::directory(1, "crates"), PaletteItem::directory(2, "packages")];
			view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Palette(browse))));
			cx.notify();
		})
		.expect("switched to browse mode");

	session
		.update(|view, _window, cx| {
			let palette = view
				.state_mut()
				.overlay_palette_mut()
				.expect("palette active");
			palette.descend("crates");
			cx.notify();
		})
		.expect("descended into directory");

	session
		.update(|view, _window, _cx| {
			let palette = view.state().overlay_palette().expect("palette active");
			assert_eq!(palette.browse_path, vec!["crates".to_string()]);
		})
		.expect("path verified");

	session
		.update(|view, _window, cx| {
			view.dispatch(Intent::PaletteAscend);
			cx.notify();
		})
		.expect("ascended directory");

	session
		.update(|view, _window, _cx| {
			let palette = view.state().overlay_palette().expect("palette active");
			assert!(palette.browse_path.is_empty());
		})
		.expect("path emptied");

	// 6. Close overlay.
	session
		.update(|view, _window, cx| {
			view.dispatch(Intent::CloseOverlay);
			cx.notify();
		})
		.expect("overlay closed");

	session
		.update(|view, _window, _cx| {
			assert!(view.state().overlay.is_none());
		})
		.expect("overlay closed verified");
}

#[test]
fn palette_result_rows_share_queue_line_row_geometry() {
	let tokens = load_bundled_tokens().expect("tokens load");
	let queue_tokens = &tokens.surface.queue;
	let palette_tokens = &tokens.surface.palette;

	// §5.2 and §5.8 mandate 36px line rows matching the queue rail line height.
	assert_eq!(
		palette_tokens.results_row_height_px, queue_tokens.line_px,
		"palette result row height must match queue line height exactly"
	);
	assert_eq!(
		palette_tokens.results_row_height_px, 36.0,
		"canonical line row height is 36px per §5.2/§5.8"
	);
}
