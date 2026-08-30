//! WHY THIS SUITE EXISTS.
//! One test per block kind in isolation, then the combinations that have
//! broken this shape of parser before: a fence inside a list item, a fence
//! that never closes, a fence whose body looks like every other construct, a
//! two-level list, an ordered list that does not start at one, and a table
//! with a missing cell and an escaped pipe.
//!
//! WHAT IT DOES NOT CATCH. Inline structure inside a block, which is the
//! sibling suite, and anything about how a block is drawn.

use crate::text::markdown::*;

#[test]
fn atx_heading_block_in_isolation() {
	let ast = parse("# Level 1 Heading");
	assert_eq!(ast, vec![Md::Heading {
		level: 1,
		spans: vec![Span::Plain("Level 1 Heading".to_string())],
	}]);
}

#[test]
fn setext_heading_level_one_and_two() {
	let ast1 = parse("Title One\n===");
	assert_eq!(ast1, vec![Md::Heading {
		level: 1,
		spans: vec![Span::Plain("Title One".to_string())],
	}]);

	let ast2 = parse("Title Two\n---");
	assert_eq!(ast2, vec![Md::Heading {
		level: 2,
		spans: vec![Span::Plain("Title Two".to_string())],
	}]);
}

#[test]
fn paragraph_block_in_isolation() {
	let ast = parse("Hello world.\nThis is on a second line.");
	assert_eq!(ast, vec![Md::Paragraph(vec![Span::Plain(
		"Hello world. This is on a second line.".to_string()
	)])]);
}

#[test]
fn list_block_in_isolation() {
	let ast = parse("- item one\n- item two");
	assert_eq!(ast, vec![Md::List(vec![
		Item {
			kind:  ListKind::Bullet,
			depth: 0,
			spans: vec![Span::Plain("item one".to_string())],
			done:  None,
		},
		Item {
			kind:  ListKind::Bullet,
			depth: 0,
			spans: vec![Span::Plain("item two".to_string())],
			done:  None,
		},
	])]);
}

#[test]
fn quote_block_in_isolation() {
	let ast = parse("> quote line 1\n> quote line 2");
	assert_eq!(ast, vec![Md::Quote(vec![Md::Paragraph(vec![Span::Plain(
		"quote line 1 quote line 2".to_string()
	)])])]);
}

#[test]
fn code_block_in_isolation() {
	let ast = parse("```rust\nfn main() {}\n```");
	assert_eq!(ast, vec![Md::Code { lang: "rust".to_string(), body: "fn main() {}".to_string() }]);
}

#[test]
fn rule_block_in_isolation() {
	let ast = parse("---");
	assert_eq!(ast, vec![Md::Rule]);

	let ast2 = parse("* * *");
	assert_eq!(ast2, vec![Md::Rule]);

	let ast3 = parse("___");
	assert_eq!(ast3, vec![Md::Rule]);
}

#[test]
fn table_block_in_isolation() {
	let text = "| A | B |\n|---|---|\n| 1 | 2 |";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::Table {
		head: vec![vec![Span::Plain("A".to_string())], vec![Span::Plain("B".to_string())],],
		rows: vec![vec![vec![Span::Plain("1".to_string())], vec![Span::Plain("2".to_string())],]],
	}]);
}

#[test]
fn a_fence_inside_a_list_item() {
	let ast = parse("- item with ```inline fence``` text");
	assert_eq!(ast, vec![Md::List(vec![Item {
		kind:  ListKind::Bullet,
		depth: 0,
		spans: vec![
			Span::Plain("item with ".to_string()),
			Span::Code("inline fence".to_string()),
			Span::Plain(" text".to_string()),
		],
		done:  None,
	}])]);
}

#[test]
fn an_unclosed_fence_runs_to_the_end_of_the_message() {
	let text = "```python\ndef run():\n    return 42";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::Code {
		lang: "python".to_string(),
		body: "def run():\n    return 42".to_string(),
	}]);
}

#[test]
fn a_fence_whose_body_contains_hash_dash_and_pipe_does_not_become_blocks() {
	let text = "```\n# Heading inside\n---\n| col1 | col2 |\n```";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::Code {
		lang: "".to_string(),
		body: "# Heading inside\n---\n| col1 | col2 |".to_string(),
	}]);
}

#[test]
fn a_heading_with_inline_code() {
	let ast = parse("## Run `cargo check` now ##");
	assert_eq!(ast, vec![Md::Heading {
		level: 2,
		spans: vec![
			Span::Plain("Run ".to_string()),
			Span::Code("cargo check".to_string()),
			Span::Plain(" now".to_string()),
		],
	}]);
}

#[test]
fn nested_quotes() {
	let text = "> outer quote\n> > inner quote";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::Quote(vec![
		Md::Paragraph(vec![Span::Plain("outer quote".to_string())]),
		Md::Quote(vec![Md::Paragraph(vec![Span::Plain("inner quote".to_string())])]),
	])]);
}

#[test]
fn a_two_level_list() {
	let text = "- top level\n  - sub level\n    - deep level";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::List(vec![
		Item {
			kind:  ListKind::Bullet,
			depth: 0,
			spans: vec![Span::Plain("top level".to_string())],
			done:  None,
		},
		Item {
			kind:  ListKind::Bullet,
			depth: 1,
			spans: vec![Span::Plain("sub level".to_string())],
			done:  None,
		},
		Item {
			kind:  ListKind::Bullet,
			depth: 2,
			spans: vec![Span::Plain("deep level".to_string())],
			done:  None,
		},
	])]);
}

#[test]
fn an_ordered_list_starting_at_seven() {
	let text = "7. seventh step\n8. eighth step";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::List(vec![
		Item {
			kind:  ListKind::Ordered(7),
			depth: 0,
			spans: vec![Span::Plain("seventh step".to_string())],
			done:  None,
		},
		Item {
			kind:  ListKind::Ordered(8),
			depth: 0,
			spans: vec![Span::Plain("eighth step".to_string())],
			done:  None,
		},
	])]);
}

#[test]
fn task_boxes_both_states() {
	let text = "- [ ] unchecked task\n- [x] checked task lowercase\n- [X] checked task uppercase";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::List(vec![
		Item {
			kind:  ListKind::Bullet,
			depth: 0,
			spans: vec![Span::Plain("unchecked task".to_string())],
			done:  Some(false),
		},
		Item {
			kind:  ListKind::Bullet,
			depth: 0,
			spans: vec![Span::Plain("checked task lowercase".to_string())],
			done:  Some(true),
		},
		Item {
			kind:  ListKind::Bullet,
			depth: 0,
			spans: vec![Span::Plain("checked task uppercase".to_string())],
			done:  Some(true),
		},
	])]);
}

#[test]
fn a_table_with_a_missing_cell_and_an_escaped_pipe_in_a_cell() {
	let text = "| Name | Value | Description |\n|---|---|---|\n| alpha \\| key | 10 |\n| beta | 20 \
	            | extra details |";
	let ast = parse(text);
	assert_eq!(ast, vec![Md::Table {
		head: vec![
			vec![Span::Plain("Name".to_string())],
			vec![Span::Plain("Value".to_string())],
			vec![Span::Plain("Description".to_string())],
		],
		rows: vec![
			vec![
				vec![Span::Plain("alpha | key".to_string())],
				vec![Span::Plain("10".to_string())],
				vec![],
			],
			vec![vec![Span::Plain("beta".to_string())], vec![Span::Plain("20".to_string())], vec![
				Span::Plain("extra details".to_string())
			],],
		],
	}]);
}
