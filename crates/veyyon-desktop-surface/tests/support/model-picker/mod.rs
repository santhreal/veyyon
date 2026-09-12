//! The catalogue a host reports, and the window that lists it.
//!
//! Several test binaries include this module and each uses a subset of it, so
//! each `mod` site carries its own `allow(dead_code)`.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	Captured,
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, ModelChoice, ModelControl, ModelOption, Overlay, PaletteState, ShellState,
	ShellView, composer::ThinkingControl, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point};

pub const WINDOW_W: u32 = 1440;
pub const WINDOW_H: u32 = 900;

/// The catalogue the host reported: three accounts, one of them serving two
/// models, and the model in effect listed last so both the grouping and the
/// lift of the active row move it away from the position the host gave it.
pub fn control() -> ModelControl {
	let option = |provider: &str, model: &str, name: &str, reasoning: bool| ModelOption {
		choice: ModelChoice::new(provider, model),
		name: name.to_owned(),
		reasoning,
		input: Vec::new(),
	};
	ModelControl {
		current: Some(ModelChoice::new("aimlapi", "qwen3-thinking")),
		options: vec![
			option("openrouter", "z-ai/glm-4.7", "GLM 4.7", true),
			option("anthropic", "claude-opus-4.1", "Claude Opus 4.1", true),
			option("aimlapi", "alibaba/qwen-max", "alibaba/qwen-max", false),
			option("anthropic", "claude-sonnet-4.5", "Claude Sonnet 4.5", true),
			option("aimlapi", "qwen3-thinking", "Qwen3 Thinking", true),
		],
	}
}

/// The levels the host reported, with the third of four in effect, so a chord
/// that wraps is told apart from one that saturates at the end.
pub fn thinking() -> ThinkingControl {
	ThinkingControl {
		level:  "medium".to_owned(),
		levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
	}
}

/// The shell with that catalogue in the footer.
pub fn state() -> ShellState {
	let mut state = fixture::populated();
	state.composer.model = Some(control());
	state.composer.thinking = Some(thinking());
	state
}

/// A live window over `shell` with the keymap bound, so a chord reaches the
/// same handler it reaches in the product rather than a listener a test
/// installed.
pub fn window<R>(
	shell: ShellState,
	test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("a headless renderer is required");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options = RenderOptions {
		width: WINDOW_W,
		height: WINDOW_H,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, shell))
	})
	.expect("the window opens offscreen");
	test(&mut session)
}

/// A live window over the reported catalogue.
pub fn session<R>(test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
	window(state(), test)
}

/// Opens the model catalogue the way the composer's chip and the composer chord
/// both open it, and drops the overlay intent so what a press sends is read on
/// its own.
pub fn open_models(session: &mut HeadlessSession<'_, ShellView>) {
	session
		.update(|view, window, cx| {
			view.open_model_picker(window, cx);
			view.drain_intents();
		})
		.expect("the catalogue opens");
	session.frame().expect("the catalogue draws");
}

/// Opens the effort rows the way an operator reaches them: the command surface,
/// the command's own spelling typed into it, and the row it leaves selected run
/// by the return key.
pub fn open_effort(session: &mut HeadlessSession<'_, ShellView>) {
	session
		.update(|view, window, cx| {
			view.open_command_palette(window, cx);
			view.drain_intents();
		})
		.expect("the command surface opens");
	session.frame().expect("the command surface draws");
	session.type_text("/effort").expect("the command is typed");
	session.frame().expect("the ranked frame draws");
	assert!(
		session
			.keystroke("enter")
			.expect("the return key dispatches"),
		"the return key reached no handler over the command surface"
	);
	session.frame().expect("the effort rows draw");
}

/// The titles the palette ranked, in the order it drew them.
pub fn ranked(session: &mut HeadlessSession<'_, ShellView>) -> Vec<String> {
	session
		.update(|view, _window, _cx| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.expect("a palette is open")
				.filtered_items()
				.iter()
				.map(|item| item.title.clone())
				.collect()
		})
		.expect("the ranked rows are read back")
}

/// The row the palette rests on.
pub fn selected(session: &mut HeadlessSession<'_, ShellView>) -> Option<String> {
	session
		.update(|view, _window, _cx| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.and_then(PaletteState::selected_item)
				.map(|item| item.title.clone())
		})
		.expect("the selected row is read back")
}

/// What the row titled `title` must send, read from the host's own catalogue
/// rather than from the list the palette built out of it.
pub fn choice_of(title: &str) -> ModelChoice {
	let options = control().options;
	let Some(option) = options.iter().find(|option| option.name == title) else {
		panic!("{title} is a row the host never reported")
	};
	option.choice.clone()
}

/// Presses the return key and reports what the shell sent for the host, having
/// asserted the palette closed behind the row that ran.
pub fn confirm(session: &mut HeadlessSession<'_, ShellView>) -> Vec<Intent> {
	assert!(
		session
			.keystroke("enter")
			.expect("the return key dispatches"),
		"the return key reached no handler over the palette"
	);
	sent(session)
}

/// What the shell holds for the host, with the palette asserted closed.
pub fn sent(session: &mut HeadlessSession<'_, ShellView>) -> Vec<Intent> {
	session
		.update(|view, _window, _cx| {
			assert!(
				view.state().overlay.is_none(),
				"the palette stayed open behind the row that was run"
			);
			view.drain_intents()
		})
		.expect("what the press sent is read back")
}

/// Steps the selection `times` rows with `chord` from the row a fresh palette
/// rests on.
pub fn step(session: &mut HeadlessSession<'_, ShellView>, chord: &str, times: usize) {
	for _ in 0..times {
		assert!(
			session.keystroke(chord).expect("the arrow key dispatches"),
			"the {chord} key reached no handler over the palette"
		);
	}
	session.frame().expect("the moved selection draws");
}

/// Every row rect the palette drew: a hit rect the height the results tokens
/// author, no wider than the surface the palette geometry sizes.
///
/// Taken from the frame rather than computed, so a row drawn outside the box it
/// registered is missed by neither the press nor the count.
pub fn row_rects(frame: &Captured, width_px: f32, row_height_px: f32) -> Vec<Bounds<Pixels>> {
	let mut rows: Vec<Bounds<Pixels>> = frame
		.hitboxes
		.iter()
		.copied()
		.filter(|rect| {
			(f32::from(rect.size.height) - row_height_px).abs() < 1.0
				&& f32::from(rect.size.width) <= width_px + 1.0
				&& f32::from(rect.size.width) > width_px / 2.0
		})
		.collect();
	rows.sort_by(|a, b| {
		f32::from(a.origin.y)
			.partial_cmp(&f32::from(b.origin.y))
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	rows.dedup();
	rows
}

pub fn centre(rect: Bounds<Pixels>) -> Point<Pixels> {
	Point { x: rect.origin.x + rect.size.width / 2.0, y: rect.origin.y + rect.size.height / 2.0 }
}
