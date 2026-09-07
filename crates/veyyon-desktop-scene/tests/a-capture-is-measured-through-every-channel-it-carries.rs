//! WHY THIS TEST EXISTS:
//! A capture carries three channels - the quad tree, the shaped text runs and
//! the registered hit rects - and the quad tree carries neither text nor
//! interactivity. Measuring the tree alone therefore reported `text: 0` and
//! `density: 0.0` for every scene in the catalogue however much prose and
//! however many controls the frame held, and counted gaps that span a line of
//! prose as rhythm. Three of the six §9.6 metrics were wrong on every line the
//! CLI printed, and two of them could never breach their §6.6 ceiling.
//!
//! THE CLASS THIS CLOSES: a metric silently reading a channel that carries
//! nothing. Each of the three channels is asserted through `measure` on a frame
//! built to hold exactly one known value of it, so a metric that stops reading
//! its channel reports zero here and turns red. The text channel is proved by
//! difference: the same geometry is rendered with and without a line of prose
//! lying in one gap, and the gap it crosses is counted only when the prose is
//! absent.
//!
//! WHAT IT DOES NOT CATCH: whether the ceilings are the right numbers, and
//! whether a frame that measures well looks good. §6.6 owns the first and a
//! person looking at the sheet owns the second.

use veyyon_desktop_scene::{
	RenderOptions, RgbaColor, headless_context, hitbox_centers, measure,
	metrics::compute_distinct_gaps, render_view_captured, rhythm_spans, text_sizes,
};
use veyyon_gpui::{
	App, AppContext, Context, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	ParentElement, Render, Styled, Window, div, px, rgb,
};

const GROUND: u32 = 0x0b_0b_0e;
const CANVAS: u32 = 0x1e_1e_28;

/// A frame with one known value of each channel: two text sizes, one hit rect,
/// and two pairs of rects separated by the same 8px gap. `prose_in_gap` lays a
/// line of text across the first pair's gap.
struct Probe {
	prose_in_gap: bool,
}

impl Render for Probe {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let rect = |top: f32, left: f32| {
			div()
				.absolute()
				.top(px(top))
				.left(px(left))
				.w(px(200.0))
				.h(px(20.0))
				.bg(rgb(CANVAS))
		};
		let mut root = div()
			.relative()
			.size_full()
			.bg(rgb(GROUND))
			.child(
				div()
					.absolute()
					.top(px(20.0))
					.left(px(20.0))
					.text_size(px(13.0))
					.child("thirteen"),
			)
			.child(
				div()
					.absolute()
					.top(px(60.0))
					.left(px(20.0))
					.text_size(px(18.0))
					.child("eighteen"),
			)
			.child(
				div()
					.id("the-one-control")
					.absolute()
					.top(px(200.0))
					.left(px(20.0))
					.w(px(80.0))
					.h(px(24.0))
					.bg(rgb(CANVAS))
					.on_mouse_down(MouseButton::Left, |_event: &MouseDownEvent, _window, _cx| {}),
			)
			// 8px between each pair, so the value is backed by two spans and
			// survives the accident filter.
			.child(rect(300.0, 20.0))
			.child(rect(328.0, 20.0))
			.child(rect(400.0, 300.0))
			.child(rect(428.0, 300.0));
		if self.prose_in_gap {
			root = root.child(
				div()
					.absolute()
					.top(px(318.0))
					.left(px(20.0))
					.text_size(px(13.0))
					.child("prose across the gap"),
			);
		}
		root
	}
}

fn options() -> RenderOptions {
	RenderOptions { width: 600, height: 500, scale_factor: 1.0, ..RenderOptions::default() }
}

#[test]
fn the_text_and_hit_channels_reach_the_metrics_the_tree_cannot_carry() {
	let mut cx = headless_context().expect("a headless renderer");
	let captured = render_view_captured(&mut cx, &options(), |_window, app: &mut App| {
		app.new(|_| Probe { prose_in_gap: false })
	})
	.expect("the probe renders offscreen");

	let measured = measure(&captured, RgbaColor::new(11, 11, 14, 255));

	let mut sizes = text_sizes(&captured);
	sizes.dedup_by(|a, b| (*a - *b).abs() <= 0.1);
	assert_eq!(sizes, vec![13.0, 18.0], "the shaped runs carry the two authored sizes");
	assert_eq!(
		measured.metrics.distinct_text_sizes, 2,
		"a quad tree has no text leaves, so this is zero unless the runs are read"
	);

	assert_eq!(hitbox_centers(&captured).len(), 1, "one element registered a listener");
	assert_eq!(measured.interactive, 1);
	assert!(
		measured.metrics.element_density > 0.0,
		"a quad tree marks no box interactive, so density is zero unless the hit rects are read"
	);

	assert!(measured.metrics.ink_ratio > 0.0, "the frame paints over its ground");
}

#[test]
fn a_gap_a_line_of_prose_crosses_is_content_and_not_rhythm() {
	let mut cx = headless_context().expect("a headless renderer");

	let clear = render_view_captured(&mut cx, &options(), |_window, app: &mut App| {
		app.new(|_| Probe { prose_in_gap: false })
	})
	.expect("the probe renders offscreen");
	let spans = rhythm_spans(&clear);
	assert_eq!(
		spans.keys().copied().collect::<Vec<_>>(),
		vec![8],
		"two pairs 8px apart make one rhythm value"
	);
	assert_eq!(spans[&8].len(), 2, "both pairs back it");
	assert!(
		compute_distinct_gaps(&clear.layout) > spans.len(),
		"the raw tree count also holds the window's own remainders, which are not rhythm"
	);

	let crossed = render_view_captured(&mut cx, &options(), |_window, app: &mut App| {
		app.new(|_| Probe { prose_in_gap: true })
	})
	.expect("the probe renders offscreen");
	let spans = rhythm_spans(&crossed);
	assert!(
		spans.is_empty(),
		"prose suppresses the gap it crosses, leaving one span the accident filter drops: {:?}",
		spans.keys().collect::<Vec<_>>()
	);
}
