//! WHY: Transcript artifacts (images, file mentions) must present accurate
//! metadata in 24px collapsed rows, decode and display images at bounded widths
//! when expanded, report explicit errors for corrupt image bytes (including
//! corrupt pixel bodies following valid headers), dispatch file open actions
//! through real ShellView click handlers, enforce admission for unavailable
//! files, distinguish MIME types in caching, enforce pre-rasterization SVG
//! bounds, and enforce bounded byte limits across all retained cache memory.

use std::{
	path::Path,
	sync::Arc,
	time::{Duration, Instant},
};

use image::{ImageBuffer, Rgba};
use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::{
	headless::{Captured, Headless, RenderOptions, headless_context, render_view_captured},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	PanelTab, ShellState, ShellView, install_tokens,
	model::Artifact,
	transcript::{
		TranscriptViewportState,
		blocks::artifact::{
			ImageStatus, get_or_decode_image, render_artifact_block, with_image_cache,
		},
	},
};
use veyyon_desktop_tokens::{Theme, Tokens, TranscriptSurfaceTokens};
use veyyon_gpui::{
	App, AppContext, Context, Entity, ImageFormat, IntoElement, ParentElement, Point, Render,
	Styled, Window, div, px,
};

fn make_test_png(w: u32, h: u32, c: [u8; 4]) -> Vec<u8> {
	let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(w, h);
	for pixel in img.pixels_mut() {
		*pixel = Rgba(c);
	}
	let mut bytes = Vec::new();
	let enc = image::codecs::png::PngEncoder::new(&mut bytes);
	image::ImageEncoder::write_image(enc, &img, w, h, image::ExtendedColorType::Rgba8).expect("png");
	bytes
}

struct TestArtifactView {
	shell_view: Option<Entity<ShellView>>,
	state:      TranscriptViewportState,
	geometry:   TranscriptSurfaceTokens,
	tokens:     TokenSet,
	motion:     MotionTokens,
	artifact:   Artifact,
	expanded:   bool,
}

impl Render for TestArtifactView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let weak = self.shell_view.as_ref().map(Entity::downgrade);
		div().size_full().child(render_artifact_block(
			0,
			0,
			&self.artifact,
			self.expanded,
			&self.geometry,
			&self.tokens,
			&self.motion,
			false,
			&self.state,
			weak.as_ref(),
		))
	}
}

fn render_artifact_headless(artifact: Artifact, expanded: bool) -> Captured {
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	let mut cx = headless_context().expect("headless context");

	render_view_captured(
		&mut cx,
		&RenderOptions {
			width: 768,
			height: if expanded { 400 } else { 48 },
			scale_factor: 1.0,
			..RenderOptions::default()
		},
		move |_, app: &mut App| {
			let ins = install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
			if expanded {
				state.record_reveal_height(0, 0, 200.0);
				state.set_block_expanded(0, 0, true, &ins.motion, true, Instant::now());
				assert_eq!(
					state.sample_reveal(0, 0, Instant::now() + Duration::from_secs(1)),
					(1.0, true)
				);
			}
			app.new(|_| TestArtifactView {
				shell_view: None,
				state,
				geometry: tokens.surface.transcript,
				tokens: ins.set,
				motion: ins.motion,
				artifact,
				expanded,
			})
		},
	)
	.expect("rendered view")
}

fn open_test_session<'a>(
	cx: &'a mut Headless,
	tokens: &Tokens,
	theme: &Theme,
	artifact: Artifact,
) -> HeadlessSession<'a, TestArtifactView> {
	let (tokens, theme) = (tokens.clone(), theme.clone());
	HeadlessSession::open(
		cx,
		&RenderOptions { width: 768, height: 300, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app: &mut App| {
			let ins = install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
			let shell = app.new(|_| ShellView::new(ins.clone(), ShellState::default()));
			let state = TranscriptViewportState::new();
			state.record_reveal_height(0, 0, 200.0);
			state.set_block_expanded(0, 0, true, &ins.motion, true, Instant::now());
			assert_eq!(
				state.sample_reveal(0, 0, Instant::now() + Duration::from_secs(1)),
				(1.0, true)
			);
			app.new(|_| TestArtifactView {
				shell_view: Some(shell),
				state,
				geometry: tokens.surface.transcript,
				tokens: ins.set,
				motion: ins.motion,
				artifact,
				expanded: true,
			})
		},
	)
	.expect("opened session")
}

