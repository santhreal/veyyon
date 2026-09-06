//! Table columnated grid primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*,
};

use crate::token_set::{ColorRole, SpacingStep, TextRamp, TokenSet};

/// Column descriptor for table grid primitive.
#[derive(Debug, Clone)]
pub struct TableColumn {
	pub header: SharedString,
	pub width:  Option<f32>,
}

impl TableColumn {
	/// Creates a new table column with header label.
	#[must_use]
	pub fn new(header: impl Into<SharedString>) -> Self {
		Self { header: header.into(), width: None }
	}

	/// Sets explicit fractional width for flex layout.
	#[must_use]
	pub fn width(mut self, width: f32) -> Self {
		self.width = Some(width);
		self
	}
}

/// Data grid table primitive element.
#[derive(IntoElement)]
pub struct Table {
	columns:     Vec<TableColumn>,
	row_count:   usize,
	render_cell:
		Arc<dyn Fn(usize, usize, &mut Window, &mut App) -> AnyElement + Send + Sync + 'static>,
}

impl Table {
	/// Creates a table primitive with column definitions and cell render
	/// callback.
	#[must_use]
	pub fn new(
		columns: impl IntoIterator<Item = TableColumn>,
		row_count: usize,
		render_cell: impl Fn(usize, usize, &mut Window, &mut App) -> AnyElement + Send + Sync + 'static,
	) -> Self {
		Self { columns: columns.into_iter().collect(), row_count, render_cell: Arc::new(render_cell) }
	}
}

impl RenderOnce for Table {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let header_bg = tokens.color(ColorRole::Inset);
		let border_color = tokens.color(ColorRole::Hairline);
		let header_fg = tokens.color(ColorRole::Secondary);
		let pad_x = tokens.spacing(SpacingStep::S3);
		let pad_y = tokens.spacing(SpacingStep::S2);
		let font_size = tokens.font_size(TextRamp::Small);
		let body_font_size = tokens.font_size(TextRamp::Body);
		let col_count = self.columns.len();

		let mut header_row = div()
			.bg(header_bg)
			.border_b_1()
			.border_color(border_color)
			.flex()
			.items_center();

		for col in &self.columns {
			header_row = header_row.child(
				div()
					.flex_1()
					.px(pad_x)
					.py(pad_y)
					.text_size(font_size)
					.text_color(header_fg)
					.child(col.header.clone()),
			);
		}

		let mut table_container = div().w_full().flex().flex_col().child(header_row);

		for row_idx in 0..self.row_count {
			let mut row_el = div()
				.w_full()
				.border_b_1()
				.border_color(border_color)
				.flex()
				.items_center();

			for col_idx in 0..col_count {
				let cell_content = (self.render_cell)(row_idx, col_idx, window, cx);
				row_el = row_el.child(
					div()
						.flex_1()
						.px(pad_x)
						.py(pad_y)
						.text_size(body_font_size)
						.child(cell_content),
				);
			}

			table_container = table_container.child(row_el);
		}

		table_container
	}
}
