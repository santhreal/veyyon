//! Line and header rendering for the diff viewport.

use gpui::{
	AnyElement, Context, Div, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, Styled, Window, div, px,
};
use veyyon_gui_core::{UiCommand, model::LineRange};
use veyyon_gui_kit::{
	theme::{Theme, diff, size, space, weight},
	ui::{AnchoredPopover, Badge, Side, Tone, text},
};

use super::{
	paint::{LinePaint, code_text, line_style, marker_cell, number_cell},
	rows::{Notice, Row},
	viewport::DiffViewport,
};
use crate::act;

impl DiffViewport {
	pub(super) fn render_row(
		&mut self,
		index: usize,
		_window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let Some(row) = self.rows.as_slice().get(index).copied() else {
			return gpui::Empty.into_any_element();
		};
		let theme = Theme::get(cx);
		match row {
			Row::File { file } => self.file_header(file as usize, &theme).into_any_element(),
			Row::Notice { file, notice } => self
				.notice(file as usize, notice, &theme)
				.into_any_element(),
			Row::Hunk { file, hunk } => self
				.hunk_header(file as usize, hunk as usize, &theme)
				.into_any_element(),
			Row::Unified { file, hunk, line } => self
				.unified_line(file as usize, hunk as usize, line as usize, &theme)
				.into_any_element(),
			Row::Split { file, hunk, left, right } => self
				.split_line(file as usize, hunk as usize, left, right, &theme)
				.into_any_element(),
			Row::Pad { .. } => div().h(px(space::X8)).into_any_element(),
		}
	}

	fn file_header(&self, file: usize, theme: &Theme) -> Div {
		let Some(file) = self.files.get(file) else {
			return div();
		};
		div()
			.flex()
			.items_center()
			.gap(px(space::X8))
			.h(px(diff::file_header_height()))
			.px(px(space::X10))
			.bg(theme.raised)
			.child(
				text::mono(file.path.clone(), theme)
					.flex_1()
					.min_w(px(0.0))
					.text_color(theme.text)
					.font_weight(weight::MEDIUM),
			)
			.children(file.old_path.clone().map(|path| {
				text::meta(path, theme)
					.flex_none()
					.text_color(theme.text_faint)
			}))
			.children(
				file
					.status
					.map(|(label, tone)| Badge::new(label).tone(tone).bare()),
			)
			.children(
				file
					.additions
					.clone()
					.map(|count| Badge::new(count).tone(Tone::Ok).bare()),
			)
			.children(
				file
					.deletions
					.clone()
					.map(|count| Badge::new(count).tone(Tone::Danger).bare()),
			)
	}

	fn notice(&self, _file: usize, notice: Notice, theme: &Theme) -> Div {
		let detail = match notice {
			Notice::Added => "New file",
			Notice::Deleted => "Deleted file. The diff shows its last contents.",
			Notice::Renamed => "Renamed file",
			Notice::Binary => "Binary file. Line content is unavailable.",
			Notice::Truncated => "The host truncated this diff. Some lines are unavailable.",
			Notice::Malformed => "A malformed hunk was preserved as far as it could be read.",
		};
		let tone = if matches!(notice, Notice::Truncated | Notice::Malformed) {
			Tone::Warn
		} else {
			Tone::Muted
		};
		div()
			.flex()
			.items_center()
			.min_h(px(diff::line_height()))
			.px(px(space::X10))
			.bg(tone.tint(theme))
			.child(text::note_wrapping(detail, theme).text_color(tone.ink(theme)))
	}

	fn hunk_header(&self, file: usize, hunk: usize, theme: &Theme) -> Div {
		let Some(file_paint) = self.files.get(file) else {
			return div();
		};
		let Some(hunk_paint) = file_paint.hunks.get(hunk) else {
			return div();
		};
		let added = hunk_paint
			.lines
			.iter()
			.filter(|l| matches!(l.kind, veyyon_gui_core::text::diff::LineKind::Added))
			.count();
		let deleted = hunk_paint
			.lines
			.iter()
			.filter(|l| matches!(l.kind, veyyon_gui_core::text::diff::LineKind::Removed))
			.count();
		let context_count = hunk_paint
			.lines
			.iter()
			.filter(|l| matches!(l.kind, veyyon_gui_core::text::diff::LineKind::Context))
			.count();

		let mut popover =
			AnchoredPopover::new(format!("hunk-popover-{}-{}", file_paint.path, hunk), true)
				.side(Side::Bottom)
				.has_controls(true);

		popover = popover.child(
			text::stack(space::SNUG)
				.child(text::title("Hunk context", theme))
				.child(hunk_detail_row("Header", &hunk_paint.header, theme))
				.child(hunk_detail_row("File", &file_paint.path, theme))
				.child(hunk_detail_row("Additions", &format!("+{added} lines"), theme))
				.child(hunk_detail_row("Deletions", &format!("-{deleted} lines"), theme))
				.child(hunk_detail_row("Context lines", &format!("{context_count} lines"), theme)),
		);

		div()
			.flex()
			.items_center()
			.justify_between()
			.h(px(diff::hunk_header_height()))
			.px(px(space::X10))
			.bg(theme.sunken)
			.child(
				text::mono(hunk_paint.header.clone(), theme)
					.text_size(px(size::body()))
					.text_color(theme.text_muted),
			)
			.child(popover)
	}

