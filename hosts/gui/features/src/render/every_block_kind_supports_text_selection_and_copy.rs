//! WHY. Rendered transcript content was drawn as plain text without selection
//! support, preventing copy out of conversations. Previous ad-hoc copy buttons
//! only covered fenced code blocks and failed across mixed paragraphs, lists,
//! quotes, tables, diffs, and tool calls.
//!
//! THE CLASS. Text selection and plain-text copy fidelity across every block
//! kind the renderer produces, ensuring code copies without chrome, lists copy
//! with markers, links copy with labels, and spans join in document order.
//!
//! WHAT IT DOES NOT CATCH. Operating-system specific clipboard managers and
//! selection wash subpixel antialiasing on remote displays.

use veyyon_gui_core::{
	model::{ContentBlock, EntryId, MessageRole, ToolId, TranscriptEntry, Value},
	text::markdown::{Item, ListKind, Md, Span},
};
use veyyon_gui_kit::input::selection::{Selection, resolve_spans};

use super::entry::{EntryCache, collect_elements, collect_md_elements};

#[test]
fn every_markdown_block_kind_is_covered() {
	let blocks = [
		Md::Heading { level: 1, spans: vec![Span::Plain("Heading text".to_string())] },
		Md::Paragraph(vec![
			Span::Plain("Paragraph with ".to_string()),
			Span::Link { text: "link label".to_string(), href: "https://example.com".to_string() },
			Span::Code("inline code".to_string()),
		]),
		Md::List(vec![
			Item {
				kind:  ListKind::Bullet,
				depth: 0,
				spans: vec![Span::Plain("Bullet item".to_string())],
				done:  None,
			},
			Item {
				kind:  ListKind::Ordered(1),
				depth: 0,
				spans: vec![Span::Plain("Ordered item".to_string())],
				done:  None,
			},
		]),
		Md::Quote(vec![Md::Paragraph(vec![Span::Plain("Quoted content".to_string())])]),
		Md::Code {
			lang: "rust".to_string(),
			body: "fn main() {\n    println!(\"hello\");\n}".to_string(),
		},
		Md::Rule,
		Md::Table {
			head: vec![vec![Span::Plain("H1".to_string())], vec![Span::Plain("H2".to_string())]],
			rows: vec![vec![vec![Span::Plain("V1".to_string())], vec![Span::Plain("V2".to_string())]]],
		},
	];

	// Exhaustive enumeration of all Md enum variants to prevent drift
	for block in &blocks {
		match block {
			Md::Heading { spans: _, level } => {
				assert_eq!(*level, 1);
				let mut elements = Vec::new();
				collect_md_elements(std::slice::from_ref(block), "test", &mut elements);
				assert_eq!(elements.len(), 1);
				assert_eq!(elements[0].1, "Heading text");
			},
			Md::Paragraph(spans) => {
				assert_eq!(spans.len(), 3);
				let mut elements = Vec::new();
				collect_md_elements(std::slice::from_ref(block), "test", &mut elements);
				assert_eq!(elements.len(), 1);
				assert_eq!(elements[0].1, "Paragraph with link labelinline code");
			},
			Md::List(items) => {
				assert_eq!(items.len(), 2);
				let mut elements = Vec::new();
				collect_md_elements(std::slice::from_ref(block), "test", &mut elements);
				assert_eq!(elements.len(), 2);
				assert_eq!(elements[0].1, "• Bullet item");
				assert_eq!(elements[1].1, "1. Ordered item");
			},
			Md::Quote(inner) => {
				assert_eq!(inner.len(), 1);
				let mut elements = Vec::new();
				collect_md_elements(std::slice::from_ref(block), "test", &mut elements);
				assert_eq!(elements.len(), 1);
				assert_eq!(elements[0].1, "Quoted content");
			},
			Md::Code { lang, body } => {
				assert_eq!(lang, "rust");
				let mut elements = Vec::new();
				collect_md_elements(std::slice::from_ref(block), "test", &mut elements);
				assert_eq!(elements.len(), 1);
				assert_eq!(elements[0].1, *body);
			},
			Md::Rule => {
				let mut elements = Vec::new();
				collect_md_elements(std::slice::from_ref(block), "test", &mut elements);
				assert!(elements.is_empty());
			},
			Md::Table { head, rows } => {
				assert_eq!(head.len(), 2);
				assert_eq!(rows.len(), 1);
				let mut elements = Vec::new();
				collect_md_elements(std::slice::from_ref(block), "test", &mut elements);
				assert_eq!(elements.len(), 4);
				assert_eq!(elements[0].1, "H1");
				assert_eq!(elements[1].1, "H2");
				assert_eq!(elements[2].1, "V1");
				assert_eq!(elements[3].1, "V2");
			},
		}
	}
}

