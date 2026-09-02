//! Height budgeting and visibility calculations for the queue rail (§5.1,
//! §5.2).
//!
//! Fits queue sections into available vertical space, accounting for content
//! insets, section headers, row heights, and the pinned rail footer.

use veyyon_desktop_tokens::QueueSurfaceTokens;

use crate::model::{Row, Section};

/// How many of a section's rows the rail pages in.
///
/// `Parked` is paged because it is unbounded — a queue running for a week holds
/// more parked sessions than a rail has height, and the rest are reached by the
/// page control rather than by scrolling past them. Every other section offers
/// all of its rows to the height budget below.
#[must_use]
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
///
/// The pinned footer height is subtracted from the budget upfront so the
/// footer control remains accessible at every height.
#[must_use]
pub fn rail_fill(
	sections: &[(Section, Vec<Row>)],
	height_px: f32,
	geometry: &QueueSurfaceTokens,
) -> RailFill {
	let total: usize = sections.iter().map(|(_, rows)| rows.len()).sum();
	if !height_px.is_finite() || height_px <= 0.0 {
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

	let mut budget = geometry.content_inset.mul_add(-2.0, height_px) - geometry.footer_height_px;
	if budget <= 0.0 {
		return RailFill { drawn: vec![0; sections.len()], hidden: total };
	}

	let header_h =
		geometry.section_header_px + geometry.section_gap_above + geometry.section_gap_below;
	let wanted: f32 = sections
		.iter()
		.zip(&paged)
		.filter(|((_, rows), _)| !rows.is_empty())
		.map(|((section, _), count)| row_height(*section).mul_add(*count as f32, header_h))
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
		if budget < header_h + each {
			drawn.push(0);
			continue;
		}
		budget -= header_h;
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
