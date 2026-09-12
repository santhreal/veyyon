//! WHY: The preview cache retained source Arcs but counted only decoded pixels.
//! This suite checks retained source and decoded payload accounting, eviction,
//! and cheap rejection before decoding. It does not measure GPU driver
//! allocations.

use std::{io::Cursor, sync::Arc};

use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
use veyyon_desktop_surface::transcript::blocks::artifact::{
	ImageCache, ImageStatus, MAX_IMAGE_CACHE_BYTES, MAX_IMAGE_RAW_BYTES, MAX_PREVIEW_DIMENSION_PX,
	decode_and_validate_image, get_or_decode_image, with_image_cache,
};

#[test]
fn retained_sources_force_eviction_even_when_decoded_images_are_small() {
	let mut png = Cursor::new(Vec::new());
	DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 2, Rgba([1, 2, 3, 255])))
		.write_to(&mut png, ImageFormat::Png)
		.expect("encode fixture");
	let mut payload = png.into_inner();
	let source_bytes = 6 * 1024 * 1024;
	payload.resize(source_bytes, 0);
	let mut cache = ImageCache::new();
	let mut sources = Vec::new();
	for _ in 0..8 {
		let source: Arc<[u8]> = Arc::from(payload.clone());
		let decoded =
			decode_and_validate_image(&source, Some("image/png")).expect("valid padded PNG");
		assert_eq!((decoded.width, decoded.height), (2, 2));
		let status = ImageStatus::Valid {
			width:      decoded.width,
			height:     decoded.height,
			format:     decoded.format,
			gpui_image: decoded.gpui_image,
		};
		sources.push(Arc::downgrade(&source));
		cache.insert(&source, Some("image/png"), status, decoded.render_bytes);
		assert!(cache.total_retained_bytes() >= cache.len() * (source_bytes + 16));
		assert!(cache.total_retained_bytes() <= MAX_IMAGE_CACHE_BYTES);
	}
	assert_eq!(cache.len(), 5);
	assert!(sources[..3].iter().all(|source| source.upgrade().is_none()));
	assert!(sources[3..].iter().all(|source| source.upgrade().is_some()));
	cache.clear();
	assert!(sources.iter().all(|source| source.upgrade().is_none()));
	assert_eq!(cache.total_retained_bytes(), 0);
}

#[test]
fn rejected_payloads_are_bounded_before_any_format_decoder_runs() {
	let oversized: Arc<[u8]> = Arc::from(vec![0; MAX_IMAGE_RAW_BYTES + 1]);
	for mime in [None, Some("image/png"), Some("image/svg+xml")] {
		let expected = format!(
			"Image input ({} bytes) exceeds preview limit of {} bytes; open the original file",
			oversized.len() + mime.map_or(0, |mime| mime.len() * 2),
			MAX_IMAGE_RAW_BYTES
		);
		assert_eq!(
			decode_and_validate_image(&oversized, mime).expect_err("reject before parsing"),
			expected
		);
		assert!(
			matches!(get_or_decode_image(&oversized, mime), ImageStatus::Error { message } if message == expected)
		);
	}
}

#[test]
fn error_cache_entries_account_for_retained_input_and_keys() {
	let source: Arc<[u8]> = Arc::from(vec![0; 1024]);
	let mut cache = ImageCache::new();
	let message = "invalid image".to_string();
	cache.insert(&source, Some("image/png"), ImageStatus::Error { message: message.clone() }, 0);
	assert!(cache.total_retained_bytes() >= source.len() + message.len() + 2 * "image/png".len());
}

#[test]
fn svg_previews_use_intrinsic_dimensions_before_bounded_rasterization() {
	for attributes in
		["width=\"64\" height=\"32\"", "width = '64px' height = '32px'", "viewBox=\"0 0 64 32\""]
	{
		let svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" {attributes}/>");
		let decoded =
			decode_and_validate_image(svg.as_bytes(), Some("image/svg+xml")).expect("valid SVG");
		assert_eq!((decoded.width, decoded.height), (64, 32));
		assert_eq!(decoded.format.mime_type(), "image/svg+xml");
	}
	let large = br#"<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="4096"/>"#;
	let decoded = decode_and_validate_image(large, Some("image/svg+xml")).expect("bounded SVG");
	assert_eq!((decoded.width, decoded.height), (4096, 4096));
	let size = decoded.gpui_image.size(0);
	assert_eq!(
		(size.width.0, size.height.0),
		(MAX_PREVIEW_DIMENSION_PX as i32, MAX_PREVIEW_DIMENSION_PX as i32)
	);
	let oversized = br#"<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"/>"#;
	assert!(
		decode_and_validate_image(oversized, Some("image/svg+xml"))
			.expect_err("reject before rasterizing")
			.contains("exceeds limit")
	);
}

#[test]
fn corrupt_payload_errors_are_retained_without_redecoding() {
	assert_eq!(
		decode_and_validate_image(&[], None).expect_err("empty input"),
		"Image payload is empty"
	);
	let corrupt: Arc<[u8]> = Arc::from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
	let ImageStatus::Error { message } = get_or_decode_image(&corrupt, Some("image/jpeg")) else {
		panic!("corrupt JPEG accepted");
	};
	with_image_cache(|cache| {
		assert!(matches!(cache.get(&corrupt, Some("image/jpeg")),
			Some(ImageStatus::Error { message: cached }) if cached == message));
	});
}
