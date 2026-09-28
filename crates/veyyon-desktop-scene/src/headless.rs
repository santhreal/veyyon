//! Offscreen rasterisation of a view to an `RgbaFrame`, and PNG encoding.
//!
//! Fork patch P10 supplies the surfaceless render target; this module gives it
//! a size, a scale factor and a root view, and hands back the frame with the
//! hit rects and text runs it registered.

use std::{
	fs,
	io::BufWriter,
	ops::{Deref, DerefMut},
	path::{Path, PathBuf},
	sync::{Mutex, MutexGuard, PoisonError},
};

use veyyon_desktop_ui::theme::Appearance;
use veyyon_gpui::{
	AnyWindowHandle, App, Bounds, Entity, HeadlessAppContext, Pixels, Render, Size, TextRunLayout,
	Window, px,
};

use crate::{
	frame::{FrameError, RgbaFrame},
	renderer::{self, NoOffscreenRenderer},
};

/// Why a headless render or its encoding did not produce a frame.
#[derive(Debug, thiserror::Error)]
pub enum RenderError {
	/// The platform supplied no offscreen renderer. Without one the render
	/// path returns an empty frame and reports success, so this is an error
	/// rather than a uniformly transparent image discovered later.
	#[error("no offscreen frame can be produced; a GPU with a Vulkan ICD is required: {source}")]
	NoRenderer {
		#[source]
		source: NoOffscreenRenderer,
	},

	#[error("the offscreen render target produced no frame: {message}")]
	NoFrame { message: String },

	#[error("the readback does not describe a frame: {source}")]
	Readback {
		#[source]
		source: FrameError,
	},

	#[error("the theme did not install: {message}")]
	Theme { message: String },

	#[error("could not create {}: {source}", path.display())]
	CreateDir {
		path:   PathBuf,
		#[source]
		source: std::io::Error,
	},

	#[error("could not write {}: {source}", path.display())]
	Write {
		path:   PathBuf,
		#[source]
		source: std::io::Error,
	},

	#[error("could not encode {}: {source}", path.display())]
	Encode {
		path:   PathBuf,
		#[source]
		source: png::EncodingError,
	},

	#[error("invalid keystroke chord {chord:?}: {message}")]
	InvalidKeystroke { chord: String, message: String },

	#[error("window error during headless interaction: {message}")]
	Window { message: String },
}

/// Everything that decides the bytes a render produces besides the view.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RenderOptions {
	/// Logical width.
	pub width:        u32,
	/// Logical height.
	pub height:       u32,
	/// Device pixels per logical pixel.
	pub scale_factor: f32,
	/// The palette a view that reads the theme is drawn in.
	pub appearance:   Appearance,
}

impl Default for RenderOptions {
	fn default() -> Self {
		Self {
			width:        1440,
			height:       900,
			scale_factor: 1.0,
			appearance:   Appearance::Dark,
		}
	}
}

impl RenderOptions {
	/// The logical size handed to the renderer. Device pixels come back scaled
	/// by `scale_factor`.
	pub const fn logical_size(&self) -> Size<Pixels> {
		Size { width: px(self.width as f32), height: px(self.height as f32) }
	}
}

/// Writes a frame as a PNG, creating parent directories.
///
/// A frame is straight-alpha RGBA8 with no row padding, which is PNG's RGBA8
/// layout, so the bytes are passed through without conversion.
pub fn write_png(frame: &RgbaFrame, path: &Path) -> Result<(), RenderError> {
	if let Some(parent) = path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
	{
		fs::create_dir_all(parent)
			.map_err(|source| RenderError::CreateDir { path: parent.to_path_buf(), source })?;
	}

	let file = fs::File::create(path)
		.map_err(|source| RenderError::Write { path: path.to_path_buf(), source })?;

	let mut encoder = png::Encoder::new(BufWriter::new(file), frame.width(), frame.height());
	encoder.set_color(png::ColorType::Rgba);
	encoder.set_depth(png::BitDepth::Eight);

	let mut writer = encoder
		.write_header()
		.map_err(|source| RenderError::Encode { path: path.to_path_buf(), source })?;
	writer
		.write_image_data(frame.as_bytes())
		.map_err(|source| RenderError::Encode { path: path.to_path_buf(), source })
}

/// Counts distinct pixel values in a frame.
///
/// A frame holding one value was cleared and never drawn into. Such a frame
/// compares equal to itself, so this separates a stable frame from an empty
/// one.
pub fn distinct_pixel_values(frame: &RgbaFrame) -> usize {
	let mut seen = std::collections::BTreeSet::new();
	for pixel in frame.as_bytes().as_chunks::<4>().0 {
		seen.insert(pixel);
	}
	seen.len()
}

