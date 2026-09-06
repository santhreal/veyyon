//! The offscreen renderer a headless frame is drawn with, and the app
//! context that draws through it.
//!
//! `gpui_platform::current_headless_renderer` builds its wgpu instance over
//! the Vulkan and GL backends together. On Linux the GL backend is EGL, and
//! initialising EGL in a process with no display crashes the NVIDIA driver
//! from one of its worker threads in about one run in five (5 of 25 runs of
//! a 41-frame sweep, against 0 of 25 with GL excluded). Nothing offscreen
//! draws through GL, so the instance here is built over Vulkan alone. macOS
//! draws through Metal and keeps the platform's renderer.
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

/// A headless app context whose windows draw through one shared renderer and
/// shape text with the sans-serif system family.
pub fn app_context() -> Result<HeadlessAppContext, NoOffscreenRenderer> {
	let renderer = SharedRenderer::open()?;
	let text_system = Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
	Ok(HeadlessAppContext::with_platform(text_system, Arc::new(()), renderer.factory()))
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

/// A wgpu renderer over a Vulkan-only instance, drawing to an offscreen
/// target.
#[cfg(not(target_os = "macos"))]
struct VulkanRenderer {
	/// Holds the device the renderer draws with.
	_context: gpui_wgpu::WgpuContext,
	renderer: gpui_wgpu::WgpuRenderer,
}

#[cfg(not(target_os = "macos"))]
impl VulkanRenderer {
	fn new() -> Result<Self, NoOffscreenRenderer> {
		use gpui_wgpu::wgpu;

		let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
			backends:                 wgpu::Backends::VULKAN,
			flags:                    wgpu::InstanceFlags::default(),
			backend_options:          wgpu::BackendOptions::default(),
			memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
			display:                  None,
		});
		let context = gpui_wgpu::WgpuContext::new_surfaceless(instance, None)
			.map_err(|error| NoOffscreenRenderer { reason: format!("no Vulkan device: {error:#}") })?;
		// The target is resized before each frame; this is only where it
		// starts.
		let initial = Size { width: DevicePixels(1), height: DevicePixels(1) };
		let renderer =
			gpui_wgpu::WgpuRenderer::new_offscreen(&context, initial).map_err(|error| {
				NoOffscreenRenderer { reason: format!("no offscreen target: {error:#}") }
			})?;
		Ok(Self { _context: context, renderer })
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
