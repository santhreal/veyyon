//! WHY THIS SUITE EXISTS
//!
//! The `ToolView` contract defines the canonical representation of tool
//! execution outputs across hosts. Deserialization errors or field name
//! mismatches between TypeScript producers and Rust desktop consumers would
//! silently corrupt tool output presentation or break transcript decoding.
//!
//! THE CLASS THIS CLOSES: serde contract mismatches, missed optional fields,
//! incorrect camelCase property name mappings, kind discriminant tagging
//! regressions, enum variant decoding divergence, and missing Hash derives
//! needed for zero-allocation change detection between contracts/view and
//! `veyyon_desktop_model`.
//!
//! WHAT IT DOES NOT CATCH: it does not verify visual layout or font
//! rasterization; those belong to the surface rendering tests.

use std::hash::{DefaultHasher, Hash, Hasher};

use veyyon_desktop_model::tool_view::*;

fn calculate_hash<T: Hash>(t: &T) -> u64 {
	let mut s = DefaultHasher::new();
	t.hash(&mut s);
	s.finish()
}

#[test]
fn status_row_deserializes_from_canonical_json() {
	let json = r#"{
		"kind": "statusRow",
		"status": "success",
		"emblem": "check",
		"emblemTone": "accent",
		"title": "Wrote file",
		"titleTone": "title",
		"description": "src/main.rs",
		"descriptionTone": "accent",
		"descriptionFits": true,
		"descriptionFile": "/path/to/src/main.rs",
		"descriptionFileLine": 42,
		"badge": { "label": "PATCH", "tone": "diffAdded" },
		"meta": [
			[{ "text": "+12", "tone": "diffAdded" }, { "text": "-3", "tone": "diffRemoved" }]
		],
		"language": "rust"
	}"#;

	let view: ToolView = serde_json::from_str(json).expect("statusRow must deserialize");
	match view {
		ToolView::StatusRow(row) => {
			assert_eq!(row.status, Some(ViewStatus::Success));
			assert_eq!(row.emblem.as_deref(), Some("check"));
			assert_eq!(row.emblem_tone, Some(ViewTone::Accent));
			assert_eq!(row.title, "Wrote file");
			assert_eq!(row.title_tone, Some(ViewTone::Title));
			assert_eq!(row.description.as_deref(), Some("src/main.rs"));
			assert_eq!(row.description_tone, Some(ViewTone::Accent));
			assert!(row.description_fits);
			assert_eq!(row.description_file.as_deref(), Some("/path/to/src/main.rs"));
			assert_eq!(row.description_file_line, Some(42));
			assert_eq!(
				row.badge,
				Some(StatusRowBadge { label: "PATCH".to_string(), tone: ViewTone::DiffAdded })
			);
			assert_eq!(row.meta.len(), 1);
			assert_eq!(row.meta[0].len(), 2);
			assert_eq!(row.meta[0][0].text, "+12");
			assert_eq!(row.language.as_deref(), Some("rust"));
		},
		other => panic!("expected StatusRow variant, got {other:?}"),
	}
}

#[test]
fn text_block_deserializes_and_roundtrips() {
	let json = r#"{
		"kind": "textBlock",
		"spans": [
			{ "text": "Error: ", "tone": "error", "bold": true },
			{ "text": "failed to connect", "tone": "muted", "strike": false },
			{ "text": " https://example.com ", "link": "https://example.com", "tone": "link" },
			{ "text": "\u001b[31mraw\u001b[0m", "captured": true }
		]
	}"#;

	let view: ToolView = serde_json::from_str(json).expect("textBlock must deserialize");
	match &view {
		ToolView::TextBlock(block) => {
			assert_eq!(block.spans.len(), 4);
			assert_eq!(block.spans[0].text, "Error: ");
			assert_eq!(block.spans[0].tone, Some(ViewTone::Error));
			assert!(block.spans[0].bold);
			assert_eq!(block.spans[1].text, "failed to connect");
			assert!(!block.spans[1].strike);
			assert_eq!(block.spans[2].link.as_deref(), Some("https://example.com"));
			assert!(block.spans[3].captured);
		},
		other => panic!("expected TextBlock variant, got {other:?}"),
	}

	let serialized = serde_json::to_string(&view).expect("must serialize");
	let roundtripped: ToolView = serde_json::from_str(&serialized).expect("must roundtrip");
	assert_eq!(view, roundtripped);
}

