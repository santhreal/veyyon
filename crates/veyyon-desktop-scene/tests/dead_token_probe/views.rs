//! What the dead-token sweep looks at: one surface holding every primitive and
//! tool view that draws a swept measure, a hovered tooltip, and the box an
//! input method is placed against.

use veyyon_desktop_kit::{
	AnchorCorner, Button, ButtonSize, ColorRole, Popover, SpacingStep, Spinner, TokenSet, Tooltip,
	input::Editor,
};
use veyyon_desktop_model::tool_view::{
	NoticeView, ViewCodeLines, ViewDiffLines, ViewSpan, ViewStatus,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::{
	Appearance, Headless, HeadlessSession, PrimitiveKind, RenderOptions, headless::render_view,
	render_primitive,
};
use veyyon_desktop_surface::{
	model::ToolInvocationViews,
	tool_view::{ToolViewCallbacks, render_code_lines, render_diff_lines, render_notice},
	transcript::{blocks::invoke::render_invoke_block, state::TranscriptViewportState},
};
use veyyon_desktop_tokens::{Tokens, load_bundled_theme};
use veyyon_gpui::{
	AppContext, Context, Div, Entity, IntoElement, ParentElement, Point, Render, Styled, Window,
	div, point, px,
};

use super::{Observation, frame_observation};

/// Every surface the sweep renders, at the size the probe is laid out for.
const fn options(appearance: Appearance) -> RenderOptions {
	RenderOptions { width: 900, height: 700, scale_factor: 1.0, appearance, seed: 7 }
}

fn token_set(tokens: &Tokens, appearance: Appearance) -> TokenSet {
	let name = match appearance {
		Appearance::Dark => "dark",
		Appearance::Light => "light",
	};
	let theme = load_bundled_theme(name).expect("a bundled theme must load");
	TokenSet::from_tokens(tokens, &theme).expect("the bundled token set must be valid")
}

/// The surface every drawn measure appears on.
struct ProbeSurface {
	tokens: Tokens,
}

impl Render for ProbeSurface {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let tokens = TokenSet::for_app(cx).into_owned();
		div()
			.size_full()
			.bg(tokens.color(ColorRole::Ground))
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S4))
			.child(sized_controls())
			.child(render_primitive(PrimitiveKind::Toggle, window, cx))
			.child(render_primitive(PrimitiveKind::ScrollView, window, cx))
			.child(edge_popover(&tokens))
			.child(floats(&tokens))
			.child(tool_views(&tokens))
			.child(invoked_call(&self.tokens, &tokens))
	}
}

/// A tool call whose result is summarised beside its name, which is the one
/// place the summary width is drawn.
fn invoked_call(tokens: &Tokens, resolved: &TokenSet) -> Div {
	let motion = MotionTokens::from(tokens.motion.clone());
	render_invoke_block(
		0,
		0,
		"call-1",
		"bash",
		"cargo test --workspace",
		Some("running 412 tests across every crate in the workspace"),
		&ToolInvocationViews::default(),
		false,
		&tokens.surface.transcript,
		resolved,
		&motion,
		true,
		&TranscriptViewportState::default(),
		None,
		None,
	)
}

/// One control at each authored height, so a height only one size uses still
/// moves a pixel.
fn sized_controls() -> Div {
	let mut row = div().flex().flex_row().gap(px(8.0));
	for (id, size) in
		[("small", ButtonSize::Small), ("medium", ButtonSize::Medium), ("large", ButtonSize::Large)]
	{
		row = row.child(Button::new(id, "Run").size(size));
	}
	// The ring is the one place the spinner's own strength is drawn.
	row.child(Spinner::new())
}

/// A popover declaring no size, at an origin the authored estimate fits at
/// and a larger one does not, so the corner it is flipped to follows the
/// estimate on each axis.
fn edge_popover(tokens: &TokenSet) -> Div {
	div().relative().h(px(40.0)).child(
		Popover::new(
			point(px(500.0), px(400.0)),
			AnchorCorner::TopLeft,
			div()
				.w(px(120.0))
				.h(px(40.0))
				.bg(tokens.color(ColorRole::Accent)),
		)
		.id("edge-popover"),
	)
}

