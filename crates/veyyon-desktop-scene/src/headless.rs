//! Offscreen rasterisation of a scene to an `RgbaFrame`, and PNG encoding.
//!
//! This is the mechanism the iteration engine rests on. A surface is judged by
//! looking at it, and looking at it costs a process launch and a window unless
//! a frame can be produced without either. Fork patch P10 supplies the
//! surfaceless render target; this module gives it a size, a scale factor and a
//! root element, and hands back a frame the metrics and the tiler already
//! consume.
//!
//! The frame type is `crate::frame::RgbaFrame` and is not redeclared here: it
//! already validates dimensions, scale factor and byte count, and every metric
//! is written against it.

use std::{
	fs,
	io::BufWriter,
	ops::{Deref, DerefMut},
	path::{Path, PathBuf},
	sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use veyyon_gpui::{
	AnyWindowHandle, App, Bounds, Entity, HeadlessAppContext, Pixels, Render, Size, TextRunLayout,
	Window, px,
};

use crate::{
	frame::{FrameError, RgbaFrame},
	layout::{LayoutBoxTree, LayoutError},
	layout_bridge::layout_box_tree_from_quads,
};

/// Why a headless render or its encoding did not produce a frame.
#[derive(Debug, thiserror::Error)]
pub enum RenderError {
	/// The platform reported no headless renderer. Without one the render path
	/// returns an empty frame and reports success, so this is an error rather
	/// than a uniformly transparent image discovered later.
	#[error(
		"this platform supplies no headless renderer, so no offscreen frame can be produced; a GPU \
		 with a Vulkan ICD is required"
	)]
	NoRenderer,

	/// A sheet with no cells has no size, and an empty image is not a useful
	/// report: the caller asked for a comparison and supplied nothing.
	#[error("a contact sheet needs at least one cell")]
	EmptySheet,

	#[error("the offscreen render target produced no frame: {message}")]
	NoFrame { message: String },

	#[error("the readback does not describe a frame: {source}")]
	Readback {
		#[source]
		source: FrameError,
	},
	#[error("layout error during box tree construction: {source}")]
	Layout {
		#[source]
		source: LayoutError,
	},

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

/// Which appearance a scene is rendered in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, strum::EnumIter)]
pub enum Appearance {
	Dark,
	Light,
}

impl Appearance {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Dark => "dark",
			Self::Light => "light",
		}
	}
}

/// Everything that decides the bytes a render produces.
///
/// Two renders with equal options must produce equal bytes, so every input the
/// renderer reads belongs here. A value taken from ambient state instead would
/// make a sweep report cells as changed when only the environment moved.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RenderOptions {
	pub width:        u32,
	pub height:       u32,
	pub scale_factor: f32,
	pub appearance:   Appearance,
	pub seed:         u64,
}

