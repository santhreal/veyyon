//! WHY: the right panel tab strip drew a tab per tenant (§5.6) and no way to
//! close one. `CloseTabOrPark` closed the active tab or parked the session on
//! the last one, so a secondary tab could only be closed by activating it
//! first, and a tab whose content the host was still fetching said nothing.
//!
//! CLASS CLOSED:
//! - The close is drawn on every tab the strip draws, at the hit square the
//!   panel tokens author, revealed by a hover of the tab it belongs to, and
//!   only while the panel holds a tab to fall back to.
//! - A close on a tab that is not the active one takes that tab and leaves the
//!   selection where it was; a close on the active one takes it and selects a
//!   neighbour.
//! - Closing asks the host for nothing, so a tab whose own content the host
//!   refused still closes.
//! - A tab the projection marks `Pending` draws the authored dot at its
//!   trailing edge and an idle one draws none, swept over every `PanelTab` read
//!   from the enum at run time rather than a list written here.
//!
//! NOT CAUGHT: what the host does with the tenant behind a closed tab, and
//! the reveal's feel — the strip is driven headless through its own pointer
//! path, so the hover is a press position and not a cursor.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::SessionId;
use veyyon_desktop_scene::{
	Appearance, Captured, HeadlessSession, RenderOptions, headless_context,
};
use veyyon_desktop_surface::{
	PanelTab, ShellState, ShellView, controls::Availability, fixture::populated, install_tokens,
};
use veyyon_gpui::{AppContext, Pixels, Point};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn driven<R>(state: ShellState, drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
	let mut cx = headless_context().expect("headless context must initialize");
	let tokens = load_bundled_tokens().expect("bundled tokens must load");
	let theme = load_bundled_theme("dark").expect("theme must load");
	let options = RenderOptions {
		width:        WIDTH,
		height:       HEIGHT,
		scale_factor: 1.0,
		appearance:   Appearance::Dark,
		seed:         11,
	};
	let mut session = HeadlessSession::open(&mut cx, &options, |_window, app| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens must install");
		app.new(|_cx| ShellView::new(installed, state))
	})
	.expect("session must open");
	drive(&mut session)
}

fn tab_label_point(captured: &Captured, tab_label: &str) -> Option<Point<Pixels>> {
	let run = captured.text_runs.iter().find(|r| {
		r.text.as_ref().trim() == tab_label
			&& f32::from(r.bounds.origin.y) < 100.0
			&& f32::from(r.bounds.origin.x) > 800.0
	})?;
	Some(Point {
		x: run.bounds.origin.x + run.bounds.size.width / 2.0,
		y: run.bounds.origin.y + run.bounds.size.height / 2.0,
	})
}

/// The hit square the panel tokens author for a tab's close control, so the
/// probe looks for the control the tokens declare rather than a size restated
/// here.
fn close_hit_px() -> f32 {
	load_bundled_tokens()
		.expect("bundled tokens must load")
		.surface
		.panels
		.tabs_close_hit_px
}

/// The dot the panel tokens author for a tab whose content is in flight.
fn pending_dot_px() -> f32 {
	load_bundled_tokens()
		.expect("bundled tokens must load")
		.surface
		.panels
		.tabs_pending_dot_px
}

/// Whether a painted square the size of the authored dot sits in the tab strip
/// band of the right panel.
fn draws_pending_dot(captured: &Captured) -> bool {
	let dot = pending_dot_px();
	captured.layout.iter().any(|b| {
		(b.bounds.width() - dot).abs() < 0.5
			&& (b.bounds.height() - dot).abs() < 0.5
			&& b.is_painted()
			&& b.bounds.top >= 40.0
			&& b.bounds.top < 90.0
			&& b.bounds.left > 800.0
	})
}

fn close_button_for_tab(captured: &Captured, tab_label: &str) -> Option<Point<Pixels>> {
	let run = captured.text_runs.iter().find(|r| {
		r.text.as_ref().trim() == tab_label
			&& f32::from(r.bounds.origin.y) < 100.0
			&& f32::from(r.bounds.origin.x) > 800.0
	})?;
	let label_right = f32::from(run.bounds.right());
	let label_top = f32::from(run.bounds.origin.y);
	let hit = close_hit_px();
	captured
		.hitboxes
		.iter()
		.find(|hb| {
			let hbx = f32::from(hb.origin.x);
			let hby = f32::from(hb.origin.y);
			let w = f32::from(hb.size.width);
			let h = f32::from(hb.size.height);
			(w - hit).abs() < 1.0
				&& (h - hit).abs() < 1.0
				&& hbx >= label_right - 2.0
				&& hbx < label_right + 80.0
				&& (hby - label_top).abs() < 20.0
		})
		.map(|hb| Point {
			x: hb.origin.x + hb.size.width / 2.0,
			y: hb.origin.y + hb.size.height / 2.0,
		})
}

