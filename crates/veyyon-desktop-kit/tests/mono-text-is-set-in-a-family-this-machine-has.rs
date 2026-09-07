//! WHY: `TokenSet::mono_family` returned the compiled literal `"monospace"`.
//! A font system resolves a family by name, so that lookup failed and GPUI
//! substituted its proportional fallback stack for every terminal cell, diff
//! row and code line, silently (§9.3). Ten more sites set a mono size and no
//! family at all, which is the same picture reached a different way: text
//! measured in columns, drawn in a face whose glyphs each have their own
//! advance.
//!
//! CLASS CLOSED: mono text drawn in a proportional face. The families are an
//! ordered chain in `scale.toml`; `resolve_mono_family` selects the first the
//! machine has and fails loud when it has none; `MonoText::mono_text` sets
//! family, size and line height in one call, so a caller cannot take the size
//! and leave the family. The advance assertions below are what prove the
//! selected face is monospaced rather than merely named: a run of narrow
//! glyphs and a run of wide ones are shaped and their widths compared, with
//! the proportional ramp beside them as the control that the frame can tell
//! the two apart.
//!
//! NOT CAUGHT: a surface that draws mono content through neither `mono_text`
//! nor `mono_family` and inherits the proportional family from its parent.
//! Nothing here observes the family a text run was shaped with — GPUI's
//! captured runs carry size and bounds only — so the evidence is the advance,
//! which needs text under the caller's control.

mod common;

use common::{headless_context, render_frame};
use veyyon_desktop_kit::{MonoSizeStep, MonoText, TextRamp, TokenSet};
use veyyon_gpui::{
	AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div, px, size,
};

/// Sixteen glyphs of the same width in a monospaced face, and of visibly
/// different widths in a proportional one.
const NARROW: &str = "iiiiiiiiiiiiiiii";
const WIDE: &str = "MMMMMMMMMMMMMMMM";

/// Whether the two runs are drawn as mono text or through the proportional
/// text ramp.
#[derive(Clone, Copy)]
enum Face {
	Mono,
	Ramp,
}

/// Two rows, one of narrow glyphs and one of wide, sized by content so each
/// row's text run is the width the face shaped it to.
struct TwoRuns {
	face: Face,
}

impl Render for TwoRuns {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let resolved = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved;
		let row = |text: &'static str| {
			let el = div().flex_shrink_0().child(text);
			match self.face {
				Face::Mono => el.mono_text(tokens, MonoSizeStep::Small),
				Face::Ramp => el
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small)),
			}
		};
		div()
			.flex()
			.flex_col()
			.items_start()
			.child(row(NARROW))
			.child(row(WIDE))
	}
}

/// Shapes both rows in one frame and reports their run widths, narrow first.
fn run_widths(face: Face) -> (f32, f32) {
	let (mut cx, _permit) = headless_context();
	let window = cx
		.open_window(size(px(600.0), px(200.0)), |_window, app| {
			let mut set = TokenSet::default();
			let available = app.text_system().all_font_names();
			set.resolve_mono_family(&available)
				.expect("this machine must have one of the authored monospace families");
			app.set_global(set);
			app.new(|_cx| TwoRuns { face })
		})
		.expect("headless window opens");
	render_frame(&mut cx, &window);

	let frame = cx
		.capture_frame(window.into(), 1.0)
		.expect("the frame rasterises");
	let mut runs: Vec<_> = frame.text_runs().to_vec();
	assert_eq!(runs.len(), 2, "the fixture draws exactly two text runs");
	runs.sort_by(|a, b| {
		a.bounds
			.origin
			.y
			.partial_cmp(&b.bounds.origin.y)
			.expect("finite origins")
	});
	(f32::from(runs[0].bounds.size.width), f32::from(runs[1].bounds.size.width))
}

/// The face the chain resolved to shapes every glyph to one advance, so a row
/// of narrow glyphs and a row of wide ones occupy the same width. This is the
/// property a terminal grid, a diff gutter and a code block all read by.
#[test]
fn mono_text_shapes_narrow_and_wide_glyphs_to_the_same_width() {
	let (narrow, wide) = run_widths(Face::Mono);
	assert!(
		(narrow - wide).abs() <= 1.0,
		"mono text must advance by the cell: {NARROW} drew {narrow}px and {WIDE} drew {wide}px"
	);
	assert!(narrow > 0.0, "the fixture must draw ink, not an empty run");
}

/// The control: the same two strings through the proportional ramp differ by
/// far more than the tolerance above. Without this the equality could hold
/// because the frame reports a container width, or nothing at all.
#[test]
fn the_proportional_ramp_draws_the_same_two_strings_at_different_widths() {
	let (narrow, wide) = run_widths(Face::Ramp);
	assert!(
		wide - narrow > 20.0,
		"the proportional control must separate the two strings: {NARROW} drew {narrow}px and \
		 {WIDE} drew {wide}px"
	);
}

/// Resolution walks the chain in order and takes the first family present,
/// rather than the first family named.
#[test]
fn resolution_skips_a_family_the_machine_lacks_and_takes_the_next_one() {
	let tokens = veyyon_desktop_kit::load_bundled_tokens().expect("bundled tokens load");
	let chain = tokens.scale.mono_family_chain().to_vec();
	assert!(chain.len() >= 2, "this case needs a chain with a second choice: {chain:?}");

	let mut set = TokenSet::default();
	set.resolve_mono_family(&chain[1..].to_vec())
		.expect("a machine with the second choice resolves");
	assert_eq!(set.mono_family().as_ref(), chain[1].as_str());

	let mut both = TokenSet::default();
	both
		.resolve_mono_family(&chain)
		.expect("a machine with every family resolves");
	assert_eq!(both.mono_family().as_ref(), chain[0].as_str(), "the first choice wins when present");
}

/// A machine with none of the authored families stops the install and names
/// every family it looked for. Drawing columns in a substituted face is the
/// failure this refuses to reach.
#[test]
fn a_machine_without_any_authored_family_fails_and_names_the_chain() {
	let tokens = veyyon_desktop_kit::load_bundled_tokens().expect("bundled tokens load");
	let chain = tokens.scale.mono_family_chain().to_vec();

	let mut set = TokenSet::default();
	let error = set
		.resolve_mono_family(&["Comic Sans MS".to_string()])
		.expect_err("a machine without a mono face must not draw columns proportionally");
	let message = error.to_string();
	for family in &chain {
		assert!(message.contains(family.as_str()), "the error omits {family:?}: {message}");
	}
	assert!(message.contains("type.family.mono"), "the error omits the key: {message}");
}
