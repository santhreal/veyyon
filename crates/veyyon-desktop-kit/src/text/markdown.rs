//! Markdown formatting parser and block emitter primitive (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	state::MarkdownConfig,
	text::code_block::CodeBlock,
	token_set::{ColorRole, SpacingStep, TextRamp, TokenSet},
};

/// Markdown structured document renderer.
#[derive(IntoElement)]
pub struct Markdown {
	source: SharedString,
	config: MarkdownConfig,
}

impl Markdown {
	/// Creates a markdown renderer with source text.
	#[must_use]
	pub fn new(source: impl Into<SharedString>) -> Self {
		Self { source: source.into(), config: MarkdownConfig::default() }
	}

	/// Applies rendering configuration.
	#[must_use]
	pub fn config(mut self, config: MarkdownConfig) -> Self {
		self.config = config;
		self
	}
}

impl RenderOnce for Markdown {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let gap = tokens.spacing(SpacingStep::S3);

		let mut container = div().flex().flex_col().gap(gap).w_full();

		let mut in_code_block = false;
		let mut code_lang = String::new();
		let mut code_lines = Vec::new();

		for line in self.source.lines() {
			if line.starts_with("```") {
				if in_code_block {
					let code_text = code_lines.join("\n");
					let mut block = CodeBlock::new(code_text);
					if !code_lang.is_empty() {
						block = block.language(code_lang.clone());
					}
					container = container.child(block);
					code_lines.clear();
					code_lang.clear();
					in_code_block = false;
				} else {
					in_code_block = true;
					code_lang = line.trim_start_matches("```").trim().to_string();
				}
				continue;
			}

			if in_code_block {
				code_lines.push(line);
				continue;
			}

			if let Some(heading) = line.strip_prefix("### ") {
				let el = div()
					.text_size(tokens.font_size(TextRamp::Head))
					.line_height(tokens.line_height(TextRamp::Head))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(heading.to_string());
				container = container.child(el);
			} else if let Some(heading) = line.strip_prefix("## ") {
				let el = div()
					.text_size(tokens.font_size(TextRamp::Head))
					.line_height(tokens.line_height(TextRamp::Head))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(heading.to_string());
				container = container.child(el);
			} else if let Some(heading) = line.strip_prefix("# ") {
				let el = div()
					.text_size(tokens.font_size(TextRamp::Lead))
					.line_height(tokens.line_height(TextRamp::Lead))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(heading.to_string());
				container = container.child(el);
			} else if let Some(bullet) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
				let row = div()
					.flex()
					.flex_row()
					.gap(tokens.spacing(SpacingStep::S2))
					.child(div().text_color(tokens.color(ColorRole::Muted)).child("•"))
					.child(
						div()
							.text_size(tokens.font_size(TextRamp::Body))
							.line_height(tokens.line_height(TextRamp::Body))
							.text_color(tokens.color(ColorRole::Foreground))
							.child(bullet.to_string()),
					);
				container = container.child(row);
			} else if !line.trim().is_empty() {
				let el = div()
					.text_size(tokens.font_size(TextRamp::Read))
					.line_height(tokens.line_height(TextRamp::Read))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(line.to_string());
				container = container.child(el);
			}
		}

		if in_code_block && !code_lines.is_empty() {
			let code_text = code_lines.join("\n");
			let block = CodeBlock::new(code_text);
			container = container.child(block);
		}

		container
	}
}
