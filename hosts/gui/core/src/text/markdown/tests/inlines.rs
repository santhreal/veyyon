//! WHY THIS SUITE EXISTS.
//! Every inline rule, and for each one the half-written form a streaming
//! message produces: an unclosed marker is the literal character, a bare URL
//! is a link, an underscore inside a word is an underscore. A parser that
//! turns half a message into italics is one a reader watches flicker.
//!
//! WHAT IT DOES NOT CATCH. Block structure, which is the sibling suite.

use crate::text::markdown::*;

#[test]
fn every_inline_rule_including_literal_on_unclosed_and_snake_case() {
	// Strong and Emphasis
	assert_eq!(inline("**strong** and *emphasis* and ***both***"), vec![
		Span::Strong("strong".to_string()),
		Span::Plain(" and ".to_string()),
		Span::Emphasis("emphasis".to_string()),
		Span::Plain(" and ".to_string()),
		Span::Strong("both".to_string()),
	]);

	// Snake case staying plain
	assert_eq!(inline("foo_bar_baz is a snake_case_identifier"), vec![Span::Plain(
		"foo_bar_baz is a snake_case_identifier".to_string()
	)]);

	// Unclosed markers are literal
	assert_eq!(inline("An unclosed *star and unclosed `code and unclosed [bracket"), vec![
		Span::Plain("An unclosed *star and unclosed `code and unclosed [bracket".to_string())
	]);

	// Backslash escapes
	assert_eq!(inline(r"\*literal star\* and \`backtick\` and \|pipe\|"), vec![Span::Plain(
		"*literal star* and `backtick` and |pipe|".to_string()
	)]);

	// Links and images
	assert_eq!(
		inline("[my link](https://example.com/path(1)) and ![alt text](https://example.com/img.png)"),
		vec![
			Span::Link {
				text: "my link".to_string(),
				href: "https://example.com/path(1)".to_string(),
			},
			Span::Plain(" and ".to_string()),
			Span::Link {
				text: "alt text".to_string(),
				href: "https://example.com/img.png".to_string(),
			},
		]
	);

	// Bare URLs
	assert_eq!(inline("Visit https://example.com/docs, ok?"), vec![
		Span::Plain("Visit ".to_string()),
		Span::Link {
			text: "https://example.com/docs".to_string(),
			href: "https://example.com/docs".to_string(),
		},
		Span::Plain(", ok?".to_string()),
	]);
}

#[test]
fn flatten_round_trips_plain_text_unchanged() {
	let text = "The quick brown fox jumps over the lazy dog.";
	let spans = inline(text);
	assert_eq!(flatten(&spans), text);
}

#[test]
fn fenced_code_leading_indentation_is_stripped_from_body_lines() {
	let text = "  ```rust\n    fn main() {\n      println!(\"hi\");\n    }\n  ```";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::Code {
		lang: "rust".to_string(),
		body: "  fn main() {\n    println!(\"hi\");\n  }".to_string(),
	}]);
}

#[test]
fn list_continuation_lines_append_with_single_space() {
	let text = "- First line of item\n  second line of item\n  third line of item";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::List(vec![Item {
		kind:  ListKind::Bullet,
		depth: 0,
		spans: vec![Span::Plain(
			"First line of item second line of item third line of item".to_string()
		)],
		done:  None,
	}])]);
}

#[test]
fn table_without_outer_edge_pipes() {
	let text = "Col 1 | Col 2\n---|---\nVal 1 | Val 2";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::Table {
		head: vec![vec![Span::Plain("Col 1".to_string())], vec![Span::Plain("Col 2".to_string())],],
		rows: vec![vec![vec![Span::Plain("Val 1".to_string())], vec![Span::Plain(
			"Val 2".to_string()
		)],]],
	}]);
}

#[test]
fn code_span_surrounding_space_stripping_rules() {
	assert_eq!(inline("` foo `"), vec![Span::Code("foo".to_string())]);
	assert_eq!(inline("` `"), vec![Span::Code(" ".to_string())]);
	assert_eq!(inline("`  `"), vec![Span::Code("".to_string())]);
	assert_eq!(inline("` foo`"), vec![Span::Code(" foo".to_string())]);
	assert_eq!(inline("`foo `"), vec![Span::Code("foo ".to_string())]);
}
