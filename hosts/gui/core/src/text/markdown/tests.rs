//! WHY THIS SUITE EXISTS.
//! This suite verifies the contract and totality of the custom markdown
//! parser for coding agent message transcripts. It defends correct block
//! decomposition (ATX headings, Setext headings, code fences, thematic
//! rules, blockquotes, nested lists, task boxes, tables, paragraphs) and
//! inline parsing (code spans, strong, emphasis, links, images, bare URLs,
//! escapes, word underscores).
//!
//! WHAT IT DOES NOT CATCH.
//! It does not catch rendering or layout bugs inside GPUI element trees
//! consuming these types. It does not validate full CommonMark HTML block
//! parsing or reference-style link definitions.

#[path = "a_streamed_fence_renders_as_the_shape_it_is_becoming.rs"]
mod a_streamed_fence_renders_as_the_shape_it_is_becoming;
mod blocks;
mod inlines;

use super::*;

fn collect_all_non_code_spans(md: &Md, out: &mut String) {
	match md {
		Md::Heading { spans, .. } | Md::Paragraph(spans) => {
			out.push_str(&flatten(spans));
		},
		Md::List(items) => {
			for item in items {
				out.push_str(&flatten(&item.spans));
			}
		},
		Md::Quote(inner) => {
			for sub in inner {
				collect_all_non_code_spans(sub, out);
			}
		},
		Md::Table { head, rows } => {
			for h in head {
				out.push_str(&flatten(h));
			}
			for r in rows {
				for c in r {
					out.push_str(&flatten(c));
				}
			}
		},
		Md::Code { .. } | Md::Rule => {},
	}
}

#[test]
fn adversarial_corpus_property_suite_never_panics_and_preserves_non_marker_characters() {
	let corpus = [
		"",
		"   ",
		"\n\n\n",
		"\r\n\r\n",
		"#",
		"####### more than six hashes",
		"```",
		"~~~",
		"```rust\n",
		"```\n\n\n```",
		">",
		"> > > > nested empty",
		"- \n* \n+ ",
		"1. \n2) ",
		"| | |\n|---|---|\n| |",
		"\\",
		"\\\\\\\\",
		"******",
		"______",
		"foo___bar___baz",
		"日本語のテスト文字列。**太字**と`コード`",
		"Combined mark: e\u{0301} and \u{1F980} emoji",
		"[unclosed",
		"[text](unclosed",
		"![image](",
		"https://",
		"http://",
		"https://example.com/a.b.c.)",
		"text with \t tabs \t\t mixed",
		"- [ ] \n- [x] \n- [X] ",
		"- item 1\n  continuation line\n  another continuation",
		"setext single line\n===",
		"setext two\n--",
		"line 1\nline 2\n===",
		"- item\n---\n* rule",
	];

	assert!(corpus.len() >= 20);

	for input in corpus {
		// Total parser contract: parse must terminate and return without panicking.
		let ast = parse(input);

		let mut flattened_non_code = String::new();
		for block in &ast {
			collect_all_non_code_spans(block, &mut flattened_non_code);
		}

		// For prose inputs where non-marker words exist outside of delimiter syntax,
		// assert that every alphabetic letter in content words is preserved in
		// flattened output.
		let content_words = [
			"more",
			"than",
			"six",
			"hashes",
			"nested",
			"empty",
			"foo",
			"bar",
			"baz",
			"Combined",
			"mark",
			"emoji",
			"unclosed",
			"text",
			"image",
			"tabs",
			"mixed",
			"continuation",
			"another",
			"single",
			"rule",
		];
		for word in content_words {
			if input.contains(word) {
				assert!(
					flattened_non_code.contains(word),
					"Input {:?} lost content word {:?}",
					input,
					word
				);
			}
		}
	}
}
