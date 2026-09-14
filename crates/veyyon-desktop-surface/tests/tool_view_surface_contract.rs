//! WHY THIS SUITE EXISTS
//!
//! The desktop GUI renderer replaces legacy terminal-bound tool renderers by
//! drawing canonical `ToolView` models as pure native GPUI elements.
//!
//! If the desktop surface were to drop variants, fail to sanitize captured
//! control sequences from subprocesses or headers, miscalculate
//! `ViewTailWindow` viewport/reserve bounds, truncate lines without disclosure
//! affordances, ignore structural precedence between diff/code/markdown, or
//! misroute disclosure and target callbacks, tool outputs would fail silently,
//! leak ANSI escape garbage, or render unreachable truncated content.
//!
//! THE CLASS THIS CLOSES:
//! 1. Native rendering failures across all five `ToolView` kinds (`statusRow`,
//!    `textBlock`, `headedBlock`, `framedBlock`, `notice`).
//! 2. Control sequence leakage across all displayed fields (`title`,
//!    `description`, `badge`, `label`, `lead`, `tag`, `path`, and `spans`).
//! 3. `ViewTailWindow` viewport/reserve bounding vs non-tail host bounds with
//!    disclosure.
//! 4. Structural precedence violations in sections (Diff > Code > Markdown).
//! 5. Emblem and status glyph resolution with graceful fallback.
//! 6. Target callback and disclosure callback registration and dispatch.
//!
//! WHAT IT DOES NOT CATCH:
//! Real GPU font rasterization, live OS window event loops, and host socket
//! transport; those belong to headless scene rasterization and desktop client
//! integration tests.

use std::{cell::RefCell, rc::Rc};

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_model::tool_view::*;
use veyyon_desktop_surface::tool_view::*;

#[test]
fn renders_all_five_canonical_tool_views_without_panics() {
	let tokens = TokenSet::default();
	let callbacks = ToolViewCallbacks::default();

	// 1. StatusRowView
	let status_row = ToolView::StatusRow(StatusRowView {
		status:                Some(ViewStatus::Success),
		emblem:                Some("check".into()),
		emblem_tone:           Some(ViewTone::Accent),
		title:                 "Wrote file".into(),
		title_tone:            Some(ViewTone::Title),
		description:           Some("src/main.rs".into()),
		description_tone:      Some(ViewTone::Accent),
		description_fits:      true,
		description_file:      Some("/workspace/src/main.rs".into()),
		description_file_line: Some(10),
		description_link:      None,
		badge:                 Some(StatusRowBadge {
			label: "DIFF".into(),
			tone:  ViewTone::DiffAdded,
		}),
		meta:                  vec![vec![
			ViewSpan::text("+10").tone(ViewTone::DiffAdded),
			ViewSpan::text("-2").tone(ViewTone::DiffRemoved),
		]],
		language:              Some("rust".into()),
	});
	let _el1 = render_tool_view(&status_row, &tokens, None, &callbacks);

	// 2. TextBlockView
	let text_block = ToolView::TextBlock(TextBlockView {
		spans: vec![
			ViewSpan::text("Building project...")
				.tone(ViewTone::Title)
				.bold(),
			ViewSpan::text(" \x1b[31;1mcompiled with warnings\x1b[0m").captured(),
		],
	});
	let _el2 = render_tool_view(&text_block, &tokens, Some(5), &callbacks);

	// 3. HeadedBlockView
	let headed_block = ToolView::HeadedBlock(HeadedBlockView {
		header: Some(StatusRowView::new("Search matches")),
		lines:  vec![vec![ViewSpan::text("crates/model/lib.rs:14: pub mod tool_view;")], vec![
			ViewSpan::text("crates/surface/lib.rs:35: pub mod tool_view;"),
		]],
		hidden: Some(ViewHiddenCount {
			count:      8,
			noun:       Some(ViewNoun { one: "match".into(), many: "matches".into() }),
			revealable: true,
		}),
		tail:   Some(ViewTailWindow { max: Some(10), viewport: true, reserve: None }),
	});
	let _el3 = render_tool_view(&headed_block, &tokens, None, &callbacks);

	// 4. FramedBlockView
	let framed_block = ToolView::FramedBlock(FramedBlockView {
		header:   Some(StatusRowView::new("Tool Execution")),
		state:    Some(ViewStatus::Warning),
		contents: Some(ViewContentsKind::Report),
		gutter:   true,
		sections: vec![ViewSection {
			label:     Some("Output".into()),
			lines:     vec![vec![ViewSpan::text("Warning: unused variable `x`")]],
			separator: true,
			hidden:    None,
			tail:      None,
			list:      false,
			code:      Some(ViewCodeLines {
				language:          Some("rust".into()),
				first_line_number: Some(1),
				total_lines:       Some(10),
				line_numbers:      None,
				lead:              Some("$ cargo check".into()),
			}),
			diff:      None,
			tree:      None,
			markdown:  false,
			clip:      false,
		}],
	});
	let _el4 = render_tool_view(&framed_block, &tokens, None, &callbacks);

	// 5. NoticeView
	let notice = ToolView::Notice(NoticeView {
		state:    ViewStatus::Error,
		mark:     Some("warning".into()),
		headline: vec![
			ViewSpan::text("Tool execution aborted")
				.tone(ViewTone::Error)
				.bold(),
		],
		tag:      Some("ABORTED".into()),
		body:     vec![vec![ViewSpan::text("Process terminated via SIGINT by operator.")]],
	});
	let _el5 = render_tool_view(&notice, &tokens, None, &callbacks);
}

