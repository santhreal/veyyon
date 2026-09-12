//! The offscreen renderer a headless frame is drawn with, and the app
//! context that draws through it.
//!
//! `gpui_platform::current_headless_renderer` builds its wgpu instance over
//! the Vulkan and GL backends together. On Linux the GL backend is EGL, and a
//! process with no display draws no offscreen frame through it: with
//! `WGPU_BACKEND=gl`, 25 of 25 runs of the `veyyon-gpui` headless surface
//! suite report no renderer at all, so every offscreen render returns an
//! empty frame. Vulkan is the only backend that serves one, so the instance
//! here is built over Vulkan alone, and the GL arm is initialisation for a
//! backend that cannot draw. macOS draws through Metal and keeps the
//! platform's renderer.
//!
//! One renderer serves every window a context opens: the device is built once
//! per context rather than once per window, and the windows share one atlas.

use std::{cell::RefCell, rc::Rc, sync::Arc};

use veyyon_gpui::{
	DevicePixels, HeadlessAppContext, PlatformAtlas, PlatformHeadlessRenderer, RgbaImage, Scene,
	Size,
};

/// Why no offscreen renderer could be built.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("no offscreen renderer: {reason}")]
pub struct NoOffscreenRenderer {
	reason: String,
}

/// One offscreen renderer every window of a context draws through.
#[derive(Clone)]
pub struct SharedRenderer {
	inner: Rc<RefCell<Box<dyn PlatformHeadlessRenderer>>>,
}

impl SharedRenderer {
	/// Builds the platform's offscreen renderer.
	pub fn open() -> Result<Self, NoOffscreenRenderer> {
		Ok(Self { inner: Rc::new(RefCell::new(platform_renderer()?)) })
	}

	/// The renderer factory a [`HeadlessAppContext`] opens windows with; every
	/// window it builds draws through this renderer.
	pub fn factory(&self) -> impl Fn() -> Option<Box<dyn PlatformHeadlessRenderer>> + 'static {
		let shared = self.clone();
		move || Some(Box::new(shared.clone()))
	}
}

impl PlatformHeadlessRenderer for SharedRenderer {
	fn render_scene_to_image(
		&mut self,
		scene: &Scene,
		size: Size<DevicePixels>,
	) -> anyhow::Result<RgbaImage> {
		self.inner.borrow_mut().render_scene_to_image(scene, size)
	}

	fn render_scene(&mut self, scene: &Scene, size: Size<DevicePixels>) -> anyhow::Result<()> {
		self.inner.borrow_mut().render_scene(scene, size)
	}

	fn sprite_atlas(&self) -> Arc<dyn PlatformAtlas> {
		self.inner.borrow().sprite_atlas()
	}
}

/// The text system every headless context shapes through.
///
/// One font system serves the whole process. The families it exposes do not
/// change between contexts and nothing here registers fonts of its own, so
/// reading the system font database again per context buys nothing: on the
/// two suites measured below it costs 0.04-0.07s per pass, against the 0.55s
/// a device per context costs.
static TEXT_SYSTEM: std::sync::LazyLock<Arc<dyn veyyon_gpui::PlatformTextSystem>> =
	std::sync::LazyLock::new(|| Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif")));

/// A headless app context whose windows draw through one shared renderer and
/// shape text with the sans-serif system family.
pub fn app_context() -> Result<HeadlessAppContext, NoOffscreenRenderer> {
	let renderer = SharedRenderer::open()?;
	Ok(HeadlessAppContext::with_platform(Arc::clone(&TEXT_SYSTEM), Arc::new(()), renderer.factory()))
}

#[cfg(target_os = "macos")]
fn platform_renderer() -> Result<Box<dyn PlatformHeadlessRenderer>, NoOffscreenRenderer> {
	gpui_platform::current_headless_renderer().ok_or_else(|| NoOffscreenRenderer {
		reason: "the platform reports no Metal renderer".to_owned(),
	})
}

#[cfg(not(target_os = "macos"))]
fn platform_renderer() -> Result<Box<dyn PlatformHeadlessRenderer>, NoOffscreenRenderer> {
	VulkanRenderer::new().map(|renderer| Box::new(renderer) as Box<dyn PlatformHeadlessRenderer>)
}

/// The Vulkan device every offscreen renderer in this process draws with.
///
/// One device serves the whole process, built on first use and kept for the
/// process's life. A test binary opens a headless context per test, and
/// building a device per context costs more than the frames do: the
/// seven-test editor-scroll suite runs a warm pass in 0.45-0.50s with one
/// device per process and 1.03-1.09s with one per context, and the five-test
/// masked-field suite in 0.41s against 0.98s. The render target and the
/// sprite atlas stay per renderer, so no glyph or texture crosses from one
/// context into the next.
#[cfg(not(target_os = "macos"))]
static DEVICE: std::sync::LazyLock<Result<gpui_wgpu::WgpuContext, NoOffscreenRenderer>> =
	std::sync::LazyLock::new(|| {
		use gpui_wgpu::wgpu;

		let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
			backends:                 wgpu::Backends::VULKAN,
			flags:                    wgpu::InstanceFlags::default(),
			backend_options:          wgpu::BackendOptions::default(),
			memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
			display:                  None,
		});
		gpui_wgpu::WgpuContext::new_surfaceless(instance, None)
			.map_err(|error| NoOffscreenRenderer { reason: format!("no Vulkan device: {error:#}") })
	});

/// The process-wide Vulkan device.
///
/// A failure is held too: a host with no Vulkan ICD does not acquire one by
/// being asked a second time, and the first error is the one that explains it.
#[cfg(not(target_os = "macos"))]
fn device() -> Result<&'static gpui_wgpu::WgpuContext, NoOffscreenRenderer> {
	DEVICE.as_ref().map_err(Clone::clone)
}

/// A wgpu renderer over the process-wide Vulkan device, drawing to an
/// offscreen target.
#[cfg(not(target_os = "macos"))]
struct VulkanRenderer {
	renderer: gpui_wgpu::WgpuRenderer,
}

#[cfg(not(target_os = "macos"))]
impl VulkanRenderer {
	fn new() -> Result<Self, NoOffscreenRenderer> {
		let context = device()?;
		// The target is resized before each frame; this is only where it
		// starts.
		let initial = Size { width: DevicePixels(1), height: DevicePixels(1) };
		let renderer = gpui_wgpu::WgpuRenderer::new_offscreen(context, initial).map_err(|error| {
			NoOffscreenRenderer { reason: format!("no offscreen target: {error:#}") }
		})?;
		Ok(Self { renderer })
	}
}

#[cfg(not(target_os = "macos"))]
impl PlatformHeadlessRenderer for VulkanRenderer {
	fn render_scene_to_image(
		&mut self,
		scene: &Scene,
		size: Size<DevicePixels>,
	) -> anyhow::Result<RgbaImage> {
		self.render_scene(scene, size)?;
		let bytes = self.renderer.read_pixels()?;
		RgbaImage::from_raw(size.width.0.unsigned_abs(), size.height.0.unsigned_abs(), bytes)
			.ok_or_else(|| anyhow::anyhow!("the readback holds fewer bytes than {size:?} needs"))
	}

	fn render_scene(&mut self, scene: &Scene, size: Size<DevicePixels>) -> anyhow::Result<()> {
		self.renderer.update_drawable_size(size);
		anyhow::ensure!(self.renderer.draw(scene), "the offscreen draw failed");
		Ok(())
	}

	fn sprite_atlas(&self) -> Arc<dyn PlatformAtlas> {
		self.renderer.sprite_atlas().clone()
	}
}
