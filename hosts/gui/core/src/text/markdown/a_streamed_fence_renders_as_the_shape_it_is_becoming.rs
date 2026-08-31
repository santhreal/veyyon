//! WHY THIS SUITE EXISTS.
//! When a model streams markdown deltas, an unterminated fence, half-written
//! table row, open list item, or dangling emphasis marker was parsed as plain
//! literal text until its closer arrived. The reply visibly flickered between
//! literal asterisks/backticks and formatted shapes as each token landed.
//!
//! THE CLASS.
//! Streaming markdown mending and monotonic reveal boundary invariants:
//! 1. Unterminated constructs mend to the shape they are becoming.
//! 2. Mending never deletes or reorders any input byte.
//! 3. Reveal boundary is monotonic across all consecutive prefixes.
//! 4. Parser variant spaces are derived from source at run time.
//!
//! WHAT IT DOES NOT CATCH.
//! Remote display subpixel text rasterization or OS-specific font fallback.

use crate::text::markdown::{
	Item, ListKind, Md, Span, all_block_variants, all_repair_kinds, all_span_variants, mend, parse,
	reveal_boundary,
};

#[test]
fn every_unterminated_construct_renders_as_the_shape_it_is_becoming() {
	// Unclosed code fence
	let m1 = mend("```rust\nfn main() {");
	let ast1 = parse(&m1.text);
	assert_eq!(ast1, vec![Md::Code { lang: "rust".to_string(), body: "fn main() {".to_string() }]);

	// Incomplete table header
	let m2 = mend("| Header 1 | Header 2");
	let ast2 = parse(&m2.text);
	assert_eq!(ast2, vec![Md::Table {
		head: vec![vec![Span::Plain("Header 1".to_string())], vec![Span::Plain(
			"Header 2".to_string()
		)]],
		rows: Vec::new(),
	}]);

	// Incomplete list item task box
	let m3 = mend("- [ ");
	let ast3 = parse(&m3.text);
	assert_eq!(ast3, vec![Md::List(vec![Item {
		kind:  ListKind::Bullet,
		depth: 0,
		spans: Vec::new(),
		done:  Some(false),
	}])]);

	// Dangling strong bold
	let m4 = mend("prefix **bold text");
	let ast4 = parse(&m4.text);
	assert_eq!(ast4, vec![Md::Paragraph(vec![
		Span::Plain("prefix ".to_string()),
		Span::Strong("bold text".to_string()),
	])]);

	// Dangling emphasis italic
	let m5 = mend("prefix *italic text");
	let ast5 = parse(&m5.text);
	assert_eq!(ast5, vec![Md::Paragraph(vec![
		Span::Plain("prefix ".to_string()),
		Span::Emphasis("italic text".to_string()),
	])]);

	// Dangling inline code
	let m6 = mend("call `compute()");
	let ast6 = parse(&m6.text);
	assert_eq!(ast6, vec![Md::Paragraph(vec![
		Span::Plain("call ".to_string()),
		Span::Code("compute()".to_string()),
	])]);

	// Dangling link
	let m7 = mend("click [documentation");
	let ast7 = parse(&m7.text);
	assert_eq!(ast7, vec![Md::Paragraph(vec![Span::Plain("click ".to_string()), Span::Link {
		text: "documentation".to_string(),
		href: crate::text::markdown::PENDING_LINK_URL.to_string(),
	},])]);
}

#[test]
fn reveal_boundary_is_monotonic_and_settled_bytes_are_byte_identical() {
	let full_doc = "# Title\n\nFirst paragraph with **bold** text.\n\n```rust\nlet a = 1;\n```\n";
	let mut prev_prefix = "";
	let mut prev_settled = 0;

	for i in 0..=full_doc.len() {
		if !full_doc.is_char_boundary(i) {
			continue;
		}
		let current_prefix = &full_doc[..i];
		let veil = reveal_boundary(prev_prefix, prev_settled, current_prefix);

		assert!(
			veil.settled >= prev_settled,
			"settled offset must never decrease: prev={prev_settled}, curr={}",
			veil.settled
		);
		assert!(
			veil.settled <= current_prefix.len(),
			"settled offset cannot exceed current prefix length: settled={}, len={}",
			veil.settled,
			current_prefix.len()
		);

		// Settled bytes must match the full document prefix byte-identically
		assert_eq!(
			&current_prefix[..veil.settled],
			&full_doc[..veil.settled],
			"settled bytes must be byte-identical to original document"
		);

		prev_prefix = current_prefix;
		prev_settled = veil.settled;
	}
}