/// Three floats at three rises, so a bound that does not bind at one rise
/// binds at another, and one float frosting a striped ground behind it.
fn floats(tokens: &TokenSet) -> Div {
	let mut row = div()
		.flex()
		.flex_row()
		.gap(tokens.spacing(SpacingStep::S6))
		.h(px(120.0));
	for shadows in [
		tokens.float_shadows_elevation(0.5),
		tokens.float_shadows(),
		tokens.float_shadows_elevation(200.0),
	] {
		row = row.child(
			div()
				.w(px(120.0))
				.h(px(60.0))
				.bg(tokens.float_ground())
				.rounded(tokens.radius(veyyon_desktop_kit::RadiusStep::Lg))
				.shadow(shadows),
		);
	}
	row.child(
		div()
			.relative()
			.w(px(160.0))
			.h(px(60.0))
			.bg(tokens.color(ColorRole::Accent))
			.child(
				div()
					.absolute()
					.size_full()
					.bg(tokens.float_ground())
					.backdrop_blur(tokens.overlay_blur())
					.backdrop_saturation(tokens.float_saturation()),
			),
	)
}

/// The tool views whose dense rows carry the transcript's `[tool_view]`
/// measures: a code listing with line numbers, a diff with its gutter, and a
/// notice with a body under its headline.
fn tool_views(tokens: &TokenSet) -> Div {
	let span = |text: &str| ViewSpan { text: text.to_owned(), ..ViewSpan::default() };
	let lines = vec![vec![span("fn main() {")], vec![span("    render();")], vec![span("}")]];
	let code = ViewCodeLines {
		line_numbers: Some(vec![Some(1), Some(2), Some(3)]),
		..ViewCodeLines::default()
	};
	let diff = ViewDiffLines {
		line_numbers: Some(vec![Some(11), Some(12), Some(13)]),
		path: Some("src/render.rs".to_owned()),
		..ViewDiffLines::default()
	};
	let notice = NoticeView {
		state:    ViewStatus::Info,
		mark:     None,
		headline: vec![span("Two files changed")],
		tag:      None,
		body:     vec![vec![span("src/render.rs")], vec![span("src/layout.rs")]],
	};
	let callbacks = ToolViewCallbacks::new();
	div()
		.flex()
		.flex_col()
		.w(px(520.0))
		.gap(tokens.spacing(SpacingStep::S2))
		.child(render_code_lines(&lines, &code, 0, tokens, &callbacks))
		.child(render_diff_lines(&lines, &diff, 0, tokens, &callbacks))
		.child(render_notice(&notice, tokens, &callbacks))
}

/// Two tooltip anchors, each placed where the side it opens on is decided by
/// the estimated size: the right-hand one fits its estimated width beside the
/// window edge and not a wider one, the lower one fits its estimated height
/// under the anchor and not a taller one.
struct TooltipSurface;

/// Where each anchor sits, and where a hover must land to open it.
const TOOLTIP_RIGHT: Point<f32> = Point { x: 700.0, y: 300.0 };
const TOOLTIP_BELOW: Point<f32> = Point { x: 200.0, y: 630.0 };

impl Render for TooltipSurface {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let tokens = TokenSet::for_app(cx).into_owned();
		div()
			.size_full()
			.bg(tokens.color(ColorRole::Ground))
			.child(
				div()
					.absolute()
					.left(px(TOOLTIP_RIGHT.x))
					.top(px(TOOLTIP_RIGHT.y))
					.child(Tooltip::new("Inspect run", Button::new("beside", "Inspect")).right()),
			)
			.child(
				div()
					.absolute()
					.left(px(TOOLTIP_BELOW.x))
					.top(px(TOOLTIP_BELOW.y))
					.child(Tooltip::new("Open the run", Button::new("under", "Open")).below()),
			)
	}
}