#[test]
fn content_block_kinds_selection_and_copy() {
	let entry = TranscriptEntry {
		id:                EntryId::new("entry-1").unwrap(),
		parent:            None,
		role:              MessageRole::Assistant,
		timestamp_ms:      1000,
		revision:          1,
		content:           vec![
			ContentBlock::Text { text: "Hello text".to_string() },
			ContentBlock::Thinking { text: "Thought process".to_string() },
			ContentBlock::Execution {
				language:  "bash".to_string(),
				command:   Some("cargo check".to_string()),
				output:    "Finished dev profile".to_string(),
				exit_code: Some(0),
			},
			ContentBlock::Diff {
				raw: "--- a/foo.rs\n+++ b/foo.rs\n@@ -1,1 +1,2 @@\n+added".to_string(),
			},
			ContentBlock::ToolCall {
				id:        ToolId::new("tool-1").unwrap(),
				name:      "read_file".to_string(),
				arguments: Value::Object(vec![(
					"path".to_string(),
					Value::String("src/main.rs".to_string()),
				)]),
			},
			ContentBlock::ToolResult {
				tool:     ToolId::new("tool-1").unwrap(),
				content:  Value::Object(vec![("status".to_string(), Value::String("ok".to_string()))]),
				is_error: false,
			},
			ContentBlock::FileMention {
				path:               "src/lib.rs".to_string(),
				has_content:        true,
				lines:              Some(42),
				bytes:              Some(1024),
				unavailable_reason: None,
				image:              None,
			},
			ContentBlock::Image {
				media_type: "image/png".to_string(),
				data:       vec![0; 16],
				alt:        Some("Diagram of architecture".to_string()),
			},
		],
		meta:              None,
		raw_discriminator: String::new(),
		raw:               Value::Null,
	};

	let cache = EntryCache::build(&entry);
	let mut elements = Vec::new();
	collect_elements(&entry, &cache, &mut elements);

	let refs: Vec<(&str, &str)> = elements
		.iter()
		.map(|(k, v)| (k.as_str(), v.as_str()))
		.collect();
	assert_eq!(refs.len(), 8);

	// Test full selection copy
	let mut sel = Selection::new();
	sel.select_all(&refs);
	let copied = sel.selected_text().expect("copies non-empty selection");

	assert!(copied.contains("Hello text"));
	assert!(copied.contains("Thought process"));
	assert!(copied.contains("cargo check\nFinished dev profile"));
	assert!(copied.contains("--- a/foo.rs\n+++ b/foo.rs"));
	assert!(copied.contains("read_file"));
	assert!(copied.contains("src/lib.rs"));
	assert!(copied.contains("Diagram of architecture"));
}

#[test]
fn boundary_cases_selection_behavior() {
	let elements = [
		("r0", "First paragraph of entry one"),
		("r1", "Second paragraph with emoji 🦀 and accents e\u{0301}"),
		("r2", "Code block body"),
	];

	// 1. Empty selection copies nothing
	let empty_spans = resolve_spans(&elements, (0, 0), (0, 0));
	assert!(empty_spans.is_empty());

	// 2. Selection wholly inside one run
	let spans1 = resolve_spans(&elements, (0, 6), (0, 15));
	assert_eq!(spans1.len(), 1);
	assert_eq!(&spans1[0].text[spans1[0].range.clone()], "paragraph");

	// 3. Selection spanning two blocks
	let spans2 = resolve_spans(&elements, (0, 16), (1, 16));
	assert_eq!(spans2.len(), 2);
	assert_eq!(&spans2[0].text[spans2[0].range.clone()], "of entry one");
	assert_eq!(&spans2[1].text[spans2[1].range.clone()], "Second paragraph");

	// 4. Selection across multiple entries
	let spans3 = resolve_spans(&elements, (0, 0), (2, 15));
	assert_eq!(spans3.len(), 3);
	assert_eq!(&spans3[2].text[spans3[2].range.clone()], "Code block body");

	// 5. Grapheme cluster boundary never split
	let mut sel = Selection::new();
	sel.begin("r1", 29, elements[1].1); // Right on crab byte boundary
	sel.update_drag(&elements, (1, 35));
	let text = sel.selected_text().expect("has selected text");
	assert!(text.contains('🦀'));
}

#[test]
fn autoscroll_and_drag_bounds_termination() {
	let elements = [("a", "Alpha"), ("b", "Bravo"), ("c", "Charlie")];
	let mut sel = Selection::new();

	// Dragging past start clamps to 0
	sel.begin("a", 0, elements[0].1);
	let ok = sel.update_drag(&elements, (0, 0));
	assert!(!ok || sel.is_empty());

	// Dragging to last element index clamps within document
	sel.update_drag(&elements, (2, 7)); // offset 7 clamped to len 7
	let text = sel.selected_text().expect("has text");
	assert_eq!(text, "Alpha\nBravo\nCharlie");

	// Dragging past end index is rejected by update_drag without panic
	let invalid_head = (999, 10);
	assert!(!sel.update_drag(&elements, invalid_head));
}