#[test]
fn headed_block_deserializes_with_hidden_and_tail() {
	let json = r#"{
		"kind": "headedBlock",
		"header": {
			"title": "Search results",
			"status": "done"
		},
		"lines": [
			[{ "text": "match 1 in file.rs:10" }],
			[{ "text": "match 2 in file.rs:20" }]
		],
		"hidden": {
			"count": 15,
			"noun": { "one": "match", "many": "matches" },
			"revealable": true
		},
		"tail": {
			"max": 10,
			"viewport": true,
			"reserve": 2
		}
	}"#;

	let view: ToolView = serde_json::from_str(json).expect("headedBlock must deserialize");
	match view {
		ToolView::HeadedBlock(headed) => {
			assert!(headed.header.is_some());
			assert_eq!(headed.header.as_ref().unwrap().title, "Search results");
			assert_eq!(headed.lines.len(), 2);
			let hidden = headed.hidden.expect("hidden must be present");
			assert_eq!(hidden.count, 15);
			assert!(hidden.revealable);
			assert_eq!(hidden.format_label(), "15 more matches");
			let tail = headed.tail.expect("tail must be present");
			assert_eq!(tail.max, Some(10));
			assert!(tail.viewport);
			assert_eq!(tail.reserve, Some(2));
		},
		other => panic!("expected HeadedBlock variant, got {other:?}"),
	}
}

#[test]
fn framed_block_with_diff_and_code_sections_deserializes() {
	let json = r#"{
		"kind": "framedBlock",
		"state": "warning",
		"contents": "data",
		"gutter": true,
		"sections": [
			{
				"label": "Changes",
				"separator": true,
				"diff": {
					"sides": ["added", "removed", "context", "gap"],
					"lineNumbers": [1, 2, null, 10],
					"path": "src/lib.rs"
				},
				"lines": [
					[{ "text": "+ pub fn new() -> Self" }],
					[{ "text": "- fn old()" }],
					[{ "text": "  unchanged" }],
					[{ "text": "..." }]
				]
			},
			{
				"label": "Code",
				"code": {
					"language": "rust",
					"firstLineNumber": 100,
					"totalLines": 250,
					"lead": "$ cargo check"
				},
				"lines": [
					[{ "text": "let x = 42;" }]
				]
			}
		]
	}"#;

	let view: ToolView = serde_json::from_str(json).expect("framedBlock must deserialize");
	match view {
		ToolView::FramedBlock(framed) => {
			assert_eq!(framed.state, Some(ViewStatus::Warning));
			assert_eq!(framed.contents, Some(ViewContentsKind::Data));
			assert!(framed.gutter);
			assert_eq!(framed.sections.len(), 2);

			let diff_sec = &framed.sections[0];
			assert_eq!(diff_sec.label.as_deref(), Some("Changes"));
			assert!(diff_sec.separator);
			let diff = diff_sec.diff.as_ref().expect("diff must be present");
			assert_eq!(diff.sides, vec![
				ViewDiffSide::Added,
				ViewDiffSide::Removed,
				ViewDiffSide::Context,
				ViewDiffSide::Gap,
			]);
			assert_eq!(diff.line_numbers, Some(vec![Some(1), Some(2), None, Some(10)]));
			assert_eq!(diff.path.as_deref(), Some("src/lib.rs"));

			let code_sec = &framed.sections[1];
			let code = code_sec.code.as_ref().expect("code must be present");
			assert_eq!(code.language.as_deref(), Some("rust"));
			assert_eq!(code.first_line_number, Some(100));
			assert_eq!(code.total_lines, Some(250));
			assert_eq!(code.lead.as_deref(), Some("$ cargo check"));
		},
		other => panic!("expected FramedBlock variant, got {other:?}"),
	}
}

