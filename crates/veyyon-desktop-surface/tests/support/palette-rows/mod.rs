//! Fixtures for the palette suites: a headless capture of the shell with a
//! palette open, and the model catalogues those suites list.
#![allow(dead_code, reason = "each test binary uses a subset of these fixtures")]

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::headless::{Captured, RenderOptions, render_view_captured};
use veyyon_desktop_surface::{
	Intent, ModelChoice, Overlay, PaletteItem, PaletteState, ShellView,
	composer::{ModelControl, ModelOption},
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, HeadlessAppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

/// Captures the shell with `palette` open, so the rows under test are the ones
/// the window actually draws rather than a fixture of them.
pub fn captured(cx: &mut HeadlessAppContext, palette: PaletteState) -> Captured {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	render_view_captured(cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| {
			let mut state = fixture::populated();
			state.overlay = Some(Overlay::Palette(palette));
			ShellView::new(installed, state)
		})
	})
	.expect("the shell renders offscreen")
}

pub fn text_run_count(captured: &Captured) -> usize {
	captured.text_runs.len()
}

/// Two accounts: the one holding the model in effect listed second, so the
/// heading order under test is not the order the host reported.
pub fn model_control() -> ModelControl {
	let plain = ModelChoice { provider: "aimlapi".into(), model: "alibaba/qwen-max".into() };
	let thinker = ModelChoice { provider: "aimlapi".into(), model: "qwen3-thinking".into() };
	let other = ModelChoice { provider: "openrouter".into(), model: "z-ai/glm-4.7".into() };
	ModelControl {
		current:    Some(plain.clone()),
		options:    vec![
			ModelOption {
				choice:    other,
				name:      "GLM 4.7".into(),
				reasoning: true,
				input:     Vec::new(),
			},
			ModelOption {
				choice:    plain,
				name:      "alibaba/qwen-max".into(),
				reasoning: false,
				input:     Vec::new(),
			},
			ModelOption {
				choice:    thinker,
				name:      "Qwen3 Thinking".into(),
				reasoning: true,
				input:     Vec::new(),
			},
		],
		selectable: true,
	}
}

/// `count` rows carrying nothing but a title and a heading, two rows per
/// heading, so a window of them costs more headings than a surface holding
/// eight bare rows has room for.
pub fn grouped_rows(count: u64) -> Vec<PaletteItem> {
	(0..count)
		.map(|index| {
			let mut item =
				PaletteItem::command(index + 1, format!("model-{index}"), Intent::NewSession, None);
			item.group = Some(format!("account-{}", index / 2));
			item
		})
		.collect()
}
