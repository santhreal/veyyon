//! WHY: §5.9 declares one settings row: a 14/20 label, a 12/16 muted
//! description, a 240px control column, 44px. §6.5 states the invariant behind
//! it — a row is exactly its declared height, and content that does not fit
//! truncates rather than growing the row. The row was built with `min_h` and a
//! description that wrapped, so a row was as tall as its prose: the General
//! page's settings run to five and six lines of description each, which drew
//! rows of 100px and more, fitted six settings where eleven fit, and read as a
//! column of paragraphs instead of a list of controls.
//!
//! CLASS CLOSED:
//! 1. A row whose height depends on the length of what it says. The same page
//!    is drawn with one-word descriptions and with paragraph-length ones, and
//!    every label box is asserted to land on the same pixel in both.
//! 2. A row that grows by wrapping: each row is asserted to draw one line of
//!    label and one line of description, so a description on two lines fails
//!    even if the row it sits in were made tall enough for it.
//! 3. A page dropping the descriptions to hold its rhythm: the long-description
//!    frame is asserted to draw a description run per row.
//! 4. The truncated prose becoming unrecoverable: hovering a row is asserted to
//!    draw text the resting frame does not, which is the tag carrying the whole
//!    description.
//! 5. Every page the overlay draws, swept from `SettingsPage` at run time, so a
//!    page added later is measured here without editing this suite.
//!
//! NOT CAUGHT: which words survive the truncation, and where the tag opens.
//! Both are judged from a capture. The row's control column is measured in
//! `a-row-clips-a-control-taller-than-the-band-it-declares`, which draws a
//! control taller than the band the row declares.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Captured, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{Overlay, SettingsPage, ShellView, fixture, install_tokens};
use veyyon_gpui::{App, AppContext, Pixels, Point, TextRunLayout, px};

#[path = "support/settings_seed.rs"]
mod settings_seed;

use settings_seed::seed_state_for_page;

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// A sentence long enough to wrap several times inside the label column: the
/// shape of every real description on the General page.
const PARAGRAPH: &str = "Off: only the account you chose is used, and a session waits out its \
                         quota window. On: when that account hits its quota or rate limit, \
                         continue on another account of the same provider and say so. A revoked \
                         account always fails over regardless, with a notice.";

/// The declared row height (§5.9), which the bundled settings tokens author.
const ROW_HEIGHT_PX: f32 = 44.0;

/// Whether the two frames differ inside a small patch with its top left corner
/// at `(x, y)` in logical pixels: the tag's ground and text against whatever
/// the resting frame drew there.
fn changed_pixels(resting: &Captured, hovered: &Captured, x: f32, y: f32) -> bool {
	let mut differing = 0;
	for row in 0..10_u32 {
		for column in 0..60_u32 {
			let (px_x, px_y) = (x as u32 + column, y as u32 + row);
			if resting.frame.pixel(px_x, px_y) != hovered.frame.pixel(px_x, px_y) {
				differing += 1;
			}
		}
	}
	differing > 20
}

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

/// Opens the overlay on `page`, with every description replaced by `describe`
/// applied to the label, and returns the resting frame and the frame with the
/// pointer over the first row's text.
fn frames(page: SettingsPage, describe: impl Fn(&str) -> String) -> (Captured, Captured) {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let mut state = seed_state_for_page(page);
	for entry in state.settings.values_mut() {
		let label = entry.label.clone().unwrap_or_default();
		entry.description = Some(describe(&label));
	}

	let mut cx = headless_context().expect("a headless renderer is required to draw the shell");
	let mut session = HeadlessSession::open(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| {
			let mut shell = fixture::populated();
			shell.overlay = Some(Overlay::Settings(Box::new(state)));
			ShellView::new(installed, shell)
		})
	})
	.expect("the shell opens offscreen");

	let resting = session.frame().expect("the resting frame renders");
	// The pointer goes to the middle of a description the frame itself drew,
	// which is the only way to be over a row whatever page and whatever height
	// the overlay took.
	let at = description_centre(&resting).unwrap_or(Point { x: px(520.0), y: px(300.0) });
	session
		.hover(at)
		.expect("the pointer moves over the overlay");
	let hovered = session.frame().expect("the hovered frame renders");
	(resting, hovered)
}

/// The centre of a row's description line: the 16px run that sits directly
/// under a 20px label run at the same left edge, in the column where most such
/// pairs are drawn, which is the settings body whatever width the overlay took.
fn description_centre(captured: &Captured) -> Option<Point<Pixels>> {
	let height = |run: &TextRunLayout| f32::from(run.bounds.bottom()) - f32::from(run.bounds.top());
	let labels: Vec<&TextRunLayout> = captured
		.text_runs
		.iter()
		.filter(|run| (19.0..=21.0).contains(&height(run)))
		.collect();
	let pairs: Vec<&TextRunLayout> = captured
		.text_runs
		.iter()
		.filter(|run| (15.0..=17.0).contains(&height(run)))
		.filter(|desc| {
			labels.iter().any(|label| {
				(f32::from(label.bounds.left()) - f32::from(desc.bounds.left())).abs() < 0.5
					&& (f32::from(label.bounds.bottom()) - f32::from(desc.bounds.top())).abs() < 1.5
			})
		})
		.collect();
	let mut counts: Vec<(f32, usize)> = Vec::new();
	for desc in &pairs {
		let left = f32::from(desc.bounds.left());
		match counts
			.iter_mut()
			.find(|(seen, _)| (*seen - left).abs() < 0.5)
		{
			Some((_, count)) => *count += 1,
			None => counts.push((left, 1)),
		}
	}
	let column = counts
		.into_iter()
		.max_by_key(|(_, count)| *count)
		.map(|(left, _)| left)?;
	pairs
		.into_iter()
		.filter(|desc| (f32::from(desc.bounds.left()) - column).abs() < 0.5)
		.map(|desc| Point {
			x: px(f32::from(desc.bounds.left()) + 4.0),
			y: px((f32::from(desc.bounds.top()) + f32::from(desc.bounds.bottom())) / 2.0),
		})
		.min_by(|left, right| {
			f32::from(left.y)
				.partial_cmp(&f32::from(right.y))
				.expect("a centre is a real number")
		})
}