#[test]
fn fuzz_suite_over_split_points_never_panics_and_preserves_every_input_byte() {
	let corpus = build_adversarial_corpus();
	assert!(corpus.len() >= 10, "corpus must contain at least 10 documents");

	let mut total_prefixes_checked = 0;

	for doc in &corpus {
		let mut prev_prefix = "";
		let mut prev_settled = 0;

		for i in 0..=doc.len() {
			if !doc.is_char_boundary(i) {
				continue;
			}
			let prefix = &doc[..i];
			total_prefixes_checked += 1;

			// 1. Mending never panics
			let mended = mend(prefix);

			// 2. Mended output contains every input byte in order (starts_with prefix)
			assert!(
				mended.text.starts_with(prefix),
				"mended text must preserve all original prefix bytes in order: prefix={prefix:?}, \
				 mended={:?}",
				mended.text
			);
			assert_eq!(
				mended.text.len(),
				prefix.len() + mended.appended,
				"mended length must equal prefix length plus appended bytes"
			);

			// 3. Parsing mended text never panics
			let _ast = parse(&mended.text);

			// 4. Reveal boundary monotonicity
			let veil = reveal_boundary(prev_prefix, prev_settled, prefix);
			assert!(veil.settled >= prev_settled);
			assert!(veil.settled <= prefix.len());
			assert_eq!(&prefix[..veil.settled], &doc[..veil.settled]);

			prev_prefix = prefix;
			prev_settled = veil.settled;
		}
	}

	assert!(
		total_prefixes_checked >= 500,
		"must check at least 500 prefix split points across corpus, checked: \
		 {total_prefixes_checked}"
	);
}

#[test]
fn variant_spaces_are_derived_at_run_time_and_fail_on_unaccounted_members() {
	let blocks = all_block_variants();
	assert_eq!(blocks.len(), 7, "expected 7 block variants");

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
	assert_eq!(spans.len(), 5, "expected 5 span variants");

	for span in spans {
		match span {
			Span::Plain(_)
			| Span::Strong(_)
			| Span::Emphasis(_)
			| Span::Code(_)
			| Span::Link { .. } => {},
		}
	}

	let repairs = all_repair_kinds();
	assert_eq!(repairs.len(), 8, "expected 8 repair kinds");

	for repair in repairs {
		match repair {
			crate::text::markdown::RepairKind::CodeFence
			| crate::text::markdown::RepairKind::Table
			| crate::text::markdown::RepairKind::List
			| crate::text::markdown::RepairKind::InlineCode
			| crate::text::markdown::RepairKind::Strong
			| crate::text::markdown::RepairKind::Emphasis
			| crate::text::markdown::RepairKind::Link
			| crate::text::markdown::RepairKind::SetextGuard => {},
		}
	}
}

fn build_adversarial_corpus() -> Vec<String> {
	vec![
		"```typescript\nfunction solve(x: number): string {\n\treturn `result: ${x}`;\n}\n```\n"
			.to_string(),
		"| Col 1 | Col 2 | Col 3 |\n|:---|:---:|---:|\n| A | B | C |\n| D | E | F |\n".to_string(),
		"- Item 1\n\t- Nested 1.1\n\t- Nested 1.2\n- Item 2\n\t1. Ordered 2.1\n\t2. Ordered 2.2\n"
			.to_string(),
		"Nested ***bold and italic*** and **strong *italic inside* strong** text.\n".to_string(),
		"Link with parens [Docs](https://example.com/api(v1)/item) and image ![Alt](https://img.png)\n"
			.to_string(),
		"Code with backticks `` `inner` and `more` `` in prose.\n".to_string(),
		"CRLF\r\nLine 2\r\n```rust\r\nlet y = 2;\r\n```\r\nEnd\r\n".to_string(),
		"Multi-byte graphemes: e\u{0301} and \u{1F980} crab and \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} family.\n"
			.to_string(),
		"> Quoted header\n> > Nested quote with **bold**\n> Continues\n\nNormal paragraph\n"
			.to_string(),
		"- [ ] Todo item\n- [x] Done item\n- Regular bullet\n".to_string(),
		"Setext title\n===\n\nSetext subtitle\n---\n".to_string(),
	]
}
