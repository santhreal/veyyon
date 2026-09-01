//! The queue rail (§5.1).
//!
//! The rail is the only surface that shows every session at once, so it is the
//! one place where density has to be decided rather than allowed. Two row
//! shapes carry that: a card for the sections the operator is working in, and a
//! line for the ones they are not. A parked list of forty sessions costs forty
//! lines, not forty cards, which is what keeps the rail readable at the bottom
//! as well as the top.
//!
//! Every dimension here is read from `QueueSurfaceTokens`. None is written as a
//! literal, so a density change is a token edit and the hot-reload loop shows
//! it without a rebuild.

use veyyon_desktop_kit::{ColorRole, TokenSet};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{Context, IntoElement, ParentElement, Styled, div, px};

mod rows;

use crate::{
	ShellView,
	model::{Row, Section},
	queue::rows::{card_row, line_row, more_row, section_header},
};

/// How many of a section's rows the rail pages in.
///
/// `Parked` is paged because it is unbounded — a queue running for a week holds
/// more parked sessions than a rail has height, and the rest are reached by the
/// page control rather than by scrolling past them. Every other section offers
/// all of its rows to the height budget below.
pub fn visible_rows(section: Section, count: usize, geometry: &QueueSurfaceTokens) -> usize {
	if section == Section::Parked {
		geometry.parked_initial_page_size.min(count)
	} else {
		count
	}
}

/// How many rows of each section the rail has the height to draw, and how many
/// rows it therefore does not draw at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RailFill {
	/// Rows drawn per section, index-aligned with the sections given.
	pub drawn:  Vec<usize>,
	/// Rows not drawn, from paging and from the height together.
	pub hidden: usize,
}

/// Fits the sections into the rail's height.
///
/// The rail cannot scroll — this fork exposes no scroll on a plain container —
/// so a rail holding more rows than it has height must stop drawing rows rather
/// than lay them out past the window's lower edge, where they are painted
/// clipped and still answer a click nobody can aim. The remainder is stated in
/// one row instead, and that row's own height is taken out of the budget before
/// any section is fitted.
#[must_use]
pub fn rail_fill(
	sections: &[(Section, Vec<Row>)],
	height_px: f32,
	geometry: &QueueSurfaceTokens,
) -> RailFill {
	let total: usize = sections.iter().map(|(_, rows)| rows.len()).sum();
	if !height_px.is_finite() || height_px <= 0.0 {
		// A height nobody can measure is no height to draw in.
		return RailFill { drawn: vec![0; sections.len()], hidden: total };
	}

	let paged: Vec<usize> = sections
		.iter()
		.map(|(section, rows)| visible_rows(*section, rows.len(), geometry))
		.collect();
	let row_height = |section: Section| {
		if section.draws_cards() {
			geometry.card_px
		} else {
			geometry.line_px
		}
	};

	let mut budget = height_px - geometry.content_inset * 2.0;
	let wanted: f32 = sections
		.iter()
		.zip(&paged)
		.filter(|((_, rows), _)| !rows.is_empty())
		.map(|((section, _), count)| {
			geometry.section_header_px + row_height(*section) * *count as f32
		})
		.sum();
	let paged_out: usize = paged
		.iter()
		.zip(sections)
		.map(|(count, (_, rows))| rows.len() - count)
		.sum();
	if wanted > budget || paged_out > 0 {
		budget -= geometry.line_px;
	}

	let mut drawn = Vec::with_capacity(sections.len());
	for ((section, rows), offered) in sections.iter().zip(&paged) {
		if rows.is_empty() {
			drawn.push(0);
			continue;
		}
		let each = row_height(*section);
		// A header with no row under it states a section the rail is not
		// showing, which is chrome for nothing.
		if budget < geometry.section_header_px + each {
			drawn.push(0);
			continue;
		}
		budget -= geometry.section_header_px;
		let mut count = 0;
		while count < *offered && budget >= each {
			budget -= each;
			count += 1;
		}
		drawn.push(count);
	}

	let shown: usize = drawn.iter().sum();
	RailFill { drawn, hidden: total - shown }
}

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
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut rail = div()
		.flex()
		.flex_col()
		.h_full()
		.w(px(width))
		.flex_shrink_0()
		.bg(tokens.color(ColorRole::Rail))
		.border_r(px(geometry.outer_edge_stroke))
		.border_color(tokens.color(ColorRole::Hairline))
		.pt(px(geometry.content_inset))
		.pb(px(geometry.content_inset))
		.overflow_hidden();

	let fill = rail_fill(sections, height, geometry);

	for ((section, rows), drawn) in sections.iter().zip(&fill.drawn) {
		// A section with no drawn row draws nothing at all, header included: an
		// empty header is a line of chrome that states only that there is
		// nothing to state.
		if *drawn == 0 {
			continue;
		}
		rail = rail.child(section_header(*section, rows.len(), geometry, tokens));

		for row in rows.iter().take(*drawn) {
			let selected = row.id == current;
			rail = if section.draws_cards() {
				rail.child(card_row(row, selected, geometry, tokens, cx))
			} else {
				rail.child(line_row(row, selected, geometry, tokens, cx))
			};
		}
	}

	// One row states everything the rail is not showing, whether it was paged
	// out or ran out of height.
	if fill.hidden > 0 {
		rail = rail.child(more_row(fill.hidden, geometry, tokens));
	}

	rail
}