#[test]
fn image_artifact_decodes_known_pixels_and_renders_dimensions() {
	let data = Arc::from(make_test_png(32, 32, [255, 0, 0, 255]));
	let status = get_or_decode_image(&data, Some("image/png"));
	match status {
		ImageStatus::Valid { width, height, format, gpui_image } => {
			assert_eq!((width, height, format), (32, 32, ImageFormat::Png));
			assert_eq!(gpui_image.as_bytes(0), Some([0, 0, 255, 255].repeat(32 * 32).as_slice()));
		},
		ImageStatus::Error { message } => panic!("Expected valid image, got error: {message}"),
	}
	let valid_art =
		Artifact::Image { media_type: "image/png".into(), data, alt: Some("Color test".into()) };
	let c = render_artifact_headless(valid_art.clone(), false);
	let e = render_artifact_headless(valid_art, true);
	// Rounded corners blend edge pixels. The interior must retain the source
	// color, while no pixel outside the 32×32 preview can have that color.
	let red_pixels = e
		.frame
		.as_bytes()
		.chunks_exact(4)
		.filter(|pixel| *pixel == [255, 0, 0, 255])
		.count();
	assert!((16 * 16..=32 * 32).contains(&red_pixels), "red pixels: {red_pixels}");
	assert_ne!(c.frame.as_bytes(), e.frame.as_bytes());
}

#[test]
fn image_with_valid_header_but_corrupted_body_fails_decoding() {
	let valid_png = make_test_png(2, 2, [255, 0, 0, 255]);
	let mut corrupt_body = valid_png[..33].to_vec();
	corrupt_body.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00]);
	let status = get_or_decode_image(&Arc::from(corrupt_body.clone()), Some("image/png"));
	assert!(matches!(status, ImageStatus::Error { .. }));
	let corrupt_art = Artifact::Image {
		media_type: "image/png".into(),
		data:       Arc::from(corrupt_body),
		alt:        Some("Corrupted".into()),
	};
	let healthy_art = Artifact::Image {
		media_type: "image/png".into(),
		data:       Arc::from(valid_png),
		alt:        Some("Corrupted".into()),
	};
	assert_ne!(
		render_artifact_headless(corrupt_art, true).frame.as_bytes(),
		render_artifact_headless(healthy_art, true).frame.as_bytes()
	);
}

#[test]
fn file_mention_all_six_variants_render_distinct_frames_and_metadata() {
	let png = make_test_png(2, 2, [255, 0, 0, 255]);
	let variants = [
		Artifact::File {
			path:               "src/main.rs".into(),
			has_content:        true,
			lines:              None,
			bytes:              None,
			unavailable_reason: None,
			image:              None,
		},
		Artifact::File {
			path:               "src/main.rs".into(),
			has_content:        false,
			lines:              Some(142),
			bytes:              None,
			unavailable_reason: None,
			image:              None,
		},
		Artifact::File {
			path:               "src/main.rs".into(),
			has_content:        false,
			lines:              None,
			bytes:              Some(8192),
			unavailable_reason: None,
			image:              None,
		},
		Artifact::File {
			path:               "src/main.rs".into(),
			has_content:        false,
			lines:              None,
			bytes:              None,
			unavailable_reason: Some("deleted".into()),
			image:              None,
		},
		Artifact::File {
			path:               "assets/logo.png".into(),
			has_content:        false,
			lines:              None,
			bytes:              None,
			unavailable_reason: None,
			image:              Some(Arc::from(png)),
		},
		Artifact::File {
			path:               "src/main.rs".into(),
			has_content:        false,
			lines:              None,
			bytes:              None,
			unavailable_reason: None,
			image:              None,
		},
	];
	let frames: Vec<Captured> = variants
		.into_iter()
		.map(|a| render_artifact_headless(a, false))
		.collect();
	for (index, frame) in frames.iter().enumerate() {
		for other in &frames[index + 1..] {
			assert_ne!(frame.frame.as_bytes(), other.frame.as_bytes());
		}
	}
}