/// A multiline editor, for the box an input method is placed against and for
/// the width an unmeasured editor falls back to.
struct EditorSurface {
	editor: Entity<Editor>,
}

impl Render for EditorSurface {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let tokens = TokenSet::for_app(cx).into_owned();
		div()
			.size_full()
			.bg(tokens.color(ColorRole::Ground))
			.flex()
			.flex_row()
			// An item sized from its content is measured with no width, which
			// is the one state the unmeasured fallback is drawn at.
			.child(div().flex_none().child(self.editor.clone()))
	}
}

/// Renders every probe surface against `tokens`, in both appearances.
pub fn render_all(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let mut out = Vec::new();
	for (name, appearance) in [("probe-dark", Appearance::Dark), ("probe-light", Appearance::Light)]
	{
		let set = token_set(tokens, appearance);
		let frame = render_view(cx, &options(appearance), |_window, app| {
			app.set_global(set);
			app.new(|_cx| ProbeSurface { tokens: tokens.clone() })
		})
		.expect("the probe surface must render");
		out.push(frame_observation(name, &frame));
	}
	out.extend(hovered_tooltips(cx, tokens));
	out.extend(editor_observations(cx, tokens));
	out
}

/// The frames with each tooltip tag open, which is the only state its
/// placement is visible in.
fn hovered_tooltips(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	[("tooltip-beside", TOOLTIP_RIGHT), ("tooltip-under", TOOLTIP_BELOW)]
		.into_iter()
		.map(|(name, anchor)| {
			let set = token_set(tokens, Appearance::Dark);
			let options = options(Appearance::Dark);
			let mut session = HeadlessSession::open(cx, &options, |_window, app| {
				app.set_global(set);
				app.new(|_cx| TooltipSurface)
			})
			.expect("the tooltip surface must open");
			session
				.hover(anchor_point(anchor))
				.expect("hovering the anchor must render");
			let captured = session.frame().expect("the hovered frame must capture");
			frame_observation(name, &captured.frame)
		})
		.collect()
}

/// A point inside the anchor at `corner`, clear of its edge and its border.
fn anchor_point(corner: Point<f32>) -> Point<veyyon_gpui::Pixels> {
	point(px(corner.x + 12.0), px(corner.y + 8.0))
}

/// What a multiline editor produces: the box an input method is placed
/// against, where the caret width is reported and never drawn, and the frame
/// itself, where the width an unmeasured editor wraps at is.
fn editor_observations(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let set = token_set(tokens, Appearance::Dark);
	let options = options(Appearance::Dark);
	let mut editor_slot = None;
	let mut session = HeadlessSession::open(cx, &options, |_window, app| {
		app.set_global(set);
		let editor = app.new(|cx| {
			let mut editor = Editor::new(
				veyyon_desktop_kit::input::EditorMode::Multiline { newline_on_enter: true },
				cx,
			);
			// Enough words that the line count follows the width the editor
			// wrapped at, so a wider fallback draws a shorter block.
			editor.buffer_mut().set_text(
				"caret wraps against the width an unmeasured editor falls back to".to_owned(),
			);
			editor
		});
		editor_slot = Some(editor.clone());
		app.new(|_cx| EditorSurface { editor })
	})
	.expect("the editor surface must open");
	session.type_text("!").expect("typing must render");
	let captured = session.frame().expect("the editor frame must capture");
	let editor = editor_slot.expect("the editor entity must be built");
	let text = session
		.update(|_root, window, cx| {
			editor.update(cx, |ed, cx| {
				let bounds = veyyon_gpui::Bounds {
					origin: point(px(0.0), px(0.0)),
					size:   veyyon_gpui::Size { width: px(400.0), height: px(200.0) },
				};
				let caret =
					veyyon_gpui::EntityInputHandler::bounds_for_range(ed, 0..0, bounds, window, cx);
				format!("{caret:?}")
			})
		})
		.expect("the editor must report a box");
	vec![frame_observation("editor-wrapped", &captured.frame), Observation::Report {
		name: "input-method-box",
		text,
	}]
}
