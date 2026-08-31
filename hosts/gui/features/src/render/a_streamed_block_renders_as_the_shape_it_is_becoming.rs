//! WHY THIS SUITE EXISTS.
//! In live conversations, streaming markdown tokens arrived with open
//! delimiters, unclosed fences, or incomplete table rows. Without mending at
//! the render seam, incomplete structures collapsed into plain text, causing
//! the message UI to flicker between plain prose and formatted boxes as each
//! token arrived.
//!
//! THE CLASS.
//! Streamed block rendering correctness:
//! 1. Incomplete fences, tables, lists, emphasis, and links render as their
//!    target shapes.
//! 2. Streaming tail styling distinguishes provisional content through theme
//!    tokens.
//! 3. All parser block and span variant spaces are swept without omissions.
//!
//! WHAT IT DOES NOT CATCH.
//! Frame-by-frame GPU compositor tearing and monitor refresh timing.

use veyyon_gui_core::text::markdown::{
	Md, Span, all_block_variants, all_span_variants, mend, parse,
};
use veyyon_gui_kit::theme::Theme;

use super::{entry::EntryCache, markdown as render};

fn theme() -> Theme {
	Theme::of(veyyon_gui_kit::theme::Appearance::Dark)
}

#[test]
fn streamed_unterminated_fence_renders_as_code_block() {
	let input = "```typescript\nconst x = 42;\n";
	let mended = mend(input);
	let ast = parse(&mended.text);

	assert_eq!(ast.len(), 1);
	match &ast[0] {
		Md::Code { lang, body } => {
			assert_eq!(lang, "typescript");
			assert_eq!(body, "const x = 42;");
		},
		other => panic!("expected Md::Code for unterminated fence, got {other:?}"),
	}
}

#[test]
fn streamed_unterminated_table_renders_as_table_block() {
	let input = "| Command | Description |\n| :--- | :--- |\n| `help` | Show commands";
	let mended = mend(input);
	let ast = parse(&mended.text);

	assert_eq!(ast.len(), 1);
	match &ast[0] {
		Md::Table { head, rows } => {
			assert_eq!(head.len(), 2);
			assert_eq!(rows.len(), 1);
		},
		other => panic!("expected Md::Table for unterminated table, got {other:?}"),
	}
}

#[test]
fn streamed_unterminated_task_list_renders_as_task_list() {
	let input = "- [ ] First task\n- [ ";
	let mended = mend(input);
	let ast = parse(&mended.text);

	assert_eq!(ast.len(), 1);
	match &ast[0] {
		Md::List(items) => {
			assert_eq!(items.len(), 2);
			assert_eq!(items[0].done, Some(false));
			assert_eq!(items[1].done, Some(false));
		},
		other => panic!("expected Md::List for unterminated list, got {other:?}"),
	}
}

#[test]
fn streamed_unterminated_inline_spans_render_as_styled_spans() {
	let input = "Here is **bold and `inline code` and [docs";
	let mended = mend(input);
	let ast = parse(&mended.text);

	assert_eq!(ast.len(), 1);
	let Md::Paragraph(spans) = &ast[0] else {
		panic!("expected Md::Paragraph");
	};

	let (body, styles) = render::styled(spans, &theme());
	assert!(body.contains("bold"));
	assert!(body.contains("inline code"));
	assert!(body.contains("docs"));
	assert!(!styles.is_empty(), "styled ranges must exist for mended spans");
}

#[test]
fn streaming_entry_cache_mends_provisional_text() {
	use veyyon_gui_core::model::{ContentBlock, EntryId, MessageRole, TranscriptEntry};

	let entry = TranscriptEntry {
		id:                EntryId::new("entry-1").unwrap(),
		parent:            None,
		role:              MessageRole::Assistant,
		timestamp_ms:      1000,
		revision:          1,
		content:           vec![ContentBlock::Text {
			text: "Streaming text with unclosed **bold\n\n```rust\nfn stream() {".to_string(),
		}],
		meta:              None,
		raw:               veyyon_gui_core::model::Value::Null,
		raw_discriminator: String::new(),
	};

	let cache = EntryCache::build(&entry);
	let md = cache.markdown(0);
	assert!(!md.is_empty(), "EntryCache must produce mended blocks");

	let has_code = md.iter().any(|b| matches!(b, Md::Code { .. }));
	assert!(has_code, "unterminated code in streaming entry must parse as Md::Code");
}

#[test]
fn every_block_and_span_variant_is_accounted_for() {
	let blocks = all_block_variants();
	assert_eq!(blocks.len(), 7);
	for block in blocks {
		match block {
			Md::Heading { .. }
			| Md::Paragraph(_)
			| Md::List(_)
			| Md::Quote(_)
			| Md::Code { .. }
			| Md::Rule
			| Md::Table { .. } => {},
		}
	}

	let spans = all_span_variants();
	assert_eq!(spans.len(), 5);
	for span in spans {
		match span {
			Span::Plain(_)
			| Span::Strong(_)
			| Span::Emphasis(_)
			| Span::Code(_)
			| Span::Link { .. } => {},
		}
	}
}
