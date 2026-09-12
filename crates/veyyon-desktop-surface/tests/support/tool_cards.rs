//! One tool card, rendered through the production invoke block, for the suites
//! that measure what a collapsed row draws and what it states.
//!
//! Every fixture here is taller than a row on purpose: a card that fits in its
//! row proves nothing about a row that has to hold one back.

use std::{path::Path, sync::Arc, time::Instant};

use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::tool_view::{
	FramedBlockView, HeadedBlockView, NoticeView, StatusRowBadge, StatusRowView, TextBlockView,
	ToolPresentation, ToolView, ViewHiddenCount, ViewNoun, ViewSection, ViewSpan, ViewStatus,
	ViewTone,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::headless::{RenderOptions, headless_context, render_view_captured};
use veyyon_desktop_surface::{
	install_tokens,
	model::ToolInvocationViews,
	transcript::{TranscriptViewportState, blocks::render_invoke_block},
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div, px,
};

/// The transcript's collapsed chrome height: the row a collapsed card occupies.
#[must_use]
pub fn row_height_px() -> f32 {
	load_bundled_tokens()
		.expect("bundled tokens")
		.surface
		.transcript
		.chrome_collapsed_height_px
}

/// The canonical kind of a view, matched exhaustively so a new variant is a
/// compile error here rather than an untested case.
#[must_use]
pub const fn kind_of(view: &ToolView) -> &'static str {
	match view {
		ToolView::StatusRow(_) => "statusRow",
		ToolView::TextBlock(_) => "textBlock",
		ToolView::HeadedBlock(_) => "headedBlock",
		ToolView::FramedBlock(_) => "framedBlock",
		ToolView::Notice(_) => "notice",
	}
}

/// One view of every kind, each carrying more than a row can hold: several
/// lines, several sections, a body, meta rows and held-back counts.
#[must_use]
pub fn views_taller_than_a_row() -> Vec<ToolView> {
	let lines = || {
		vec![
			vec![ViewSpan::text("printf 'running 6 tests'")],
			vec![ViewSpan::text("running 6 tests")],
			vec![ViewSpan::text("test transcribes_a_16k_mono_wav ... ok")],
			vec![ViewSpan::text("test rejects_a_truncated_header ... ok")],
		]
	};

	vec![
		ToolView::StatusRow(StatusRowView {
			status: Some(ViewStatus::Success),
			emblem: Some("check".into()),
			title: "bash".into(),
			description: Some("printf 'running 6 tests'".into()),
			badge: Some(StatusRowBadge { label: "0.02s".into(), tone: ViewTone::Muted }),
			// Meta rows are extra lines a status row can carry, and a row that
			// stacks them is exactly as tall as the block it should not be.
			meta: vec![vec![ViewSpan::text("wall 0.02s")], vec![ViewSpan::text("timeout 300s")]],
			..Default::default()
		}),
		ToolView::TextBlock(TextBlockView {
			spans: vec![
				ViewSpan::text("Building core target...\n").bold(),
				ViewSpan::text("warning: unused variable `x`\n").tone(ViewTone::Warning),
				ViewSpan::text("warning: unused import `std::fmt`\n").tone(ViewTone::Warning),
				ViewSpan::text("finished in 4.10s").tone(ViewTone::Success),
			],
		}),
		ToolView::HeadedBlock(HeadedBlockView {
			header: None,
			lines:  lines(),
			hidden: Some(ViewHiddenCount {
				count:      12,
				noun:       Some(ViewNoun { one: "line".into(), many: "lines".into() }),
				revealable: true,
			}),
			tail:   None,
		}),
		ToolView::FramedBlock(FramedBlockView {
			header:   None,
			state:    Some(ViewStatus::Success),
			sections: vec![
				ViewSection { label: Some("Command".into()), lines: lines(), ..ViewSection::new() },
				ViewSection { label: Some("Output".into()), lines: lines(), ..ViewSection::new() },
			],
			contents: None,
			gutter:   false,
		}),
		ToolView::Notice(NoticeView {
			state:    ViewStatus::Error,
			mark:     Some("x".into()),
			headline: vec![ViewSpan::text("bash exited 127")],
			tag:      Some("bash".into()),
			body:     lines(),
		}),
	]
}

