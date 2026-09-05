//! The headless half of the iteration engine (§9.4–9.7).
//!
//! `build` turns a scene name into the protocol state it shows, `render`
//! rasterises it with the window's tokens, `sweep` materialises k candidate
//! token sets, and this module runs the subcommands over them, printing one
//! line of measurements per frame so a judgement is made on numbers beside
//! the image rather than on the image alone.

pub mod build;
pub mod render;
pub mod seed;
pub mod sweep;

use std::path::{Path, PathBuf};

use veyyon_desktop_scene::{
	Captured, MetricReport, RenderOptions, SceneRegistry, SheetCell, SheetGrid, SurfaceClass,
	compute_metrics, headless_context, tile, write_png,
};
use veyyon_desktop_tokens::{Theme, Tokens, dump_to_dir, load_theme};

pub use self::{
	build::{SceneBuildError, SceneRoot, build},
	render::{Assets, Rendered, SceneRenderError, SceneWindow, matching},
	seed::{Built, SCENE_CLOCK_MS, Seed},
	sweep::{SweepError, TokenKey, candidates, materialise},
};
use crate::{
	StartupBundle,
	cli::{FrameArgs, RenderCommand, SceneCommand, SweepCommand, TokensCommand},
};

/// The process exit code of a subcommand.
const OK: i32 = 0;
const FAILED: i32 = 1;

impl FrameArgs {
	fn options(&self) -> RenderOptions {
		RenderOptions {
			width: self.width,
			height: self.height,
			scale_factor: self.scale,
			appearance: self.appearance.into(),
			..RenderOptions::default()
		}
	}

	/// The theme of the requested appearance, from the bundle's themes
	/// directory.
	fn theme(&self, bundle: &StartupBundle) -> Result<Theme, veyyon_desktop_tokens::TokenError> {
		let appearance: veyyon_desktop_scene::Appearance = self.appearance.into();
		load_theme(
			&bundle
				.paths
				.themes_dir
				.join(format!("{}.toml", appearance.as_str())),
		)
	}
}

/// `scene list` and `scene render`.
pub fn run_scene(bundle: &StartupBundle, command: SceneCommand) -> i32 {
	let registry = SceneRegistry::new();
	match command {
		SceneCommand::List { pattern } => list(&registry, &pattern),
		SceneCommand::Render(command) => report(render(bundle, &registry, &command)),
	}
}

/// `sweep`.
pub fn run_sweep(bundle: &StartupBundle, command: SweepCommand) -> i32 {
	report(sweep(bundle, &SceneRegistry::new(), &command))
}

/// `tokens dump`.
pub fn run_tokens(bundle: &StartupBundle, command: TokensCommand) -> i32 {
	let TokensCommand::Dump { out } = command;
	match dump_to_dir(&bundle.tokens, &out) {
		Ok(()) => {
			println!("wrote the live token set under {}", out.display());
			OK
		},
		Err(error) => {
			eprintln!("tokens dump failed: {error}");
			FAILED
		},
	}
}

fn report(result: Result<(), Box<dyn std::error::Error>>) -> i32 {
	match result {
		Ok(()) => OK,
		Err(error) => {
			eprintln!("{error}");
			FAILED
		},
	}
}

/// Prints every scene a pattern names, marking the ones nothing in the
/// protocol can produce.
fn list(registry: &SceneRegistry, pattern: &str) -> i32 {
	let scenes = registry.find_glob(pattern);
	if scenes.is_empty() {
		eprintln!("no scene matches {pattern}");
		return FAILED;
	}
	for scene in scenes {
		match build(scene) {
			Ok(_) => println!("{}", scene.name),
			Err(SceneBuildError::Unreachable { reason, .. }) => {
				println!("{}\tunreachable: {reason}", scene.name);
			},
			Err(error) => println!("{}\terror: {error}", scene.name),
		}
	}
	OK
}

/// One rendered scene, labelled and measured.
fn cell(
	name: &str,
	captured: Captured,
	assets: &Assets<'_>,
) -> Result<SheetCell, SceneRenderError> {
	let metrics = compute_metrics(&captured.layout, &captured.frame, assets.ground()?);
	let report = MetricReport::new(metrics, SurfaceClass::WholeWindow);
	println!(
		"{name}\t{}x{}@{}\t{report}",
		captured.frame.width(),
		captured.frame.height(),
		captured.frame.scale_factor()
	);
	Ok(SheetCell::new(name, captured.frame).with_metrics(metrics))
}

