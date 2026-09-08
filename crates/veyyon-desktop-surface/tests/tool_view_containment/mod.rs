//! Fixtures and the measuring harness for the tool view containment suite.
//!
//! Every text-bearing field a host can fill is seeded with the same
//! unbreakable run, far wider than the block, so a renderer that happens to
//! wrap on a space cannot pass by luck. Nothing here asserts; the suite that
//! includes this module does.

pub mod shares;

use std::{path::Path, sync::Arc};

use strum::EnumIter;
use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::tool_view::{
	FramedBlockView, HeadedBlockView, NoticeView, StatusRowBadge, StatusRowView, TextBlockView,
	ToolPresentation, ToolView, ViewCodeLines, ViewDiffLines, ViewDiffSide, ViewHiddenCount,
	ViewNoun, ViewSection, ViewSpan, ViewStatus, ViewTailWindow, ViewTone, ViewTreeLines,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::{
	frame::RgbaFrame,
	headless::{Captured, RenderOptions, headless_context, render_view_captured},
};
use veyyon_desktop_surface::{
	install_tokens,
	model::ToolInvocationViews,
	transcript::{TranscriptViewportState, blocks::render_invoke_block},
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{App, AppContext, Context, IntoElement, ParentElement, Render, Styled, div, px};

/// The width the block is given. The window is wider, so anything that escapes
/// the block lands in a margin no tool view is entitled to draw in, and the
/// escape is measurable rather than clipped away by the window itself.
pub const BLOCK_W: f32 = 520.0;

/// The margin to the right of the block, inside the window.
const MARGIN: f32 = 260.0;

/// Device columns skipped at the block's right edge. A border and a glyph that
/// ends exactly on the edge are antialiased across the boundary pixel, and
/// that is the edge being drawn, not text escaping it.
const EDGE_AA_PX: u32 = 2;

/// Ground is sampled here, in device pixels in from the window's right and top
/// edges: far from the block, so it is the window's own canvas.
const GROUND_PROBE_PX: u32 = 4;

/// One unbreakable run, far wider than the block at any ramp.
///
/// Letters only. A real invocation carries `=`, `/`, `.` and `-`, and a shaper
/// takes a break at each of them, so a fixture spelled that way lets a
/// wrapping renderer pass without ever being asked to hold a run it cannot
/// break. This is the worst case every renderer meets the same way.
pub fn overlong() -> String {
	"UNBREAKABLERUNOFHOSTTEXTWITHNOSPACEANDNOBREAKOPPORTUNITYINSIDEIT".repeat(6)
}

/// The section shapes `render_section` dispatches between, in that precedence.
/// Every shape is reached by seeding the field that selects it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, EnumIter)]
pub enum SectionShape {
	Diff,
	Code,
	Markdown,
	Tree,
	List,
	Prose,
}

impl SectionShape {
	/// The shape's name, for the pin and for a failure that has to say which
	/// case escaped.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Diff => "diff",
			Self::Code => "code",
			Self::Markdown => "markdown",
			Self::Tree => "tree",
			Self::List => "list",
			Self::Prose => "prose",
		}
	}

	/// A section of this shape whose every text-bearing field is one
	/// unbreakable run wider than the block.
	///
	/// `clip` is the host's own `ViewSection::clip`: set, the section's lines
	/// are held to one row each and marked where they were cut; clear, they
	/// are allowed to wrap.
	fn section(self, clip: bool) -> ViewSection {
		let long = overlong();
		let base = ViewSection {
			clip,
			label: Some(long.clone()),
			// The section's disclosure states a count that cannot be opened;
			// the headed block below states one that can, so the sweep reaches
			// both arms of the affordance.
			hidden: Some(ViewHiddenCount {
				count:      12,
				noun:       Some(ViewNoun { one: long.clone(), many: long.clone() }),
				revealable: false,
			}),
			// A tail window that omits its front, so the notice naming what
			// was dropped is on the frame rather than in an arm nothing
			// reaches.
			tail: Some(ViewTailWindow { max: Some(1), viewport: false, reserve: None }),
			lines: vec![vec![ViewSpan::text(long.clone())], vec![ViewSpan::text(long.clone())]],
			..Default::default()
		};
		match self {
			Self::Diff => ViewSection {
				diff: Some(ViewDiffLines {
					sides:        vec![ViewDiffSide::Added],
					line_numbers: Some(vec![Some(1)]),
					path:         Some(long),
				}),
				..base
			},
			Self::Code => ViewSection {
				code: Some(ViewCodeLines {
					language: Some("bash".into()),
					total_lines: Some(1),
					line_numbers: Some(vec![Some(1)]),
					lead: Some(format!("$ {long}")),
					..Default::default()
				}),
				..base
			},
			Self::Markdown => ViewSection { markdown: true, ..base },
			Self::Tree => ViewSection {
				tree: Some(ViewTreeLines { depth: vec![0], opens: vec![true], last: vec![true] }),
				..base
			},
			Self::List => ViewSection { list: true, ..base },
			Self::Prose => base,
		}
	}
}

