//! The block model representative sources parse into.

use veyyon_desktop_ui::markdown::{Align, Block, Inlines, MarkdownDoc, RunStyle};

fn para(text: &str) -> Block {
	Block::Paragraph(Inlines::plain(text))
}

/// The style of the run that covers the first occurrence of `needle`.
fn style_of(inlines: &Inlines, needle: &str) -> RunStyle {
	let at = inlines.text.find(needle).unwrap_or_else(|| panic!("{needle:?} is in {:?}", inlines.text));
	let run = inlines
		.runs
		.iter()
		.find(|run| run.range.start <= at && at + needle.len() <= run.range.end)
		.unwrap_or_else(|| panic!("one run covers {needle:?}"));
	run.style.clone()
}

#[test]
fn inline_styles_become_runs_over_one_text() {
	let doc = MarkdownDoc::new(
		"# Title\n\nSome **bold** *it* ~~gone~~ `code` [link](https://example.com/a)\nnext line.\n",
	);
	let [Block::Heading { level: 1, runs: title }, Block::Paragraph(body)] = doc.blocks() else {
		panic!("a heading and a paragraph: {:#?}", doc.blocks());
	};
	assert_eq!(&*title.text, "Title");
	assert_eq!(&*body.text, "Some bold it gone code link next line.");
	assert_eq!(style_of(body, "bold"), RunStyle { bold: true, ..RunStyle::default() });
	assert_eq!(style_of(body, "it"), RunStyle { italic: true, ..RunStyle::default() });
	assert_eq!(style_of(body, "gone"), RunStyle { strike: true, ..RunStyle::default() });
	assert_eq!(style_of(body, "code"), RunStyle { code: true, ..RunStyle::default() });
	assert_eq!(style_of(body, "link").link.as_deref(), Some("https://example.com/a"));
	assert_eq!(style_of(body, "Some"), RunStyle::default());
	let covered: usize = body.runs.iter().map(|run| run.range.len()).sum();
	assert_eq!(covered, body.text.len(), "the runs cover the text end to end");
}

#[test]
fn nested_ordered_and_task_lists_keep_their_structure() {
	let doc = MarkdownDoc::new("3. one\n4. two\n   - [x] done\n   - [ ] open\n");
	let tasks = Block::List {
		ordered: false,
		start:   1,
		items:   vec![
			vec![Block::TaskItem { checked: true }, para("done")],
			vec![Block::TaskItem { checked: false }, para("open")],
		],
	};
	let expected = Block::List {
		ordered: true,
		start:   3,
		items:   vec![vec![para("one")], vec![para("two"), tasks]],
	};
	assert_eq!(doc.blocks(), [expected]);
}

#[test]
fn fences_name_their_language_and_indented_code_has_none() {
	let doc = MarkdownDoc::new("```rust,ignore\nfn main() {}\n```\n\n    indented\n\n```\nbare\n```\n");
	let code = |lang: Option<&str>, code: &str| Block::CodeBlock {
		lang: lang.map(Into::into),
		code: code.into(),
	};
	assert_eq!(doc.blocks(), [
		code(Some("rust"), "fn main() {}"),
		code(None, "indented"),
		code(None, "bare"),
	]);
}

#[test]
fn an_unclosed_fence_holds_the_code_streamed_so_far() {
	let doc = MarkdownDoc::new("```py\nprint(1)\nprint(2");
	assert_eq!(doc.blocks(), [Block::CodeBlock {
		lang: Some("py".into()),
		code: "print(1)\nprint(2".into(),
	}]);
}

#[test]
fn quotes_tables_and_rules_parse_into_their_blocks() {
	let doc = MarkdownDoc::new("> quoted\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |\n\n---\n");
	let cells = |texts: &[&str]| texts.iter().map(|text| Inlines::plain(text)).collect::<Vec<_>>();
	assert_eq!(doc.blocks(), [
		Block::Quote(vec![para("quoted")]),
		Block::Table {
			align: vec![Align::Left, Align::Right],
			head:  cells(&["a", "b"]),
			rows:  vec![cells(&["1", "2"]), cells(&["3", ""])],
		},
		Block::Rule,
	]);
}

#[test]
fn a_reference_link_resolves_to_its_definition() {
	let doc = MarkdownDoc::new("See [the docs].\n\n[the docs]: https://example.com/docs\n");
	let [Block::Paragraph(body)] = doc.blocks() else {
		panic!("one paragraph: {:#?}", doc.blocks());
	};
	assert_eq!(style_of(body, "the docs").link.as_deref(), Some("https://example.com/docs"));
}