fn render(
	bundle: &StartupBundle,
	registry: &SceneRegistry,
	command: &RenderCommand,
) -> Result<(), Box<dyn std::error::Error>> {
	let scenes = matching(registry, &command.pattern)?;
	let theme = command.frame.theme(bundle)?;
	let assets = Assets {
		tokens:       &bundle.tokens,
		theme:        &theme,
		surface_path: &bundle.surface_path,
	};
	let options = command.frame.options();
	let mut cx = headless_context()?;
	let mut cells = Vec::with_capacity(scenes.len());
	let mut rendered = 0usize;
	let mut window = SceneWindow::open(&mut cx, &options)?;
	for scene in &scenes {
		let Rendered { captured, unprojected } = match window.render(&assets, scene) {
			Ok(rendered) => rendered,
			Err(SceneRenderError::Build(SceneBuildError::Unreachable { reason, .. })) => {
				println!("{}\tskipped, unreachable: {reason}", scene.name);
				continue;
			},
			Err(error) => return Err(error.into()),
		};
		rendered += 1;
		for id in unprojected {
			eprintln!("{}\tread an availability no projection set: {id:?}", scene.name);
		}
		let sheet_cell = cell(&scene.name, captured, &assets)?;
		if command.contact_sheet {
			cells.push(sheet_cell);
		} else {
			let path = png_path(&command.out, &scene.name);
			write_png(&sheet_cell.frame, &path)?;
			println!("\t-> {}", path.display());
		}
	}
	if rendered == 0 {
		return Err(SceneRenderError::NoMatch(command.pattern.clone()).into());
	}
	drop(window);
	if command.contact_sheet {
		let sheet = tile(&mut cx, cells, SheetGrid::new(command.columns), options.scale_factor)?;
		let path = command.out.join("contact-sheet.png");
		write_png(&sheet, &path)?;
		println!("{rendered} cells -> {}", path.display());
	}
	Ok(())
}

/// `out/<surface>/<state>.png`.
fn png_path(out: &Path, scene_name: &str) -> PathBuf {
	let mut path = out.to_path_buf();
	for part in scene_name.split('/') {
		path.push(part);
	}
	path.set_extension("png");
	path
}

fn sweep(
	bundle: &StartupBundle,
	registry: &SceneRegistry,
	command: &SweepCommand,
) -> Result<(), Box<dyn std::error::Error>> {
	let key = TokenKey::parse(&command.token)?;
	let values = if command.values.is_empty() {
		let (Some(from), Some(to)) = (&command.from, &command.to) else {
			return Err(SweepError::Range { from: String::new(), to: String::new() }.into());
		};
		candidates(from, to, command.steps)?
	} else {
		command.values.clone()
	};
	let scenes = matching(registry, &command.scene)?;
	let theme = command.frame.theme(bundle)?;
	let options = command.frame.options();
	let mut cx = headless_context()?;
	let mut cells = Vec::with_capacity(values.len() * scenes.len());
	let mut window = SceneWindow::open(&mut cx, &options)?;
	for (index, value) in values.iter().enumerate() {
		let dir = command.work_dir.join(format!("{index:02}"));
		let tokens: Tokens = materialise(&bundle.paths.tokens_dir, &dir, &key, value)?;
		let assets =
			Assets { tokens: &tokens, theme: &theme, surface_path: &bundle.surface_path };
		for scene in &scenes {
			let label = format!("{} @ {}={value}", scene.name, key.key);
			let Rendered { captured, .. } = window.render(&assets, scene)?;
			cells.push(cell(&label, captured, &assets)?);
		}
	}
	drop(window);
	let sheet = tile(&mut cx, cells, SheetGrid::new(command.columns), options.scale_factor)?;
	write_png(&sheet, &command.out)?;
	println!("{} candidates x {} scenes -> {}", values.len(), scenes.len(), command.out.display());
	Ok(())
}
