//! Side-by-side split diff row rendering (§5.11).

use veyyon_desktop_kit::{ColorRole, TextRamp, TintRole, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{Context, Div, ParentElement, Styled, div, px};

use crate::{
	ShellView,
	right_panel::{
		content::{DiffFile, DiffRow},
		diff_rows::{content_cell, gutter_cell, render_hunk_header, render_unified_row, sign_cell},
	},
};

/// Renders diff rows in side-by-side split mode.
pub fn render_split_rows(
	file_idx: usize,
	file: &DiffFile,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div().w_full().flex().flex_col();

	let mut row_idx = 0;
	while row_idx < file.rows.len() {
		match &file.rows[row_idx] {
			DiffRow::HunkHeader { old_start, old_count, new_start, new_count, symbol } => {
				container = container.child(render_hunk_header(
					*old_start, *old_count, *new_start, *new_count, symbol, geometry, tokens,
				));
				row_idx += 1;
			},
			DiffRow::Context { old_line, new_line, text } => {
				let old_no = format!("{old_line:>4}");
				let new_no = format!("{new_line:>4}");
				container = container.child(
					div()
						.h(px(geometry.diff_row_height_px))
						.w_full()
						.flex_shrink_0()
						.flex()
						.flex_row()
						.items_center()
						.text_size(tokens.font_size(TextRamp::Micro))
						.line_height(px(geometry.diff_row_height_px))
						.font_family(tokens.mono_family())
						// Left side (Old)
						.child(
							div()
								.flex_1()
								.min_w_0()
								.flex()
								.flex_row()
								.items_center()
								.border_r(px(1.0))
								.border_color(tokens.color(ColorRole::Hairline))
								.child(gutter_cell(&old_no, geometry, tokens))
								.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary))
								.child(content_cell(text, &[], tokens, None)),
						)
						// Right side (New)
						.child(
							div()
								.flex_1()
								.min_w_0()
								.flex()
								.flex_row()
								.items_center()
								.child(gutter_cell(&new_no, geometry, tokens))
								.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary))
								.child(content_cell(text, &[], tokens, None)),
						),
				);
				row_idx += 1;
			},
			DiffRow::Removed { .. } | DiffRow::Added { .. } => {
				let mut removed_chunk = Vec::new();
				let mut added_chunk = Vec::new();

				while row_idx < file.rows.len() {
					match &file.rows[row_idx] {
						DiffRow::Removed { old_line, text, intraline } => {
							removed_chunk.push((*old_line, text.clone(), intraline.clone()));
							row_idx += 1;
						},
						_ => break,
					}
				}
				while row_idx < file.rows.len() {
					match &file.rows[row_idx] {
						DiffRow::Added { new_line, text, intraline } => {
							added_chunk.push((*new_line, text.clone(), intraline.clone()));
							row_idx += 1;
						},
						_ => break,
					}
				}

				let max_pairs = removed_chunk.len().max(added_chunk.len());
				let mut rem_bg = tokens.tint(TintRole::Error).fill;
				rem_bg.a = geometry.diff_added_removed_alpha;
				let mut rem_hl_bg = tokens.tint(TintRole::Error).fill;
				rem_hl_bg.a = geometry.diff_intraline_alpha;

				let mut add_bg = tokens.tint(TintRole::Done).fill;
				add_bg.a = geometry.diff_added_removed_alpha;
				let mut add_hl_bg = tokens.tint(TintRole::Done).fill;
				add_hl_bg.a = geometry.diff_intraline_alpha;

				for i in 0..max_pairs {
					let left_cell = if let Some((old_line, text, intraline)) = removed_chunk.get(i) {
						let old_no = format!("{old_line:>4}");
						div()
							.flex_1()
							.min_w_0()
							.flex()
							.flex_row()
							.items_center()
							.bg(rem_bg)
							.border_r(px(1.0))
							.border_color(tokens.color(ColorRole::Hairline))
							.child(gutter_cell(&old_no, geometry, tokens))
							.child(sign_cell("-", geometry, tokens, ColorRole::Foreground))
							.child(content_cell(text, intraline, tokens, Some(rem_hl_bg)))
					} else {
						div()
							.flex_1()
							.min_w_0()
							.flex()
							.flex_row()
							.items_center()
							.border_r(px(1.0))
							.border_color(tokens.color(ColorRole::Hairline))
							.child(gutter_cell("    ", geometry, tokens))
							.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary))
							.child(div().flex_1())
					};

					let right_cell = if let Some((new_line, text, intraline)) = added_chunk.get(i) {
						let new_no = format!("{new_line:>4}");
						div()
							.flex_1()
							.min_w_0()
							.flex()
							.flex_row()
							.items_center()
							.bg(add_bg)
							.child(gutter_cell(&new_no, geometry, tokens))
							.child(sign_cell("+", geometry, tokens, ColorRole::Foreground))
							.child(content_cell(text, intraline, tokens, Some(add_hl_bg)))
					} else {
						div()
							.flex_1()
							.min_w_0()
							.flex()
							.flex_row()
							.items_center()
							.child(gutter_cell("    ", geometry, tokens))
							.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary))
							.child(div().flex_1())
					};

					container = container.child(
						div()
							.h(px(geometry.diff_row_height_px))
							.w_full()
							.flex_shrink_0()
							.flex()
							.flex_row()
							.items_center()
							.text_size(tokens.font_size(TextRamp::Micro))
							.line_height(px(geometry.diff_row_height_px))
							.font_family(tokens.mono_family())
							.child(left_cell)
							.child(right_cell),
					);
				}
			},
			row => {
				container =
					container.child(render_unified_row(file_idx, row_idx, row, geometry, tokens, cx));
				row_idx += 1;
			},
		}
	}

	container
}
