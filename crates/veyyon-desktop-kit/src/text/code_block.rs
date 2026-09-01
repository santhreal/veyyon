//! Code block syntax-highlighted display primitive (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::token_set::{ColorRole, MonoSizeStep, RadiusStep, SpacingStep, TokenSet};

/// Code block syntax container with line numbering and monospace styling.
#[derive(IntoElement)]
pub struct CodeBlock {
	code:         SharedString,
	language:     Option<SharedString>,
	line_numbers: bool,
}

impl CodeBlock {
	/// Creates a code block with code text content.
	#[must_use]
	pub fn new(code: impl Into<SharedString>) -> Self {
		Self { code: code.into(), language: None, line_numbers: true }
	}

	/// Sets language identifier for syntax styling.
	#[must_use]
	pub fn language(mut self, language: impl Into<SharedString>) -> Self {
		self.language = Some(language.into());
		self
	}

	/// Sets whether line numbers are displayed.
	#[must_use]
	pub fn line_numbers(mut self, line_numbers: bool) -> Self {
		self.line_numbers = line_numbers;
		self
	}
}

impl RenderOnce for CodeBlock {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Inset);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Md);
		let pad = tokens.spacing(SpacingStep::S3);
		let font_size = tokens.mono_font_size(MonoSizeStep::Body);
		let line_h = tokens.mono_line_height(MonoSizeStep::Body);

		let mut container = div()
			.w_full()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.p(pad)
			.text_size(font_size)
			.line_height(line_h)
			.font_family(".SystemMonoFont")
			.flex()
			.flex_col();

		if let Some(lang) = self.language {
			container = container.child(
				div()
					.text_size(tokens.mono_font_size(MonoSizeStep::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.mb(tokens.spacing(SpacingStep::S1))
					.child(lang),
			);
		}

		let lines: Vec<&str> = self.code.lines().collect();
		for (idx, line) in lines.iter().enumerate() {
			let mut line_row = div().flex().items_center();

			if self.line_numbers {
				let line_num_str = format!("{:>3} ", idx + 1);
				line_row = line_row.child(
					div()
						.text_color(tokens.color(ColorRole::Muted))
						.mr(tokens.spacing(SpacingStep::S2))
						.child(line_num_str),
				);
			}

			line_row = line_row.child(
				div()
					.text_color(tokens.color(ColorRole::Foreground))
					.child(SharedString::from((*line).to_string())),
			);

			container = container.child(line_row);
		}

		container
	}
}