/// Renders one view through the production collapsed or expanded invoke block.
struct CardUnderTest {
	view:     ToolView,
	expanded: bool,
	tokens:   TokenSet,
	geometry: TranscriptSurfaceTokens,
	motion:   MotionTokens,
	state:    TranscriptViewportState,
}

impl Render for CardUnderTest {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let views = ToolInvocationViews {
			call:   None,
			result: Some(Arc::new(ToolPresentation {
				expanded: self.expanded,
				view:     self.view.clone(),
			})),
		};
		// The card sits at the top-left with nothing above it, so a painted box
		// past the row's bottom edge is the card's own overflow and not an
		// offset the harness introduced.
		div().w(px(768.0)).child(render_invoke_block(
			0,
			0,
			"call-1",
			"bash",
			"printf 'running 6 tests'",
			Some("running 6 tests"),
			&views,
			self.expanded,
			&self.geometry,
			&self.tokens,
			&self.motion,
			true,
			&self.state,
			None,
			None,
		))
	}
}

/// What one render of the card says about its size and its row.
pub struct Drawn {
	/// The lowest edge the card draws to: the bottom of its lowest painted box
	/// or shaped text run, whichever reaches further. Both are needed — a row of
	/// plain text paints no quad at all, and a card's frame paints no text.
	pub bottom:      f32,
	/// The highest edge it draws to. A card centred in a row too short for it
	/// spills in both directions, and the block above it is the casualty.
	pub top:         f32,
	/// The height of every rect the frame will answer a click on. The card's
	/// disclosure row is one of them, and a collapsed card offers no taller one.
	pub hit_heights: Vec<f32>,
	/// How many shaped text runs start inside the row: the tool's name, the
	/// view's one-line projection, and the count of what the row holds back
	/// when it states one.
	pub row_runs:    usize,
}

/// Renders `view` collapsed or expanded and measures the frame.
///
/// # Arguments
/// * `view` - The canonical view the host supplied for the card.
/// * `expanded` - Whether the card is disclosed.
#[must_use]
pub fn draw(view: &ToolView, expanded: bool) -> Drawn {
	let bundled = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	let motion = MotionTokens::reference();
	let row_height = bundled.surface.transcript.chrome_collapsed_height_px;

	if expanded {
		// The disclosure the operator performs, at rest: reduced motion settles
		// the reveal in one step rather than leaving it mid-animation.
		state.set_block_expanded(0, 0, true, &motion, true, Instant::now());
	}

	let mut cx = headless_context().expect("headless context");
	let mut drawn =
		Drawn { bottom: 0.0, top: 0.0, hit_heights: Vec::new(), row_runs: 0 };

	// The reveal container measures its child at prepaint and draws the recorded
	// height on the frame after, so the card is rendered twice: the first frame
	// measures, the second draws what was measured.
	for _ in 0..2 {
		let tokens = bundled.clone();
		let theme = theme.clone();
		let state = state.clone();
		let view = view.clone();

		let captured = render_view_captured(
			&mut cx,
			&RenderOptions { width: 768, height: 640, scale_factor: 1.0, ..RenderOptions::default() },
			move |_, app: &mut App| {
				let installed =
					install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
				app.new(|_| CardUnderTest {
					view,
					expanded,
					tokens: installed.set,
					geometry: tokens.surface.transcript,
					motion: installed.motion,
					state,
				})
			},
		)
		.expect("rendered card");

		let quad_bottom = captured
			.layout
			.painted_boxes()
			.map(|painted| painted.bounds.bottom)
			.fold(0.0_f32, f32::max);
		let run_bottom = captured
			.text_runs
			.iter()
			.map(|run| f32::from(run.bounds.bottom()))
			.fold(0.0_f32, f32::max);
		let quad_top = captured
			.layout
			.painted_boxes()
			.map(|painted| painted.bounds.top)
			.fold(0.0_f32, f32::min);
		let run_top = captured
			.text_runs
			.iter()
			.map(|run| f32::from(run.bounds.top()))
			.fold(0.0_f32, f32::min);
		drawn = Drawn {
			bottom:      quad_bottom.max(run_bottom),
			top:         quad_top.min(run_top),
			hit_heights: captured
				.hitboxes
				.iter()
				.map(|hit| f32::from(hit.size.height))
				.collect(),
			row_runs:    captured
				.text_runs
				.iter()
				.filter(|run| f32::from(run.bounds.top()) < row_height)
				.count(),
		};
	}

	drawn
}
