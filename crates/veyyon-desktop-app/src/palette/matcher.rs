//! Subsequence fuzzy scoring with word-boundary and adjacency bonuses.
//!
//! A candidate matches when every query character appears in it in order,
//! ignoring case. Prefixes, word starts and consecutive runs score higher;
//! a match spread over a wide window, and a longer candidate, score lower.

/// A query prepared once per keystroke and scored against many candidates.
pub struct Query {
	chars: Vec<char>,
}

impl Query {
	/// Prepares `text`, trimmed and lower-cased.
	pub fn new(text: &str) -> Self {
		Self { chars: text.trim().chars().flat_map(char::to_lowercase).collect() }
	}

	/// True when the query matches everything with a score of zero.
	pub const fn is_empty(&self) -> bool {
		self.chars.is_empty()
	}

	/// The score of `target`, or `None` when the query is not a subsequence
	/// of it.
	pub fn score(&self, target: &str) -> Option<i32> {
		let Some(&first) = self.chars.first() else {
			return Some(0);
		};
		let mut want = first;
		let mut next = 1;
		let mut score = 0i32;
		let mut run = 0i32;
		let mut first_hit: Option<usize> = None;
		let mut last_hit = 0usize;
		let mut prev: Option<char> = None;
		let mut len = 0usize;
		let mut done = false;
		for (ix, ch) in target.chars().enumerate() {
			len = ix + 1;
			if !done && ch.to_lowercase().eq(std::iter::once(want)) {
				first_hit.get_or_insert(ix);
				last_hit = ix;
				score += 10;
				if ix == 0 {
					score += 30;
				}
				if is_boundary(prev, ch) {
					score += 20;
				}
				score += 15 * run;
				run += 1;
				match self.chars.get(next) {
					Some(&c) => {
						want = c;
						next += 1;
					},
					None => done = true,
				}
			} else {
				run = 0;
			}
			prev = Some(ch);
		}
		if !done {
			return None;
		}
		let wanted = self.chars.len();
		if len == wanted && first_hit == Some(0) && last_hit + 1 == wanted {
			score += 100;
		}
		if let Some(first) = first_hit {
			let span = last_hit - first + 1;
			score -= 2 * saturating_i32(span.saturating_sub(wanted));
		}
		score -= saturating_i32(len.saturating_sub(wanted));
		Some(score)
	}

	/// The best score of any of `targets`.
	pub fn best<'a>(&self, targets: impl IntoIterator<Item = &'a str>) -> Option<i32> {
		targets
			.into_iter()
			.filter_map(|target| self.score(target))
			.max()
	}
}

/// Whether `ch`, preceded by `prev`, starts a word: the first character, one
/// after a separator, or an upper-case letter after a lower-case one.
const fn is_boundary(prev: Option<char>, ch: char) -> bool {
	match prev {
		None => true,
		Some(prev) => {
			matches!(prev, ' ' | '/' | '\\' | '-' | '_' | '.' | ':' | '#')
				|| (prev.is_lowercase() && ch.is_uppercase())
		},
	}
}

fn saturating_i32(value: usize) -> i32 {
	i32::try_from(value).unwrap_or(i32::MAX)
}

#[cfg(test)]
mod tests {
	use super::Query;

	fn score(query: &str, target: &str) -> Option<i32> {
		Query::new(query).score(target)
	}

	#[test]
	fn an_empty_query_matches_everything_at_zero() {
		assert_eq!(score("", "anything"), Some(0));
		assert_eq!(score("  ", ""), Some(0));
	}

	#[test]
	fn a_query_out_of_order_does_not_match() {
		assert_eq!(score("abc", "acb"), None);
		assert_eq!(score("xyz", "hello world"), None);
		assert_eq!(score("long", "lon"), None);
	}

	#[test]
	fn a_word_start_outranks_a_mid_word_hit() {
		assert!(score("fb", "foo_bar") > score("fb", "freebird"));
		assert!(score("ts", "Toggle Sidebar") > score("ts", "Tests"));
	}

	#[test]
	fn an_exact_match_outranks_a_longer_candidate() {
		assert!(score("open", "open") > score("open", "open session"));
		assert!(score("OPEN", "open") > score("open", "open session"));
	}

	#[test]
	fn matching_ignores_case() {
		assert!(score("SIDE", "toggle sidebar").is_some());
		assert!(score("side", "Toggle SIDEBAR").is_some());
	}
}
