//! WHY: §6.5 requires level 0 shell ground grain to use a 128x128 R8 blue-noise
//! texture generated once at startup from a fixed seed. A regular pattern or
//! naive white noise introduces visible tiling periodicity or low-frequency
//! blotches rather than uniformly dispersing energy into high frequencies.
//!
//! THE CLASS THIS CLOSES: ground grain texture defects including
//! non-deterministic texture variations across processes and low-frequency
//! spectral clustering.
//!
//! WHAT IT DOES NOT CATCH: GPU rasterizer interpolation artifacts when scaling
//! or rendering under non-integer display scaling factors.

use std::f32::consts::PI;

use veyyon_desktop_surface::shell::render::grain::blue_noise::{
	BLUE_NOISE_SIZE, blue_noise_tile, generate_blue_noise,
};

#[test]
fn blue_noise_generator_is_deterministic_for_seed() {
	let seed = 0x5a17_b10e_4015_e128;
	let tile_a = generate_blue_noise(seed);
	let tile_b = generate_blue_noise(seed);
	assert_eq!(tile_a, tile_b, "same seed must produce identical blue noise tiles");

	let tile_static = blue_noise_tile();
	assert_eq!(*tile_static, tile_a, "statically cached tile must match seeded generator");

	let tile_other = generate_blue_noise(seed ^ 0xffff_ffff);
	assert_ne!(tile_a, tile_other, "different seeds must produce different tiles");
}

/// 1D radix-2 decimation-in-time fast Fourier transform.
fn fft_1d(data: &[(f32, f32)]) -> Vec<(f32, f32)> {
	let n = data.len();
	if n <= 1 {
		return data.to_vec();
	}
	let mut even = Vec::with_capacity(n / 2);
	let mut odd = Vec::with_capacity(n / 2);
	for i in 0..n / 2 {
		even.push(data[2 * i]);
		odd.push(data[2 * i + 1]);
	}
	let even_fft = fft_1d(&even);
	let odd_fft = fft_1d(&odd);

	let mut result = vec![(0.0f32, 0.0f32); n];
	let angle_step = -2.0 * PI / (n as f32);
	for k in 0..n / 2 {
		let angle = (k as f32) * angle_step;
		let (cos_k, sin_k) = (angle.cos(), angle.sin());
		let (odd_re, odd_im) = odd_fft[k];
		let twiddle_re = sin_k.mul_add(-odd_im, cos_k * odd_re);
		let twiddle_im = sin_k.mul_add(odd_re, cos_k * odd_im);
		let (even_re, even_im) = even_fft[k];

		result[k] = (even_re + twiddle_re, even_im + twiddle_im);
		result[k + n / 2] = (even_re - twiddle_re, even_im - twiddle_im);
	}
	result
}

/// Computes the ratio of high-frequency power to low-frequency power.
fn high_to_low_energy_ratio(tile: &[u8; BLUE_NOISE_SIZE * BLUE_NOISE_SIZE]) -> f32 {
	let n = BLUE_NOISE_SIZE;
	let mut grid = vec![vec![(0.0f32, 0.0f32); n]; n];

	// Remove DC component (zero-mean).
	let sum: f32 = tile.iter().map(|&v| v as f32).sum();
	let mean = sum / (tile.len() as f32);
	for (y, row) in grid.iter_mut().enumerate() {
		for (x, cell) in row.iter_mut().enumerate() {
			*cell = ((tile[y * n + x] as f32) - mean, 0.0);
		}
	}

	// 2D FFT: rows then columns.
	for row in &mut grid {
		*row = fft_1d(row);
	}
	for x in 0..n {
		let col: Vec<(f32, f32)> = grid.iter().map(|row| row[x]).collect();
		let col_fft = fft_1d(&col);
		for (row, value) in grid.iter_mut().zip(col_fft) {
			row[x] = value;
		}
	}

	let center = (n / 2) as f32;
	let mut low_power_sum = 0.0f32;
	let mut low_count = 0usize;
	let mut high_power_sum = 0.0f32;
	let mut high_count = 0usize;

	for (y, row) in grid.iter().enumerate() {
		// FFT shift: shift frequency zero to center.
		let sy = ((y + n / 2) % n) as f32 - center;
		for (x, &(re, im)) in row.iter().enumerate() {
			let sx = ((x + n / 2) % n) as f32 - center;
			let r = sx.mul_add(sx, sy * sy).sqrt();
			let power = re.mul_add(re, im * im);

			if r > 2.0 && r < center * 0.5 {
				low_power_sum += power;
				low_count += 1;
			} else if r >= center * 0.5 && r <= center {
				high_power_sum += power;
				high_count += 1;
			}
		}
	}

	let low_avg = low_power_sum / (low_count.max(1) as f32);
	let high_avg = high_power_sum / (high_count.max(1) as f32);
	high_avg / low_avg.max(1e-6)
}

#[test]
fn blue_noise_spectrum_is_high_frequency_weighted() {
	let blue_tile = blue_noise_tile();
	let blue_ratio = high_to_low_energy_ratio(blue_tile);

	// Generate uniform white noise for contrast.
	let mut white_tile = [0u8; BLUE_NOISE_SIZE * BLUE_NOISE_SIZE];
	let mut state = 0x1234_5678_9abc_def0u64;
	for b in &mut white_tile {
		state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
		*b = (state >> 32) as u8;
	}
	let white_ratio = high_to_low_energy_ratio(&white_tile);

	assert!(
		white_ratio > 0.8 && white_ratio < 1.2,
		"white noise spectrum should be flat (ratio near 1.0), got {white_ratio:.2}"
	);
	assert!(
		blue_ratio > 5.0,
		"blue noise spectrum must be concentrated in high frequencies (ratio > 5.0), got \
		 {blue_ratio:.2}"
	);
}
