//! Presentation-only projections for the files route.
//!
//! Every label returned here is sliced from host-provided paths or contents.
//! The helpers never read the filesystem and never manufacture file rows.

use std::cmp::Ordering;

use veyyon_gui_core::model::{FileKind, FileNode, FileSearchResult, LineRange};

/// One path component in the selected file header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Crumb<'a> {
	pub label: &'a str,
	pub end:   usize,
}

/// Iterate path components without allocating a second path.
pub fn breadcrumbs(path: &str) -> impl Iterator<Item = Crumb<'_>> {
	path
		.char_indices()
		.filter_map(|(index, character)| (character == '/' || character == '\\').then_some(index))
		.chain(std::iter::once(path.len()))
		.scan(0, move |start, end| {
			let label = &path[*start..end];
			*start = end.saturating_add(1);
			Some((label, end))
		})
		.filter_map(|(label, end)| (!label.is_empty()).then_some(Crumb { label, end }))
}

/// Metadata printed beside a tree row without implying that it can be edited.
pub fn metadata(node: &FileNode) -> String {
	let mut parts = Vec::with_capacity(3);
	match node.kind {
		FileKind::Directory | FileKind::Text | FileKind::Image | FileKind::Other => {},
		FileKind::Binary => parts.push("binary".to_owned()),
		FileKind::Symlink => parts.push("symlink".to_owned()),
	}
	if node.ignored {
		parts.push("ignored".to_owned());
	}
	if let Some(target) = &node.symlink_target {
		parts.push(format!("→ {target}"));
	}
	if let Some(size) = node.size_bytes {
		parts.push(byte_count(size));
	}
	parts.join(" · ")
}

pub fn byte_count(bytes: u64) -> String {
	const KIB: u64 = 1_024;
	const MIB: u64 = KIB * KIB;
	const GIB: u64 = MIB * KIB;
	match bytes {
		0..KIB => format!("{bytes} B"),
		KIB..MIB => format!("{:.1} KiB", bytes as f64 / KIB as f64),
		MIB..GIB => format!("{:.1} MiB", bytes as f64 / MIB as f64),
		_ => format!("{:.1} GiB", bytes as f64 / GIB as f64),
	}
}

/// Fuzzy subsequence rank. Contiguous and path-segment-prefix matches win.
pub fn fuzzy_score(query: &str, candidate: &str) -> Option<i64> {
	if query.is_empty() {
		return Some(0);
	}
	let mut query = query.chars().flat_map(char::to_lowercase);
	let mut wanted = query.next()?;
	let mut score = 0_i64;
	let mut run = 0_i64;
	let mut matched = 0_i64;
	let mut previous_match = false;
	for (index, character) in candidate.chars().flat_map(char::to_lowercase).enumerate() {
		if character != wanted {
			previous_match = false;
			continue;
		}
		matched += 1;
		run = if previous_match { run + 1 } else { 1 };
		score += 16 + run * 7;
		if index == 0
			|| candidate
				.as_bytes()
				.get(index.wrapping_sub(1))
				.is_some_and(|byte| matches!(byte, b'/' | b'\\' | b'-' | b'_' | b'.'))
		{
			score += 24;
		}
		previous_match = true;
		match query.next() {
			Some(next) => wanted = next,
			None => return Some(score - candidate.len() as i64 + matched),
		}
	}
	None
}

/// Host results ordered for display; excerpts remain byte-for-byte host data.
pub fn ranked_results<'a>(
	query: &str,
	results: &'a [FileSearchResult],
) -> Vec<&'a FileSearchResult> {
	let mut ranked: Vec<_> = results
		.iter()
		.filter_map(|result| {
			let path = fuzzy_score(query, &result.path);
			let excerpt = result
				.excerpt
				.as_deref()
				.and_then(|excerpt| fuzzy_score(query, excerpt));
			path
				.into_iter()
				.chain(excerpt)
				.max()
				.map(|score| (score, result))
		})
		.collect();
	ranked.sort_by(|(left_score, left), (right_score, right)| {
		right_score
			.cmp(left_score)
			.then_with(|| left.path.cmp(&right.path))
			.then(Ordering::Equal)
	});
	ranked.into_iter().map(|(_, result)| result).collect()
}

/// Syntax name used by the retained lightweight lexer. Unknown extensions stay
/// plain.
pub fn language<'a>(path: &str, declared: Option<&'a str>) -> Option<&'a str> {
	if let Some(language) = declared.filter(|language| !language.trim().is_empty()) {
		return Some(language);
	}
	let extension = path.rsplit_once('.')?.1;
	Some(match extension.to_ascii_lowercase().as_str() {
		"c" | "h" => "c",
		"cc" | "cpp" | "cxx" | "hpp" => "cpp",
		"go" => "go",
		"js" | "jsx" => "javascript",
		"json" | "jsonl" => "json",
		"md" | "markdown" | "mdx" => "markdown",
		"py" | "pyi" => "python",
		"rs" => "rust",
		"sh" | "bash" | "zsh" => "shell",
		"sql" => "sql",
		"toml" => "toml",
		"ts" | "tsx" => "typescript",
		"yaml" | "yml" => "yaml",
		_ => return None,
	})
}

pub fn normalized_range(range: LineRange, line_count: u32) -> Option<LineRange> {
	if line_count == 0 {
		return None;
	}
	let start = range.start.clamp(1, line_count);
	let end = range.end.clamp(start, line_count);
	Some(LineRange { start, end })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn breadcrumbs_keep_exact_path_slices() {
		let actual: Vec<_> = breadcrumbs("src/files/view.rs")
			.map(|crumb| crumb.label)
			.collect();
		assert_eq!(actual, ["src", "files", "view.rs"]);
	}

	#[test]
	fn fuzzy_rank_rewards_contiguous_segment_prefixes() {
		assert!(
			fuzzy_score("fvp", "files/view/preview.rs") > fuzzy_score("fvp", "features/very_plain.rs")
		);
		assert_eq!(fuzzy_score("xyz", "files.rs"), None);
	}

	#[test]
	fn unknown_language_does_not_imply_syntax_support() {
		assert_eq!(language("notes.proprietary", None), None);
		assert_eq!(language("src/lib.rs", None), Some("rust"));
	}
}
