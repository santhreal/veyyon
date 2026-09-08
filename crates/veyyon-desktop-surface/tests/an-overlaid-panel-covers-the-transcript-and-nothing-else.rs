//! WHY: below the 980px row the right panel is a float rather than a column
//! (§5.6), and the float was placed on the columns row: `absolute().inset_0()`
//! of the row that holds the queue rail AND the session surface. So the scrim
//! dimmed the rail the panel sits beside, and at the 800 row the sheet covered
//! the composer, the card stack above it and the run bar under it. A draft
//! typed with the panel open landed under the sheet, unreadable, and the rail
//! read as disabled. That is a modal, and the panel is contextual: it annotates
//! the transcript, so the transcript is the region it may cover.
//!
//! CLASS CLOSED: a float covering or dimming a region it is not about. The
//! sweep enumerates the regions the frame itself laid out, so a region added
//! later is covered without this file naming it, and the exemption is stated by
//! shape rather than by count: the transcript and the turns inside it are the
//! only boxes the panel's box may meet. The pixel channel is read beside the
//! geometry because a float can be laid out clear of a region and still tint
//! it: the scrim is a colour, not a box.
//!
//! NOT CAUGHT: what the panel draws inside itself, the inline placement (the
//! split's own suite), and where the float's leading edge sits, which
//! `the-width-shed-reaches-the-frame` measures against the shed.

use std::path::Path;

use veyyon_desktop_kit::{SpacingStep, TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	frame::RgbaFrame,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Keymap, ShellView,
	damage::Region,
	fixture, install_tokens,
	keymap::resolve_chord,
	layout::{LabelState, RightPanelPlacement, ShedInput, shell_widths},
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, px, size};

/// A window wide enough to keep the queue rail and narrow enough to float the
/// panel: the 980 row of the shed, which is the row both defects lived on.
const WIDTH: u32 = 1000;
const HEIGHT: u32 = 800;

/// The shed's input for this window, with the gutter the session column uses.
fn shed(panel_open: bool) -> ShedInput {
	let surface = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface;
	ShedInput {
		viewport_px: WIDTH as f32,
		viewport_height_px: HEIGHT as f32,
		chrome_height_px: surface.shell.titlebar_height_px,
		gutter_px: f32::from(TokenSet::default().spacing(SpacingStep::S4)),
		queue_collapsed: false,
		panel_open,
		panel_width: None,
		labels: LabelState::default(),
	}
}

/// Opens the populated shell with the panel closed and the shipped keymap
/// bound, so the panel is opened by the chord an operator presses.
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
		let mut state = fixture::populated();
		state.keymap.panel_collapsed = true;
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the session opens offscreen")
}

/// The box the last frame drew `region` in.
fn box_of(session: &mut HeadlessSession<'_, ShellView>, region: Region) -> Bounds<Pixels> {
	session
		.update(|view, _window, _cx| view.laid_out().drawn_bounds(region))
		.expect("the view is live")
		.unwrap_or_else(|| panic!("the frame drew no {region:?} for this to mean anything"))
}

/// Whether two boxes share any area. Touching edges are not an overlap: a
/// float that ends exactly where the composer starts covers none of it.
fn overlaps(one: Bounds<Pixels>, other: Bounds<Pixels>) -> bool {
	one.origin.x < other.origin.x + other.size.width
		&& other.origin.x < one.origin.x + one.size.width
		&& one.origin.y < other.origin.y + other.size.height
		&& other.origin.y < one.origin.y + one.size.height
}

/// Pixels inside `area` that differ between two frames of the same window.
fn differing_pixels(before: &RgbaFrame, after: &RgbaFrame, area: Bounds<Pixels>) -> u32 {
	let left = f32::from(area.origin.x).max(0.0) as u32;
	let top = f32::from(area.origin.y).max(0.0) as u32;
	let right = (f32::from(area.origin.x + area.size.width) as u32).min(before.width());
	let bottom = (f32::from(area.origin.y + area.size.height) as u32).min(before.height());
	let mut differing = 0;
	for y in top..bottom {
		for x in left..right {
			let one = before.pixel(x, y).expect("the sample is inside the frame");
			let other = after.pixel(x, y).expect("the sample is inside the frame");
			if one != other {
				differing += 1;
			}
		}
	}
	differing
}

/// The brightest pixel, the mean brightness, and how many pixels are bright
/// enough to read as ink, inside `area`.
///
/// A scrim is read this way rather than by counting changed pixels: the
/// transcript's ground is black, a dark scrim over black is still black, and
/// the share of the band that changes is then the share of it that carries
/// ink, which is a property of the fixture and not of the scrim.
fn brightness(frame: &RgbaFrame, area: Bounds<Pixels>) -> (u32, u32, u32) {
	let left = f32::from(area.origin.x).max(0.0) as u32;
	let top = f32::from(area.origin.y).max(0.0) as u32;
	let right = (f32::from(area.origin.x + area.size.width) as u32).min(frame.width());
	let bottom = (f32::from(area.origin.y + area.size.height) as u32).min(frame.height());
	let mut brightest = 0;
	let mut total = 0u64;
	let mut counted = 0u64;
	let mut ink = 0;
	for y in top..bottom {
		for x in left..right {
			let pixel = frame.pixel(x, y).expect("the sample is inside the frame");
			let luminance = (u32::from(pixel.r) * 2 + u32::from(pixel.g) * 5 + u32::from(pixel.b)) / 8;
			brightest = brightest.max(luminance);
			total += u64::from(luminance);
			counted += 1;
			if luminance > INK {
				ink += 1;
			}
		}
	}
	(brightest, (total / counted.max(1)) as u32, ink)
}

