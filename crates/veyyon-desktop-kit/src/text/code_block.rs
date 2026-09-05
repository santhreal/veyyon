//! Mono pane primitive (§8.25): the frame every block of code or captured
//! output is shown in.
//!
//! One shape for the transcript's invoke output, an approval's detail and a
//! raw value nobody could name (§5.3): an inset ground, one radius, one
//! padding, lines that truncate rather than wrap, and a height cap after which
//! the pane clips. A caption above the pane says what the lines are.

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, SharedString, Window, div, prelude::*};

use crate::token_set::{ColorRole, MonoSizeStep, RadiusStep, SpacingStep, TextRamp, TokenSet};

/// A captioned, height-capped pane of monospace lines.
#[derive(IntoElement)]
pub struct CodeBlock {
	lines:        Vec<SharedString>,
	caption:      Option<SharedString>,
	line_numbers: bool,
	size:         MonoSizeStep,
	max_height:   Option<Pixels>,
}

impl CodeBlock {
	/// A pane of `code`, one row per line.
	#[must_use]
	pub fn new(code: impl Into<SharedString>) -> Self {
		let code: SharedString = code.into();
		Self::lines(code.lines().map(|line| SharedString::from(line.to_owned())))
	}

	/// A pane of lines already split.
	#[must_use]
	pub fn lines(lines: impl IntoIterator<Item = SharedString>) -> Self {
		Self {
			lines:        lines.into_iter().collect(),
			caption:      None,
			line_numbers: false,
			size:         MonoSizeStep::Body,
			max_height:   None,
		}
	}

	/// The line above the pane saying what the lines are: a language, a
	/// command, a file.
	#[must_use]
	pub fn caption(mut self, caption: impl Into<SharedString>) -> Self {
		self.caption = Some(caption.into());
		self
	}

	/// Whether each line is numbered.
	#[must_use]
	pub const fn line_numbers(mut self, line_numbers: bool) -> Self {
		self.line_numbers = line_numbers;
		self
	}

	/// The mono size the lines are set at.
	#[must_use]
	pub const fn size(mut self, size: MonoSizeStep) -> Self {
		self.size = size;
		self
	}

	/// The height after which the pane clips.
	#[must_use]
	pub const fn max_height(mut self, max_height: Pixels) -> Self {
		self.max_height = Some(max_height);
		self
	}
}

impl RenderOnce for CodeBlock {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let font_size = tokens.mono_font_size(self.size);
		let line_h = tokens.mono_line_height(self.size);
		let ink = tokens.color(ColorRole::Secondary);
		let number_ink = tokens.color(ColorRole::Muted);
		let width = self.lines.len().to_string().len();

		let mut body = div()
			.w_full()
			.overflow_hidden()
			.bg(tokens.color(ColorRole::Inset))
			.rounded(tokens.radius(RadiusStep::Sm))
			.p(tokens.spacing(SpacingStep::S2))
			.flex()
			.flex_col()
			.font_family(tokens.mono_family())
			.text_size(font_size)
			.line_height(line_h);
		if let Some(max_height) = self.max_height {
			body = body.max_h(max_height);
		}

		for (index, line) in self.lines.into_iter().enumerate() {
			let mut row = div().w_full().min_w_0().flex().flex_row();
			if self.line_numbers {
				row = row.child(
					div()
						.flex_shrink_0()
						.mr(tokens.spacing(SpacingStep::S2))
						.text_color(number_ink)
						.child(format!("{:>width$}", index + 1)),
				);
			}
			body = body.child(
				row.child(
					div()
						.flex_1()
						.min_w_0()
						.overflow_hidden()
						.whitespace_nowrap()
						.truncate()
						.text_color(ink)
						.child(line),
				),
			);
		}

		let mut pane = div()
			.w_full()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S1));
		if let Some(caption) = self.caption {
			pane = pane.child(
				div()
					.w_full()
					.min_w_0()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_size(tokens.font_size(TextRamp::Micro))
					.line_height(tokens.line_height(TextRamp::Micro))
					.text_color(number_ink)
					.child(caption),
			);
		}
		pane.child(body)
	}
}
