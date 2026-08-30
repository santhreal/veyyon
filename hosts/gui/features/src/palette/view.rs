//! Drawing the sheet, the field and the rows.

use gpui::{
	AnyElement, App, Div, Entity, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};
use veyyon_gui_core::{
	command::Command,
	palette::{self, Row as PaletteRow},
	store::model::Store,
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{self, Channel, Key},
	paint,
	theme::{Theme, layout, size, space},
	ui::{Empty, Icon, Row, Sheet, Tone, icon, kbd, square, text},
};

use super::logic;
use crate::act;

/// How tall the list is allowed to get before it scrolls.
///
/// Twelve rows and a bit: a list that fills the window is a list a reader has
/// to read rather than glance at, and the field is where the next keystroke
/// goes anyway.
const LIST_MAX: f32 = 13.0 * layout::ROW;

/// The palette, or nothing at all.
///
/// Returns `None` once it is both closed and finished leaving, which is what
/// keeps the closing animation on screen: the sheet stays mounted while its
/// channel runs back to zero.
///
/// THE SHEET IS THE ROOT OF WHAT THIS RETURNS. An absolutely positioned
/// element is laid out against its own parent here, not against the nearest
/// ancestor that asked to be positioned, so a wrapper around the sheet is a
/// wrapper the sheet then fills: a flex item of no height, drawn nowhere. The
/// caller hangs this on the window root, which is the box the sheet covers.
pub fn render(store: &Store, field: &Entity<Editor>, cx: &mut App) -> Option<AnyElement> {
	let open = store.overlay.palette().is_some();
	let arrival = paint::toward(
		cx,
		Key::of(Channel::Sheet),
		if open {
			motion::SHEET_IN
		} else {
			motion::SHEET_OUT
		},
		f32::from(open),
	);
	if !open && arrival <= 0.01 {
		return None;
	}

	let rows = palette::rows(store);
	let selected = store
		.overlay
		.palette()
		.map(|palette| palette.selected)
		.unwrap_or(0);

	Some(
		Sheet::new("palette", arrival)
			.width(layout::SHEET)
			.on_dismiss(act::click(Command::Back))
			.child(search(field, cx))
			.child(list(&rows, selected, cx))
			.into_any_element(),
	)
}

/// The field at the top of the sheet.
///
/// No label and no placeholder beyond a word: the sheet arrived because
/// somebody pressed the chord for it, and a form label above a search field in
/// a palette is a line of text between the keystroke and the answer.
fn search(field: &Entity<Editor>, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	div()
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.px(px(space::BASE))
		.pb(px(space::SNUG))
		.child(square(icon::scale::BASE).child(icon::base(Icon::Search, theme.text_faint)))
		.child(
			div()
				.flex_1()
				.min_w(px(0.0))
				.text_size(px(size::LEAD))
				.child(field.clone()),
		)
}

/// The rows, in the order the list decided, under a heading per run.
fn list(rows: &[PaletteRow], selected: usize, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	if rows.is_empty() {
		// Not an error, and not a row: a list with nothing in it says so where
		// the rows would be, so the sheet does not collapse to a field.
		return div()
			.px(px(space::BASE))
			.pb(px(space::BASE))
			.child(Empty::new("Nothing matches").note("Try fewer words."))
			.into_any_element();
	}

	let mut list = div()
		.id("palette-rows")
		.flex()
		.flex_col()
		.gap(px(1.0))
		.max_h(px(LIST_MAX))
		.overflow_y_scroll()
		.border_t_1()
		.border_color(theme.stroke)
		.pt(px(space::SNUG));
	let mut heading = None;
	for (index, row) in rows.iter().enumerate() {
		if heading != Some(row.kind) {
			heading = Some(row.kind);
			list = list.child(
				div()
					.px(px(space::BASE))
					.pt(px(if index == 0 { 0.0 } else { space::SNUG }))
					.pb(px(2.0))
					.child(text::overline(logic::heading(row.kind), &theme)),
			);
		}
		list = list.child(entry(row, index, index == selected, cx));
	}
	list.into_any_element()
}

/// One row: what it is, what it is in, and the chord that does it.
fn entry(row: &PaletteRow, index: usize, selected: bool, cx: &mut App) -> Row {
	let theme = Theme::get(cx);
	let mut entry = Row::new(format!("palette-{index}"), row.label.clone())
		.selected(selected)
		// Every row keeps the space a drawing takes, because only some commands
		// have one and a list whose titles start at two different offsets reads
		// as two lists.
		.gutter(true)
		.tone(if selected { Tone::Plain } else { Tone::Muted })
		.on_click(act::click(row.command.clone()));

	if let Some(mark) = logic::mark(row) {
		entry = entry.icon(mark);
	}

	// The right of the row, in the order a reader scans it: where it lives,
	// then whether it is already on screen, then the chord for it.
	let mut trailing: Vec<AnyElement> = Vec::new();
	if !row.detail.is_empty() {
		trailing.push(text::meta(row.detail.clone(), &theme).into_any_element());
	}
	if logic::current(row) {
		trailing.push(
			square(icon::scale::SMALL)
				.child(icon::at(Icon::Check, icon::scale::SMALL, theme.accent))
				.into_any_element(),
		);
	}
	if let Some(chord) = logic::chord(row) {
		trailing.push(kbd::caps(chord, &theme).into_any_element());
	}
	entry.children(trailing)
}