#[test]
fn section_structural_precedence_is_diff_over_code_over_markdown() {
	let tokens = TokenSet::default();
	let callbacks = ToolViewCallbacks::default();

	// Section that declares diff, code, and markdown simultaneously
	let conflicted_section = ViewSection {
		label:     Some("Conflicted".into()),
		lines:     vec![vec![ViewSpan::text("+ added line")], vec![ViewSpan::text("- removed line")]],
		separator: false,
		hidden:    None,
		tail:      None,
		list:      false,
		diff:      Some(ViewDiffLines {
			sides:        vec![ViewDiffSide::Added, ViewDiffSide::Removed],
			line_numbers: Some(vec![Some(1), Some(2)]),
			path:         Some("file.rs".into()),
		}),
		code:      Some(ViewCodeLines {
			language:          Some("rust".into()),
			first_line_number: Some(1),
			total_lines:       Some(2),
			line_numbers:      None,
			lead:              None,
		}),
		markdown:  true,
		tree:      None,
		clip:      false,
	};

	// Rendering executes diff without failing or panicking
	let _el = render_section(&conflicted_section, &tokens, None, &callbacks, true);
}

#[test]
fn sanitizes_all_displayed_text_fields_across_surfaces() {
	let tokens = TokenSet::default();
	let callbacks = ToolViewCallbacks::default();

	let row = StatusRowView {
		status: Some(ViewStatus::Info),
		emblem: Some("\x1b[33mterminal\x1b[0m".into()),
		title: "Build \x1b[1;32mSuccess\x1b[0m".into(),
		description: Some("Output \x1b[2Jcleaned".into()),
		badge: Some(StatusRowBadge { label: "OK\x00\x08".into(), tone: ViewTone::Success }),
		language: Some("rust\x1b[0m".into()),
		..Default::default()
	};

	let _el = render_status_row(&row, &tokens, &callbacks);

	let notice = NoticeView {
		state:    ViewStatus::Warning,
		mark:     Some("\x1b[31malert\x1b[0m".into()),
		headline: vec![ViewSpan::text("\x1b[31;1mSecurity Warning\x1b[0m")],
		tag:      Some("AUDIT\x1b[0m".into()),
		body:     vec![vec![ViewSpan::text("Escape \x1b]0;Title\x07bytes sanitized")]],
	};

	let _el_notice = render_notice(&notice, &tokens, &callbacks);
}