/// A status row header whose every field is one unbreakable run.
fn overlong_header() -> StatusRowView {
	let long = overlong();
	StatusRowView {
		status:                Some(ViewStatus::Running),
		emblem:                Some(long.clone()),
		emblem_tone:           Some(ViewTone::Success),
		title:                 long.clone(),
		title_tone:            Some(ViewTone::Title),
		description:           Some(long.clone()),
		description_tone:      Some(ViewTone::Text),
		description_fits:      true,
		description_file:      Some(long.clone()),
		description_file_line: Some(4096),
		description_link:      None,
		badge:                 Some(StatusRowBadge {
			label: long.clone(),
			tone:  ViewTone::DiffAdded,
		}),
		meta:                  vec![vec![ViewSpan::text(long.clone())]],
		language:              Some(long),
	}
}

/// One case: what to call it in a failure, the view to render, and whether the
/// variant holds each of its lines to one row.
pub struct Case {
	pub kind:     &'static str,
	pub view:     ToolView,
	pub one_line: bool,
}

/// Every `ToolView` variant, each carrying `shape` wherever it holds sections
/// and one unbreakable run in every other text field.
///
/// `one_line` is read off the variant's own contract, not off the renderer: a
/// view that bounds itself in LINES — `TextBlockView` through the row budget,
/// `HeadedBlockView` through `tail.max` and `reserve`, a status row through its
/// fixed height — cannot let one line become three rows without spending a
/// budget it declared in a different unit. A `ViewSection` says so itself
/// through `clip`, except a markdown section, which `render_section` dispatches
/// before every clip-aware arm and so is a document that wraps. A notice body
/// declares no budget, so it may wrap too.
///
/// The match below is exhaustive, so a variant added to `ToolView` fails to
/// compile here until it is seeded.
pub fn variants_holding(shape: SectionShape, clip: bool) -> Vec<Case> {
	let long = overlong();
	let lines = vec![vec![ViewSpan::text(long.clone())]];
	let cases = vec![
		Case {
			kind:     "statusRow",
			view:     ToolView::StatusRow(overlong_header()),
			one_line: true,
		},
		Case {
			kind:     "textBlock",
			view:     ToolView::TextBlock(TextBlockView {
				spans: vec![ViewSpan::text(long.clone()).bold()],
			}),
			one_line: true,
		},
		Case {
			kind:     "headedBlock",
			view:     ToolView::HeadedBlock(HeadedBlockView {
				header: Some(overlong_header()),
				lines:  lines.clone(),
				hidden: Some(ViewHiddenCount {
					count:      9,
					noun:       Some(ViewNoun { one: long.clone(), many: long.clone() }),
					revealable: true,
				}),
				tail:   None,
			}),
			one_line: true,
		},
		Case {
			kind:     "framedBlock",
			view:     ToolView::FramedBlock(FramedBlockView {
				header:   Some(overlong_header()),
				state:    Some(ViewStatus::Done),
				sections: vec![shape.section(clip)],
				contents: None,
				gutter:   true,
			}),
			one_line: clip && !matches!(shape, SectionShape::Markdown),
		},
		Case {
			kind:     "notice",
			view:     ToolView::Notice(NoticeView {
				state:    ViewStatus::Warning,
				mark:     Some(long.clone()),
				headline: vec![ViewSpan::text(long.clone())],
				tag:      Some(long),
				body:     lines,
			}),
			one_line: false,
		},
	];
	for case in &cases {
		match &case.view {
			ToolView::StatusRow(_)
			| ToolView::TextBlock(_)
			| ToolView::HeadedBlock(_)
			| ToolView::FramedBlock(_)
			| ToolView::Notice(_) => {},
		}
	}
	cases
}