/// The luminance a run of text has to reach to be read as ink rather than as
/// ground or as an antialiased edge of it.
const INK: u32 = 96;

#[test]
fn a_floating_panel_meets_no_region_it_is_not_annotating() {
	let surface = load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface;
	let widths = shell_widths(shed(true), &surface);
	assert!(
		matches!(widths.right_panel, RightPanelPlacement::Overlay { .. }),
		"a {WIDTH}px window must float the panel for this to mean anything, not place it {:?}",
		widths.right_panel
	);
	assert!(
		widths.queue_px.is_some(),
		"a {WIDTH}px window must keep the queue rail, or the rail cannot be dimmed"
	);

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_shell(&mut cx);
	session.frame().expect("the first frame renders");
	session
		.keystroke(&resolve_chord("primary-\\"))
		.expect("the panel chord dispatches");
	session.frame().expect("the frame with the panel renders");

	let panel = box_of(&mut session, Region::Panel);
	let transcript = box_of(&mut session, Region::Transcript);
	// The three regions below the transcript are what the float covered. They
	// are read here so a fixture that stopped drawing one cannot leave the
	// sweep passing on an empty set.
	for region in [Region::Queue, Region::Cards, Region::Composer, Region::RunBar] {
		let _ = box_of(&mut session, region);
	}

	let recorded = session
		.update(|view, _window, _cx| view.laid_out().recorded_regions())
		.expect("the view is live");
	let met: Vec<Region> = recorded
		.into_iter()
		.filter(|region| *region != Region::Panel)
		.filter(|region| overlaps(panel, box_of(&mut session, *region)))
		.collect();

	assert!(
		met.contains(&Region::Transcript),
		"the float met no transcript box, so it is not over the region it annotates: {met:?}"
	);
	let strays: Vec<Region> = met
		.iter()
		.copied()
		.filter(|region| !matches!(region, Region::Transcript | Region::Turn(_)))
		.collect();
	assert_eq!(strays, Vec::new(), "the float covers regions it does not annotate: {strays:?}");
	assert!(
		panel.origin.y >= transcript.origin.y
			&& panel.origin.y + panel.size.height <= transcript.origin.y + transcript.size.height,
		"the float's box {panel:?} leaves the transcript's box {transcript:?} vertically"
	);
}

#[test]
fn a_floating_panel_tints_the_transcript_and_leaves_the_rail_and_the_draft_lit() {
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_shell(&mut cx);
	let closed = session
		.frame()
		.expect("the frame without the panel renders")
		.frame;

	let rail = box_of(&mut session, Region::Queue);
	let composer = box_of(&mut session, Region::Composer);
	let cards = box_of(&mut session, Region::Cards);
	let run_bar = box_of(&mut session, Region::RunBar);
	let transcript = box_of(&mut session, Region::Transcript);

	session
		.keystroke(&resolve_chord("primary-\\"))
		.expect("the panel chord dispatches");
	let open = session
		.frame()
		.expect("the frame with the panel renders")
		.frame;

	let panel = box_of(&mut session, Region::Panel);
	// The strip of the transcript the sheet does not cover: what the scrim is
	// for. It is read clear of the sheet's own drop shadow, which spills into
	// the band beside it, so a change there is not evidence of a scrim -- a
	// float with no scrim at all still darkens what its shadow falls on.
	let clear_of_shadow = px(64.0);
	let tinted = Bounds {
		origin: transcript.origin,
		size:   size(panel.origin.x - transcript.origin.x - clear_of_shadow, transcript.size.height),
	};
	let (was_brightest, was_mean, was_ink) = brightness(&closed, tinted);
	let (is_brightest, is_mean, is_ink) = brightness(&open, tinted);
	// Whatever the fixture draws there has to be readable first, or a band of
	// bare ground would pass every claim below without a scrim existing.
	assert!(
		was_ink > 0 && was_brightest > 2 * INK,
		"the transcript beside the float draws no ink ({was_ink} px over {INK}, brightest \
		 {was_brightest}), so there is nothing for a scrim to dim"
	);
	assert!(
		is_brightest * 2 < was_brightest,
		"the brightest pixel beside the float went {was_brightest} -> {is_brightest}, so the float \
		 does not dim the transcript it covers"
	);
	assert_eq!(
		is_ink, 0,
		"{is_ink} pixels beside the float still read at ink brightness, so the scrim is drawn over \
		 part of the transcript rather than the region"
	);
	assert!(
		is_mean < was_mean,
		"the band's mean brightness went {was_mean} -> {is_mean}, so the scrim darkens nothing"
	);

	for (name, area) in [
		("the queue rail", rail),
		("the card stack", cards),
		("the composer", composer),
		("the run bar", run_bar),
	] {
		let differing = differing_pixels(&closed, &open, area);
		assert_eq!(
			differing, 0,
			"{name} changed {differing} pixels when the panel opened, so the float reaches a surface \
			 it is not annotating"
		);
	}
}
