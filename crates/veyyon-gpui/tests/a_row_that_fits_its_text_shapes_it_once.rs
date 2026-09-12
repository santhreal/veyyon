//! WHY THIS SUITE EXISTS
//!
//! Patch P9 adds a persistent text advance cache on `TextSystem`. When
//! measuring a row to fit it and then laying it out to paint, text is shaped
//! once instead of twice, and a second frame over unchanged rows shapes
//! nothing.
//!
//! This suite proves through the vendored snapshot that a row of single-line
//! text fitting within its column bounds shapes its text exactly once on
//! initial render (frame 1), and requires zero shaping calls on a subsequent
//! frame when its content remains unchanged.
//!
//! THE CLASS THIS CLOSES: redundant shaping of identical text across
//! measurement passes and successive frames in the UI layout pipeline.
//!
//! WHAT IT DOES NOT CATCH: shaping behavior across distinct fonts or font
//! sizes, or text cache eviction under memory pressure beyond the cache
//! capacity.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use veyyon_gpui::{
	App, AppContext, Context, HeadlessAppContext, IntoElement, ParentElement as _, Pixels, Render,
	Size, Styled as _, Window, div, px,
};

struct FittingRowScene {
	rows: Vec<String>,
}

impl Render for FittingRowScene {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().flex().flex_col().w(px(256.0)).children(
			self
				.rows
				.iter()
				.cloned()
				.map(|row_text| div().w_full().truncate().child(row_text)),
		)
	}
}

const fn frame_size() -> Size<Pixels> {
	Size { width: px(320.0), height: px(400.0) }
}

static RENDERER: Mutex<()> = Mutex::new(());

fn headless_context() -> (HeadlessAppContext, MutexGuard<'static, ()>) {
	let permit = RENDERER.lock().unwrap_or_else(PoisonError::into_inner);
	let text_system = Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
	let cx = HeadlessAppContext::with_platform(text_system, Arc::new(()), || {
		gpui_platform::current_headless_renderer()
	});
	(cx, permit)
}

#[test]
fn a_row_that_fits_its_text_shapes_it_once() {
	let (mut cx, _permit) = headless_context();
	let rows: Vec<String> = (0..40).map(|i| format!("Row {i:02}: item text")).collect();

	let text_system = cx.text_system().clone();
	text_system.reset_shaping_calls();

	// Frame 1
	let _frame1 = cx
		.render_frame(frame_size(), 1.0, |_window, app: &mut App| {
			let rows = rows.clone();
			app.new(|_| FittingRowScene { rows })
		})
		.expect("headless render frame 1");

	let frame_1_calls = text_system.shaping_calls();
	assert_eq!(frame_1_calls, 40, "frame 1 must shape each distinct row exactly once");

	// Frame 2 with identical content
	text_system.reset_shaping_calls();
	let _frame2 = cx
		.render_frame(frame_size(), 1.0, |_window, app: &mut App| {
			let rows = rows.clone();
			app.new(|_| FittingRowScene { rows })
		})
		.expect("headless render frame 2");

	let frame_2_calls = text_system.shaping_calls();
	assert_eq!(frame_2_calls, 0, "frame 2 with unchanged rows must perform 0 shaping calls");
}
