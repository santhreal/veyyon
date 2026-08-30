//! WHY THIS SUITE EXISTS.
//!
//! Every renderer here turns parsed content into styled ranges over one string,
//! and a range that is wrong by one byte is the defect this closes. It has two
//! shapes, both of which reach a reader rather than a test:
//!
//! - A range that starts or ends inside a multi-byte character. The text system
//!   asserts on it in a debug build, so the window dies on a message with an
//!   emoji in it; a release build styles the wrong run instead.
//! - A range that covers different text than the span it came from, so the bold
//!   is around the wrong words. Nothing crashes, and it is only visible to
//!   somebody looking at the frame.
//!
//! The corpus is deliberately hostile in the one dimension that matters: CJK,
//! emoji outside the basic plane, and a combining mark, in every span kind,
//! since a per-kind offset bug is exactly what a single-kind test misses.
//!
//! WHAT IT DOES NOT CATCH. Anything about the drawing: sizes, colours, wrapping
//! and hit testing need a window and a font, and the capture pass covers them.

use veyyon_gui_core::text::{
	markdown::{self, Md, Span},
	syntax,
};
use veyyon_gui_kit::theme::Theme;

use super::markdown as render;

/// Text that has broken every offset bug in this file at least once.
const AWKWARD: &str = "漢字 👨‍👩‍👧 e\u{0301}nd";

fn theme() -> Theme {
	Theme::of(veyyon_gui_core::store::model::Appearance::Dark)
}

/// One span of every kind, each carrying awkward text.
fn every_kind() -> Vec<Span> {
	vec![
		Span::Plain(format!("plain {AWKWARD} ")),
		Span::Strong(format!("strong {AWKWARD} ")),
		Span::Emphasis(format!("emphasis {AWKWARD} ")),
		Span::Code(format!("code {AWKWARD} ")),
		Span::Link { text: format!("link {AWKWARD}"), href: "https://example.invalid".to_owned() },
	]
}

#[test]
fn every_styled_range_starts_and_ends_on_a_character_boundary() {
	let (body, styles) = render::styled(&every_kind(), &theme());
	for (range, _) in &styles {
		assert!(
			body.is_char_boundary(range.start),
			"a run starts inside a character at {} of {body:?}",
			range.start
		);
		assert!(body.is_char_boundary(range.end), "a run ends inside a character at {}", range.end);
		assert!(range.end <= body.len(), "a run runs past the end of the text");
	}
}

#[test]
fn a_styled_range_covers_the_text_its_span_carried() {
	// The bug this catches styles the right number of bytes at the wrong offset,
	// which draws bold around the words next to the bold ones.
	let spans = every_kind();
	let (body, styles) = render::styled(&spans, &theme());
	let styled_texts: Vec<&str> = styles
		.iter()
		.map(|(range, _)| &body[range.clone()])
		.collect();
	assert_eq!(styled_texts, vec![
		format!("strong {AWKWARD} "),
		format!("emphasis {AWKWARD} "),
		format!("code {AWKWARD} "),
		format!("link {AWKWARD}"),
	]);
}

#[test]
fn plain_text_carries_no_style_of_its_own() {
	// Four styled runs for five spans: a style over plain text would override
	// the element's own colour and size, which is how a paragraph ends up in the
	// accent colour.
	let (_, styles) = render::styled(&every_kind(), &theme());
	assert_eq!(styles.len(), 4);
}

#[test]
fn a_link_prints_what_the_writer_wrote_and_never_the_url() {
	let spans = vec![Span::Link {
		text: "the handbook".to_owned(),
		href: "https://veyyon.invalid/handbook".to_owned(),
	}];
	let (body, styles) = render::styled(&spans, &theme());
	assert_eq!(body, "the handbook");
	assert!(!body.contains("://"), "a raw url reached the line: {body:?}");
	assert_eq!(styles.len(), 1);
	assert!(styles[0].1.underline.is_some(), "a link that is not underlined is prose");
}

#[test]
fn an_empty_run_of_spans_is_an_empty_line_rather_than_a_panic() {
	// Reachable: a paragraph of only a stripped-out construct.
	let (body, styles) = render::styled(&[], &theme());
	assert!(body.is_empty());
	assert!(styles.is_empty());
}

#[test]
fn a_message_of_awkward_text_survives_the_whole_parse_and_style_path() {
	// The end-to-end version: whatever the parser produces, every run it leads
	// to lands on a boundary. This is the test that would have caught an offset
	// bug in the parser rather than in this file.
	let source = format!(
		"# {AWKWARD}\n\nprose **{AWKWARD}** and `{AWKWARD}` and [{AWKWARD}](https://x.invalid)\n\n- \
		 item {AWKWARD}\n- [x] done {AWKWARD}\n\n> quoted {AWKWARD}\n\n| a | b |\n| - | - |\n| \
		 {AWKWARD} | x |\n"
	);
	let theme = theme();
	let mut styled: Vec<String> = Vec::new();
	let mut walk = |blocks: &[Md]| {
		let mut stack: Vec<&Md> = blocks.iter().collect();
		while let Some(block) = stack.pop() {
			let spans: Vec<Vec<Span>> = match block {
				Md::Heading { spans, .. } | Md::Paragraph(spans) => vec![spans.clone()],
				Md::List(items) => items.iter().map(|item| item.spans.clone()).collect(),
				Md::Table { head, rows } => head
					.iter()
					.cloned()
					.chain(rows.iter().flat_map(|row| row.iter().cloned()))
					.collect(),
				Md::Quote(inner) => {
					stack.extend(inner.iter());
					Vec::new()
				},
				Md::Code { .. } | Md::Rule => Vec::new(),
			};
			for run in spans {
				let (body, styles) = render::styled(&run, &theme);
				for (range, _) in styles {
					assert!(
						body.is_char_boundary(range.start) && body.is_char_boundary(range.end),
						"{range:?} splits a character in {body:?}"
					);
					styled.push(body[range].to_owned());
				}
			}
		}
	};
	walk(&markdown::parse(&source));

	// Exactly the three inline constructs the corpus carries, each covering the
	// awkward text and nothing around it. A count of runs would pass on three
	// runs over the wrong words; a check that "some run exists" would pass on a
	// parser that dropped two of the three.
	styled.sort();
	assert_eq!(styled, vec![AWKWARD.to_owned(); 3]);
}

#[test]
fn every_lexed_range_lands_on_a_character_boundary_in_the_body_it_came_from() {
	// The same class, on the other parser: a fenced block's runs are applied to
	// the exact string the lexer was handed.
	let body = format!("let s = \"{AWKWARD}\"; // {AWKWARD}\n");
	for lang in ["rust", "typescript", "python", "", "no-such-language"] {
		for (range, _) in syntax::spans(lang, &body) {
			assert!(
				body.is_char_boundary(range.start) && body.is_char_boundary(range.end),
				"{lang}: {range:?} splits a character in {body:?}"
			);
		}
	}
}
