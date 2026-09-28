//! The keys move the keyboard among the rows the filter shows: Up and Down
//! wrap at either end, Home and End jump to them, and the page keys, Left and
//! Right with them, move by the rows in view and stop at either end.

use gpui::TestAppContext;

use super::harness::{Win, browsing, long};

/// How many rows the long tree holds, more than the sheet shows at once.
const ROWS: usize = 60;

impl Win<'_> {
	/// Where among the long tree's rows the keyboard is.
	fn at(&self) -> usize {
		let entry = self.selected().expect("the keyboard is on a row");
		entry
			.strip_prefix('r')
			.and_then(|ix| ix.parse().ok())
			.unwrap_or_else(|| panic!("{entry} is a long tree row"))
	}

	/// Presses `keys` and answers where the keyboard landed.
	fn press(&mut self, keys: &str) -> usize {
		self.keys(keys);
		self.at()
	}
}

#[gpui::test]
fn the_arrows_wrap_and_home_end_and_the_page_keys_stop_at_either_end(app: &mut TestAppContext) {
	let mut w = browsing(app, long(ROWS));
	let last = ROWS - 1;
	assert_eq!(w.at(), last, "the keyboard starts on the leaf");
	assert_eq!(w.press("down"), 0, "Down on the last row wraps to the first");
	assert_eq!(w.press("up"), last, "Up on the first row wraps to the last");
	assert_eq!(w.press("up"), last - 1);
	assert_eq!(w.press("down"), last);
	assert_eq!(w.press("home"), 0);

	let page = w.press("pagedown");
	assert!(page > 1 && page < last, "a page moves by the rows in view, not one or all: {page}");
	assert_eq!(w.press("home right"), page, "Right pages down");
	assert_eq!(w.press("home pageup"), 0, "a page up stops at the first row");
	assert_eq!(w.press("home left"), 0, "and so does Left");

	let back = last - w.press("end pageup");
	assert!(back > 1 && back < last, "a page up moves by the rows in view: {back}");
	assert_eq!(w.press("end left"), last - back, "Left pages up");
	assert_eq!(w.press("end pagedown"), last, "a page down stops at the last row");
	assert_eq!(w.press("end right"), last, "and so does Right");
	assert!(w.sent().is_empty(), "moving sends nothing");
}
