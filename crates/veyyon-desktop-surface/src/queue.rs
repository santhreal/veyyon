//! The queue rail (§5.1, §5.2).
//!
//! The rail is the only surface that shows every session at once, displaying
//! session state across five collapsible and ordered partitions with real
//! motion transitions and a pinned settings footer.
//!
//! Every dimension here is read from `QueueSurfaceTokens`. None is written as a
//! literal, so a density change is a token edit and the hot-reload loop shows
//! it without a rebuild.

use std::{collections::HashMap, time::Instant};

use veyyon_desktop_kit::{ColorRole, TokenSet};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{Context, InteractiveElement, IntoElement, ParentElement, Styled, div, px};

pub mod card;
pub mod fill;
pub mod footer;
pub mod header;
pub mod line;
pub mod menu;
pub mod motion;
pub mod rows;

pub use fill::{RailFill, rail_fill, visible_rows};
pub use footer::queue_footer;
pub use menu::{RowMenu, row_menu_layer};
pub use motion::RailMotion;
pub use rows::{card_row, line_row, more_row, section_header};

use crate::{
	ShellView,
	model::{Badge, Row, Section},
};

/// Builds the queue rail at the width and height the shed allots it.
///
/// Neither measure is the rail's own: §5.7 sheds the rail from 256 to 208 and
/// then to nothing as the window narrows, and the height is the columns row's,
/// which is what decides how many rows there is room to answer a click on.
pub fn queue_rail(
	sections: &[(Section, Vec<Row>)],
	current: u64,
	width: f32,
	height: f32,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	motion: &mut RailMotion,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let now = Instant::now();
	let fill = rail_fill(sections, height, geometry);

	let mut positions = HashMap::new();
	let mut current_y = geometry.content_inset;

	for ((section, rows), drawn) in sections.iter().zip(&fill.drawn) {
		if *drawn == 0 {
			continue;
		}
		current_y +=
			geometry.section_gap_above + geometry.section_header_px + geometry.section_gap_below;
		let row_h = if section.draws_cards() {
			geometry.card_px
		} else {
			geometry.line_px
		};
		if !motion.is_collapsed(*section) {
			for row in rows.iter().take(*drawn) {
				positions.insert(row.id, current_y);
				current_y += row_h;
			}
		}
	}

	motion.record_positions(&positions, now);

	let mut sections_col = div().flex().flex_col().flex_1().w_full().overflow_hidden();

	for ((section, rows), drawn) in sections.iter().zip(&fill.drawn) {
		if *drawn == 0 {
			continue;
		}
		let is_collapsed = motion.is_collapsed(*section);
		sections_col = sections_col.child(section_header(
			*section,
			rows.len(),
			is_collapsed,
			geometry,
			tokens,
			cx,
		));

		if !is_collapsed {
			for row in rows.iter().take(*drawn) {
				let selected = row.id == current;
				let is_open = selected;
				let shift_y = motion.shift_offset(row.id, now);
				sections_col = if section.draws_cards() {
					sections_col.child(card_row(row, selected, is_open, shift_y, geometry, tokens, cx))
				} else {
					sections_col.child(line_row(row, selected, is_open, shift_y, geometry, tokens, cx))
				};
			}
		}
	}

	if fill.hidden > 0 {
		sections_col = sections_col.child(more_row(fill.hidden, geometry, tokens));
	}

	let has_working = sections
		.iter()
		.any(|(_, rows)| rows.iter().any(|r| r.badge == Some(Badge::Working)));
	if has_working {
		cx.spawn(async move |this, cx| {
			cx.background_executor()
				.timer(std::time::Duration::from_secs(1))
				.await;
			let _ = this.update(cx, |_view, cx| {
				cx.notify();
			});
		})
		.detach();
	}

	if motion.has_active_animations(now) {
		cx.spawn(async move |this, cx| {
			cx.background_executor()
				.timer(std::time::Duration::from_millis(16))
				.await;
			let _ = this.update(cx, |_view, cx| {
				cx.notify();
			});
		})
		.detach();
	}

	div()
		.id("queue-rail")
		.key_context("Queue")
		.flex()
		.flex_col()
		.justify_between()
		.h_full()
		.w(px(width))
		.flex_shrink_0()
		.bg(tokens.color(ColorRole::Rail))
		.border_r(px(geometry.outer_edge_stroke))
		.border_color(tokens.color(ColorRole::Hairline))
		.pt(px(geometry.content_inset))
		.overflow_hidden()
		.child(sections_col)
		.child(queue_footer(geometry, tokens, cx))
}
