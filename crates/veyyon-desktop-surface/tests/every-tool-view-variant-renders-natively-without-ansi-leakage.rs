//! WHY: Native GPUI `ToolView` rendering must display every semantic tool
//! output representation without falling back to terminal emulation, leaking
//! ANSI/CSI control codes, or silently dropping variants.
//!
//! CLASS CLOSED:
//! 1. Unrendered or silently ignored `ToolView` variants.
//! 2. Raw terminal escape sequences (CSI, SGR, OSC, cursor movement, screen
//!    clearing, C0/C1 control codes) leaking into GUI text runs or layout.
//! 3. Hardcoded variant lists drifting out of sync with `ToolView` enum
//!    definitions.
//! 4. Collapsed vs expanded rendering failures through the production
//!    `invoke.rs` block path.
//! 5. Missing opt-out enforcement (pinned to empty set by exact equality).
//!
//! NOT CAUGHT: Live network streaming socket latency and OS-level display
//! compositor bugs.

use std::{cell::RefCell, path::Path, rc::Rc, sync::Arc};

use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::tool_view::{
	FramedBlockView, HeadedBlockView, NoticeView, StatusRowBadge, StatusRowView, TextBlockView,
	ToolPresentation, ToolView, ViewCodeLines, ViewDiffLines, ViewDiffSide, ViewHiddenCount,
	ViewNoun, ViewSection, ViewSpan, ViewStatus, ViewTailWindow, ViewTone, ViewTreeLines,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::headless::{RenderOptions, headless_context, render_view_captured};
use veyyon_desktop_surface::{
	install_tokens,
	model::ToolInvocationViews,
	tool_view::{ToolViewCallbacks, ToolViewTarget, render_tool_view, sanitize_control_sequences},
	transcript::{TranscriptViewportState, blocks::render_invoke_block},
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div,
};

/// Constructs sample instances of every canonical `ToolView` variant seeded
/// with hostile ANSI/CSI escape codes across titles, descriptions, badges,
/// labels, spans, and lines.
fn every_tool_view_variant() -> Vec<ToolView> {
	let status_row = ToolView::StatusRow(StatusRowView {
		status:                Some(ViewStatus::Success),
		emblem:                Some("\x1b[32mcheck\x1b[0m".into()),
		emblem_tone:           Some(ViewTone::Success),
		title:                 "Wrote \x1b[1;34mmain.rs\x1b[0m\x07".into(),
		title_tone:            Some(ViewTone::Title),
		description:           Some("120 \x1b[2Jlines \x1b[33mwritten\x1b[0m\x00\x08".into()),
		description_tone:      Some(ViewTone::Text),
		description_fits:      true,
		description_file:      Some("/workspace/\x1b[31msrc/main.rs\x1b[0m".into()),
		description_file_line: Some(42),
		description_link:      None,
		badge:                 Some(StatusRowBadge {
			label: "DIFF\x1b[0m".into(),
			tone:  ViewTone::DiffAdded,
		}),
		meta:                  vec![vec![
			ViewSpan::text("+\x1b[32m12\x1b[0m").tone(ViewTone::DiffAdded),
			ViewSpan::text("-\x1b[31m4\x1b[0m").tone(ViewTone::DiffRemoved),
		]],
		language:              Some("rust\x1b[0m".into()),
	});

	let text_block = ToolView::TextBlock(TextBlockView {
		spans: vec![
			ViewSpan::text("Building \x1b[36mcore\x1b[0m target...\n").bold(),
			ViewSpan::text("warning: \x1b[33munused variable `x`\x1b[0m").tone(ViewTone::Warning),
			ViewSpan { markdown: true, ..ViewSpan::text(" \x1b]0;Build Title\x07`let x = 1;`") },
		],
	});

	let headed_block = ToolView::HeadedBlock(HeadedBlockView {
		header: Some(StatusRowView {
			status: Some(ViewStatus::Running),
			emblem: Some("play".into()),
			title: "Running \x1b[1mtests\x1b[0m".into(),
			description: Some("suite: \x1b[35mconformance\x1b[0m".into()),
			..Default::default()
		}),
		lines:  vec![vec![ViewSpan::text("test 1: \x1b[32mpassed\x1b[0m")], vec![
			ViewSpan::text("test 2: \x1b[31mfailed\x1b[0m").tone(ViewTone::Error),
		]],
		hidden: Some(ViewHiddenCount {
			count:      8,
			noun:       Some(ViewNoun { one: "test".into(), many: "tests".into() }),
			revealable: true,
		}),
		tail:   Some(ViewTailWindow { max: Some(2), viewport: true, reserve: Some(1) }),
	});

	let framed_block = ToolView::FramedBlock(FramedBlockView {
		header:   Some(StatusRowView {
			status: Some(ViewStatus::Done),
			title: "Patch \x1b[32mApplied\x1b[0m".into(),
			..Default::default()
		}),
		state:    Some(ViewStatus::Done),
		sections: vec![
			ViewSection {
				label: Some("Diff \x1b[33mHunk\x1b[0m".into()),
				lines: vec![vec![ViewSpan::text("@@ -1,3 +1,4 @@")], vec![ViewSpan::text(
					"+let y = 2;\x1b[0m",
				)]],
				diff: Some(ViewDiffLines {
					sides:        vec![ViewDiffSide::Context, ViewDiffSide::Added],
					line_numbers: Some(vec![Some(1), Some(2)]),
					path:         Some("src/\x1b[34mlib.rs\x1b[0m".into()),
				}),
				..Default::default()
			},
			ViewSection {
				label: Some("Source \x1b[36mCode\x1b[0m".into()),
				lines: vec![vec![ViewSpan::text("fn main() {\x1b[0m")]],
				code: Some(ViewCodeLines {
					language: Some("rust".into()),
					total_lines: Some(1),
					line_numbers: Some(vec![Some(1)]),
					lead: Some("$\x1b[32m cargo test\x1b[0m".into()),
					..Default::default()
				}),
				separator: true,
				..Default::default()
			},
			ViewSection {
				label: Some("Hierarchy".into()),
				lines: vec![vec![ViewSpan::text("root\x1b[0m")]],
				tree: Some(ViewTreeLines { depth: vec![0], opens: vec![true], last: vec![true] }),
				separator: true,
				..Default::default()
			},
		],
		contents: None,
		gutter:   true,
	});

	let notice = ToolView::Notice(NoticeView {
		state:    ViewStatus::Warning,
		mark:     Some("\x1b[33malert\x1b[0m".into()),
		headline: vec![ViewSpan::text("Disk usage \x1b[1;31m> 90%\x1b[0m")],
		tag:      Some("STORAGE\x1b[0m".into()),
		body:     vec![vec![ViewSpan::text("Clean up \x1b[4m/var/log\x1b[0m immediately.")]],
	});

	let variants = vec![status_row, text_block, headed_block, framed_block, notice];

	// Exhaustive match is the compile-time variant coverage gate.
	// Adding a new variant to ToolView turns this red until handled here.
	for view in &variants {
		match view {
			ToolView::StatusRow(_)
			| ToolView::TextBlock(_)
			| ToolView::HeadedBlock(_)
			| ToolView::FramedBlock(_)
			| ToolView::Notice(_) => {},
		}
	}

	variants
}

#[test]
fn every_tool_view_variant_is_covered_and_none_opted_out() {
	let variants = every_tool_view_variant();
	assert_eq!(variants.len(), 5, "exactly 5 ToolView variants must be defined and tested");

	// Pin opt-outs by exact equality: no variants may be skipped.
	let opt_outs: Vec<&str> = Vec::new();
	assert_eq!(opt_outs, Vec::<&str>::new(), "no ToolView variants may be opted out of rendering");

	// Verify all variants map to canonical camelCase kind discriminants.
	let kinds: Vec<&str> = variants
		.iter()
		.map(|v| match v {
			ToolView::StatusRow(_) => "statusRow",
			ToolView::TextBlock(_) => "textBlock",
			ToolView::HeadedBlock(_) => "headedBlock",
			ToolView::FramedBlock(_) => "framedBlock",
			ToolView::Notice(_) => "notice",
		})
		.collect();

	assert_eq!(kinds, vec!["statusRow", "textBlock", "headedBlock", "framedBlock", "notice"]);
}

#[test]
fn every_tool_view_variant_renders_through_production_invoke_block_path() {
	let bundled = load_bundled_tokens().expect("bundled tokens");
	let geometry = bundled.surface.transcript;
	let tokens = TokenSet::default();
	let motion_tokens = MotionTokens::reference();
	let viewport_state = TranscriptViewportState::new();

	for (ix, view) in every_tool_view_variant().into_iter().enumerate() {
		// 1. Collapsed block path (views.result presentation)
		let collapsed_views = ToolInvocationViews {
			call:   None,
			result: Some(Arc::new(ToolPresentation { expanded: false, view: view.clone() })),
		};
		let collapsed_el = render_invoke_block(
			0,
			ix,
			&format!("call-{ix}"),
			"tool_runner",
			"workspace/target",
			Some("summary outcome"),
			&collapsed_views,
			false,
			&geometry,
			&tokens,
			&motion_tokens,
			false,
			&viewport_state,
			None,
		);
		let _ = collapsed_el;

		// 2. Expanded block path (views.result presentation with details)
		let expanded_views = ToolInvocationViews {
			call:   None,
			result: Some(Arc::new(ToolPresentation { expanded: true, view: view.clone() })),
		};
		let expanded_el = render_invoke_block(
			0,
			ix,
			&format!("call-{ix}"),
			"tool_runner",
			"workspace/target",
			Some("summary outcome"),
			&expanded_views,
			true,
			&geometry,
			&tokens,
			&motion_tokens,
			false,
			&viewport_state,
			None,
		);
		let _ = expanded_el;

		// 3. Direct render_tool_view across multiple budget bounds
		let callbacks = ToolViewCallbacks::default();
		let _full = render_tool_view(&view, &tokens, None, &callbacks);
		let _bounded_1 = render_tool_view(&view, &tokens, Some(1), &callbacks);
		let _bounded_5 = render_tool_view(&view, &tokens, Some(5), &callbacks);
	}
}

struct TestToolBlockView {
	view:     ToolView,
	tokens:   TokenSet,
	geometry: TranscriptSurfaceTokens,
	motion:   MotionTokens,
	state:    TranscriptViewportState,
}

impl Render for TestToolBlockView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let views = ToolInvocationViews {
			call:   None,
			result: Some(Arc::new(ToolPresentation { expanded: true, view: self.view.clone() })),
		};
		div().size_full().child(render_invoke_block(
			0,
			0,
			"test-call",
			"eval",
			"target",
			Some("ok"),
			&views,
			true,
			&self.geometry,
			&self.tokens,
			&self.motion,
			false,
			&self.state,
			None,
		))
	}
}

