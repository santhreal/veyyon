//! WHY: `LaidOut` keeps a region's box after the frame that drew it, because
//! damage is the union of where a region was and where it is: the pixels a
//! closing drawer vacates repaint only if the vacated box outlives the drawer.
//! A measurement wants the opposite. A §6.6 verdict, a float-containment sweep
//! or a hit test taken through a box the current frame did not lay out reads
//! this frame's pixels through the last frame's geometry, and the drawer's
//! vacated band is exactly where the composer moves to, so the reading is
//! charged to the wrong surface rather than merely stale.
//!
//! CLASS CLOSED: a reader of `recorded_regions()` / `drawn_bounds` that
//! measures a surface the frame did not draw. The retention contract and the
//! reset are pinned as one pair, so neither can be dropped in favour of the
//! other: retention without a reset gives every measuring caller a stale box,
//! and a reset that also cleared the surviving regions would blind them all.
//! The harm is measured rather than asserted — the vacated box is shown to
//! overlap the surface that moved into it.
//!
//! NOT CAUGHT: whether the damage rectangle the retained box produces is
//! composited correctly, which the streaming parity bench owns, and whether
//! any particular gate remembers to call `forget`, which is that gate's own
//! mutation.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Keymap, ShellView, damage::Region, fixture, install_tokens, keymap::resolve_chord,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

/// A window wide enough to dock the drawer as a row of the session column, so
/// closing it moves the composer into the band it vacates.
const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// Opens the populated shell with the drawer offered and closed, and the
/// shipped keymap bound, so the drawer opens on the chord an operator presses.
fn open_shell(cx: &mut Headless) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("the session opens offscreen")
}

/// The regions the last frame recorded.
fn recorded(session: &mut HeadlessSession<'_, ShellView>) -> Vec<Region> {
	session
		.update(|view, _window, _cx| view.laid_out().recorded_regions())
		.expect("the view is live")
}

/// The box recorded for `region`, absent when no frame has drawn it.
fn box_of(session: &mut HeadlessSession<'_, ShellView>, region: Region) -> Option<Bounds<Pixels>> {
	session
		.update(|view, _window, _cx| view.laid_out().drawn_bounds(region))
		.expect("the view is live")
}

/// Whether two boxes share any area.
fn overlaps(one: Bounds<Pixels>, other: Bounds<Pixels>) -> bool {
	one.origin.x < other.origin.x + other.size.width
		&& other.origin.x < one.origin.x + one.size.width
		&& one.origin.y < other.origin.y + other.size.height
		&& other.origin.y < one.origin.y + one.size.height
}

#[test]
fn a_surface_the_frame_stopped_drawing_keeps_its_box_for_damage_and_loses_it_for_measurement() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_shell(&mut cx);
	session.frame().expect("the first frame renders");
	session
		.keystroke(&resolve_chord("primary-j"))
		.expect("the drawer chord dispatches");
	session.frame().expect("the frame with the drawer renders");

	let drawn = box_of(&mut session, Region::DrawerChrome)
		.expect("the drawer chord drew no chrome, so there is nothing for this to be about");
	let framed = box_of(&mut session, Region::Transcript)
		.expect("the frame drew no transcript for the drawer to take a band from");

	session
		.keystroke(&resolve_chord("primary-j"))
		.expect("the drawer chord dispatches again");
	session
		.frame()
		.expect("the frame without the drawer renders");

	// Retention: the vacated box outlives the drawer, because the pixels it
	// gave up repaint from the union of the two boxes.
	let vacated = box_of(&mut session, Region::DrawerChrome).expect(
		"the drawer's box was dropped when it closed, so the band it vacated repaints from nothing",
	);
	assert_eq!(vacated, drawn, "the retained box is not the one the drawer was last drawn in");

	// The harm the reset prevents, measured: the surfaces that take the band
	// back are under the retained box, so a reading through it is charged
	// their pixels rather than merely being old.
	let transcript = box_of(&mut session, Region::Transcript)
		.expect("the frame drew no transcript, so nothing reclaimed the vacated band");
	assert!(
		transcript.origin.y + transcript.size.height > framed.origin.y + framed.size.height,
		"the transcript did not grow when the drawer closed ({framed:?} -> {transcript:?}), so no \
		 surface reclaimed the band"
	);
	let live = recorded(&mut session);
	let met: Vec<Region> = live
		.iter()
		.copied()
		.filter(|region| *region != Region::DrawerChrome && *region != Region::Drawer)
		.filter(|region| box_of(&mut session, *region).is_some_and(|held| overlaps(vacated, held)))
		.collect();
	assert!(
		!met.is_empty(),
		"the drawer's vacated box {vacated:?} meets no live surface, so a stale reading through it \
		 would be merely old rather than wrong: the frame drew {live:?}"
	);

	// The reset: the next frame's set is its own, and only the drawer left it.
	session
		.update(|view, window, _cx| {
			view.laid_out().forget();
			window.refresh();
		})
		.expect("the view is live");
	session.frame().expect("the measured frame renders");

	let fresh = recorded(&mut session);
	assert!(
		!fresh.contains(&Region::DrawerChrome),
		"the closed drawer is still in the measured frame's own set: {fresh:?}"
	);
	assert_eq!(
		box_of(&mut session, Region::DrawerChrome),
		None,
		"the closed drawer still answers with a box after the set was forgotten"
	);
	for region in [Region::Titlebar, Region::Queue, Region::Transcript, Region::Composer] {
		assert!(
			fresh.contains(&region),
			"{region:?} did not come back after the reset, so forgetting blinds the reader it exists \
			 for: {fresh:?}"
		);
	}
}
