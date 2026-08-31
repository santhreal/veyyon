//! Event-built strings and fixed diff-row paint helpers.

use gpui::{Div, ParentElement, SharedString, Styled, div, px};
use veyyon_gui_core::text::diff::{Change, DiffLine, FileDiff, Hunk, LineKind};
use veyyon_gui_kit::{
	theme::{Theme, diff, size, space},
	ui::{Tone, text},
};

pub(super) struct FilePaint {
	pub path:      SharedString,
	pub old_path:  Option<SharedString>,
	pub status:    Option<(&'static str, Tone)>,
	pub additions: Option<SharedString>,
	pub deletions: Option<SharedString>,
	pub hunks:     Vec<HunkPaint>,
}

pub(super) struct HunkPaint {
	pub header: SharedString,
	pub lines:  Vec<LinePaint>,
}

pub(super) struct LinePaint {
	pub kind:       LineKind,
	pub old_number: SharedString,
	pub new_number: SharedString,
	pub old_line:   Option<u32>,
	pub new_line:   Option<u32>,
	pub text:       SharedString,
	pub no_newline: bool,
}

impl FilePaint {
	pub fn new(file: &FileDiff, whitespace: bool) -> Self {
		let additions = file.added();
		let deletions = file.removed();
		let status = match file.change {
			Change::Added => Some(("added", Tone::Ok)),
			Change::Removed => Some(("deleted", Tone::Danger)),
			Change::Renamed => Some(("renamed", Tone::Muted)),
			Change::Modified => None,
		};
		Self {
			path: file.path().to_owned().into(),
			old_path: (file.change == Change::Renamed && !file.old_path.is_empty())
				.then(|| format!("was {}", file.old_path).into()),
			status,
			additions: (additions > 0).then(|| format!("+{additions}").into()),
			deletions: (deletions > 0).then(|| format!("-{deletions}").into()),
			hunks: file
				.hunks
				.iter()
				.map(|hunk| HunkPaint::new(hunk, whitespace))
				.collect(),
		}
	}
}

impl HunkPaint {
	fn new(hunk: &Hunk, whitespace: bool) -> Self {
		let header = if hunk.section.is_empty() {
			format!("@@ -{},{} +{},{} @@", hunk.old_start, hunk.old_len, hunk.new_start, hunk.new_len)
		} else {
			format!(
				"@@ -{},{} +{},{} @@ {}",
				hunk.old_start, hunk.old_len, hunk.new_start, hunk.new_len, hunk.section
			)
		};
		Self {
			header: header.into(),
			lines:  hunk
				.lines
				.iter()
				.map(|line| LinePaint::new(line, whitespace))
				.collect(),
		}
	}
}

impl LinePaint {
	fn new(line: &DiffLine, whitespace: bool) -> Self {
		let value = if whitespace {
			line.text.replace(' ', "·").replace('\t', "→   ")
		} else {
			line.text.clone()
		};
		Self {
			kind:       line.kind,
			old_number: line
				.old_no
				.map_or_else(String::new, |number| number.to_string())
				.into(),
			new_number: line
				.new_no
				.map_or_else(String::new, |number| number.to_string())
				.into(),
			old_line:   line.old_no,
			new_line:   line.new_no,
			text:       value.into(),
			no_newline: line.no_newline,
		}
	}
}

pub(super) fn line_style(kind: LineKind, theme: &Theme) -> (gpui::Hsla, &'static str, gpui::Hsla) {
	match kind {
		LineKind::Added => (theme.added, "+", theme.text),
		LineKind::Removed => (theme.removed, "−", theme.text),
		LineKind::Context => (gpui::transparent_black(), " ", theme.text),
	}
}

pub(super) fn number_cell(value: SharedString, theme: &Theme) -> Div {
	div()
		.flex()
		.flex_none()
		.justify_end()
		.w(px(diff::line_number_gutter()))
		.pr(px(space::X6))
		.child(
			text::mono(value, theme)
				.text_size(px(size::body()))
				.text_color(theme.text_muted),
		)
}

pub(super) fn marker_cell(marker: &'static str, theme: &Theme) -> Div {
	div()
		.flex()
		.flex_none()
		.justify_center()
		.w(px(diff::marker_gutter()))
		.child(
			text::mono(marker, theme)
				.text_size(px(size::body()))
				.text_color(theme.text_muted),
		)
}

pub(super) fn code_text(value: SharedString, wrap: bool, theme: &Theme) -> Div {
	let text = text::mono(value, theme)
		.flex_1()
		.min_w(px(0.0))
		.text_size(px(size::body()))
		.line_height(px(diff::line_height()));
	if wrap { text } else { text.whitespace_nowrap() }
}