/// One live headless context at a time, process-wide.
///
/// The offscreen renderer draws through a device the process owns, and a
/// third live `HeadlessAppContext` in one process aborts it with SIGSEGV
/// (`crates/veyyon-gpui/README.md`). A test binary runs its tests on parallel
/// threads, so the permit is taken when a context is built and released when
/// it drops.
static RENDERER: Mutex<()> = Mutex::new(());

/// A headless context holding the process-wide renderer permit.
///
/// Dereferences to [`HeadlessAppContext`], so a caller renders through it
/// directly and the permit is released when the context is dropped. The permit
/// is declared after the context so the context is torn down first.
pub struct Headless {
	cx:      HeadlessAppContext,
	_permit: MutexGuard<'static, ()>,
}

impl Deref for Headless {
	type Target = HeadlessAppContext;

	fn deref(&self) -> &Self::Target {
		&self.cx
	}
}

impl DerefMut for Headless {
	fn deref_mut(&mut self) -> &mut Self::Target {
		&mut self.cx
	}
}

/// A context wired to the offscreen renderer.
///
/// `HeadlessAppContext::new` hands back a context with no renderer attached,
/// which renders nothing and reports success, so the renderer is supplied
/// explicitly and its absence is reported here.
///
/// Blocks while another [`Headless`] is alive in this process. A permit
/// poisoned by a panicking caller is recovered rather than propagated, so one
/// failed render does not turn every later one into a panic of its own.
pub fn headless_context() -> Result<Headless, RenderError> {
	let permit = RENDERER.lock().unwrap_or_else(PoisonError::into_inner);
	let cx = renderer::app_context().map_err(|source| RenderError::NoRenderer { source })?;
	Ok(Headless { cx, _permit: permit })
}

/// Whether the shared offscreen renderer draws on a software adapter.
///
/// A budget calibrated for hardware cannot hold under lavapipe, so a timing
/// assertion reads this once and relaxes its bound rather than reporting a
/// software rasterizer as a regression.
pub fn renderer_is_software() -> bool {
	renderer::adapter_is_software()
}

/// Everything one offscreen render produced.
///
/// The frame is what a reviewer looks at and the hit rects are what an
/// operator can reach, so a render hands back both.
#[derive(Debug)]
pub struct Captured {
	/// The rasterised frame.
	pub frame:     RgbaFrame,
	/// Every hit rect the frame registered, in logical pixels: an element with
	/// a listener, a hover style or another reason to be hit-tested.
	pub hitboxes:  Vec<Bounds<Pixels>>,
	/// Every shaped text run the frame registered, in logical pixels.
	pub text_runs: Vec<TextRunLayout>,
}

/// Captures a rendered frame, hitboxes and text runs from an open window.
pub fn capture_window(
	cx: &mut HeadlessAppContext,
	handle: AnyWindowHandle,
	scale_factor: f32,
) -> Result<Captured, RenderError> {
	let headless_frame = cx
		.update_window(handle, |_, window, _| window.render_to_frame(scale_factor))
		.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?
		.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;

	let hitboxes = headless_frame.hitboxes().to_vec();
	let text_runs = headless_frame.text_runs().to_vec();
	let frame = RgbaFrame::new(
		headless_frame.width(),
		headless_frame.height(),
		scale_factor,
		headless_frame.as_bytes().to_vec(),
	)
	.map_err(|source| RenderError::Readback { source })?;

	Ok(Captured { frame, hitboxes, text_runs })
}

/// Rasterises one root view offscreen and captures everything the frame knows.
///
/// The root is built by a closure rather than passed as a value because a gpui
/// view is created inside the app context that renders it.
pub fn render_view<V, F>(
	cx: &mut HeadlessAppContext,
	options: &RenderOptions,
	build_root: F,
) -> Result<Captured, RenderError>
where
	V: Render + 'static,
	F: FnOnce(&mut Window, &mut App) -> Entity<V>,
{
	let window = cx
		.open_window(options.logical_size(), build_root)
		.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;

	cx.update_window(window.into(), |_, window, _| {
		window.set_scale_factor(options.scale_factor);
	})
	.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;

	cx.run_until_parked();

	let captured = capture_window(cx, window.into(), options.scale_factor);

	cx.update(|app| {
		let _ = window.update(app, |_, window, _| window.remove_window());
	});

	captured
}
