//! WHY: a settings surface drifts one page at a time: a tab that adopts its
//! own row geometry, a control that stays at full ink after the host reported
//! it unavailable, a page that draws nothing from the state it was handed.
//!
//! CLASS CLOSED, from captured frames rather than from the elements:
//! 1. A control the host gates draws at less ink than an enabled one, and the
//!    dimming is confined to the 44px row that owns the control — a sibling row
//!    that dims with it, or a row taller than §5.9's shape, fails.
//! 2. Every page draws its seeded rows: the seeded and the empty frame of a
//!    page differ, so a page that ignores its state fails, swept from the
//!    `SettingsPage` enum so a page added later is measured the moment it
//!    exists.
//!
//! The dispatch half (a change, reset, theme pick, auth step, MCP toggle or
//! diagnostics retry reaching the host) is in
//! `a-settings-change-lands-in-the-overlay-and-reaches-the-host.rs`. NOT
//! CAUGHT: the exact opacity value, and persistent storage of setting values
//! on disk, which is the host's.

mod support;

use std::path::Path;

use strum::IntoEnumIterator;
use support::settings_seed::seed_state_for_page;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_scene::{
	HeadlessSession, RgbaColor, RgbaFrame,
	headless::{RenderOptions, headless_context, render_view_captured},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Intent, Overlay, SettingsPage, SettingsState, ShellState, ShellView,
	controls::Availability, install_tokens,
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

/// An attached shell: an unattached one draws the attach screen and no
/// overlay, so every frame here starts attached.
fn attached() -> ShellState {
	ShellState { connection: ConnectionPhase::Attached, ..ShellState::default() }
}

/// The General page seeded, with one control's availability set as the host
/// would project it.
fn general_with(key: &str, availability: Availability) -> ShellState {
	let mut state = ShellState {
		overlay: Some(Overlay::Settings(Box::new(seed_state_for_page(SettingsPage::General)))),
		..attached()
	};
	state
		.controls
		.set_availability(SurfaceId::SettingsField(key.to_owned()), availability);
	state
}

/// Renders one state to a frame.
fn frame_of(state: ShellState) -> RgbaFrame {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	render_view_captured(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the shell renders offscreen")
	.frame
}

/// The box the pixels two frames disagree on lie in, and the mean ink of those
/// pixels in each frame: how far, in luma, each sits from the ground the box
/// is drawn on. The ground is the most common colour in the box in `a`.
fn differing_ink(a: &RgbaFrame, b: &RgbaFrame) -> Option<(u32, f32, f32)> {
	let mut differing = Vec::new();
	let mut top = u32::MAX;
	let mut bottom = 0;
	for y in 0..a.height() {
		for x in 0..a.width() {
			let (pa, pb) = (a.pixel(x, y)?, b.pixel(x, y)?);
			if pa != pb {
				differing.push((x, y, pa, pb));
				top = top.min(y);
				bottom = bottom.max(y);
			}
		}
	}
	if differing.is_empty() {
		return None;
	}
	let (left, right) = differing
		.iter()
		.fold((u32::MAX, 0), |(l, r), (x, ..)| (l.min(*x), r.max(*x)));
	let mut counts = std::collections::HashMap::new();
	for y in top..=bottom {
		for x in left..=right {
			let colour = a.pixel(x, y)?;
			*counts
				.entry([colour.r, colour.g, colour.b, colour.a])
				.or_insert(0usize) += 1;
		}
	}
	let ground = counts
		.into_iter()
		.max_by_key(|(_, count)| *count)
		.map(|([r, g, b, a], _)| RgbaColor::new(r, g, b, a).luma_255())?;
	let count = differing.len() as f32;
	let ink_a = differing
		.iter()
		.map(|(.., pa, _)| (pa.luma_255() - ground).abs())
		.sum::<f32>()
		/ count;
	let ink_b = differing
		.iter()
		.map(|(.., pb)| (pb.luma_255() - ground).abs())
		.sum::<f32>()
		/ count;
	Some((bottom - top + 1, ink_a, ink_b))
}

#[test]
fn a_gated_control_dims_its_own_row_and_no_other() {
	let key = "drawer.copy_on_select";
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let row_px = tokens.surface.settings.row_height_px as u32;

	let enabled = frame_of(general_with(key, Availability::Enabled));
	let pending = frame_of(general_with(key, Availability::Pending));
	let unavailable = frame_of(general_with(key, Availability::Unavailable {
		reason: "host has no terminal".to_owned(),
	}));

	let (height, ink_enabled, ink_pending) = differing_ink(&enabled, &pending)
		.expect("a pending control drew the same pixels as an enabled one");
	assert!(
		height <= row_px,
		"a pending control changed {height}px of the page, more than its {row_px}px row: the \
		 dimming reached a sibling row or the row is not §5.9's shape"
	);
	assert!(
		ink_pending < ink_enabled,
		"a pending control draws at {ink_pending} luma from its ground, not below the enabled \
		 {ink_enabled}"
	);

	let (height, ink_enabled, ink_unavailable) = differing_ink(&enabled, &unavailable)
		.expect("an unavailable control drew the same pixels as an enabled one");
	assert!(
		height <= row_px,
		"an unavailable control changed {height}px of the page, more than its row"
	);
	assert!(
		ink_unavailable < ink_pending && ink_pending < ink_enabled,
		"the ink order is not unavailable < pending < enabled: {ink_unavailable} / {ink_pending} / \
		 {ink_enabled}"
	);
}

#[test]
fn every_page_draws_its_seeded_rows_when_opened_by_dispatch() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	let mut session = HeadlessSession::open(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| ShellView::new(installed, attached()))
	})
	.expect("the session opens");

	// Each page is reached the way the palette reaches it, by dispatch into
	// the live view, once seeded and once empty; the two frames differ or the
	// page draws nothing from its state.
	for page in SettingsPage::iter() {
		let mut frames = [seed_state_for_page(page), SettingsState::new(page)]
			.into_iter()
			.map(|settings| {
				session
					.update(|view, _window, cx| {
						view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Settings(Box::new(
							settings,
						)))));
						cx.notify();
					})
					.expect("the page opens by dispatch");
				session.frame().expect("the page renders").frame
			});
		let (seeded, empty) = (frames.next(), frames.next());
		assert_ne!(
			seeded.as_ref().map(RgbaFrame::as_bytes),
			empty.as_ref().map(RgbaFrame::as_bytes),
			"page {page:?} draws the same frame seeded and empty, so its rows never reach the frame"
		);
	}
}
