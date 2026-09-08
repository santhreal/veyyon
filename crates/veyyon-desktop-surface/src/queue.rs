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
use veyyon_gpui::{
	Context, FocusHandle, InteractiveElement, IntoElement, ParentElement, Styled, Window, div, px,
};
pub mod card;
pub mod fill;
pub mod footer;
pub mod header;
pub mod line;
pub mod menu;
pub mod motion;
pub mod rows;

pub use fill::{RailFill, paged_rail_fill, rail_fill, visible_rows, visible_rows_with_limit};
pub use footer::queue_footer;
pub use header::{more_row, older_row, queue_nav_header, section_header};
pub use menu::{RowMenu, RowMenuKind, row_menu_layer};
pub use motion::RailMotion;
pub use rows::{card_row, line_row};
use veyyon_desktop_model::{SessionId, SurfaceId};

use crate::{
	ShellView,
	controls::{ControlStates, availability_style, hairline_for_weak},
	model::{Row, Section},
};

/// A single renderable item in the virtualized queue list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueListItem {
	SectionHeader { section: Section, count: usize, collapsed: bool },
	Row { row: Row, section: Section, selected: bool, is_open: bool },
	OlderRow { hidden: usize },
}
/// Builds the queue rail at the width and height the shed allots it.
///
/// Neither measure is the rail's own: §5.7 sheds the rail from 256 to 208 and
/// then to nothing as the window narrows, and the height is the columns row's,
/// which is what decides how many rows there is room to answer a click on.
pub fn queue_rail(
	sections: &[(Section, Vec<Row>)],
	filter_query: Option<&str>,
	current: u64,
	width: f32,
	_height: f32,
	controls: &ControlStates,
	geometry: &QueueSurfaceTokens,
	tokens: &TokenSet,
	motion: &mut RailMotion,
	focus: &FocusHandle,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let now = Instant::now();
	motion.record_selected_id(current);
	motion.ensure_visible(current, sections, geometry.parked_initial_page_size, now);
	let parked_limit = motion.parked_limit(geometry.parked_initial_page_size);
	let filtered_storage;
	let active_sections: &[(Section, Vec<Row>)] = if let Some(q) = filter_query {
		let needle = q.trim().to_lowercase();
		if needle.is_empty() {
			sections
		} else {
			filtered_storage = sections
				.iter()
				.map(|(sec, rows)| {
					let filtered: Vec<Row> = rows
						.iter()
						.filter(|r| {
							r.title.to_lowercase().contains(&needle)
								|| r.subtitle.to_lowercase().contains(&needle)
						})
						.cloned()
						.collect();
					(*sec, filtered)
				})
				.collect::<Vec<_>>();
			&filtered_storage
		}
	} else {
		sections
	};
	let mut current_y = geometry.content_inset;
	let mut positions = HashMap::new();
	let mut items = Vec::new();
	let mut selected_item_ix = None;

	for (section, rows) in active_sections {
		if rows.is_empty() {
			continue;
		}
		current_y +=
			geometry.section_gap_above + geometry.section_header_px + geometry.section_gap_below;
		let row_h = if section.draws_cards() {
			geometry.card_px
		} else {
			geometry.line_px
		};
		let is_collapsed = motion.is_collapsed(*section);

		items.push(QueueListItem::SectionHeader {
			section:   *section,
			count:     rows.len(),
			collapsed: is_collapsed,
		});

		if !is_collapsed {
			let drawn_count = if *section == Section::Parked {
				rows.len().min(parked_limit)
			} else {
				rows.len()
			};
			let hidden_count = if *section == Section::Parked {
				rows.len().saturating_sub(drawn_count)
			} else {
				0
			};

			for row in rows.iter().take(drawn_count) {
				positions.insert(row.id, current_y);
				current_y += row_h;
				let selected = row.id == current;
				if selected {
					selected_item_ix = Some(items.len());
				}
				items.push(QueueListItem::Row {
					row: row.clone(),
					section: *section,
					selected,
					is_open: selected,
				});
			}

			if *section == Section::Parked && hidden_count > 0 {
				current_y += geometry.line_px;
				items.push(QueueListItem::OlderRow { hidden: hidden_count });
			}
		}
	}

	motion.record_positions(&positions, now);
	motion.sync_item_count(items.len());

	if motion.should_scroll_to_selected() {
		if let Some(ix) = selected_item_ix {
			motion.scroll_to_reveal_item(ix);
		} else {
			motion.clear_pending_scroll();
		}
	}

	if motion.has_active_animations(now) {
		let view = cx.weak_entity();
		window.on_next_frame(move |_, app| {
			let _ = view.update(app, |_, cx| cx.notify());
		});
	}

	let nav_header = queue_nav_header(filter_query, controls, geometry, tokens, cx);

	let mut shift_map = HashMap::new();
	for item in &items {
		if let QueueListItem::Row { row, .. } = item {
			shift_map.insert(row.id, motion.shift_offset(row.id, now));
		}
	}
	let shift_offsets: std::rc::Rc<HashMap<u64, f32>> = std::rc::Rc::new(shift_map);
	let items_snapshot: std::rc::Rc<[QueueListItem]> = std::rc::Rc::from(items);
	let list_state = motion.list_state().clone();
	let geometry_copy = geometry.clone();
	let tokens_copy = tokens.clone();
	let controls_copy = controls.clone();
	let weak_view = cx.weak_entity();

	let list_el = veyyon_gpui::list(list_state, move |item_ix, _window, _app| {
		let Some(item) = items_snapshot.get(item_ix) else {
			return div().into_any_element();
		};
		let row = match item {
			QueueListItem::SectionHeader { section, count, collapsed } => section_header(
				*section,
				*count,
				*collapsed,
				&geometry_copy,
				&tokens_copy,
				Some(weak_view.clone()),
			)
			.into_any_element(),
			QueueListItem::Row { row, section, selected, is_open } => {
				let shift_y = shift_offsets.get(&row.id).copied().unwrap_or(0.0);
				let row_surface = SurfaceId::QueueSessionRow(SessionId::from(row.id.to_string()));
				let row_error = hairline_for_weak(
					&controls_copy,
					&row_surface,
					&tokens_copy,
					Some(weak_view.clone()),
				);
				let row_el = if section.draws_cards() {
					card_row(
						row,
						*section,
						*selected,
						*is_open,
						shift_y,
						&controls_copy,
						&geometry_copy,
						&tokens_copy,
						Some(weak_view.clone()),
					)
					.into_any_element()
				} else {
					line_row(
						row,
						*section,
						*selected,
						*is_open,
						shift_y,
						&geometry_copy,
						&tokens_copy,
						Some(weak_view.clone()),
					)
					.into_any_element()
				};
				let row_av = controls_copy.availability(&row_surface);
				let (row_opacity, ..) = availability_style(&row_av, &tokens_copy);
				return div()
					.w_full()
					.flex()
					.flex_col()
					.opacity(row_opacity)
					.child(row_el)
					.children(row_error)
					.into_any_element();
			},
			QueueListItem::OlderRow { hidden } => {
				older_row(*hidden, &geometry_copy, &tokens_copy, Some(weak_view.clone()))
					.into_any_element()
			},
		};
		div()
			.w_full()
			.flex()
			.flex_col()
			.child(row)
			.into_any_element()
	})
	.w_full()
	.h_full();

	let list_container = div()
		.id("queue-scroll-container")
		.flex_1()
		.w_full()
		.h_full()
		.overflow_hidden()
		.child(list_el);

	// The rail tracks the focus, so a press anywhere in it -- a row, a header,
	// the footer -- hands the keyboard to the rail and the `Queue` context
	// reaches the focus path (§5.14).
	div()
		.id("queue-rail")
		.key_context("Queue")
		.track_focus(focus)
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
		.child(nav_header)
		.child(list_container)
		.child(queue_footer(geometry, tokens, cx))
}
