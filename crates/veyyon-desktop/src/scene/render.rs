//! One scene to one captured frame, through the tokens the window installs.
//!
//! A shell scene renders `ShellView` from its built state; a kit scene renders
//! the primitive on the canvas. Both install the same token set the window
//! does, so a token edit moves a kit scene and a shell scene by the same
//! amount and a sweep's cells are comparable across the two.
//!
//! One window renders every scene. The headless renderer is owned by the
//! process, and a window per scene creates a device and shader modules per
//! scene; past a hundred or so of those in one process the native side
//! corrupts and the run dies with a SIGSEGV or a shader that no longer parses.
//! Swapping the root view leaves the device alone.

use std::path::Path;

use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_scene::{
	Captured, PrimitiveSceneView, RenderError, RenderOptions, RgbaColor, Scene, SceneRegistry,
	capture_window,
};
use veyyon_desktop_surface::{ShellView, install_tokens};
use veyyon_desktop_tokens::{ColorRole, Theme, TokenError, Tokens};
use veyyon_gpui::{AppContext as _, Entity, HeadlessAppContext, WindowHandle};

use super::{
	build::{SceneBuildError, SceneRoot, build},
	seed::SCENE_CLOCK_MS,
};

/// Why a scene produced no frame.
#[derive(Debug, thiserror::Error)]
pub enum SceneRenderError {
	#[error(transparent)]
	Build(#[from] SceneBuildError),
	#[error("tokens failed to install: {0}")]
	Tokens(#[from] TokenError),
	#[error(transparent)]
	Render(#[from] RenderError),
	#[error("no scene matches {0}")]
	NoMatch(String),
}

/// The token set a render draws with, and the path errors are reported at.
pub struct Assets<'a> {
	pub tokens:       &'a Tokens,
	pub theme:        &'a Theme,
	pub surface_path: &'a Path,
}

impl Assets<'_> {
	/// The theme's ground, as the metrics read it.
	pub fn ground(&self) -> Result<RgbaColor, TokenError> {
		let ground = self.theme.role(self.surface_path, ColorRole::Ground)?;
		let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
		Ok(RgbaColor::new(channel(ground.r), channel(ground.g), channel(ground.b), channel(ground.a)))
	}
}

/// The scenes a pattern names, in catalogue order.
pub fn matching(registry: &SceneRegistry, pattern: &str) -> Result<Vec<Scene>, SceneRenderError> {
	let scenes: Vec<Scene> = registry.find_glob(pattern).into_iter().cloned().collect();
	if scenes.is_empty() {
		return Err(SceneRenderError::NoMatch(pattern.to_string()));
	}
	Ok(scenes)
}

/// One rendered scene: the capture, and every control id the shell read an
/// availability for that no projection had set (§1.2 item 3). A kit scene
/// has no controls, so its list is empty.
#[derive(Debug)]
pub struct Rendered {
	pub captured:    Captured,
	pub unprojected: Vec<SurfaceId>,
}

/// One open window that renders scene after scene at one size.
///
/// The window is removed when this drops. `options` is fixed at open because
/// the window's size is; a render pass at another size opens another one.
pub struct SceneWindow<'cx> {
	cx:      &'cx mut HeadlessAppContext,
	window:  WindowHandle<RootView>,
	root:    Entity<RootView>,
	options: RenderOptions,
}

impl<'cx> SceneWindow<'cx> {
	/// Opens the window with nothing in it.
	pub fn open(
		cx: &'cx mut HeadlessAppContext,
		options: &RenderOptions,
	) -> Result<Self, SceneRenderError> {
		let mut slot = None;
		let window = cx
			.open_window(options.logical_size(), |_, app| {
				let root = app.new(|_| RootView::Empty);
				slot = Some(root.clone());
				root
			})
			.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;
		let root = slot.ok_or_else(|| RenderError::NoFrame {
			message: "the window opened without building its root".to_string(),
		})?;
		cx.update_window(window.into(), |_, window, _| {
			window.set_scale_factor(options.scale_factor);
		})
		.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;
		Ok(Self { cx, window, root, options: *options })
	}

	/// Renders one scene and captures its frame, layout tree and hit rects.
	///
	/// The tokens are installed on every call, so a sweep that rewrote one key
	/// between calls renders the rewritten value.
	pub fn render(
		&mut self,
		assets: &Assets<'_>,
		scene: &Scene,
	) -> Result<Rendered, SceneRenderError> {
		let built = build(scene)?;
		let installed = self
			.cx
			.update(|app| install_tokens(app, assets.tokens, assets.theme, assets.surface_path))?;
		let root = &self.root;
		let shell = self.cx.update(|app| {
			root.update(app, |root, cx| {
				let shell = match built {
					SceneRoot::Primitive(kind) => {
						*root = RootView::Primitive(cx.new(|_| PrimitiveSceneView::new(kind)));
						None
					},
					SceneRoot::Shell(built) => {
						let mut view = ShellView::new(installed, built.state);
						view.set_clock_ms(SCENE_CLOCK_MS);
						view.set_notice(built.notice);
						let composer_text = built.composer_text;
						let view = cx.new(|cx| {
							if !composer_text.is_empty() {
								view.set_composed(composer_text, cx);
							}
							view
						});
						*root = RootView::Shell(view.clone());
						Some(view)
					},
				};
				cx.notify();
				shell
			})
		});
		self.cx.run_until_parked();
		// `render_to_frame` reads the last drawn frame; the draw itself is the
		// vsync this delivers, which the notify above left the window dirty for.
		self
			.cx
			.request_frame(self.window.into())
			.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;
		self.cx.run_until_parked();
		let captured = capture_window(self.cx, self.window.into(), self.options.scale_factor)?;
		let unprojected = shell
			.map(|view| {
				self
					.cx
					.update(|app| view.read(app).state().controls.unprojected())
			})
			.unwrap_or_default();
		Ok(Rendered { captured, unprojected })
	}
}

impl Drop for SceneWindow<'_> {
	fn drop(&mut self) {
		let window = self.window;
		self.cx.update(|app| {
			let _ = window.update(app, |_, window, _| window.remove_window());
		});
	}
}

/// The root a scene renders under: one of the two view kinds, or nothing
/// before the first scene.
enum RootView {
	Shell(Entity<ShellView>),
	Primitive(Entity<PrimitiveSceneView>),
	Empty,
}

impl veyyon_gpui::Render for RootView {
	fn render(
		&mut self,
		_window: &mut veyyon_gpui::Window,
		_cx: &mut veyyon_gpui::Context<Self>,
	) -> impl veyyon_gpui::IntoElement {
		use veyyon_gpui::{ParentElement as _, Styled as _, div};
		match self {
			Self::Shell(view) => div().size_full().child(view.clone()),
			Self::Primitive(view) => div().size_full().child(view.clone()),
			Self::Empty => div().size_full(),
		}
	}
}
