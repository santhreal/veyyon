//! Cached-source projections used by the plan review overlay.
//!
//! The parser implementations remain in core. This module only selects the
//! blocks the review chrome presents as an outline or a diff.

use veyyon_gui_core::text::{
	diff::{self, FileDiff},
	markdown::{self, Md},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineItem {
	pub level: u8,
	pub label: String,
}

pub fn outline(source: &str) -> Vec<OutlineItem> {
	markdown::parse(source)
		.into_iter()
		.filter_map(|block| match block {
			Md::Heading { level, spans } => {
				Some(OutlineItem { level, label: markdown::flatten(&spans) })
			},
			_ => None,
		})
		.collect()
}

pub fn diffs(source: &str) -> Vec<FileDiff> {
	let mut files = Vec::new();
	for block in markdown::parse(source) {
		let Md::Code { lang, body } = block else {
			continue;
		};
		if lang == "diff" || lang == "patch" || diff::looks_like_a_patch(&body) {
			files.extend(diff::parse(&body));
		}
	}
	files
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn outline_keeps_heading_depth_and_visible_text() {
		let items = outline("# Plan\n\n## First **step**\nbody\n\n### Detail");
		assert_eq!(items, vec![
			OutlineItem { level: 1, label: "Plan".into() },
			OutlineItem { level: 2, label: "First step".into() },
			OutlineItem { level: 3, label: "Detail".into() },
		]);
	}

	#[test]
	fn diff_tab_uses_only_fenced_patch_content() {
		let source = "# Plan\n\n```diff\ndiff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 \
		              @@\n-old\n+new\n```";
		let files = diffs(source);
		assert_eq!(files.len(), 1);
		assert_eq!(files[0].path(), "a.rs");
	}
}
