//! Queue rail visibility, paging, and partition layout calculations (§5.1,
//! §5.2).
//!
//! Defines visibility rules for the scrollable queue rail, handling bounded
//! initial paging for archival sections and height budgeting metrics.

use veyyon_desktop_tokens::QueueSurfaceTokens;

use crate::model::{Row, Section};

/// How many of a section's rows the rail initially pages in.
///
/// `Parked` is paged because it is unbounded — a queue running for a long
/// period holds more parked sessions than an initial view requires, and the
/// rest are reached through the pagination control and scrollable navigation.
/// Every other partition offers all of its rows.
#[must_use]
pub fn visible_rows(section: Section, count: usize, geometry: &QueueSurfaceTokens) -> usize {
	visible_rows_with_limit(section, count, geometry.parked_initial_page_size)
}

/// How many of a section's rows the rail pages in given an explicit parked
/// limit.
#[must_use]
pub fn visible_rows_with_limit(section: Section, count: usize, parked_limit: usize) -> usize {
	if section == Section::Parked {
		parked_limit.min(count)
	} else {
		count
	}
}

/// Computes paged visibility for all sections based on active parked limit.
#[must_use]
pub fn paged_rail_fill(sections: &[(Section, Vec<Row>)], parked_limit: usize) -> RailFill {
	let total: usize = sections.iter().map(|(_, rows)| rows.len()).sum();
	let drawn: Vec<usize> = sections
		.iter()
		.map(|(section, rows)| visible_rows_with_limit(*section, rows.len(), parked_limit))
		.collect();
	let shown: usize = drawn.iter().sum();
	RailFill { drawn, hidden: total.saturating_sub(shown) }
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

/// Fits the sections into the rail's height budget.
///
/// Calculates how many rows fit within a given vertical pixel budget, taking
/// into account content insets, section headers, row heights, and the pinned
/// footer. The pinned footer height is subtracted from the budget upfront so
/// the footer control remains accessible at every height.
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
