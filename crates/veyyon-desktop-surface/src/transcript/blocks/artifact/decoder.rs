//! Image validation, decoding, and bounded LRU cache for transcript artifacts
//! (§5.3).

use std::{
	collections::{HashMap, VecDeque},
	io::Cursor,
	sync::{Arc, LazyLock, Mutex},
};

use image::{DynamicImage, ImageDecoder};
use smallvec::SmallVec;
use veyyon_gpui::{
	AssetSource, DevicePixels, ImageFormat, RenderImage, Size, SvgRenderer, SvgSize,
};

/// Maximum encoded payload and cache-key storage admitted for a preview (16
/// MiB).
pub const MAX_IMAGE_RAW_BYTES: usize = 16 * 1024 * 1024;
/// Maximum pixel dimensions allowed for decoded images (16,384 x 16,384).
pub const MAX_IMAGE_DIMENSION_PX: u32 = 16_384;
/// Maximum total pixels allowed for an image (32 MP = 33,554,432 pixels).
pub const MAX_IMAGE_PIXELS: u64 = 33_554_432;
/// Maximum preview dimension stored in GPU render memory.
pub const MAX_PREVIEW_DIMENSION_PX: u32 = 1_920;
/// Maximum retained source, preview, key, and accounting overhead (32 MiB).
pub const MAX_IMAGE_CACHE_BYTES: usize = 32 * 1024 * 1024;
/// Maximum number of distinct entries retained in the LRU cache.
pub const MAX_IMAGE_CACHE_ENTRIES: usize = 128;
/// Estimated base struct and map allocation overhead per cache entry in bytes.
pub const ENTRY_BASE_OVERHEAD_BYTES: usize = 256;

/// Status of an image artifact after decoding and pixel validation.
#[derive(Clone, Debug)]
pub enum ImageStatus {
	Valid { width: u32, height: u32, format: ImageFormat, gpui_image: Arc<RenderImage> },
	Error { message: String },
}

#[derive(Clone, Debug)]
pub struct DecodedImage {
	pub width:        u32,
	pub height:       u32,
	pub format:       ImageFormat,
	pub gpui_image:   Arc<RenderImage>,
	pub render_bytes: usize,
}

struct CacheEntry {
	source:    Arc<[u8]>,
	status:    ImageStatus,
	byte_size: usize,
}

/// LRU cache storing decoded image outcomes keyed by Arc data pointer address
/// and optional MIME.
pub struct ImageCache {
	entries:     HashMap<(usize, Option<String>), CacheEntry>,
	order:       VecDeque<(usize, Option<String>)>,
	total_bytes: usize,
}

impl Default for ImageCache {
	fn default() -> Self {
		Self::new()
	}
}

impl ImageCache {
	pub fn new() -> Self {
		Self { entries: HashMap::new(), order: VecDeque::new(), total_bytes: 0 }
	}

	pub fn len(&self) -> usize {
		self.entries.len()
	}

	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}

	pub fn total_bytes(&self) -> usize {
		self.total_bytes
	}

	pub fn total_retained_bytes(&self) -> usize {
		self.total_bytes
	}

	pub fn clear(&mut self) {
		self.entries.clear();
		self.order.clear();
		self.total_bytes = 0;
	}

	pub fn get(&mut self, data: &Arc<[u8]>, mime: Option<&str>) -> Option<ImageStatus> {
		let key = (data.as_ptr() as usize, mime.map(str::to_string));
		if let Some(entry) = self.entries.get(&key) {
			if Arc::ptr_eq(&entry.source, data) {
				let status = entry.status.clone();
				self.order.retain(|k| k != &key);
				self.order.push_back(key);
				return Some(status);
			}
			let stale_bytes = entry.byte_size;
			self.entries.remove(&key);
			self.order.retain(|k| k != &key);
			self.total_bytes = self.total_bytes.saturating_sub(stale_bytes);
		}
		None
	}

	pub fn insert(
		&mut self,
		data: &Arc<[u8]>,
		mime: Option<&str>,
		status: ImageStatus,
		render_bytes: usize,
	) {
		let key = (data.as_ptr() as usize, mime.map(str::to_string));
		let retained_input = data
			.len()
			.saturating_add(mime.map_or(0, |mime| mime.len().saturating_mul(2)));
		let byte_size = match &status {
			ImageStatus::Valid { .. } => ENTRY_BASE_OVERHEAD_BYTES.saturating_add(render_bytes),
			ImageStatus::Error { message } => ENTRY_BASE_OVERHEAD_BYTES.saturating_add(message.len()),
		}
		.saturating_add(retained_input);

		if let Some(old) = self.entries.remove(&key) {
			self.total_bytes = self.total_bytes.saturating_sub(old.byte_size);
			self.order.retain(|k| k != &key);
		}

		if byte_size > MAX_IMAGE_CACHE_BYTES {
			return;
		}

		while !self.order.is_empty()
			&& (self.total_bytes.saturating_add(byte_size) > MAX_IMAGE_CACHE_BYTES
				|| self.entries.len() >= MAX_IMAGE_CACHE_ENTRIES)
		{
			if let Some(old_key) = self.order.pop_front() {
				if let Some(old_entry) = self.entries.remove(&old_key) {
					self.total_bytes = self.total_bytes.saturating_sub(old_entry.byte_size);
				}
			}
		}

		self.total_bytes = self.total_bytes.saturating_add(byte_size);
		self.order.push_back(key.clone());
		self
			.entries
			.insert(key, CacheEntry { source: Arc::clone(data), status, byte_size });
	}
}