	fn unified_line(&self, file: usize, hunk: usize, line: usize, theme: &Theme) -> Div {
		let Some(line) = self.line(file, hunk, line) else {
			return div();
		};
		let (ground, marker, ink) = line_style(line.kind, theme);
		let content = code_text(line.text.clone(), self.wrap, theme).text_color(ink);
		let number = line.new_line.or(line.old_line);
		let ground = if self.is_selected(file, number) {
			theme.selected()
		} else {
			ground
		};
		let row = div()
			.flex()
			.items_start()
			.min_h(px(diff::line_height()))
			.bg(ground)
			.child(number_cell(line.old_number.clone(), theme))
			.child(number_cell(line.new_number.clone(), theme))
			.child(marker_cell(marker, theme))
			.child(content)
			.children(line.no_newline.then(|| {
				text::meta("no newline", theme)
					.flex_none()
					.pr(px(space::X6))
					.text_color(theme.warn)
			}));
		self.selectable(row, file, number)
	}

	fn split_line(
		&self,
		file: usize,
		hunk: usize,
		left: Option<u32>,
		right: Option<u32>,
		theme: &Theme,
	) -> Div {
		div()
			.flex()
			.min_h(px(diff::line_height()))
			.child(self.split_half(file, hunk, left, true, theme))
			.child(div().w(px(diff::SPLIT_DIVIDER)).h_full().bg(theme.stroke))
			.child(self.split_half(file, hunk, right, false, theme))
	}

	fn split_half(
		&self,
		file: usize,
		hunk: usize,
		line: Option<u32>,
		old: bool,
		theme: &Theme,
	) -> Div {
		let Some(line) = line.and_then(|line| self.line(file, hunk, line as usize)) else {
			return div()
				.w_1_2()
				.min_h(px(diff::line_height()))
				.bg(theme.sunken);
		};
		let (ground, marker, ink) = line_style(line.kind, theme);
		let number_text = if old {
			line.old_number.clone()
		} else {
			line.new_number.clone()
		};
		let number = if old { line.old_line } else { line.new_line };
		let ground = if self.is_selected(file, number) {
			theme.selected()
		} else {
			ground
		};
		let row = div()
			.flex()
			.items_start()
			.w_1_2()
			.min_w(px(0.0))
			.min_h(px(diff::line_height()))
			.bg(ground)
			.child(number_cell(number_text, theme))
			.child(marker_cell(marker, theme))
			.child(code_text(line.text.clone(), self.wrap, theme).text_color(ink));
		self.selectable(row, file, number)
	}

	fn line(&self, file: usize, hunk: usize, line: usize) -> Option<&LinePaint> {
		self.files.get(file)?.hunks.get(hunk)?.lines.get(line)
	}

	fn is_selected(&self, file: usize, number: Option<u32>) -> bool {
		let Some(number) = number else {
			return false;
		};
		let Some(path) = self.files.get(file).map(|file| file.path.as_ref()) else {
			return false;
		};
		self.review_path.as_deref() == Some(path)
			&& self
				.review_range
				.is_some_and(|range| range.start <= number && number <= range.end)
	}

	fn selectable(&self, row: Div, file: usize, number: Option<u32>) -> Div {
		let Some(number) = number else {
			return row;
		};
		let Some(path) = self.files.get(file).map(|file| file.path.clone()) else {
			return row;
		};
		let current_path = self.review_path.clone();
		let current_range = self.review_range;
		row.cursor_pointer().on_mouse_down(
			MouseButton::Left,
			move |event: &MouseDownEvent, window, cx| {
				let range = if event.modifiers.shift && current_path.as_ref() == Some(&path) {
					let current = current_range.unwrap_or(LineRange { start: number, end: number });
					LineRange { start: current.start.min(number), end: current.end.max(number) }
				} else {
					LineRange { start: number, end: number }
				};
				act::run(
					UiCommand::SetReviewRange { path: path.to_string(), range: Some(range) },
					window,
					cx,
				);
			},
		)
	}
}

fn hunk_detail_row(label: &str, value: &str, theme: &Theme) -> gpui::Div {
	div()
		.flex()
		.items_center()
		.justify_between()
		.gap(px(space::BASE))
		.child(text::meta(label.to_owned(), theme))
		.child(
			text::mono(value.to_owned(), theme)
				.text_size(px(size::meta()))
				.text_color(theme.text),
		)
}
