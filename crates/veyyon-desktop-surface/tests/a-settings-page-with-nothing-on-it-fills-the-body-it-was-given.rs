//! WHY: a settings page with nothing on it drew its two sentences hard under
//! the page description and left the rest of the sheet empty, because the page
//! body was sized by its content rather than by the sheet. The same content
//! sizing collapsed the body's `ScrollView` onto those two lines, and the view
//! faded its edges to the canvas rather than to the sheet it sits on, so a page
//! with nothing to scroll drew two dark bars across the sheet.
//!
//! CLASS CLOSED: both defects are properties of the body every page renders
//! into, so the sweep is over `SettingsPage::iter()` rather than over the page
//! that was reported:
//! 1. Every page that states an empty condition centres it in the body: the
//!    space above the two sentences matches the space below them, measured from
//!    the last chrome the sheet drew above them to the sheet's own inner foot.
//!    A page whose body is content-sized fails, because its sentences sit at
//!    the top of a body that stops just under them.
//! 2. No page draws ink darker than the ground it is drawn on. An edge fade
//!    that falls off to another ground, a scrim leaking through a body, or a
//!    fill reaching for the canvas role inside the sheet is darker than the
//!    sheet, and turns this red wherever on the page it lands.
//! 3. A page added to the enum is swept without being named here; a page that
//!    draws rows rather than an empty state is a recorded opt-out pinned by
//!    exact equality.
//!
//! NOT CAUGHT: the wording of either sentence, which
//! `a-settings-page-with-nothing-on-it-states-the-condition-and-the-step.rs`
//! judges; the horizontal placement of the block; and a fade that falls off to
//! a ground lighter than the sheet, which no page has and which this reads as
//! ordinary ink.

mod support;

use std::{
	path::Path,
	sync::{Arc, Mutex},
};

use strum::IntoEnumIterator;
use support::empty_prose::squeezed;
use veyyon_desktop_kit::{SpacingStep, TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	layout::{BoxBounds, BoxId},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	ConnectionPhase, Keymap, Overlay, SettingsPage, SettingsState, ShellState, ShellView,
	install_tokens,
	navigation::SurfaceRoute,
	settings::empty::{EmptyCopy, empty_copy},
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// Half a line of slack. The two sentences are measured by their glyph boxes
/// and the body by its layout box, so the two ends of the centring differ by
/// the descent the last line reserves and nothing else.
const CENTRING_SLACK: f32 = 6.0;

/// The pages that draw rows rather than an empty state, and so have no block to
/// centre. Keybindings falls back to the shipped default bindings.
fn opted_out() -> Vec<SettingsPage> {
	vec![SettingsPage::Keybindings]
}

/// The sheet open on `page` with nothing in it, routed the way a command
/// reaches one page.
fn empty_sheet(page: SettingsPage) -> ShellState {
	let mut settings = SettingsState::new(page);
	settings.route = Some(SurfaceRoute::Page(page));
	ShellState {
		connection: ConnectionPhase::Attached,
		overlay: Some(Overlay::Settings(Box::new(settings))),
		..ShellState::default()
	}
}

/// One frame of the sheet, with the inset the sheet holds its body at.
///
/// The inset is read from the installed tokens rather than restated here, so
/// the measurement below moves when the sheet's padding does.
fn drawn(page: SettingsPage) -> (Captured, Insets) {
	let mut cx = headless_context().expect("headless renderer available");
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let theme = load_bundled_theme("dark").expect("bundled theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	let inset = Arc::new(Mutex::new(Insets { pad: 0.0, gap: 0.0 }));
	let read_inset = Arc::clone(&inset);
	let state = empty_sheet(page);
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		app.bind_keys(Keymap::default().bindings());
		if let Ok(mut slot) = read_inset.lock() {
			let set = TokenSet::for_app(app);
			*slot = Insets {
				pad: f32::from(set.spacing(SpacingStep::S6)),
				gap: f32::from(set.spacing(SpacingStep::S4)),
			};
		}
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the sheet opens");
	let captured = session.frame().expect("the sheet renders");
	let held = inset
		.lock()
		.map_or(Insets { pad: 0.0, gap: 0.0 }, |slot| *slot);
	(captured, held)
}

/// The measures the sheet holds its body at: the padding inside the sheet, and
/// the gap the sheet leaves between the description and the body.
#[derive(Clone, Copy)]
struct Insets {
	pad: f32,
	gap: f32,
}

/// The sheet's own box: the largest box carrying both a fill and a border,
/// which is the one surface in this frame that draws its own boundary.
fn sheet_box(captured: &Captured) -> BoxBounds {
	let mut best: Option<BoxBounds> = None;
	for id in 0..captured.layout.len() {
		let Some(item) = captured
			.layout
			.get(BoxId(u32::try_from(id).unwrap_or_default()))
		else {
			continue;
		};
		if item.fill.is_none() || item.border.is_none() || !item.visible {
			continue;
		}
		let bounds = item.bounds;
		let kept = best
			.map(|held| held.width() * held.height())
			.unwrap_or_default();
		if bounds.width() * bounds.height() > kept {
			best = Some(bounds);
		}
	}
	best.expect("the sheet draws a bordered ground")
}

/// True when `run` was drawn inside `sheet` rather than on the shell behind
/// the scrim, which draws its own text at every height this measures.
fn inside(run: &veyyon_gpui::TextRunLayout, sheet: BoxBounds) -> bool {
	let left = f32::from(run.bounds.origin.x);
	let top = f32::from(run.bounds.origin.y);
	left >= sheet.left
		&& left + f32::from(run.bounds.size.width) <= sheet.right
		&& top >= sheet.top
		&& top + f32::from(run.bounds.size.height) <= sheet.bottom
}

/// The shortest run this reads as part of a sentence it is looking for.
///
/// A run is matched by containment, and a page's title, its description and
/// its empty copy share words and sometimes a whole name. A fragment this long
/// is the sentence rather than a word two of them have in common.
const FRAGMENT: usize = 12;

/// Where the empty copy sits, and what the sheet drew immediately above it.
struct Body {
	/// The bottom edge of the last thing the sheet drew above the copy: its
	/// description, or a row the page draws above its empty state.
	chrome: f32,
	/// The top and bottom edge of the copy itself.
	top:    f32,
	bottom: f32,
}

/// Reads the body of `page` out of the frame.
///
/// Every reading starts at the description, which is the first run the page
/// itself draws: the shell the scrim covers draws text at every height in the
/// sheet's box and the frame records a run the scrim later hid, and the page
/// title above the description carries the page's own name, which its empty
/// copy names as well.
fn body(captured: &Captured, sheet: BoxBounds, page: SettingsPage, copy: &EmptyCopy) -> Body {
	let described = squeezed(page.description());
	let mut chrome = f32::MIN;
	let mut first = 0;
	for (index, run) in captured.text_runs.iter().enumerate() {
		let text = squeezed(run.text.as_ref());
		if text.len() < FRAGMENT || !described.contains(&text) || !inside(run, sheet) {
			continue;
		}
		if chrome == f32::MIN {
			first = index;
		}
		chrome = chrome.max(f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height));
	}
	assert!(chrome > f32::MIN, "{page:?} draws its description");

	let wanted = format!("{}{}", squeezed(copy.condition), squeezed(copy.action));
	let mut top = f32::MAX;
	let mut bottom = f32::MIN;
	for run in captured.text_runs.iter().skip(first) {
		let text = squeezed(run.text.as_ref());
		let run_top = f32::from(run.bounds.origin.y);
		if text.len() < FRAGMENT || !wanted.contains(&text) || !inside(run, sheet) || run_top < chrome
		{
			continue;
		}
		top = top.min(run_top);
		bottom = bottom.max(run_top + f32::from(run.bounds.size.height));
	}
	assert!(top < bottom, "{page:?} draws its empty copy");

	for run in captured.text_runs.iter().skip(first) {
		let run_bottom = f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height);
		if !inside(run, sheet) || run_bottom > top {
			continue;
		}
		chrome = chrome.max(run_bottom);
	}
	Body { chrome, top, bottom }
}