static IMAGE_CACHE: LazyLock<Mutex<ImageCache>> = LazyLock::new(|| Mutex::new(ImageCache::new()));

/// Executes a closure with exclusive access to the global image cache.
pub fn with_image_cache<R>(f: impl FnOnce(&mut ImageCache) -> R) -> R {
	let mut cache = match IMAGE_CACHE.lock() {
		Ok(guard) => guard,
		Err(poisoned) => poisoned.into_inner(),
	};
	f(&mut cache)
}

/// Decodes and validates image bytes, enforcing pixel dimensions and payload
/// integrity.
pub fn decode_and_validate_image(
	bytes: &[u8],
	media_type: Option<&str>,
) -> Result<DecodedImage, String> {
	if bytes.is_empty() {
		return Err("Image payload is empty".to_string());
	}
	let input_bytes = bytes
		.len()
		.saturating_add(media_type.map_or(0, |mime| mime.len().saturating_mul(2)));
	if input_bytes > MAX_IMAGE_RAW_BYTES {
		return Err(format!(
			"Image input ({} bytes) exceeds preview limit of {} bytes; open the original file",
			input_bytes, MAX_IMAGE_RAW_BYTES
		));
	}

	let mime = media_type.unwrap_or("").trim().to_ascii_lowercase();
	if mime == "image/svg+xml" || (mime.is_empty() && is_svg_payload(bytes)) {
		let asset_source: Arc<dyn AssetSource> = Arc::new(());
		let renderer = SvgRenderer::new(asset_source);
		let parsed_svg = renderer
			.parse_svg(bytes)
			.map_err(|e| format!("SVG parse error: {e}"))?;
		let (w, h) = parsed_svg.size();
		if w <= 0.0 || h <= 0.0 {
			return Err(format!("SVG dimensions must be non-zero (got {w}×{h})"));
		}
		let (w_u32, h_u32) = (w.ceil() as u32, h.ceil() as u32);
		if w_u32 > MAX_IMAGE_DIMENSION_PX || h_u32 > MAX_IMAGE_DIMENSION_PX {
			return Err(format!(
				"SVG dimension {w_u32}×{h_u32} exceeds limit of {MAX_IMAGE_DIMENSION_PX}px"
			));
		}
		let total_pixels = (w_u32 as u64)
			.checked_mul(h_u32 as u64)
			.ok_or_else(|| "SVG pixel count overflow".to_string())?;
		if total_pixels > MAX_IMAGE_PIXELS {
			return Err(format!(
				"SVG pixel count {total_pixels} exceeds limit of {MAX_IMAGE_PIXELS} pixels"
			));
		}

		let (target_w, target_h) = if w_u32 > MAX_PREVIEW_DIMENSION_PX
			|| h_u32 > MAX_PREVIEW_DIMENSION_PX
		{
			let scale = (MAX_PREVIEW_DIMENSION_PX as f32 / w).min(MAX_PREVIEW_DIMENSION_PX as f32 / h);
			((w * scale).round() as i32, (h * scale).round() as i32)
		} else {
			(w_u32 as i32, h_u32 as i32)
		};

		let img = renderer
			.render_parsed(
				&parsed_svg,
				SvgSize::ExactSize(Size {
					width:  DevicePixels(target_w.max(1)),
					height: DevicePixels(target_h.max(1)),
				}),
			)
			.map_err(|e| format!("SVG rasterize error: {e}"))?;

		let size = img.size(0);
		let render_bytes = (size.width.0 as usize)
			.checked_mul(size.height.0 as usize)
			.and_then(|px| px.checked_mul(4))
			.ok_or_else(|| "SVG preview memory size overflow".to_string())?;

		return Ok(DecodedImage {
			width: w_u32,
			height: h_u32,
			format: ImageFormat::Svg,
			gpui_image: img,
			render_bytes,
		});
	}

	let format_hint = match mime.as_str() {
		"image/png" => Some(image::ImageFormat::Png),
		"image/jpeg" | "image/jpg" => Some(image::ImageFormat::Jpeg),
		"image/webp" => Some(image::ImageFormat::WebP),
		"image/gif" => Some(image::ImageFormat::Gif),
		"image/bmp" => Some(image::ImageFormat::Bmp),
		"image/tiff" => Some(image::ImageFormat::Tiff),
		"image/x-icon" | "image/vnd.microsoft.icon" => Some(image::ImageFormat::Ico),
		_ => None,
	};

	let reader = if let Some(fmt) = format_hint {
		image::ImageReader::with_format(Cursor::new(bytes), fmt)
	} else {
		image::ImageReader::new(Cursor::new(bytes))
			.with_guessed_format()
			.map_err(|e| format!("Failed to detect image format: {e}"))?
	};

	let format = reader
		.format()
		.ok_or_else(|| "Unknown image format".to_string())?;
	let gpui_format = match format {
		image::ImageFormat::Png => ImageFormat::Png,
		image::ImageFormat::Jpeg => ImageFormat::Jpeg,
		image::ImageFormat::WebP => ImageFormat::Webp,
		image::ImageFormat::Gif => ImageFormat::Gif,
		image::ImageFormat::Bmp => ImageFormat::Bmp,
		image::ImageFormat::Tiff => ImageFormat::Tiff,
		image::ImageFormat::Ico => ImageFormat::Ico,
		image::ImageFormat::Pnm => ImageFormat::Pnm,
		other => return Err(format!("Unsupported format: {other:?}")),
	};

	let mut decoder = reader
		.into_decoder()
		.map_err(|e| format!("Decoder init failed: {e}"))?;
	let (orig_width, orig_height) = decoder.dimensions();
	if orig_width == 0 || orig_height == 0 {
		return Err(format!("Image dimensions must be non-zero (got {orig_width}×{orig_height})"));
	}
	if orig_width > MAX_IMAGE_DIMENSION_PX || orig_height > MAX_IMAGE_DIMENSION_PX {
		return Err(format!(
			"Image dimension {orig_width}×{orig_height} exceeds limit of {MAX_IMAGE_DIMENSION_PX}px"
		));
	}
	let total_pixels = (orig_width as u64)
		.checked_mul(orig_height as u64)
		.ok_or_else(|| "Image pixel count overflow".to_string())?;
	if total_pixels > MAX_IMAGE_PIXELS {
		return Err(format!(
			"Image pixel count {total_pixels} exceeds limit of {MAX_IMAGE_PIXELS} pixels"
		));
	}

	let mut limits = image::Limits::default();
	limits.max_image_width = Some(MAX_IMAGE_DIMENSION_PX);
	limits.max_image_height = Some(MAX_IMAGE_DIMENSION_PX);
	limits.max_alloc = Some(MAX_IMAGE_CACHE_BYTES as u64);
	decoder
		.set_limits(limits)
		.map_err(|error| format!("Image decoder cannot enforce resource limits: {error}"))?;

	let orientation = decoder
		.orientation()
		.map_err(|error| format!("Image orientation failed: {error}"))?;
	let mut dynamic_image = DynamicImage::from_decoder(decoder)
		.map_err(|e| format!("Image pixel decoding failed: {e}"))?;
	dynamic_image.apply_orientation(orientation);

	let render_data =
		if orig_width > MAX_PREVIEW_DIMENSION_PX || orig_height > MAX_PREVIEW_DIMENSION_PX {
			dynamic_image.thumbnail(MAX_PREVIEW_DIMENSION_PX, MAX_PREVIEW_DIMENSION_PX)
		} else {
			dynamic_image
		};

	let mut data = render_data.into_rgba8();
	let render_bytes = data.len();
	for pixel in data.chunks_exact_mut(4) {
		pixel.swap(0, 2);
	}
	let gpui_image = Arc::new(RenderImage::new(SmallVec::from_const([image::Frame::new(data)])));

	Ok(DecodedImage {
		width: orig_width,
		height: orig_height,
		format: gpui_format,
		gpui_image,
		render_bytes,
	})
}

