//! Fixtures for the share half of §6.7: one long primary beside one long
//! detail, with every other field of the row left empty.
//!
//! The containment fixtures in the parent module fill every text field at
//! once, which is right for asking whether anything escapes the block and
//! wrong for asking which role took the room. A row carrying an emblem, a
//! badge, a language marker and a trailing meta entry, each one seeded far
//! past its own share, is over subscribed: the primary is starved by
//! arithmetic rather than by a role that failed to yield, and a share
//! assertion over it would fail whatever the renderer does. Each case here
//! seeds exactly one detail, so the width it took is attributable to the one
//! role that drew it.
//!
//! These cases also render `render_tool_view` on its own rather than through
//! the invoke card the parent module uses. A share is read by attributing each
//! shaped run to the box that held it, and the card draws its own header from
//! the same host text a few pixels above the row, so every run has a twin of a
//! similar width in a band the row does not own. Attributing across that would
//! be a guess about the card's chrome; `render_tool_view` is the function the
//! card itself calls with the width it resolved, so the row's runs are the
//! only runs on the frame.

use std::path::Path;

use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::tool_view::{
	StatusRowBadge, StatusRowView, TextBlockView, ToolView, ViewSpan, ViewTone,
};
use veyyon_desktop_scene::headless::{
	Captured, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	install_tokens,
	tool_view::{ToolViewCallbacks, render_tool_view},
};
use veyyon_gpui::{App, AppContext, Context, IntoElement, ParentElement, Render, Styled, div, px};

use super::{BLOCK_W, overlong};

/// One long primary beside one long detail.
pub struct Detail {
	/// What to call the case in a failure.
	pub kind:  &'static str,
	/// The view to render, seeded with one detail and nothing else.
	pub view:  ToolView,
	/// The fraction of the line §6.7 allows this detail to hold.
	pub share: f32,
}

/// A row carrying a long title and no detail of any kind.
///
/// No status either: a status draws a glyph at the row's left edge, and the
/// cases below read the primary text off the leftmost run.
fn titled() -> StatusRowView {
	StatusRowView { title: overlong(), ..StatusRowView::default() }
}

/// Every place a detail is set beside a row's primary text, one case each,
/// with the share §6.7 allows it.
///
/// A detail the host says fits is not here: it shares the room that is left
/// with the title on equal terms rather than holding a ceiling, so there is no
/// share to assert.
pub fn every_detail_beside_a_primary() -> Vec<Detail> {
	let long = overlong();
	vec![
		Detail {
			kind:  "status row description",
			view:  ToolView::StatusRow(StatusRowView {
				description: Some(long.clone()),
				description_tone: Some(ViewTone::Text),
				description_fits: false,
				..titled()
			}),
			share: 0.5,
		},
		Detail {
			kind:  "status row badge",
			view:  ToolView::StatusRow(StatusRowView {
				badge: Some(StatusRowBadge { label: long.clone(), tone: ViewTone::DiffAdded }),
				..titled()
			}),
			share: 0.25,
		},
		Detail {
			kind:  "status row language",
			view:  ToolView::StatusRow(StatusRowView { language: Some(long.clone()), ..titled() }),
			share: 0.25,
		},
		Detail {
			kind:  "status row meta",
			view:  ToolView::StatusRow(StatusRowView {
				meta: vec![vec![ViewSpan::text(long.clone())]],
				..titled()
			}),
			share: 0.25,
		},
		Detail {
			kind:  "text line trailing",
			view:  ToolView::TextBlock(TextBlockView {
				spans: vec![ViewSpan::text(long.clone()), ViewSpan {
					text: long,
					trailing: true,
					..ViewSpan::default()
				}],
			}),
			share: 0.5,
		},
	]
}

/// A shaped run narrower than this is the ellipsis a starved box was left
/// with, or a separator glyph beside it, and not the row's text.
const RUN_FLOOR: f32 = 3.0;

/// One shaped run: where its left edge sits and how wide it was shaped.
pub struct Run {
	/// Logical pixels from the row's left edge.
	pub left:  f32,
	/// Logical pixels of shaped width.
	pub width: f32,
}

/// The row under test, at the width the suite hands it.
struct RowAtWidth {
	view:   ToolView,
	tokens: TokenSet,
}

impl Render for RowAtWidth {
	fn render(
		&mut self,
		_window: &mut veyyon_gpui::Window,
		_cx: &mut Context<Self>,
	) -> impl IntoElement {
		div()
			.size_full()
			.child(div().w(px(BLOCK_W)).child(render_tool_view(
				&self.view,
				&self.tokens,
				None,
				&ToolViewCallbacks::default(),
			)))
	}
}

/// Renders `view` at `BLOCK_W`, the width the card resolves for it.
fn capture_row(view: ToolView) -> Captured {
	let bundled = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled theme loads");
	let mut cx = headless_context().expect("the headless context opens");
	render_view_captured(
		&mut cx,
		&RenderOptions { width: BLOCK_W as u32, height: 320, ..RenderOptions::default() },
		move |_window, app: &mut App| {
			let installed = install_tokens(app, &bundled, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| RowAtWidth { view, tokens: installed.set })
		},
	)
	.expect("the row renders")
}

/// The runs `view` registered, left to right.
///
/// Every case above renders on one clipped row laid out left to right, so a
/// run is one shaped line, its recorded width is the width of the box that
/// held it, and the leftmost run is the row's primary text. That is the only
/// arrangement where run geometry answers a question about layout: a wrapping
/// line records its unwrapped width and says nothing about either.
pub fn runs_left_to_right(view: ToolView) -> Vec<Run> {
	let mut runs: Vec<Run> = capture_row(view)
		.text_runs
		.iter()
		.map(|run| Run {
			left:  f32::from(run.bounds.origin.x),
			width: f32::from(run.bounds.size.width),
		})
		.filter(|run| run.width > RUN_FLOOR)
		.collect();
	runs.sort_by(|left, right| left.left.total_cmp(&right.left));
	runs
}