#[test]
fn an_empty_page_centres_its_sentences_in_the_body_the_sheet_gave_it() {
	let skipped = opted_out();
	for page in SettingsPage::iter() {
		if skipped.contains(&page) {
			continue;
		}
		let Some(copy) = empty_copy(page) else {
			continue;
		};
		let (captured, inset) = drawn(page);
		let sheet = sheet_box(&captured);
		if std::env::var("DUMP_EMPTY").is_ok() {
			let frame = &captured.frame;
			let buffer = image::RgbaImage::from_raw(
				(frame.logical_width() * frame.scale_factor()) as u32,
				(frame.logical_height() * frame.scale_factor()) as u32,
				frame.as_bytes().to_vec(),
			)
			.expect("frame buffer");
			std::fs::create_dir_all("../../target/empty").expect("dir");
			buffer
				.save(format!("../../target/empty/{page:?}.png"))
				.expect("written");
		}
		let read = body(&captured, sheet, page, &copy);
		let above = read.top - read.chrome - inset.gap;
		let below = sheet.bottom - inset.pad - read.bottom;
		assert!(
			above > 0.0 && below > 0.0,
			"{page:?} draws its empty copy inside the sheet: above {above}, below {below}"
		);
		assert!(
			(above - below).abs() <= CENTRING_SLACK,
			"{page:?} centres its empty copy in the body: {above} above, {below} below"
		);
	}
}

#[test]
fn an_empty_page_draws_nothing_darker_than_the_ground_it_sits_on() {
	let skipped = opted_out();
	for page in SettingsPage::iter() {
		if skipped.contains(&page) {
			continue;
		}
		if empty_copy(page).is_none() {
			continue;
		}
		let (captured, inset) = drawn(page);
		let sheet = sheet_box(&captured);
		let frame = &captured.frame;
		let left = (sheet.left + inset.pad).round().max(0.0) as u32;
		let right = (sheet.right - inset.pad).round().max(0.0) as u32;
		let top = (sheet.top + inset.pad).round().max(0.0) as u32;
		let foot = (sheet.bottom - inset.pad).round().max(0.0) as u32;
		let ground = frame
			.pixel(left + 1, top + 1)
			.expect("the sheet ground is rastered");
		let floor = ground.relative_luminance() * 0.9;
		let mut darkest: Option<(u32, u32, f32)> = None;
		for y in top..foot {
			for x in left..right {
				let Some(pixel) = frame.pixel(x, y) else {
					continue;
				};
				let luminance = pixel.relative_luminance();
				if luminance < floor && darkest.is_none_or(|(_, _, held)| luminance < held) {
					darkest = Some((x, y, luminance));
				}
			}
		}
		assert!(
			darkest.is_none(),
			"{page:?} draws only the sheet's own ground and lighter ink: {darkest:?} under {floor}"
		);
	}
}
