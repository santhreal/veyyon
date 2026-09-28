//! A document built by appending deltas equals a full parse of the same
//! source, at every prefix and for every delta size.
//!
//! The corpus covers the constructs whose meaning a later line changes:
//! setext underlines, lazy continuation, loose lists, fences opened and closed
//! across deltas, table delimiter rows, and link reference definitions that
//! follow the links naming them.

use veyyon_desktop_ui::markdown::MarkdownDoc;

const CORPUS: &[&str] = &[
	"# Heading\n\nA paragraph that grows\nover two lines.\n\nSetext heading\n---\n\nTail\n===\n",
	"- one\n- two\n  - nested *emph*\n  - [x] task\n\n1. first\n2. second\n\n   continued paragraph\n",
	"Intro\n\n```rust\nfn main() {\n    println!(\"hi\");\n}\n```\n\nAfter the fence.\n",
	"| a | b |\n|---|:-:|\n| 1 | **2** |\n| 3 | `4` |\n\nText after\n",
	"> quote\n> more\nlazy line\n>\n> - list in quote\n\n***\n\nfinal ~~strike~~ [link](https://example.com)\n",
	"    indented code\n\n    more code\n\nparagraph\n<div>\nhtml block\n</div>\n\nafter html\n",
	"See [later] and [later][].\n\nMore text.\n\n[later]: https://example.com/later\n\nAgain [later].\n",
	"Line one  \nhard break\\\nand ``tick ` text``\n\n````md\n```\nnested fence\n```\n````\n",
	"1) paren list\n2) second\n\n- a\n\n- loose b\n\n  para in b\n",
	"Title\n===\n\ntext then list\n- item after paragraph\n+ other bullet\n\n2. not a list start\n",
	"a | b\n--|--\nc | d\ne\n\n~~~\ntilde fence\n~~~\n\n* [ ] todo\n* [x] done\n",
	"para\n#foo bar\n\npara\n***x\n\npara\n---x\n\n> quote\n#lazy\n\n- item\n#lazy too\n",
	"| h | i |\n|---|---|\n|\n| r1 | x\n|x|y|\n\npara\n| not | table |\n",
	"text\n<di\n\n- a\n\n  b\n\n    code\n\n  c\n1.5 apples\n",
];

/// Splits `source` into deltas of `size` bytes, widened to char boundaries.
fn deltas(source: &str, size: usize) -> Vec<&str> {
	let mut out = Vec::new();
	let mut from = 0;
	while from < source.len() {
		let mut to = (from + size).min(source.len());
		while !source.is_char_boundary(to) {
			to += 1;
		}
		out.push(&source[from..to]);
		from = to;
	}
	out
}

#[test]
fn every_prefix_streamed_a_char_at_a_time_equals_a_full_parse() {
	for source in CORPUS {
		let mut streamed = MarkdownDoc::default();
		let mut end = 0;
		for delta in deltas(source, 1) {
			streamed.append(delta);
			end += delta.len();
			let full = MarkdownDoc::new(&source[..end]);
			assert_eq!(streamed.blocks(), full.blocks(), "prefix {:?}", &source[..end]);
		}
	}
}

#[test]
fn every_delta_size_converges_on_the_full_parse() {
	for source in CORPUS {
		let full = MarkdownDoc::new(*source);
		for size in [2, 3, 7, 16, 64] {
			let mut streamed = MarkdownDoc::new("");
			for delta in deltas(source, size) {
				streamed.append(delta);
			}
			assert_eq!(streamed.source(), *source);
			assert_eq!(streamed.blocks(), full.blocks(), "delta size {size} of {source:?}");
		}
	}
}

#[test]
fn set_source_replaces_the_document_and_streaming_resumes_after_it() {
	let mut doc = MarkdownDoc::new("# Old\n\nold text\n");
	doc.set_source("```\nfresh");
	doc.append(" code\n```\n\nnew ");
	doc.append("text\n");
	assert_eq!(doc.blocks(), MarkdownDoc::new("```\nfresh code\n```\n\nnew text\n").blocks());
}

#[test]
fn multibyte_text_streams_without_splitting_a_char() {
	let source = "## Überschrift ✓\n\n- naïve café — 日本語\n- emoji 🦀 crab\n";
	let mut doc = MarkdownDoc::default();
	for delta in deltas(source, 1) {
		doc.append(delta);
	}
	assert_eq!(doc.blocks(), MarkdownDoc::new(source).blocks());
}