fn is_svg_payload(bytes: &[u8]) -> bool {
	let prefix_len = bytes.len().min(512);
	let prefix = String::from_utf8_lossy(&bytes[..prefix_len]);
	let trimmed = prefix.trim_start();
	trimmed.starts_with("<svg") || trimmed.starts_with("<?xml") && trimmed.contains("<svg")
}

/// Retrieves or decodes an image artifact, caching the outcome in memory.
pub fn get_or_decode_image(data: &Arc<[u8]>, media_type: Option<&str>) -> ImageStatus {
	let input_bytes = data
		.len()
		.saturating_add(media_type.map_or(0, |mime| mime.len().saturating_mul(2)));
	if input_bytes > MAX_IMAGE_RAW_BYTES {
		return ImageStatus::Error {
			message: format!(
				"Image input ({input_bytes} bytes) exceeds preview limit of {MAX_IMAGE_RAW_BYTES} \
				 bytes; open the original file"
			),
		};
	}
	if let Some(status) = with_image_cache(|cache| cache.get(data, media_type)) {
		return status;
	}

	let (status, render_bytes) = match decode_and_validate_image(data, media_type) {
		Ok(decoded) => (
			ImageStatus::Valid {
				width:      decoded.width,
				height:     decoded.height,
				format:     decoded.format,
				gpui_image: decoded.gpui_image,
			},
			decoded.render_bytes,
		),
		Err(err) => (ImageStatus::Error { message: err }, 0),
	};

	with_image_cache(|cache| {
		cache.insert(data, media_type, status.clone(), render_bytes);
	});

	status
}