/// The block under test, at the width this suite hands it, inside a wider
/// window.
struct BlockAtWidth {
	view:     ToolView,
	tokens:   TokenSet,
	geometry: TranscriptSurfaceTokens,
	motion:   MotionTokens,
	state:    TranscriptViewportState,
}

impl Render for BlockAtWidth {
	fn render(
		&mut self,
		_window: &mut veyyon_gpui::Window,
		_cx: &mut Context<Self>,
	) -> impl IntoElement {
		let views = ToolInvocationViews {
			call:   None,
			result: Some(Arc::new(ToolPresentation { expanded: true, view: self.view.clone() })),
		};
		div()
			.size_full()
			.child(div().w(px(BLOCK_W)).child(render_invoke_block(
				0,
				0,
				"containment",
				"bash",
				"target",
				Some("failed"),
				&views,
				true,
				&self.geometry,
				&self.tokens,
				&self.motion,
				false,
				&self.state,
				None,
			)))
	}
}

/// Renders `view` the way the transcript draws it, in a block `BLOCK_W` wide
/// inside a wider window.
fn capture(view: ToolView) -> Captured {
	let bundled = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled theme loads");
	let mut cx = headless_context().expect("the headless context opens");
	let geometry = bundled.surface.transcript.clone();
	let state = TranscriptViewportState::new();
	render_view_captured(
		&mut cx,
		&RenderOptions { width: (BLOCK_W + MARGIN) as u32, height: 900, ..RenderOptions::default() },
		move |_window, app: &mut App| {
			let installed = install_tokens(app, &bundled, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| BlockAtWidth {
				view,
				tokens: installed.set,
				geometry,
				motion: installed.motion,
				state,
			})
		},
	)
	.expect("the block renders")
}

/// The widest shaped run `view` registered, in logical pixels.
pub fn widest_shaped_run(view: ToolView) -> f32 {
	capture(view)
		.text_runs
		.iter()
		.map(|run| f32::from(run.bounds.size.width))
		.fold(0.0_f32, f32::max)
}

/// What a rendered view put where.
pub struct Ink {
	/// Device pixels right of the block that differ from the window's ground.
	pub outside:   usize,
	/// The rightmost logical column any of them sits at.
	pub rightmost: f32,
	/// Device pixels inside the block that differ from the ground. The control
	/// against a blank raster: a clean margin proves nothing on an empty frame.
	pub inside:    usize,
	/// Shaped text runs the frame registered, so a renderer that dropped its
	/// content cannot pass by painting nothing.
	pub runs:      usize,
}

/// Reads the raster for what `view` painted on either side of the block's right
/// edge.
pub fn ink_of(view: ToolView) -> Ink {
	let captured = capture(view);
	let frame = &captured.frame;
	let height = device_height(frame);
	let width = frame.as_bytes().len() as u32 / 4 / height;
	let ground = frame
		.pixel(width - GROUND_PROBE_PX, GROUND_PROBE_PX)
		.expect("the ground probe is inside the frame");
	let first_margin_col = frame
		.device_x(BLOCK_W)
		.expect("the block's right edge is inside the frame")
		+ EDGE_AA_PX;

	let scale = frame.scale_factor();
	let mut ink =
		Ink { outside: 0, rightmost: 0.0, inside: 0, runs: captured.text_runs.len() };
	for y in 0..height {
		for x in 0..width {
			if frame.pixel(x, y).is_some_and(|pixel| pixel != ground) {
				if x >= first_margin_col {
					ink.outside += 1;
					ink.rightmost = ink.rightmost.max(x as f32 / scale);
				} else {
					ink.inside += 1;
				}
			}
		}
	}
	ink
}

/// The frame's device height, so the row stride is exact.
fn device_height(frame: &RgbaFrame) -> u32 {
	(frame.logical_height() * frame.scale_factor()).round() as u32
}
