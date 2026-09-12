//! Row ranking for the palette (§5.8), run when the query, the items or the
//! route change and never while a frame is drawn.
//!
//! Scoring a catalogue is not free: the model list carries thousands of rows,
//! each with a title, an id, a heading, a search alias and its route aliases,
//! and each candidate string is lowercased and walked per character. Ranking
//! from the render path spent every frame on a result the previous frame had
//! already computed, which starved the window's own event loop. The order is
//! held as indices into the item list so the state stays `Clone` and `Eq`.

use super::{PaletteItem, PaletteItemKind, matcher::fuzzy_rank};
use crate::{Intent, navigation::SurfaceRoute};

/// The row order for `query` over `items`, as indices into `items`.
///
/// An empty query keeps the authored order and drops the commands another
/// route owns; a query ranks by best field score and then regroups so a
/// heading is drawn once.
pub(super) fn rank_rows(
	query: &str,
	items: &[PaletteItem],
	route: Option<SurfaceRoute>,
) -> Vec<usize> {
	if query.is_empty() {
		return items
			.iter()
			.enumerate()
			.filter(|(_, item)| route_keeps(item, route))
			.map(|(index, _)| index)
			.collect();
	}
	let ranked = fuzzy_rank(query, items, targets);
	let mut ordered: Vec<usize> = ranked.into_iter().map(|(index, ..)| index).collect();
	// A complete slash-command name takes precedence over a description or alias.
	if let Some(position) = ordered.iter().position(|index| {
		let item = &items[*index];
		matches!(item.kind, PaletteItemKind::Command { .. } | PaletteItemKind::Composer { .. })
			&& item.title.starts_with('/')
			&& item
				.title
				.trim_start_matches('/')
				.eq_ignore_ascii_case(query.trim_start_matches('/'))
	}) {
		ordered[..=position].rotate_right(1);
	}
	regroup(&ordered, items)
}

/// Whether a row belongs to the route the palette is showing. A command that
/// navigates elsewhere is reachable from its own destination, not from this
/// one.
fn route_keeps(item: &PaletteItem, route: Option<SurfaceRoute>) -> bool {
	if route != Some(SurfaceRoute::Commands) {
		return true;
	}
	match &item.kind {
		PaletteItemKind::Command { intent } => match intent.as_ref() {
			Intent::Navigate(destination) => destination.parent() == route,
			_ => true,
		},
		_ => true,
	}
}

/// The strings a query is scored against: what the row draws, what it holds,
/// and the aliases its destination answers to.
fn targets(item: &PaletteItem) -> impl Iterator<Item = &str> {
	let aliases: &[&str] = match &item.kind {
		PaletteItemKind::Command { intent } => match intent.as_ref() {
			Intent::Navigate(route) => route.aliases(),
			_ => &[],
		},
		_ => &[],
	};
	std::iter::once(item.title.as_str())
		.chain(item.subtitle.as_deref())
		.chain(item.group.as_deref())
		.chain(item.search.as_deref())
		.chain(aliases.iter().copied())
}

/// Reorders `ordered` so rows carrying the same heading stay together, in the
/// order their best-ranked row appeared.
///
/// Ranking scatters a provider's models across the list, and a heading drawn
/// once per run of rows would then state the same provider several times.
/// Ungrouped rows keep their ranked order among themselves.
fn regroup(ordered: &[usize], items: &[PaletteItem]) -> Vec<usize> {
	let group = |index: usize| items.get(index).and_then(|item| item.group.as_deref());
	let mut headings: Vec<Option<&str>> = Vec::new();
	for index in ordered {
		let heading = group(*index);
		if !headings.contains(&heading) {
			headings.push(heading);
		}
	}
	if headings.len() < 2 {
		return ordered.to_vec();
	}
	let mut grouped: Vec<usize> = Vec::with_capacity(ordered.len());
	for heading in headings {
		grouped.extend(
			ordered
				.iter()
				.copied()
				.filter(|index| group(*index) == heading),
		);
	}
	grouped
}
