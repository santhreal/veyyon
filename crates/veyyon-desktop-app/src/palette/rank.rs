//! Ranking: which rows the query keeps, and the order they are drawn in.

use super::{item::Item, matcher::Query};

/// The rows one section lists at most.
pub const SECTION_LIMIT: usize = 50;

/// The indices of `items` the query keeps, in draw order: sections in
/// [`Group`](super::item::Group) order, rows within a section by score, then
/// in the order the sources listed them. An empty query keeps every row in
/// source order.
pub fn rank(items: &[Item], query: &Query) -> Vec<usize> {
	let mut kept: Vec<(usize, i32)> = items
		.iter()
		.enumerate()
		.filter_map(|(ix, item)| query.best(item.targets()).map(|score| (ix, score)))
		.collect();
	kept.sort_by(|(a, a_score), (b, b_score)| {
		items[*a]
			.group
			.cmp(&items[*b].group)
			.then(b_score.cmp(a_score))
			.then(a.cmp(b))
	});
	let mut shown = Vec::with_capacity(kept.len());
	let mut section = None;
	let mut in_section = 0;
	for (ix, _) in kept {
		let group = items[ix].group;
		if section != Some(group) {
			section = Some(group);
			in_section = 0;
		}
		if in_section < SECTION_LIMIT {
			shown.push(ix);
			in_section += 1;
		}
	}
	shown
}

#[cfg(test)]
mod tests {
	use super::{Query, rank};
	use crate::palette::item::{Group, Item, Run};

	fn item(group: Group, label: &str) -> Item {
		Item::new(group, label.to_owned(), Run::Command(String::new()))
	}

	#[test]
	fn sections_keep_their_order_and_rows_rank_by_score_within_one() {
		let items = vec![
			item(Group::Settings, "Themes"),
			item(Group::Commands, "Toggle sidebar"),
			item(Group::Commands, "/theme"),
			item(Group::Threads, "fix the theme loader"),
		];
		let shown = rank(&items, &Query::new("the"));
		assert_eq!(shown, vec![2, 3, 0]);
	}

	#[test]
	fn a_section_lists_at_most_the_limit() {
		let items: Vec<Item> = (0..super::SECTION_LIMIT + 5)
			.map(|n| item(Group::Threads, &format!("t{n}")))
			.collect();
		assert_eq!(rank(&items, &Query::new("")).len(), super::SECTION_LIMIT);
	}
}
