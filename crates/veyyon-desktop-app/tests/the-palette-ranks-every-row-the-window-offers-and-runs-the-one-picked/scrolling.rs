//! The list lays out only the lines scrolled inside the card, and lays out
//! each row, under its section's heading, once the highlight reaches it.
//!
//! WHY: every thread the host lists is a row, so the list grows with the
//! threads. A list that lays out every row lays all of them out again on each
//! frame of the open motion, and a long one misses frames. A row laid out
//! past the card records a driver target outside it, so the targets read
//! back are the rows laid out. Walking the highlight over every row proves the
//! scroll lands on the row and not on a line offset by the headings above it.
//!
//! Gap: the time a frame takes is not read here; `scripts/desktop-bench`
//! (`--probes palette_open`) reads the painted frames of the built binary.

use gpui::{Bounds, Pixels, TestAppContext};
use veyyon_desktop_ui::theme::size as measure;

use crate::harness::{Win, threads, title, window};

/// The shown rows whose driver targets are recorded, in order.
fn laid_out(w: &mut Win<'_>) -> Vec<usize> {
	let count = w.rows().len();
	(0..count)
		.filter(|row| w.bounds(&format!("palette.row:{row}")).is_some())
		.collect()
}

fn row_bounds(w: &mut Win<'_>, row: usize) -> Bounds<Pixels> {
	w.bounds(&format!("palette.row:{row}"))
		.unwrap_or_else(|| panic!("row {row} is laid out"))
}

#[gpui::test]
fn a_long_list_lays_out_only_the_rows_inside_the_card(app: &mut TestAppContext) {
	let mut w = window(app, threads(400), true);
	w.open();
	// An empty query lists the newest threads; a query lists fifty matches a
	// section.
	w.typed(&title("t"));
	let count = w.rows().len();
	assert!(count >= 50, "fifty matching threads are rows: {count} rows");
	for (place, key) in [("at the top", None), ("wrapped to the last row", Some("up"))] {
		if let Some(key) = key {
			w.keys(key);
		}
		let card = w.bounds("palette").expect("the card is laid out");
		let fits = (card.size.height / measure::MENU_ROW).ceil() as usize + 1;
		let rows = laid_out(&mut w);
		assert!(
			!rows.is_empty() && rows.len() <= fits,
			"{place}: {} of {count} rows are laid out; {fits} fit the card",
			rows.len()
		);
		assert!(
			rows.windows(2).all(|pair| pair[1] == pair[0] + 1),
			"{place}: the rows laid out are consecutive: {rows:?}"
		);
		assert!(rows.contains(&w.selected()), "{place}: the highlighted row is laid out");
		for row in rows {
			let bounds = row_bounds(&mut w, row);
			assert!(
				bounds.intersects(&card),
				"{place}: row {row} at {bounds:?} is laid out outside the card at {card:?}"
			);
		}
	}
	assert_eq!(w.selected(), count - 1);
	assert_eq!(w.bounds("palette.row:0"), None, "the first row is forgotten once scrolled away");
}

#[gpui::test]
fn the_highlight_scrolls_every_row_inside_the_card_under_its_heading(app: &mut TestAppContext) {
	let mut w = window(app, threads(40), true);
	w.open();
	let rows = w.rows();
	let card = w.bounds("palette").expect("the card is laid out");
	let list_top = card.top() + measure::HEADER;
	for (row, item) in rows.iter().enumerate() {
		if row > 0 {
			w.keys("down");
		}
		assert_eq!(w.selected(), row);
		let bounds = row_bounds(&mut w, row);
		assert!(
			bounds.top() >= list_top && bounds.bottom() <= card.bottom(),
			"row {row} ({}) at {bounds:?} is inside the list under the card's header at {card:?}",
			item.label
		);
		let texts = w.texts();
		assert!(
			texts.iter().any(|text| *text == *item.label),
			"row {row} draws {:?} in {texts:?}",
			item.label
		);
		if row == 0 || rows[row - 1].group != item.group {
			let heading = item.group.label();
			assert!(
				texts.iter().any(|text| text == heading),
				"{heading:?} is drawn above row {row}, its section's first, in {texts:?}"
			);
		}
	}
}
