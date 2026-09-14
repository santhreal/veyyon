//! WHY: a review gutter can either open a local editor or have no repository
//! available. Intercepting the latter press strands panel focus; floating the
//! former outside the Panel context strands its keyboard navigation. This suite
//! drives native gutter/list presses and sweeps every shipped Panel chord in
//! unified and split layouts. It does not cover comment persistence or
//! rendering.

#[allow(dead_code, reason = "the shared pointer helper serves several native suites")]
#[path = "support/overlay_pointer.rs"]
mod pointer;

use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_model::{ChangeScope, DiffMode};
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::{Keymap, Scope, damage::Region, keymap::resolve_chord};
use veyyon_gpui::{Point, px};

#[derive(Clone, Copy, Debug)]
enum Target {
	UnavailableLine,
	ReviewLine,
	ReviewList,
}

#[test]
fn every_panel_chord_remains_reachable_from_review_controls_and_unavailable_gutters() {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let geometry = &tokens.surface.panels;
	let chords: Vec<_> = Keymap::default()
		.rows()
		.into_iter()
		.filter(|row| row.scope == Scope::Panel)
		.map(|row| resolve_chord(&row.chord))
		.collect();
	assert!(!chords.is_empty(), "the shipped panel scope must declare navigation");
	for mode in [DiffMode::Unified, DiffMode::Split] {
		for target in [Target::UnavailableLine, Target::ReviewLine, Target::ReviewList] {
			for chord in &chords {
				let mut cx = headless_context().expect("native renderer is required");
				let mut session = pointer::open_test_session(&mut cx);
				let enabled = !matches!(target, Target::UnavailableLine);
				session
					.update(|view, _, cx| {
						let panel = &mut view.state_mut().panel;
						panel.diff_mode = mode;
						panel.review_repository =
							enabled.then(|| ("/repo".into(), ChangeScope::WorkingTree));
						cx.notify();
					})
					.expect("fixture repository availability is established before drawing");
				session.frame().expect("panel draws");
				let chrome = session
					.update(|view, _, _| {
						view
							.laid_out()
							.drawn_bounds(Region::PanelChrome)
							.expect("panel tab strip has bounds")
					})
					.expect("panel geometry is recorded");
				let point = match target {
					Target::UnavailableLine | Target::ReviewLine => Point::new(
						chrome.origin.x + px(geometry.diff_gutter_width_px / 2.0),
						chrome.bottom()
							+ px(geometry.chrome_row_height_px.mul_add(
								if enabled { 3.0 } else { 2.0 },
								geometry.diff_hunk_header_height_px,
							) + geometry.diff_row_height_px / 2.0),
					),
					Target::ReviewList => Point::new(
						chrome.origin.x + px(geometry.diff_gutter_width_px),
						chrome.bottom() + px(geometry.chrome_row_height_px * 1.5),
					),
				};
				session
					.click(point)
					.expect("native pointer reaches the review control or ordinary gutter");
				session
					.frame()
					.expect("focus path is drawn after the press");
				let before = session
					.update(|view, _, _| {
						assert_eq!(view.review_is_open(), enabled, "{target:?} in {mode:?}");
						view.drain_intents();
						view.state().clone()
					})
					.expect("press result is observed");
				assert!(
					session.keystroke(chord).expect("panel chord dispatches"),
					"{target:?} in {mode:?}: {chord}"
				);
				session
					.update(|view, _, _| {
						let requests = view.drain_intents();
						assert!(
							!requests.is_empty() || *view.state() != before,
							"{target:?} in {mode:?} swallowed {chord}"
						);
						assert_eq!(
							view.review_is_open(),
							enabled,
							"panel navigation must not discard an open review"
						);
					})
					.expect("navigation effect is observed");
			}
		}
	}
}