#[test]
fn clicking_close_on_non_active_tab_removes_that_tab_and_leaves_active_selected() {
	let mut state = populated();
	state.keymap.panel_collapsed = false;
	state.panel.tabs = vec![PanelTab::Diff, PanelTab::File];
	state.panel.active_tab = PanelTab::Diff;

	driven(state, |session| {
		let captured = session.frame().expect("initial frame must capture");
		let label_pt =
			tab_label_point(&captured, PanelTab::File.label()).expect("File tab must exist in strip");
		session
			.hover(label_pt)
			.expect("hovering File tab must succeed");
		let hovered = session.frame().expect("hovered frame must capture");
		let close_pt = close_button_for_tab(&hovered, PanelTab::File.label())
			.expect("close button on File tab must appear on hover");

		session
			.click(close_pt)
			.expect("clicking close button must succeed");
		session.frame().expect("frame after click must capture");

		let final_state = session
			.update(|view, _, _| view.state().clone())
			.expect("state update must succeed");
		assert_eq!(final_state.panel.tabs, vec![PanelTab::Diff]);
		assert_eq!(final_state.panel.active_tab, PanelTab::Diff);
	});
}

#[test]
fn clicking_close_on_active_tab_removes_it_and_selects_a_neighbour() {
	let mut state = populated();
	state.keymap.panel_collapsed = false;
	state.panel.tabs = vec![PanelTab::Diff, PanelTab::File];
	state.panel.active_tab = PanelTab::Diff;

	driven(state, |session| {
		let captured = session.frame().expect("initial frame must capture");
		let label_pt =
			tab_label_point(&captured, PanelTab::Diff.label()).expect("Diff tab must exist in strip");
		session
			.hover(label_pt)
			.expect("hovering Diff tab must succeed");
		let hovered = session.frame().expect("hovered frame must capture");
		let close_pt = close_button_for_tab(&hovered, PanelTab::Diff.label())
			.expect("close button on Diff tab must appear on hover");

		session
			.click(close_pt)
			.expect("clicking close button must succeed");
		session.frame().expect("frame after click must capture");

		let final_state = session
			.update(|view, _, _| view.state().clone())
			.expect("state update must succeed");
		assert_eq!(final_state.panel.tabs, vec![PanelTab::File]);
		assert_eq!(final_state.panel.active_tab, PanelTab::File);
	});
}

#[test]
fn close_is_absent_while_panel_holds_one_tab() {
	let mut state = populated();
	state.keymap.panel_collapsed = false;
	state.panel.tabs = vec![PanelTab::Diff];
	state.panel.active_tab = PanelTab::Diff;

	driven(state, |session| {
		let captured = session.frame().expect("initial frame must capture");
		let label_pt =
			tab_label_point(&captured, PanelTab::Diff.label()).expect("Diff tab must exist in strip");
		session
			.hover(label_pt)
			.expect("hovering Diff tab must succeed");
		let hovered = session.frame().expect("hovered frame must capture");
		assert!(
			close_button_for_tab(&hovered, PanelTab::Diff.label()).is_none(),
			"close button must be absent when panel holds only one tab"
		);
	});
}

#[test]
fn the_close_answers_whatever_the_host_says_about_the_tab() {
	let mut state = populated();
	state.keymap.panel_collapsed = false;
	state.panel.tabs = vec![PanelTab::Diff, PanelTab::File];
	state.panel.active_tab = PanelTab::Diff;
	// The tab's own content is refused; the tab is still one the window can
	// close, because closing it asks the host for nothing.
	state.controls.set_availability(
		PanelTab::Diff.surface_id(SessionId::from(state.current_id.to_string())),
		Availability::Unavailable { reason: "test unavailable".into() },
	);

	driven(state, |session| {
		let captured = session.frame().expect("initial frame must capture");
		let label_pt =
			tab_label_point(&captured, PanelTab::Diff.label()).expect("Diff tab must exist in strip");
		session
			.hover(label_pt)
			.expect("hovering Diff tab must succeed");
		let hovered = session.frame().expect("hovered frame must capture");
		let close_pt = close_button_for_tab(&hovered, PanelTab::Diff.label())
			.expect("close button must be drawn for a tab whose content is refused");

		session
			.click(close_pt)
			.expect("clicking close button must succeed");
		session.frame().expect("frame after click must capture");

		let final_state = session
			.update(|view, _, _| view.state().clone())
			.expect("state update must succeed");
		assert_eq!(final_state.panel.tabs, vec![PanelTab::File]);
		assert_eq!(final_state.panel.active_tab, PanelTab::File);
	});
}

#[test]
fn tab_whose_content_is_pending_draws_dot_and_idle_tab_does_not() {
	for tab in PanelTab::iter() {
		let mut state_pending = populated();
		state_pending.keymap.panel_collapsed = false;
		state_pending.panel.tabs = vec![tab];
		state_pending.panel.active_tab = tab;
		let sid = tab.surface_id(SessionId::from(state_pending.current_id.to_string()));
		state_pending
			.controls
			.set_availability(sid.clone(), Availability::Pending);

		let mut state_enabled = state_pending.clone();
		state_enabled
			.controls
			.set_availability(sid, Availability::Enabled);

		let cap_pending = driven(state_pending, |s| s.frame().expect("frame pending must capture"));
		let cap_enabled = driven(state_enabled, |s| s.frame().expect("frame enabled must capture"));

		let dot_in_pending = draws_pending_dot(&cap_pending);
		let dot_in_enabled = draws_pending_dot(&cap_enabled);
		assert!(dot_in_pending, "tab {tab:?} must draw the pending dot when Availability::Pending");
		assert!(
			!dot_in_enabled,
			"tab {tab:?} must not draw the pending dot when Availability::Enabled"
		);
		assert_ne!(
			cap_pending.frame.as_bytes(),
			cap_enabled.frame.as_bytes(),
			"tab {tab:?} pending frame must differ from enabled frame"
		);
	}
}
