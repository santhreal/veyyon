//! WHY: the four icon boxes were a table compiled into the kit, so editing an
//! icon size meant editing Rust and `scale.toml` stated three of the desktop's
//! measures and not the fourth. They are authored now, and an authored measure
//! nothing reads is the failure this repository keeps finding: the loader
//! parses it, the struct carries it, and the renderer draws the number it
//! always drew.
//!
//! THE CLASS THIS CLOSES: an icon box that no longer reaches the raster. The
//! steps come from `IconSizeStep::all()` at run time, so a fifth box added to
//! the ramp is swept with no edit here. Each step is rendered alone on a
//! ground and measured by the ink it puts down: the shipped ramp must draw a
//! strictly larger mark at each larger box, and doubling one step's authored
//! value must grow that step's mark. A renderer that goes back to a compiled
//! constant leaves the mutated frame identical and fails by name.
//!
//! WHAT IT DOES NOT CATCH: an icon drawn at the right size in the wrong place,
//! and the stroke it is drawn with, which `[stroke]` authors and the control
//! sweep covers.

use veyyon_desktop_kit::{
	ColorRole, TokenSet,
	icons::{Icon, IconName, IconSize},
};
use veyyon_desktop_scene::{
	Appearance, Headless, RenderOptions, RgbaFrame, headless_context, render_view,
};
use veyyon_desktop_tokens::{IconSizeStep, Tokens, load_bundled_theme, load_bundled_tokens};
use veyyon_gpui::{AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div};

/// A box large enough for the largest authored icon and nothing else.
const OPTIONS: RenderOptions = RenderOptions {
	width:        64,
	height:       64,
	scale_factor: 1.0,
	appearance:   Appearance::Dark,
	seed:         7,
};

/// One icon on the ground, with no chrome to put ink of its own down.
struct IconSurface {
	size: IconSize,
}

impl Render for IconSurface {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let tokens = TokenSet::for_app(cx).into_owned();
		div().size_full().bg(tokens.color(ColorRole::Ground)).child(
			Icon::new(IconName::Settings)
				.size(self.size)
				.color(tokens.color(ColorRole::Foreground)),
		)
	}
}

fn token_set(tokens: &Tokens) -> TokenSet {
	let theme = load_bundled_theme("dark").expect("a bundled theme must load");
	TokenSet::from_tokens(tokens, &theme).expect("the bundled token set must be valid")
}

/// The pixels an icon put down over the ground it was drawn on.
fn ink(frame: &RgbaFrame) -> usize {
	let ground = frame.pixel(0, 0).expect("the frame has a first pixel");
	frame
		.pixels()
		.filter(|pixel| {
			pixel.r.abs_diff(ground.r) > 8
				|| pixel.g.abs_diff(ground.g) > 8
				|| pixel.b.abs_diff(ground.b) > 8
		})
		.count()
}

fn ink_of(cx: &mut Headless, tokens: &Tokens, size: IconSize) -> usize {
	let set = token_set(tokens);
	let frame = render_view(cx, &OPTIONS, |_window, app| {
		app.set_global(set);
		app.new(|_cx| IconSurface { size })
	})
	.expect("the icon surface must render");
	ink(&frame)
}

/// `tokens` with the box `step` authors doubled.
fn with_doubled_box(tokens: &Tokens, step: IconSizeStep) -> Tokens {
	let mut mutated = tokens.clone();
	mutated.scale.icon_sizes[step as usize] *= 2.0;
	mutated
}

#[test]
fn every_authored_icon_box_draws_a_larger_mark_than_the_one_below_it() {
	let tokens = load_bundled_tokens().expect("the bundled tokens must load");
	let mut cx = headless_context().expect("a Vulkan ICD is required");

	let marks: Vec<(IconSizeStep, usize)> = IconSizeStep::all()
		.into_iter()
		.map(|step| (step, ink_of(&mut cx, &tokens, step)))
		.collect();

	let blank: Vec<IconSizeStep> = marks
		.iter()
		.filter(|(_, mark)| *mark == 0)
		.map(|(step, _)| *step)
		.collect();
	let none: Vec<IconSizeStep> = Vec::new();
	assert_eq!(blank, none, "an icon box that draws nothing cannot be measured at all");

	let not_growing: Vec<(IconSizeStep, usize, usize)> = marks
		.windows(2)
		.filter(|pair| pair[1].1 <= pair[0].1)
		.map(|pair| (pair[1].0, pair[0].1, pair[1].1))
		.collect();
	let none: Vec<(IconSizeStep, usize, usize)> = Vec::new();
	assert_eq!(
		not_growing, none,
		"(step, ink at the step below, ink at this step): a larger authored box that marks no more \
		 of the frame is not the box being drawn"
	);
}

#[test]
fn doubling_an_authored_box_grows_the_mark_that_step_draws() {
	let tokens = load_bundled_tokens().expect("the bundled tokens must load");
	let mut cx = headless_context().expect("a Vulkan ICD is required");

	let unmoved: Vec<(IconSizeStep, usize, usize)> = IconSizeStep::all()
		.into_iter()
		.map(|step| {
			let shipped = ink_of(&mut cx, &tokens, step);
			let doubled = ink_of(&mut cx, &with_doubled_box(&tokens, step), step);
			(step, shipped, doubled)
		})
		.filter(|(_, shipped, doubled)| doubled <= shipped)
		.collect();

	let none: Vec<(IconSizeStep, usize, usize)> = Vec::new();
	assert_eq!(
		unmoved, none,
		"(step, shipped ink, ink at twice the authored box): a step whose mark does not grow is \
		 drawn from something other than `scale.toml`"
	);
}
