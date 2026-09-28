//! The offscreen renderer a headless frame is drawn with, and the app
//! context that draws through it.
//!
//! `gpui_platform::current_headless_renderer` builds its wgpu instance over
//! the Vulkan and GL backends together. On Linux the GL backend is EGL, and a
//! process with no display draws no offscreen frame through it: with
//! `WGPU_BACKEND=gl`, 25 of 25 runs of the `veyyon-gpui` headless surface
//! suite report no renderer at all, so every offscreen render returns an
//! empty frame. Vulkan is the only backend that serves one, so the instance
//! here is built over Vulkan alone. macOS draws through Metal and keeps the
//! platform's renderer.
//!
//! One renderer serves every window a context opens: the device is built once
//! per process rather than once per window, and the windows share one atlas.

use std::{borrow::Cow, cell::RefCell, rc::Rc, sync::Arc};

use veyyon_desktop_ui::{fonts, icons::Assets};
use veyyon_gpui::{
	DevicePixels, HeadlessAppContext, PlatformAtlas, PlatformHeadlessRenderer, PlatformTextSystem,
	RgbaImage, Scene, Size,
};

/// Why no offscreen renderer could be built.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("no offscreen renderer: {reason}")]
pub struct NoOffscreenRenderer {
	reason: String,
}

/// One offscreen renderer every window of a context draws through.
#[derive(Clone)]
struct SharedRenderer {
	inner: Rc<RefCell<Box<dyn PlatformHeadlessRenderer>>>,
}

impl SharedRenderer {
	/// Builds the platform's offscreen renderer.
	fn open() -> Result<Self, NoOffscreenRenderer> {
		Ok(Self { inner: Rc::new(RefCell::new(platform_renderer()?)) })
	}

	/// The renderer factory a [`HeadlessAppContext`] opens windows with; every
	/// window it builds draws through this renderer.
	fn factory(&self) -> impl Fn() -> Option<Box<dyn PlatformHeadlessRenderer>> + 'static {
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
/// One font system serves the whole process: reading the system font
/// database again per context costs 0.04-0.07 s per pass and buys nothing.
/// The desktop's embedded faces are added once, so a view that names
/// `Inter` or `JetBrains Mono` shapes in the face the binary ships rather than
/// in whatever the host has installed; the system families stay for a view
/// that names none.
static TEXT_SYSTEM: std::sync::LazyLock<Result<Arc<dyn PlatformTextSystem>, NoOffscreenRenderer>> =
	std::sync::LazyLock::new(|| {
		let system: Arc<dyn PlatformTextSystem> =
			Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
		system
			.add_fonts(
				fonts::FACES
					.iter()
					.map(|face| Cow::Borrowed(*face))
					.collect(),
			)
			.map_err(|error| NoOffscreenRenderer {
				reason: format!("the embedded faces did not load: {error:#}"),
			})?;
		Ok(system)
	});

/// A headless app context whose windows draw through one shared renderer and
/// load the desktop's embedded icons.
pub fn app_context() -> Result<HeadlessAppContext, NoOffscreenRenderer> {
	let text_system = TEXT_SYSTEM.as_ref().map_err(Clone::clone)?;
	let renderer = SharedRenderer::open()?;
	Ok(HeadlessAppContext::with_platform(
		Arc::clone(text_system),
		Arc::new(Assets),
		renderer.factory(),
	))
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
/// process's life: a test binary opens a headless context per test, and a
/// device per context costs more than the frames do (0.45-0.50 s against
/// 1.03-1.09 s for a seven-test suite). The render target and the sprite atlas
/// stay per renderer, so no glyph or texture crosses from one context into
/// the next. A failure is held too: a host with no Vulkan ICD does not
/// acquire one by being asked a second time.
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

/// Whether the process-wide device draws on a software adapter.
///
/// Lavapipe and llvmpipe report `DeviceType::Cpu`. A device that failed to
/// build reports `false`; the context that needs it fails first anyway.
#[cfg(not(target_os = "macos"))]
pub fn adapter_is_software() -> bool {
	DEVICE.as_ref().is_ok_and(|context| {
		context.adapter.get_info().device_type == gpui_wgpu::wgpu::DeviceType::Cpu
	})
}

/// macOS draws through Metal, which has no software adapter to name.
#[cfg(target_os = "macos")]
pub const fn adapter_is_software() -> bool {
	false
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
		let context = DEVICE.as_ref().map_err(Clone::clone)?;
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
