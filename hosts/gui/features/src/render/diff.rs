//! A patch.
//!
//! One card per file: the path, what happened to it, how many lines it moves,
//! and the hunks. A patch is the one thing in a transcript a reader scans
//! rather than reads, so the file line carries the whole summary and the hunks
//! are under it in the order the patch had them.
//!
//! LINE NUMBERS ARE PART OF THE CONTENT. A patch with no numbers cannot be
//! matched against the file it applies to, so both columns are drawn, in mono,
//! at the width of the widest number in the hunk: a column that resizes per
//! line makes every line start at a different place.
//!
//! A line's ground says what it does; the sign says it again for anybody who
//! cannot tell the two grounds apart. Neither alone is enough.

use gpui::{AnyElement, App, Div, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::text::diff::{Change, DiffLine, FileDiff, Hunk, LineKind};
use veyyon_gui_kit::{
	theme::{Theme, radius, size, space, weight},
	ui::{Badge, Icon, Tone, text},
};

/// Every file in a patch.
pub fn patch(files: &[FileDiff], cx: &mut App) -> Vec<AnyElement> {
	files
		.iter()
		.map(|file| one(file, cx).into_any_element())
		.collect()
}

/// One file.
fn one(file: &FileDiff, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let added = file.added();
	let removed = file.removed();

	let mut card = text::stack(0.0)
		.w_full()
		.rounded(px(radius::CHIP))
		.bg(theme.sunken)
		.overflow_hidden()
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::SNUG))
				.w_full()
				.px(px(space::BASE))
				.h(px(30.0))
				.child(
					text::mono(file.path().to_owned(), &theme)
						.flex_1()
						.min_w(px(0.0))
						.text_color(theme.text)
						.font_weight(weight::MEDIUM),
				)
				.children(renamed(file, &theme))
				// What happened to the file, where the counts do not already say
				// it: a modified file is the ordinary case, and the words
				// "changed" beside "+2 -1" carry nothing.
				.children(what(file.change).map(|what| Badge::new(what).tone(tone(file.change)).bare()))
				.children((added > 0).then(|| Badge::new(format!("+{added}")).tone(Tone::Ok).bare()))
				.children(
					(removed > 0).then(|| Badge::new(format!("-{removed}")).tone(Tone::Danger).bare()),
				),
		);

	if file.binary {
		// Nothing to draw, and saying so is the honest answer: a binary file has
		// no lines to show.
		return card.child(
			div()
				.px(px(space::BASE))
				.pb(px(space::SNUG))
				.child(text::note("Binary, so there is nothing to show", &theme)),
		);
	}

	let width = number_width(&file.hunks);
	for hunk in &file.hunks {
		card = card.child(run(hunk, width, &theme));
	}
	card
}

/// One `@@` run: its heading, then its lines.
fn run(hunk: &Hunk, width: f32, theme: &Theme) -> Div {
	let heading = if hunk.section.is_empty() {
		format!("@@ -{},{} +{},{} @@", hunk.old_start, hunk.old_len, hunk.new_start, hunk.new_len)
	} else {
		format!(
			"@@ -{},{} +{},{} @@ {}",
			hunk.old_start, hunk.old_len, hunk.new_start, hunk.new_len, hunk.section
		)
	};

	let mut column = text::stack(0.0).w_full().child(
		div()
			.w_full()
			.px(px(space::BASE))
			.py(px(2.0))
			.bg(theme.text.opacity(0.03))
			.child(
				text::mono(heading, theme)
					.text_color(theme.text_faint)
					.text_size(px(size::META)),
			),
	);
	for line in &hunk.lines {
		column = column.child(row(line, width, theme));
	}
	column
}

/// One line of a hunk.
fn row(line: &DiffLine, width: f32, theme: &Theme) -> Div {
	let (ground, sign, ink) = match line.kind {
		LineKind::Added => (theme.added, "+", theme.text),
		LineKind::Removed => (theme.removed, "-", theme.text),
		LineKind::Context => (gpui::transparent_black(), " ", theme.text_muted),
	};
	let number = |value: Option<u32>| {
		text::mono(value.map(|value| value.to_string()).unwrap_or_default(), theme)
			.flex_none()
			.w(px(width))
			.text_size(px(size::META))
			.text_color(theme.text_faint)
	};

	let mut element = div()
		.flex()
		.w_full()
		.gap(px(space::SNUG))
		.px(px(space::SNUG))
		.bg(ground)
		.child(number(line.old_no))
		.child(number(line.new_no))
		.child(
			text::mono(format!("{sign}{}", line.text), theme)
				.flex_1()
				.min_w(px(0.0))
				.text_size(px(size::SMALL))
				.line_height(px(size::SMALL * size::LINE_CODE))
				.text_color(ink),
		);
	if line.no_newline {
		element = element.child(
			text::meta("no newline", theme)
				.flex_none()
				.text_color(theme.warn),
		);
	}
	element
}

/// Wide enough for the largest line number in the file, so every line starts at
/// the same place.
fn number_width(hunks: &[Hunk]) -> f32 {
	let widest = hunks
		.iter()
		.flat_map(|hunk| hunk.lines.iter())
		.flat_map(|line| [line.old_no, line.new_no])
		.flatten()
		.max()
		.unwrap_or(0);
	// Mono digits at the meta size, plus a little: the exact advance is the text
	// system's to know, and this is the column it is given.
	let digits = widest.to_string().len().max(2) as f32;
	digits * 7.0
}

/// What happened to the file, in a word, and nothing when the counts beside it
/// already say so.
fn what(change: Change) -> Option<&'static str> {
	match change {
		Change::Added => Some("new"),
		Change::Removed => Some("deleted"),
		Change::Renamed => Some("renamed"),
		Change::Modified => None,
	}
}

fn tone(change: Change) -> Tone {
	match change {
		Change::Added => Tone::Ok,
		Change::Removed => Tone::Danger,
		Change::Renamed | Change::Modified => Tone::Muted,
	}
}

/// The path a rename came from, named once beside the one it went to.
fn renamed(file: &FileDiff, theme: &Theme) -> Option<Div> {
	if file.change != Change::Renamed || file.old_path.is_empty() {
		return None;
	}
	Some(
		text::mono(format!("was {}", file.old_path), theme)
			.flex_none()
			.text_size(px(size::META))
			.text_color(theme.text_faint),
	)
}

/// The glyph a patch is announced with, where a surface wants to name one.
pub const MARK: Icon = Icon::Changed;
