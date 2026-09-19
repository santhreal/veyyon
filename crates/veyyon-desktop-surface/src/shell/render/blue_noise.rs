//! Deterministic 128x128 R8 blue-noise texture generator (§6.5).
//!
//! Generated once at startup behind a `LazyLock` using the void-and-cluster
//! algorithm with a toroidal Gaussian filter. Energy is concentrated in
//! high frequencies to eliminate regular tiling artifacts on level 0 ground.

use std::sync::LazyLock;

use veyyon_gpui::RenderImage;

/// Side length of the blue noise tile in pixels.
pub const BLUE_NOISE_SIZE: usize = 128;
const PIXEL_COUNT: usize = BLUE_NOISE_SIZE * BLUE_NOISE_SIZE;
const DEFAULT_SEED: u64 = 0x5a17_b10e_4015_e128;

static BLUE_NOISE_TILE: LazyLock<[u8; PIXEL_COUNT]> =
	LazyLock::new(|| generate_blue_noise(DEFAULT_SEED));

static BLUE_NOISE_IMAGE: LazyLock<std::sync::Arc<RenderImage>> = LazyLock::new(|| {
	let tile = blue_noise_tile();
	let mut rgba = image::RgbaImage::new(BLUE_NOISE_SIZE as u32, BLUE_NOISE_SIZE as u32);
	for (i, &v) in tile.iter().enumerate() {
		let x = (i % BLUE_NOISE_SIZE) as u32;
		let y = (i / BLUE_NOISE_SIZE) as u32;
		rgba.put_pixel(x, y, image::Rgba([v, v, v, 255]));
	}
	std::sync::Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(rgba)]))
});

/// Returns a reference to the statically generated 128x128 R8 blue noise tile.
#[must_use]
pub fn blue_noise_tile() -> &'static [u8; PIXEL_COUNT] {
	&BLUE_NOISE_TILE
}

/// Returns the cached GPUI `RenderImage` constructed from the blue noise tile.
#[must_use]
pub fn blue_noise_image() -> std::sync::Arc<RenderImage> {
	std::sync::Arc::clone(&BLUE_NOISE_IMAGE)
}

/// Simple `SplitMix64` pseudo-random generator for deterministic seeding.
struct SplitMix64(u64);

impl SplitMix64 {
	const fn new(seed: u64) -> Self {
		Self(seed)
	}

	const fn next_u64(&mut self) -> u64 {
		self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
		let mut z = self.0;
		z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
		z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
		z ^ (z >> 31)
	}

	const fn next_usize(&mut self, bound: usize) -> usize {
		if bound == 0 {
			0
		} else {
			(self.next_u64() % (bound as u64)) as usize
		}
	}
}