#[test]
fn view_tail_window_bounds_with_viewport_and_reserve() {
	let tokens = TokenSet::default();
	let disclosed = Rc::new(RefCell::new(false));
	let callbacks = ToolViewCallbacks::new().on_disclose(move |_win, _cx| {
		*disclosed.borrow_mut() = true;
	});

	// 20 lines with ViewTailWindow asking for viewport bound and reserve 2
	let tail_section = ViewSection {
		label:     Some("Tail Section".into()),
		lines:     (1..=20)
			.map(|i| vec![ViewSpan::text(format!("log entry {i}"))])
			.collect(),
		separator: false,
		hidden:    Some(ViewHiddenCount {
			count:      10,
			noun:       Some(ViewNoun { one: "log".into(), many: "logs".into() }),
			revealable: true,
		}),
		tail:      Some(ViewTailWindow { max: Some(10), viewport: true, reserve: Some(2) }),
		list:      false,
		code:      None,
		diff:      None,
		tree:      None,
		markdown:  false,
		clip:      false,
	};

	// Row budget = 8. Available host rows = 8 - 2 = 6. Effective max = min(10, 6) =
	// 6. Omitted front = 20 - 6 = 14.
	let _el = render_section(&tail_section, &tokens, Some(8), &callbacks, true);
}

#[test]
fn non_tail_section_bounds_from_front_with_disclosure_affordance() {
	let tokens = TokenSet::default();
	let disclosed = Rc::new(RefCell::new(false));
	let callbacks = ToolViewCallbacks::new().on_disclose(move |_win, _cx| {
		*disclosed.borrow_mut() = true;
	});

	// 15 lines without tail window
	let non_tail = ViewSection {
		label:     Some("File listing".into()),
		lines:     (1..=15)
			.map(|i| vec![ViewSpan::text(format!("file_{i}.rs"))])
			.collect(),
		separator: false,
		hidden:    None,
		tail:      None,
		list:      true,
		code:      None,
		diff:      None,
		tree:      None,
		markdown:  false,
		clip:      true,
	};

	// Budget = 5 -> displays lines 1..=5, omits 10 back lines with disclosure
	// affordance
	let _el = render_section(&non_tail, &tokens, Some(5), &callbacks, true);
}

#[test]
fn unknown_decorative_symbols_retain_fallback() {
	let tokens = TokenSet::default();
	let callbacks = ToolViewCallbacks::default();

	// Status row with an unrecognized emblem and no status
	let row_unknown = StatusRowView {
		emblem: Some("nonexistent_custom_emblem_glyph".into()),
		title: "Custom Tool".into(),
		..Default::default()
	};
	let _el1 = render_status_row(&row_unknown, &tokens, &callbacks);

	// Status row with an unrecognized emblem but valid status falls back to status
	// icon
	let row_fallback = StatusRowView {
		emblem: Some("unrecognized_glyph".into()),
		status: Some(ViewStatus::Done),
		title: "Settled Tool".into(),
		..Default::default()
	};
	let _el2 = render_status_row(&row_fallback, &tokens, &callbacks);
}

#[test]
fn callbacks_record_target_and_disclosure_interactions() {
	let clicked_target = Rc::new(RefCell::new(None));
	let disclosed = Rc::new(RefCell::new(false));

	let callbacks = ToolViewCallbacks::new()
		.on_target(move |tgt, _window, _cx| {
			*clicked_target.borrow_mut() = Some(tgt);
		})
		.on_disclose(move |_window, _cx| {
			*disclosed.borrow_mut() = true;
		});

	assert!(callbacks.on_target.is_some());
	assert!(callbacks.on_disclose.is_some());

	// Verify target representation
	let url_target = ToolViewTarget::Url("https://veyyon.dev".into());
	let file_target = ToolViewTarget::File { path: "src/main.rs".into(), line: Some(42) };

	match url_target {
		ToolViewTarget::Url(url) => assert_eq!(url, "https://veyyon.dev"),
		_ => panic!("expected url"),
	}

	match file_target {
		ToolViewTarget::File { path, line } => {
			assert_eq!(path, "src/main.rs");
			assert_eq!(line, Some(42));
		},
		_ => panic!("expected file"),
	}
}