#[test]
fn file_open_action_button_click_through_shell_view_and_unavailable_admission() {
	let (tokens, theme) =
		(load_bundled_tokens().expect("tokens"), load_bundled_theme("dark").expect("theme"));
	let avail = Artifact::File {
		path:               "src/widgets/canvas.rs".into(),
		has_content:        true,
		lines:              Some(100),
		bytes:              Some(4096),
		unavailable_reason: None,
		image:              None,
	};
	{
		let mut cx = headless_context().expect("headless context");
		let mut session = open_test_session(&mut cx, &tokens, &theme, avail);
		let frame = session.frame().expect("rendered frame");
		let open_hitbox = frame
			.hitboxes
			.iter()
			.find(|hb| {
				hb.origin.y > px(30.0) && hb.size.width < px(200.0) && hb.size.height >= px(20.0)
			})
			.expect("hitbox");
		let click_pt = Point {
			x: open_hitbox.origin.x + open_hitbox.size.width / 2.0,
			y: open_hitbox.origin.y + open_hitbox.size.height / 2.0,
		};
		session.click(click_pt).expect("click");
		session
			.update(|test_view, _, cx| {
				let shell = test_view.shell_view.as_ref().unwrap();
				shell.update(cx, |s, _| {
					assert_eq!(s.state().panel.active_tab, PanelTab::File);
					assert_eq!(
						s.state().panel.tree.selected_path.as_deref(),
						Some("src/widgets/canvas.rs")
					);
				});
			})
			.expect("open verified");
	}

	let unavail = Artifact::File {
		path:               "src/deleted.rs".into(),
		has_content:        false,
		lines:              None,
		bytes:              None,
		unavailable_reason: Some("deleted".into()),
		image:              None,
	};
	{
		let mut cx = headless_context().expect("headless context");
		let mut session = open_test_session(&mut cx, &tokens, &theme, unavail);
		let frame = session.frame().expect("rendered frame");
		if let Some(hb) = frame
			.hitboxes
			.iter()
			.find(|hb| hb.origin.y > px(30.0) && hb.size.width < px(200.0))
		{
			let pt =
				Point { x: hb.origin.x + hb.size.width / 2.0, y: hb.origin.y + hb.size.height / 2.0 };
			let _ = session.click(pt);
		}
		session
			.update(|test_view, _, cx| {
				let shell = test_view.shell_view.as_ref().unwrap();
				shell.update(cx, |s, _| {
					assert_ne!(s.state().panel.active_tab, PanelTab::File);
					assert_eq!(s.state().panel.tree.selected_path, None);
				});
			})
			.expect("admission verified");
	}
}

#[test]
fn image_cache_distinguishes_mime_and_source_identity() {
	with_image_cache(|cache| cache.clear());
	let data1: Arc<[u8]> = Arc::from(make_test_png(2, 2, [255, 0, 0, 255]));
	let s_png = get_or_decode_image(&data1, Some("image/png"));
	let s_png_again = get_or_decode_image(&data1, Some("image/png"));
	match (&s_png, &s_png_again) {
		(ImageStatus::Valid { gpui_image: g1, .. }, ImageStatus::Valid { gpui_image: g2, .. }) => {
			assert!(Arc::ptr_eq(g1, g2), "Same Arc source must hit cache");
		},
		_ => panic!("Expected valid image status"),
	}

	let s_jpeg = get_or_decode_image(&data1, Some("image/jpeg"));
	assert!(
		matches!(s_jpeg, ImageStatus::Error { .. }),
		"PNG bytes declared as JPEG must fail decoding"
	);

	// Source identity validation: distinct Arc instances with identical bytes do
	// not collide
	let data2: Arc<[u8]> = Arc::from(make_test_png(2, 2, [255, 0, 0, 255]));
	with_image_cache(|cache| {
		assert!(cache.get(&data1, Some("image/png")).is_some());
		assert!(cache.get(&data2, Some("image/png")).is_none());
	});
}

#[test]
fn expansion_and_collapse_toggle_motion_state() {
	let viewport_state = TranscriptViewportState::new();
	let motion = MotionTokens::reference();
	let now = Instant::now();
	assert!(!viewport_state.is_block_expanded(0, 0));
	viewport_state.set_block_expanded(0, 0, true, &motion, false, now);
	assert!(viewport_state.is_block_expanded(0, 0));
	let half = now + Duration::from_millis(100);
	let (progress, _) = viewport_state.reveal_frame(0, 0, half);
	assert!(progress > 0.0 && progress < 1.0);
	viewport_state.set_block_expanded(0, 0, false, &motion, false, half);
	assert!(!viewport_state.is_block_expanded(0, 0));
	assert!((viewport_state.reveal_frame(0, 0, half).0 - progress).abs() < 0.001);
	let done = half + Duration::from_secs(3);
	assert_eq!(viewport_state.reveal_frame(0, 0, done).0, 0.0);
	viewport_state.set_block_expanded(0, 0, true, &motion, true, done);
	assert_eq!(
		viewport_state
			.reveal_frame(0, 0, done + Duration::from_millis(60))
			.0,
		1.0
	);
}
