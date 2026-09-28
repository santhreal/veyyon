//! WHY: a capture of the desktop window is evidence only while it is a
//! function of the store it draws. A render that picks up the wall clock, a
//! hash seed or the order two tasks finished in draws different bytes for the
//! same store, and a render that never reached the regions draws the same
//! bytes for every store; either one turns a Before/After pair into noise.
//!
//! CLASS CLOSED: a headless render of the window the binary opens (the
//! workspace over the six regions `regions::build` constructs) that is not
//! byte-identical across two renders of one store, that draws nothing, that
//! does not change when the store names different threads, or that writes a
//! PNG which does not decode at the frame's geometry.
//!
//! NOT CAUGHT: whether two processes or two GPUs draw the same bytes, and
//! whether the frame is well designed, which a person reads the PNG for.

use std::{fs, io::BufReader, path::PathBuf};

use veyyon_desktop_scene::{
	Captured, RenderOptions, distinct_pixel_values, render_workspace, write_png,
};
use veyyon_desktop_ui::theme::Appearance;

/// Under `target/`, so a frame a test writes is never committed.
fn output_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/scene-frames")
}

const fn options() -> RenderOptions {
	RenderOptions {
		width:        1280,
		height:       800,
		scale_factor: 1.0,
		appearance:   Appearance::Dark,
	}
}

fn render(seed: u64) -> Captured {
	render_workspace(&options(), seed).expect("the workspace renders headless")
}

/// Whether a text run of the frame drew `text`.
fn draws(captured: &Captured, text: &str) -> bool {
	captured.text_runs.iter().any(|run| run.text.contains(text))
}

#[test]
fn one_store_renders_the_same_bytes_twice_and_a_different_one_does_not() {
	let first = render(7);
	let again = render(7);
	let other = render(8);

	assert_eq!(
		(first.frame.width(), first.frame.height()),
		(1280, 800),
		"the frame is the requested size in device pixels"
	);
	assert!(
		distinct_pixel_values(&first.frame) > 16,
		"the frame holds {} pixel values, so the regions were not drawn",
		distinct_pixel_values(&first.frame)
	);
	assert!(
		first.frame.as_bytes() == again.frame.as_bytes(),
		"two renders of one store drew different bytes"
	);
	assert_eq!(
		first.text_runs, again.text_runs,
		"two renders of one store laid text out differently"
	);

	// The seed reaches the view: the open thread's title is drawn, and the
	// other seed's is not.
	assert!(draws(&first, "(7.0)"), "the open thread of seed 7 is not drawn");
	assert!(!draws(&first, "(8.0)"), "a thread seed 7 does not list is drawn");
	assert!(draws(&other, "(8.0)"), "the open thread of seed 8 is not drawn");
	assert!(
		first.frame.as_bytes() != other.frame.as_bytes(),
		"two stores naming different threads drew the same bytes"
	);
}

#[test]
fn a_rendered_window_writes_a_png_that_decodes_at_its_geometry() {
	let dark = render(7);
	let light = render_workspace(&RenderOptions { appearance: Appearance::Light, ..options() }, 7)
		.expect("the workspace renders headless in the light palette");
	assert!(
		dark.frame.as_bytes() != light.frame.as_bytes(),
		"the appearance did not reach the render"
	);

	let path = output_dir().join("workspace-seed-7-dark.png");
	write_png(&dark.frame, &path).expect("the frame encodes as a PNG");
	let file = fs::File::open(&path).expect("the PNG exists after writing");
	let mut reader = png::Decoder::new(BufReader::new(file))
		.read_info()
		.expect("the PNG header decodes");
	let info = reader.info();
	assert_eq!((info.width, info.height), (1280, 800), "the PNG is the frame's size");
	assert_eq!(info.color_type, png::ColorType::Rgba, "the PNG carries an alpha channel");
	let mut decoded = vec![
		0;
		reader
			.output_buffer_size()
			.expect("the PNG states its size")
	];
	reader
		.next_frame(&mut decoded)
		.expect("the PNG body decodes");
	assert!(decoded == dark.frame.as_bytes(), "the PNG holds different pixels than the frame");
}
