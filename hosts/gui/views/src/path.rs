//! Shortening a path for display.
//!
//! A view kind carries the path a tool saw, whole, because a shortened path
//! cannot be opened. Shortening is the host's job, and doing it at each call
//! site gives one kind a home-relative path and the next an absolute one.

/// The path as it is drawn.
///
/// Two rewrites, in this order: a leading home directory becomes `~`, and a
/// path longer than `budget` segments keeps its first segment and its last
/// `budget - 1`, with the middle elided. A path is read from both ends — the
/// project it is in, and the file it is — so eliding the middle is what keeps
/// both.
pub fn shorten(path: &str, home: Option<&str>, budget: usize) -> String {
	let path = strip_home(path, home);
	elide(&path, budget)
}

/// A leading home directory replaced by `~`.
///
/// Matched on a segment boundary: `/home/other` does not begin with `/home/o`
/// even though the bytes do, and a home of `/` never swallows the whole path.
fn strip_home(path: &str, home: Option<&str>) -> String {
	let Some(home) = home.map(|home| home.trim_end_matches('/')) else {
		return path.to_owned();
	};
	if home.is_empty() {
		return path.to_owned();
	}
	if path == home {
		return "~".to_owned();
	}
	match path.strip_prefix(home) {
		Some(rest) if rest.starts_with('/') => format!("~{rest}"),
		_ => path.to_owned(),
	}
}

/// The middle segments replaced by an ellipsis when there are more than
/// `budget`.
///
/// `budget` counts the segments kept. Below two there is nothing to elide
/// between, so the path is returned whole rather than reduced to an ellipsis.
fn elide(path: &str, budget: usize) -> String {
	if budget < 2 {
		return path.to_owned();
	}
	let segments: Vec<&str> = path.split('/').collect();
	if segments.len() <= budget {
		return path.to_owned();
	}
	let tail = segments.len() - (budget - 1);
	let mut out = String::with_capacity(path.len());
	out.push_str(segments[0]);
	out.push_str("/…");
	for segment in &segments[tail..] {
		out.push('/');
		out.push_str(segment);
	}
	out
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A path is the value most likely to leak an operator's home directory into
	//! a screenshot, and the shortening that prevents it is a prefix match — the
	//! kind that silently swallows a sibling directory whose name starts the
	//! same way. Eliding the middle is the other half: a truncation from the
	//! left loses the project and a truncation from the right loses the file,
	//! and either reads as a path that does not exist.
	//!
	//! WHAT IT DOES NOT CATCH. Width. A shortened path can still be wider than
	//! the column it is drawn in, which is the renderer's own truncation.

	use super::*;

	const HOME: Option<&str> = Some("/home/dev");

	#[test]
	fn a_path_under_home_is_drawn_relative_to_it() {
		assert_eq!(shorten("/home/dev/veyyon/README.md", HOME, 8), "~/veyyon/README.md");
		assert_eq!(shorten("/home/dev", HOME, 8), "~");
	}

	#[test]
	fn a_sibling_of_home_keeps_its_own_path() {
		assert_eq!(shorten("/home/developer/veyyon", HOME, 8), "/home/developer/veyyon");
		assert_eq!(shorten("/home/dev2", HOME, 8), "/home/dev2");
	}

	#[test]
	fn a_relative_path_is_left_alone() {
		assert_eq!(shorten("hosts/gui/views/src/lib.rs", HOME, 8), "hosts/gui/views/src/lib.rs");
		assert_eq!(shorten("lib.rs", HOME, 8), "lib.rs");
		assert_eq!(shorten("", HOME, 8), "");
	}

	#[test]
	fn a_root_home_never_swallows_the_path() {
		assert_eq!(shorten("/usr/lib/x.so", Some("/"), 8), "/usr/lib/x.so");
		assert_eq!(shorten("/usr/lib/x.so", Some(""), 8), "/usr/lib/x.so");
		assert_eq!(shorten("/usr/lib/x.so", None, 8), "/usr/lib/x.so");
	}

	#[test]
	fn a_long_path_keeps_its_first_and_last_segments() {
		assert_eq!(
			shorten("hosts/gui/contract/src/fixtures/routes.rs", None, 3),
			"hosts/…/fixtures/routes.rs"
		);
	}

	#[test]
	fn a_budget_too_small_to_elide_between_returns_the_path_whole() {
		let path = "hosts/gui/contract/src/lib.rs";
		assert_eq!(shorten(path, None, 1), path);
		assert_eq!(shorten(path, None, 0), path);
	}

	#[test]
	fn a_path_within_budget_is_not_elided() {
		assert_eq!(shorten("hosts/gui/lib.rs", None, 3), "hosts/gui/lib.rs");
	}
}