/// The label-column text runs of the overlay: the runs left of the control
/// column, ordered top down as `(top, height)`.
fn column_runs(captured: &Captured) -> Vec<(f32, f32)> {
	let control_edge = f32::from(WIDTH as f32) / 2.0 + 60.0;
	let mut runs: Vec<(f32, f32)> = captured
		.text_runs
		.iter()
		.filter(|run| f32::from(run.bounds.left()) < control_edge)
		.map(|run| {
			(f32::from(run.bounds.top()), f32::from(run.bounds.bottom()) - f32::from(run.bounds.top()))
		})
		.collect();
	runs.sort_by(|left, right| {
		left
			.0
			.partial_cmp(&right.0)
			.expect("a top is a real number")
	});
	runs
}

#[test]
fn a_page_draws_the_same_rows_whether_its_descriptions_are_a_word_or_a_paragraph() {
	for page in SettingsPage::iter() {
		let (short, _) = frames(page, |_| "Short".to_string());
		let (long, _) = frames(page, |_| PARAGRAPH.to_string());

		let short_runs = column_runs(&short);
		let long_runs = column_runs(&long);
		assert!(
			!short_runs.is_empty(),
			"{page:?}: the page drew no text in its label column, so it measures nothing"
		);
		assert_eq!(
			short_runs.len(),
			long_runs.len(),
			"{page:?}: the page drew {} lines of text with one-word descriptions and {} with \
			 paragraphs, so a description wraps or is dropped",
			short_runs.len(),
			long_runs.len()
		);
		for (index, ((short_top, _), (long_top, _))) in
			short_runs.iter().zip(long_runs.iter()).enumerate()
		{
			assert!(
				(short_top - long_top).abs() <= 0.5,
				"{page:?}: line {index} is at {short_top:.1}px with a one-word description and \
				 {long_top:.1}px with a paragraph, so the row grew to the length of its prose"
			);
		}
	}
}

#[test]
fn a_row_hands_over_the_description_it_truncated() {
	for page in SettingsPage::iter() {
		let (resting, hovered) = frames(page, |_| PARAGRAPH.to_string());
		let at = description_centre(&resting)
			.unwrap_or_else(|| panic!("{page:?}: the page drew no row description to point at"));
		let added: Vec<&TextRunLayout> = hovered
			.text_runs
			.iter()
			.filter(|run| {
				!resting
					.text_runs
					.iter()
					.any(|rest| rest.bounds == run.bounds)
			})
			.collect();
		assert_eq!(
			added.len(),
			1,
			"{page:?}: pointing at a row's description drew {} new text runs, and the row hands over \
			 exactly one tag",
			added.len()
		);
		let tag = added[0].bounds;
		assert!(
			f32::from(tag.top()) > f32::from(at.y),
			"{page:?}: the tag opened at {:.1}px, above the description it belongs to at {:.1}px",
			f32::from(tag.top()),
			f32::from(at.y)
		);

		// The tag hangs over the rows under it, which are drawn after the row
		// that owns it: a tag laid out inside the row is painted before them
		// and clipped by the list, so the prose is recorded and invisible.
		// Every pixel row of the tag below the hovered row's own band is
		// asserted to have changed.
		let band_end = f32::from(at.y) + ROW_HEIGHT_PX / 2.0;
		let overlap = f32::from(tag.bottom()).min(band_end + ROW_HEIGHT_PX) - band_end;
		assert!(
			overlap > 1.0,
			"{page:?}: the tag ends at {:.1}px, inside the row it belongs to, so it proves nothing \
			 about the rows it covers",
			f32::from(tag.bottom())
		);
		let changed = changed_pixels(&resting, &hovered, f32::from(tag.left()) + 2.0, band_end + 2.0);
		assert!(
			changed,
			"{page:?}: the frame is unchanged where the tag covers the row under it, so the tag was \
			 recorded and never drawn"
		);

		// Paint order: the runs come back in the order the frame drew them, so
		// a tag drawn inside its row lands before the rows it hangs over and
		// their labels are drawn on top of the prose it carries.
		let tag_index = hovered
			.text_runs
			.iter()
			.position(|run| run.bounds == tag)
			.expect("the tag is one of the frame's runs");
		let covered_after = hovered
			.text_runs
			.iter()
			.skip(tag_index + 1)
			.filter(|run| run.bounds.intersects(&tag))
			.count();
		assert_eq!(
			covered_after, 0,
			"{page:?}: {covered_after} text runs are drawn over the tag, so the prose it hands over \
			 is read through the rows under it"
		);
	}
}