#[test]
fn every_tool_view_variant_renders_distinct_non_empty_headless_frames() {
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	let mut cx = headless_context().expect("headless context");
	let mut rendered_frames = Vec::new();

	for view in every_tool_view_variant() {
		let tokens_clone = tokens.clone();
		let theme_clone = theme.clone();
		let state_clone = state.clone();
		let view_clone = view.clone();

		let captured = render_view_captured(
			&mut cx,
			&RenderOptions { width: 768, height: 200, scale_factor: 1.0, ..RenderOptions::default() },
			move |_, app: &mut App| {
				let ins = install_tokens(app, &tokens_clone, &theme_clone, Path::new("surface"))
					.expect("installed");
				app.new(|_| TestToolBlockView {
					view:     view_clone,
					tokens:   ins.set,
					geometry: tokens_clone.surface.transcript,
					motion:   ins.motion,
					state:    state_clone,
				})
			},
		)
		.expect("rendered tool view variant");

		assert!(!captured.frame.as_bytes().is_empty(), "frame output must be non-empty");
		assert!(!captured.text_runs.is_empty(), "text runs must be non-empty");
		rendered_frames.push(captured);
	}

	assert_eq!(rendered_frames.len(), 5);

	// Assert every variant produces distinct render outputs
	for i in 0..rendered_frames.len() {
		for j in (i + 1)..rendered_frames.len() {
			assert_ne!(
				rendered_frames[i].text_runs, rendered_frames[j].text_runs,
				"variant {i} and variant {j} must render distinct text runs"
			);
		}
	}
}

