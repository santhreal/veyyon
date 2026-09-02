//! Subsequence fuzzy scoring with word-boundary and adjacency bonuses (§5.8).
//!
//! Ranks candidates deterministically by match quality: exact prefixes,
//! word starts, and consecutive matching runs receive bonuses. Equal scores
//! preserve original insertion order.

/// Evaluates whether `query` is a subsequence of `target` and computes a match
/// score.
///
/// Returns `None` if `query` characters do not appear in `target` in order.
/// An empty query matches every target with a score of zero.
#[must_use]
pub fn fuzzy_score(query: &str, target: &str) -> Option<i32> {
	if query.is_empty() {
		return Some(0);
	}

	let q_lower: Vec<char> = query.to_lowercase().chars().collect();
	let t_chars: Vec<char> = target.chars().collect();
	let t_lower: Vec<char> = target.to_lowercase().chars().collect();

	if q_lower.len() > t_lower.len() {
		return None;
	}

	let mut q_idx = 0;
	let mut t_idx = 0;
	let mut score = 0i32;
	let mut consecutive_matches = 0i32;
	let mut first_match_idx: Option<usize> = None;
	let mut last_match_idx = 0usize;

	while q_idx < q_lower.len() && t_idx < t_lower.len() {
		if q_lower[q_idx] == t_lower[t_idx] {
			if first_match_idx.is_none() {
				first_match_idx = Some(t_idx);
			}
			last_match_idx = t_idx;

			// Base character match score.
			score += 10;

			// Prefix bonus: matches starting at index 0.
			if t_idx == 0 {
				score += 30;
			}

			// Word boundary bonus: character following delimiter or uppercase transition.
			if is_word_boundary(&t_chars, t_idx) {
				score += 20;
			}

			// Adjacency bonus for consecutive matching characters.
			if consecutive_matches > 0 {
				score += 15 * consecutive_matches;
			}
			consecutive_matches += 1;

			q_idx += 1;
		} else {
			consecutive_matches = 0;
		}
		t_idx += 1;
	}

	if q_idx < q_lower.len() {
		return None;
	}

	// Exact match bonus.
	if query.eq_ignore_ascii_case(target) {
		score += 100;
	}

	// Span penalty: penalise matches spread across a wide window.
	if let Some(first) = first_match_idx {
		let span = (last_match_idx - first + 1) as i32;
		let extra_span = span.saturating_sub(q_lower.len() as i32);
		score -= extra_span * 2;
	}

	// Length penalty: prefer shorter candidates on equivalent match spans.
	let length_delta = (t_lower.len() - q_lower.len()) as i32;
	score -= length_delta;

	Some(score)
}

/// Determines if the character at `idx` in `chars` represents a word start
/// boundary.
const fn is_word_boundary(chars: &[char], idx: usize) -> bool {
	if idx == 0 {
		return true;
	}

	let prev = chars[idx - 1];
	let curr = chars[idx];

	// Separator boundaries: space, slash, backslash, dash, underscore, dot, colon.
	if matches!(prev, ' ' | '/' | '\\' | '-' | '_' | '.' | ':' | '#') {
		return true;
	}

	// CamelCase boundary: lowercase followed by uppercase.
	if prev.is_lowercase() && curr.is_uppercase() {
		return true;
	}

	false
}

/// Ranks a slice of candidate items against a query string using fuzzy scoring.
///
/// Returns a vector of tuples `(original_index, score, &item)` sorted by
/// descending score with ties broken by original index order.
pub fn fuzzy_rank<'a, T, F>(
	query: &str,
	items: &'a [T],
	extract_target: F,
) -> Vec<(usize, i32, &'a T)>
where
	F: Fn(&T) -> &str,
{
	let mut scored: Vec<(usize, i32, &'a T)> = items
		.iter()
		.enumerate()
		.filter_map(|(idx, item)| {
			let target = extract_target(item);
			fuzzy_score(query, target).map(|score| (idx, score, item))
		})
		.collect();

	// Stable sort by score descending; ties retain their original index order.
	scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
	scored
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn empty_query_matches_all_targets() {
		assert_eq!(fuzzy_score("", "anything"), Some(0));
		assert_eq!(fuzzy_score("", ""), Some(0));
	}

	#[test]
	fn non_subsequence_returns_none() {
		assert_eq!(fuzzy_score("abc", "acb"), None);
		assert_eq!(fuzzy_score("xyz", "hello world"), None);
	}

	#[test]
	fn word_boundary_outranks_mid_word_matches() {
		let score_boundary = fuzzy_score("fb", "foo_bar").unwrap_or(0);
		let score_mid = fuzzy_score("fb", "freebird").unwrap_or(0);
		assert!(
			score_boundary > score_mid,
			"word boundary score {score_boundary} should exceed mid-word score {score_mid}"
		);
	}

	#[test]
	fn exact_match_outranks_longer_superstring() {
		let score_exact = fuzzy_score("open", "open").unwrap_or(0);
		let score_longer = fuzzy_score("open", "open_session").unwrap_or(0);
		assert!(
			score_exact > score_longer,
			"exact match score {score_exact} should exceed partial score {score_longer}"
		);
	}

	#[test]
	fn ranks_ties_by_original_order() {
		let items = vec!["alpha", "beta", "alpine"];
		let ranked = fuzzy_rank("al", &items, |s| s);
		assert_eq!(ranked.len(), 2);
		assert_eq!(*ranked[0].2, "alpha");
		assert_eq!(*ranked[1].2, "alpine");
	}
}