impl Default for RenderOptions {
	fn default() -> Self {
		Self {
			width:        1180,
			height:       800,
			scale_factor: 2.0,
			appearance:   Appearance::Dark,
			seed:         0x5eed_cafe,
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
/// A frame is straight-alpha RGBA8 with no row padding, which is exactly PNG's
/// RGBA8 layout, so the bytes are passed through without conversion.
pub fn write_png(frame: &RgbaFrame, path: &Path) -> Result<(), RenderError> {
	if let Some(parent) = path.parent() {
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
/// A frame holding one value was cleared and never drawn into. Determinism is
/// satisfied by such a frame comparing equal to itself, so this separates a
/// stable frame from an empty one, which is the check every render proof needs.
pub fn distinct_pixel_values(frame: &RgbaFrame) -> usize {
	let mut seen = std::collections::BTreeSet::new();
	for pixel in frame.as_bytes().as_chunks::<4>().0 {
		seen.insert(pixel);
	}
	seen.len()
}

/// One live headless context at a time, process-wide.
///
/// `gpui_platform::current_headless_renderer` resolves to a renderer owned by
/// the process, not by the caller. Building a third context while two are live
/// aborts with SIGSEGV, and a test binary runs its tests on parallel threads,
/// so concurrent callers have to queue rather than race. The permit is taken
/// when a context is built and released when it drops.
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

/// A context wired to this platform's headless renderer.
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
	if gpui_platform::current_headless_renderer().is_none() {
		return Err(RenderError::NoRenderer);
	}
	let text_system = Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
	let cx = HeadlessAppContext::with_platform(text_system, Arc::new(()), || {
		gpui_platform::current_headless_renderer()
	});
	Ok(Headless { cx, _permit: permit })
}

/// Rasterises one root view offscreen and captures the rendered frame and
/// the layout box tree.
pub fn render_view_with_layout<V, F>(
	cx: &mut HeadlessAppContext,
	options: &RenderOptions,
	build_root: F,
) -> Result<(RgbaFrame, LayoutBoxTree), RenderError>
where
	V: Render + 'static,
	F: FnOnce(&mut Window, &mut App) -> Entity<V>,
{
	render_view_captured(cx, options, build_root).map(|captured| (captured.frame, captured.layout))
}

/// Everything one offscreen render produced.
///
/// The frame is what a reviewer looks at, the tree is what the metrics
/// evaluate, and the hit rects are what an operator can actually reach. A
/// surface can be correct in all three and wrong in one, so a render hands
/// back all three rather than the caller choosing which to trust.
#[derive(Debug)]
pub struct Captured {
	/// The rasterised frame.
	pub frame:     RgbaFrame,
	/// The quad tree, in logical pixels.
	pub layout:    LayoutBoxTree,
	/// Every hit rect the frame registered, in logical pixels.
	///
	/// A rect appears here only for an element that carries a listener, a
	/// hover style or another reason to be hit-tested, so this is the set of
	/// controls the frame is willing to answer a click on — not the set of
	/// things drawn to look like controls.
	pub hitboxes:  Vec<Bounds<Pixels>>,
	/// Every shaped text run the frame registered, in logical pixels.
	pub text_runs: Vec<TextRunLayout>,
}

/// Captures a rendered frame, layout tree, hitboxes and text runs from an open
/// window.
pub fn capture_window(
	cx: &mut HeadlessAppContext,
	handle: AnyWindowHandle,
	scale_factor: f32,
) -> Result<Captured, RenderError> {
	let (frame_result, quads) = cx
		.update_window(handle, |_, window, _| {
			let frame = window.render_to_frame(scale_factor);
			let quads = window.painted_quads();
			(frame, quads)
		})
		.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;

	let headless_frame =
		frame_result.map_err(|error| RenderError::NoFrame { message: format!("{error:?}") })?;

	let hitboxes = headless_frame.hitboxes().to_vec();
	let text_runs = headless_frame.text_runs().to_vec();

	let frame = RgbaFrame::new(
		headless_frame.width(),
		headless_frame.height(),
		scale_factor,
		headless_frame.as_bytes().to_vec(),
	)
	.map_err(|source| RenderError::Readback { source })?;

	let layout = layout_box_tree_from_quads(&quads, scale_factor)
		.map_err(|source| RenderError::Layout { source })?;

	Ok(Captured { frame, layout, hitboxes, text_runs })
}

/// Rasterises one root view offscreen and captures everything the frame knows.
pub fn render_view_captured<V, F>(
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

/// Rasterises one root view offscreen.
///
/// The root is built by a closure rather than passed as a value because a gpui
/// view is created inside the app context that renders it.
pub fn render_view<V, F>(
	cx: &mut HeadlessAppContext,
	options: &RenderOptions,
	build_root: F,
) -> Result<RgbaFrame, RenderError>
where
	V: Render + 'static,
	F: FnOnce(&mut Window, &mut App) -> Entity<V>,
{
	render_view_with_layout(cx, options, build_root).map(|(frame, _)| frame)
}
