//! Rasterized frame data, owned here rather than in `veyyon-gpui`.
//!
//! A frame is plain data: a readback of the headless surface converts into
//! one, and a caller compares or encodes it with no renderer linked.
//!
//! Coordinates: `width` and `height` are DEVICE pixels. Hit rects and text
//! runs are LOGICAL pixels. `scale_factor` converts between them.

use thiserror::Error;

/// A frame whose length disagrees with its declared dimensions, or whose
/// dimensions cannot describe a raster.
#[derive(Debug, Error, PartialEq)]
pub enum FrameError {
	#[error(
		"frame is {width}x{height} device px at scale {scale_factor}, which needs {expected} bytes \
		 of RGBA8, but {actual} were supplied"
	)]
	ByteCountMismatch {
		width:        u32,
		height:       u32,
		scale_factor: f32,
		expected:     usize,
		actual:       usize,
	},
	#[error("frame dimensions must both be non-zero, got {width}x{height}")]
	ZeroDimension { width: u32, height: u32 },
	#[error("scale factor must be finite and greater than zero, got {scale_factor}")]
	InvalidScaleFactor { scale_factor: f32 },
}

/// One straight sRGB colour, unpremultiplied.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub struct RgbaColor {
	pub r: u8,
	pub g: u8,
	pub b: u8,
	pub a: u8,
}

impl RgbaColor {
	pub const TRANSPARENT: Self = Self { r: 0, g: 0, b: 0, a: 0 };

	pub const fn opaque(r: u8, g: u8, b: u8) -> Self {
		Self { r, g, b, a: 255 }
	}

	pub const fn new(r: u8, g: u8, b: u8, a: u8) -> Self {
		Self { r, g, b, a }
	}

	/// True when the colour paints nothing.
	pub const fn is_invisible(&self) -> bool {
		self.a == 0
	}
}

/// An RGBA8 raster, row-major, four bytes per pixel, no row padding.
#[derive(Clone, PartialEq, Eq)]
pub struct RgbaFrame {
	width:               u32,
	height:              u32,
	scale_factor_millis: u32,
	pixels:              Vec<u8>,
}

impl std::fmt::Debug for RgbaFrame {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("RgbaFrame")
			.field("width", &self.width)
			.field("height", &self.height)
			.field("scale_factor", &self.scale_factor())
			.field("bytes", &self.pixels.len())
			.finish()
	}
}

impl RgbaFrame {
	/// Wrap a readback buffer. `width` and `height` are device pixels.
	pub fn new(
		width: u32,
		height: u32,
		scale_factor: f32,
		pixels: Vec<u8>,
	) -> Result<Self, FrameError> {
		if width == 0 || height == 0 {
			return Err(FrameError::ZeroDimension { width, height });
		}
		if !scale_factor.is_finite() || scale_factor <= 0.0 {
			return Err(FrameError::InvalidScaleFactor { scale_factor });
		}
		let expected = (width as usize)
			.checked_mul(height as usize)
			.and_then(|n| n.checked_mul(4))
			.ok_or(FrameError::ByteCountMismatch {
				width,
				height,
				scale_factor,
				expected: usize::MAX,
				actual: pixels.len(),
			})?;
		if pixels.len() != expected {
			return Err(FrameError::ByteCountMismatch {
				width,
				height,
				scale_factor,
				expected,
				actual: pixels.len(),
			});
		}
		Ok(Self {
			width,
			height,
			scale_factor_millis: (scale_factor * 1000.0).round().max(1.0) as u32,
			pixels,
		})
	}

	pub const fn width(&self) -> u32 {
		self.width
	}

	pub const fn height(&self) -> u32 {
		self.height
	}

	/// Device pixels per logical pixel. Reconstructed from the stored
	/// thousandths so that `RgbaFrame` can derive `Eq`.
	pub fn scale_factor(&self) -> f32 {
		self.scale_factor_millis as f32 / 1000.0
	}

	pub fn logical_width(&self) -> f32 {
		self.width as f32 / self.scale_factor()
	}

	pub fn logical_height(&self) -> f32 {
		self.height as f32 / self.scale_factor()
	}

	/// The raster, row-major RGBA8, which a determinism check compares.
	pub fn as_bytes(&self) -> &[u8] {
		&self.pixels
	}

	/// The colour at a device pixel, or `None` when out of bounds.
	pub fn pixel(&self, x: u32, y: u32) -> Option<RgbaColor> {
		if x >= self.width || y >= self.height {
			return None;
		}
		let offset = ((y as usize) * (self.width as usize) + (x as usize)) * 4;
		let bytes = self.pixels.get(offset..offset + 4)?;
		match bytes {
			[red, green, blue, alpha] => Some(RgbaColor::new(*red, *green, *blue, *alpha)),
			_ => None,
		}
	}

	/// Every pixel in raster order.
	pub fn pixels(&self) -> impl Iterator<Item = RgbaColor> + '_ {
		self
			.pixels
			.as_chunks::<4>()
			.0
			.iter()
			.map(|[r, g, b, a]| RgbaColor::new(*r, *g, *b, *a))
	}
}