/// Generates a 128x128 R8 blue-noise dither pattern for the given seed.
#[must_use]
pub fn generate_blue_noise(seed: u64) -> [u8; PIXEL_COUNT] {
	let mut rng = SplitMix64::new(seed);
	let mut binary = [false; PIXEL_COUNT];
	// Two words per pixel, which is past the stack budget a lint holds this
	// crate to and past what a render thread should carry: the tile is built
	// once, so the working set is allocated once.
	let mut energy = vec![0.0f32; PIXEL_COUNT];
	let mut dither = vec![0usize; PIXEL_COUNT];

	// Precomputed 13x13 Gaussian filter (sigma = 1.9, radius = 6).
	const K_RADIUS: isize = 6;
	const K_SIZE: usize = 13;
	let mut kernel = [[0.0f32; K_SIZE]; K_SIZE];
	let two_sigma_sq = 2.0 * 1.9f32 * 1.9f32;
	for dy in -K_RADIUS..=K_RADIUS {
		for dx in -K_RADIUS..=K_RADIUS {
			let dist_sq = (dx * dx + dy * dy) as f32;
			kernel[(dy + K_RADIUS) as usize][(dx + K_RADIUS) as usize] =
				(-dist_sq / two_sigma_sq).exp();
		}
	}

	// Helper to add or subtract kernel energy at (x, y) with toroidal wrapping.
	let apply_kernel = |energy: &mut [f32], cx: usize, cy: usize, sign: f32| {
		for (dy_idx, dy) in (-K_RADIUS..=K_RADIUS).enumerate() {
			let ny = (cy as isize + dy).rem_euclid(BLUE_NOISE_SIZE as isize) as usize;
			let row_offset = ny * BLUE_NOISE_SIZE;
			let k_row = &kernel[dy_idx];
			for (dx_idx, dx) in (-K_RADIUS..=K_RADIUS).enumerate() {
				let nx = (cx as isize + dx).rem_euclid(BLUE_NOISE_SIZE as isize) as usize;
				energy[row_offset + nx] = sign.mul_add(k_row[dx_idx], energy[row_offset + nx]);
			}
		}
	};

	// Phase 1: Initialize ~10% minority points using partial Fisher-Yates shuffle.
	let initial_count = PIXEL_COUNT / 10;
	let mut indices: Vec<usize> = (0..PIXEL_COUNT).collect();
	for i in 0..initial_count {
		let swap_idx = i + rng.next_usize(PIXEL_COUNT - i);
		indices.swap(i, swap_idx);
		let pos = indices[i];
		binary[pos] = true;
		apply_kernel(&mut energy, pos % BLUE_NOISE_SIZE, pos / BLUE_NOISE_SIZE, 1.0);
	}

	// Relax minority points until convergence or iteration limit.
	for _ in 0..(initial_count * 2) {
		let mut max_energy = -f32::INFINITY;
		let mut cluster_pos = 0;
		for (i, &is_set) in binary.iter().enumerate() {
			if is_set && energy[i] > max_energy {
				max_energy = energy[i];
				cluster_pos = i;
			}
		}

		binary[cluster_pos] = false;
		apply_kernel(&mut energy, cluster_pos % BLUE_NOISE_SIZE, cluster_pos / BLUE_NOISE_SIZE, -1.0);

		let mut min_energy = f32::INFINITY;
		let mut void_pos = 0;
		for (i, &is_set) in binary.iter().enumerate() {
			if !is_set && energy[i] < min_energy {
				min_energy = energy[i];
				void_pos = i;
			}
		}

		binary[void_pos] = true;
		apply_kernel(&mut energy, void_pos % BLUE_NOISE_SIZE, void_pos / BLUE_NOISE_SIZE, 1.0);

		if cluster_pos == void_pos {
			break;
		}
	}

	// Phase 2: Rank minority points down to 0 by removing clusters.
	let mut b2 = binary;
	let mut e2 = energy.clone();
	for rank in (0..initial_count).rev() {
		let mut max_energy = -f32::INFINITY;
		let mut cluster_pos = 0;
		for (i, &is_set) in b2.iter().enumerate() {
			if is_set && e2[i] > max_energy {
				max_energy = e2[i];
				cluster_pos = i;
			}
		}
		dither[cluster_pos] = rank;
		b2[cluster_pos] = false;
		apply_kernel(&mut e2, cluster_pos % BLUE_NOISE_SIZE, cluster_pos / BLUE_NOISE_SIZE, -1.0);
	}

	// Phase 3: Rank majority points up to PIXEL_COUNT - 1 by filling voids.
	let mut b3 = binary;
	let mut e3 = energy;
	for rank in initial_count..PIXEL_COUNT {
		let mut min_energy = f32::INFINITY;
		let mut void_pos = 0;
		for (i, &is_set) in b3.iter().enumerate() {
			if !is_set && e3[i] < min_energy {
				min_energy = e3[i];
				void_pos = i;
			}
		}
		dither[void_pos] = rank;
		b3[void_pos] = true;
		apply_kernel(&mut e3, void_pos % BLUE_NOISE_SIZE, void_pos / BLUE_NOISE_SIZE, 1.0);
	}

	let mut result = [0u8; PIXEL_COUNT];
	for (i, &rank) in dither.iter().enumerate() {
		result[i] = ((rank as u32 * 256) / PIXEL_COUNT as u32) as u8;
	}
	result
}
