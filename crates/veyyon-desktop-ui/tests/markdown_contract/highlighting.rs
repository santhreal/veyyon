//! Highlighting maps a fence's language onto the palette's syntax roles.

use veyyon_desktop_ui::{
	markdown::{SyntaxRole, cached, highlight, resolve_language},
	theme::{Appearance, Theme},
};

const RUST: &str = "fn main() {\n    let answer: u32 = 42; // comment\n    println!(\"{answer}\");\n}";

#[test]
fn a_rust_fence_draws_fn_in_the_keyword_color() {
	let Ok(theme) = Theme::embedded(Appearance::Dark) else {
		panic!("the dark palette parses");
	};
	let highlighted = highlight(RUST, Some("rust"));
	let role = highlighted.role_at(0);
	assert_eq!(role, Some(SyntaxRole::Keyword), "spans: {:?}", highlighted.spans());
	assert_eq!(role.map(|role| role.color(&theme.palette.syntax)), Some(theme.palette.syntax.keyword));
	let at = |needle: &str| RUST.find(needle).and_then(|offset| highlighted.role_at(offset));
	assert_eq!(at("42"), Some(SyntaxRole::Number));
	assert_eq!(at("// comment"), Some(SyntaxRole::Comment));
	assert_eq!(at("\"{answer}\""), Some(SyntaxRole::String));
}

#[test]
fn a_language_resolves_by_extension_or_name_in_any_case() {
	for tag in ["rust", "RUST", "rs", "Rs", " rust "] {
		assert_eq!(resolve_language(tag), Some("Rust"), "{tag:?}");
	}
	assert_eq!(resolve_language("python"), resolve_language("py"));
	assert_eq!(resolve_language("ts"), Some("JavaScript"));
	for tag in ["klingon", "", "text", "plain"] {
		assert_eq!(resolve_language(tag), None, "{tag:?}");
	}
	assert_eq!(highlight(RUST, Some("RS")).spans(), highlight(RUST, Some("rust")).spans());
}

#[test]
fn an_unknown_or_absent_language_highlights_nothing() {
	assert!(highlight(RUST, Some("klingon")).spans().is_empty());
	assert!(highlight(RUST, None).spans().is_empty());
}

#[test]
fn spans_are_ordered_disjoint_and_on_char_boundaries() {
	let code = "let s = \"日本語 ✓\"; // 🦀\nlet n = 1;";
	let highlighted = highlight(code, Some("rust"));
	let mut end = 0;
	for (range, _) in highlighted.spans() {
		assert!(end <= range.start && range.start < range.end && range.end <= code.len(), "{range:?}");
		assert!(code.is_char_boundary(range.start) && code.is_char_boundary(range.end), "{range:?}");
		end = range.end;
	}
}

/// A grown code block resumes after the last complete line of the shorter
/// version and ends with the spans a fresh parse produces.
#[test]
fn a_growing_code_block_reparses_only_after_its_last_complete_line() {
	let mut full = String::new();
	for i in 0..120 {
		full.push_str(&line(i));
	}
	let first = &full[..full.len() / 3];
	let second = &full[..full.len() * 2 / 3];
	let complete = |code: &str| code.rfind('\n').map_or(0, |newline| newline + 1);

	assert_eq!(highlight(first, Some("rust")).resumed_at(), 0);
	let grown = highlight(second, Some("rust"));
	assert_eq!(grown.resumed_at(), complete(first));

	// Evict every cached result and parser state, then parse `second` fresh.
	for i in 0..96 {
		highlight(&format!("let evict_{i} = {i};\n"), Some("rust"));
	}
	let fresh = highlight(second, Some("rust"));
	assert_eq!(fresh.resumed_at(), 0, "the cache no longer holds a prefix of `second`");
	assert_eq!(grown.spans(), fresh.spans());
}

fn line(i: usize) -> String {
	format!("fn grow_{i}(x: u32) -> u32 {{ x + {i} }}\n")
}

#[test]
fn a_cache_lookup_misses_until_the_code_is_highlighted_and_never_parses() {
	let code = "let looked_up_only = 1;\nlet then_parsed = 2;";
	assert_eq!(cached(code, Some("rust")), None);
	assert_eq!(cached(code, Some("rust")), None, "a lookup stored a result");
	let parsed = highlight(code, Some("rust"));
	assert_eq!(cached(code, Some("rs")).as_deref(), Some(&*parsed));
	assert_eq!(cached(code, Some("python")), None, "the language is part of the key");
	for lang in [None, Some("klingon")] {
		assert_eq!(cached(code, lang).map(|plain| plain.spans().is_empty()), Some(true), "{lang:?}");
	}
}