#[test]
fn notice_view_deserializes_and_roundtrips() {
	let json = r#"{
		"kind": "notice",
		"state": "error",
		"mark": "warning",
		"headline": [
			{ "text": "Action Rejected", "tone": "error", "bold": true }
		],
		"tag": "SECURITY",
		"body": [
			[{ "text": "Destination path is outside authorized workspace root." }]
		]
	}"#;

	let view: ToolView = serde_json::from_str(json).expect("notice must deserialize");
	match &view {
		ToolView::Notice(notice) => {
			assert_eq!(notice.state, ViewStatus::Error);
			assert_eq!(notice.mark.as_deref(), Some("warning"));
			assert_eq!(notice.tag.as_deref(), Some("SECURITY"));
			assert_eq!(notice.headline.len(), 1);
			assert_eq!(notice.headline[0].text, "Action Rejected");
			assert_eq!(notice.body.len(), 1);
		},
		other => panic!("expected Notice variant, got {other:?}"),
	}

	let serialized = serde_json::to_string(&view).expect("must serialize");
	let roundtripped: ToolView = serde_json::from_str(&serialized).expect("must roundtrip");
	assert_eq!(view, roundtripped);
}

#[test]
fn tool_presentation_wrapper_deserializes() {
	let json = r#"{
		"expanded": true,
		"view": {
			"kind": "textBlock",
			"spans": [{ "text": "output" }]
		}
	}"#;

	let pres: ToolPresentation = serde_json::from_str(json).expect("presentation must deserialize");
	assert!(pres.expanded);
	assert_eq!(pres.view, ToolView::TextBlock(TextBlockView::text("output")));
}

#[test]
fn hidden_count_formatting_handles_singular_plural_and_missing_nouns() {
	let custom = ViewHiddenCount {
		count:      1,
		noun:       Some(ViewNoun { one: "file".into(), many: "files".into() }),
		revealable: true,
	};
	assert_eq!(custom.format_label(), "1 more file");

	let custom_many = ViewHiddenCount {
		count:      5,
		noun:       Some(ViewNoun { one: "file".into(), many: "files".into() }),
		revealable: true,
	};
	assert_eq!(custom_many.format_label(), "5 more files");

	let default_one = ViewHiddenCount { count: 1, noun: None, revealable: false };
	assert_eq!(default_one.format_label(), "1 more line");

	let default_many = ViewHiddenCount { count: 12, noun: None, revealable: false };
	assert_eq!(default_many.format_label(), "12 more lines");
}

#[test]
fn tree_lines_and_markdown_sections_deserialize() {
	let json = r##"{
		"kind": "framedBlock",
		"sections": [
			{
				"tree": {
					"depth": [0, 1, 1, 2],
					"opens": [true, true, false, true],
					"last": [false, false, true, true]
				},
				"lines": [
					[{ "text": "root" }],
					[{ "text": "child 1" }],
					[{ "text": "child 1 detail" }],
					[{ "text": "grandchild" }]
				]
			},
			{
				"markdown": true,
				"lines": [
					[{ "text": "# Heading", "tone": "accent" }],
					[{ "text": "- bullet item" }]
				]
			}
		]
	}"##;

	let view: ToolView = serde_json::from_str(json).expect("tree/markdown section must deserialize");
	match view {
		ToolView::FramedBlock(framed) => {
			assert_eq!(framed.sections.len(), 2);
			let tree = framed.sections[0].tree.as_ref().expect("tree metadata");
			assert_eq!(tree.depth, vec![0, 1, 1, 2]);
			assert_eq!(tree.opens, vec![true, true, false, true]);
			assert_eq!(tree.last, vec![false, false, true, true]);

			assert!(framed.sections[1].markdown);
		},
		other => panic!("expected FramedBlock variant, got {other:?}"),
	}
}

#[test]
fn hash_derives_detect_semantic_presentation_and_view_changes() {
	let pres1 = ToolPresentation {
		expanded: false,
		view:     ToolView::StatusRow(StatusRowView::new("Running")),
	};
	let pres2 = ToolPresentation {
		expanded: true,
		view:     ToolView::StatusRow(StatusRowView::new("Running")),
	};
	let pres3 = ToolPresentation {
		expanded: false,
		view:     ToolView::StatusRow(StatusRowView {
			title: "Running".into(),
			status: Some(ViewStatus::Running),
			..Default::default()
		}),
	};

	let hash1 = calculate_hash(&pres1);
	let hash2 = calculate_hash(&pres2);
	let hash3 = calculate_hash(&pres3);

	assert_ne!(hash1, hash2, "disclosure expansion must change hash");
	assert_ne!(hash1, hash3, "status progress must change hash");
	assert_eq!(hash1, calculate_hash(&pres1), "hash must be deterministic");
}