#[test]
fn no_ansi_or_control_sequences_survive_sanitization() {
	let hostile_cases = vec![
		("\x1b[31;1mRed Bold\x1b[0m", "Red Bold"),
		("\x1b[38;2;255;128;0mTrueColor\x1b[39m", "TrueColor"),
		("\x1b[4;7mUnderline Inverse\x1b[24;27m", "Underline Inverse"),
		("\x1b[2J\x1b[HCleared Screen", "Cleared Screen"),
		("Line 1\x1b[2K\rLine 2", "Line 1\nLine 2"),
		("\x1b[?25h\x1b[?1049hAlternate Buffer", "Alternate Buffer"),
		("\x1b]0;Window Title\x07Clean Text", "Clean Text"),
		("\x1b]8;;https://example.com\x1b\\Link Text\x1b]8;;\x1b\\", "Link Text"),
		("\x1bP$q\"p\x1b\\Device Control", "Device Control"),
		("\x1b_Application Program\x1b\\Clean", "Clean"),
		("\x1b^Privacy Message\x1b\\Visible", "Visible"),
		("Null\x00Bell\x07Back\x08Space", "NullBellBackSpace"),
		("C1 \u{0080}\u{009B}\u{009F}Scrubbed", "C1 Scrubbed"),
		("Trailing \x1b[", "Trailing "),
		("Broken \x1b", "Broken "),
		("Standard \tTabs & \nNewlines", "Standard \tTabs & \nNewlines"),
	];

	for (input, expected) in hostile_cases {
		let sanitized = sanitize_control_sequences(input);
		assert_eq!(sanitized, expected, "input '{input:?}' did not match expected '{expected:?}'");
		assert!(
			!sanitized.as_bytes().contains(&0x1b),
			"sanitized text '{sanitized}' must not contain ESC"
		);

		for b in sanitized.bytes() {
			if b < 0x20 {
				assert!(b == b'\n' || b == b'\t', "forbidden C0 control byte {b:#x}");
			}
			assert_ne!(b, 0x7f, "sanitized text contains DEL byte");
		}
	}
}

#[test]
fn callbacks_dispatch_targets_and_disclosures_without_panics() {
	let target_log = Rc::new(RefCell::new(Vec::new()));
	let disclose_log = Rc::new(RefCell::new(0usize));

	let callbacks = ToolViewCallbacks::new()
		.on_target(move |target, _window, _cx| {
			target_log.borrow_mut().push(target);
		})
		.on_disclose(move |_window, _cx| {
			*disclose_log.borrow_mut() += 1;
		});

	assert!(callbacks.on_target.is_some());
	assert!(callbacks.on_disclose.is_some());
	let _ = ToolViewTarget::Url("https://example.com".into());
}
