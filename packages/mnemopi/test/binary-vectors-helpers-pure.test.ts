import { describe, expect, it } from "bun:test";
import {
	assertSqlIdentifier,
	BITS_PER_BYTE,
	bytesFromBlob,
	bytesPerVector,
	getVecType,
	hammingDistance,
	hammingDistanceForDimension,
	informationTheoreticScore,
	isReadonlyMap,
	magnitude,
	maximallyInformativeBinarization,
	POPCOUNT_TABLE,
	quantizeInt8,
	toFiniteNumber,
} from "../src/core/binary-vectors-helpers";

describe("BITS_PER_BYTE", () => {
	it("is 8", () => {
		expect(BITS_PER_BYTE).toBe(8);
	});
});

describe("POPCOUNT_TABLE", () => {
	it("has 256 entries", () => {
		expect(POPCOUNT_TABLE.length).toBe(256);
	});
	it("has 0 for 0", () => {
		expect(POPCOUNT_TABLE[0]).toBe(0);
	});
	it("has 1 for powers of 2", () => {
		expect(POPCOUNT_TABLE[1]).toBe(1);
		expect(POPCOUNT_TABLE[2]).toBe(1);
		expect(POPCOUNT_TABLE[4]).toBe(1);
		expect(POPCOUNT_TABLE[128]).toBe(1);
	});
	it("has 8 for 255", () => {
		expect(POPCOUNT_TABLE[255]).toBe(8);
	});
	it("has 4 for 15", () => {
		expect(POPCOUNT_TABLE[15]).toBe(4);
	});
});

describe("bytesPerVector", () => {
	it("returns 1 for 8 dimensions", () => {
		expect(bytesPerVector(8)).toBe(1);
	});
	it("returns 4 for 32 dimensions", () => {
		expect(bytesPerVector(32)).toBe(4);
	});
	it("returns 16 for 128 dimensions", () => {
		expect(bytesPerVector(128)).toBe(16);
	});
	it("returns 1 for 1 dimension (ceiling)", () => {
		expect(bytesPerVector(1)).toBe(1);
	});
	it("returns 0 for 0 dimensions", () => {
		expect(bytesPerVector(0)).toBe(0);
	});
	it("returns 2 for 9 dimensions (ceiling)", () => {
		expect(bytesPerVector(9)).toBe(2);
	});
});

describe("assertSqlIdentifier", () => {
	it("accepts simple identifier", () => {
		expect(assertSqlIdentifier("mytable")).toBe("mytable");
	});
	it("accepts identifier with underscores", () => {
		expect(assertSqlIdentifier("my_table")).toBe("my_table");
	});
	it("accepts identifier starting with underscore", () => {
		expect(assertSqlIdentifier("_private")).toBe("_private");
	});
	it("accepts identifier with numbers (not first)", () => {
		expect(assertSqlIdentifier("table123")).toBe("table123");
	});
	it("throws for identifier starting with number", () => {
		expect(() => assertSqlIdentifier("1table")).toThrow();
	});
	it("throws for identifier with special characters", () => {
		expect(() => assertSqlIdentifier("table-name")).toThrow();
	});
	it("throws for identifier with spaces", () => {
		expect(() => assertSqlIdentifier("table name")).toThrow();
	});
	it("throws for empty string", () => {
		expect(() => assertSqlIdentifier("")).toThrow();
	});
	it("throws for SQL injection attempt", () => {
		expect(() => assertSqlIdentifier("table; DROP TABLE")).toThrow();
	});
});

describe("toFiniteNumber", () => {
	it("returns number as-is", () => {
		expect(toFiniteNumber(42)).toBe(42);
	});
	it("returns 0 for null", () => {
		expect(toFiniteNumber(null)).toBe(0);
	});
	it("returns 0 for undefined", () => {
		expect(toFiniteNumber(undefined)).toBe(0);
	});
	it("parses string number", () => {
		expect(toFiniteNumber("3.14")).toBe(3.14);
	});
	it("returns 0 for non-numeric string", () => {
		expect(toFiniteNumber("hello")).toBe(0);
	});
	it("returns 1 for true", () => {
		expect(toFiniteNumber(true)).toBe(1);
	});
	it("returns 0 for false", () => {
		expect(toFiniteNumber(false)).toBe(0);
	});
	it("returns 0 for NaN", () => {
		expect(toFiniteNumber(Number.NaN)).toBe(0);
	});
	it("returns 0 for Infinity", () => {
		expect(toFiniteNumber(Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe("magnitude", () => {
	it("returns 0 for empty array", () => {
		expect(magnitude([])).toBe(0);
	});
	it("returns absolute value for single element", () => {
		expect(magnitude([3])).toBe(3);
		expect(magnitude([-4])).toBe(4);
	});
	it("computes Euclidean norm", () => {
		expect(magnitude([3, 4])).toBe(5);
	});
	it("computes norm for 3D vector", () => {
		expect(magnitude([1, 2, 2])).toBe(3);
	});
	it("handles zeros", () => {
		expect(magnitude([0, 0, 0])).toBe(0);
	});
	it("handles negative values", () => {
		expect(magnitude([-3, -4])).toBe(5);
	});
});

describe("bytesFromBlob", () => {
	it("returns Uint8Array as-is", () => {
		const arr = new Uint8Array([1, 2, 3]);
		expect(bytesFromBlob(arr)).toBe(arr);
	});
	it("converts ArrayBuffer to Uint8Array", () => {
		const buf = new ArrayBuffer(4);
		const result = bytesFromBlob(buf);
		expect(result).toBeInstanceOf(Uint8Array);
		expect(result.length).toBe(4);
	});
	it("converts Buffer to Uint8Array", () => {
		const buf = Buffer.from([1, 2, 3]);
		const result = bytesFromBlob(buf);
		expect(result).toBeInstanceOf(Uint8Array);
		expect(result.length).toBe(3);
	});
});

describe("isReadonlyMap", () => {
	it("returns true for Map", () => {
		expect(isReadonlyMap(new Map())).toBe(true);
	});
	it("returns false for plain object", () => {
		expect(isReadonlyMap({})).toBe(false);
	});
	it("returns false for array", () => {
		expect(isReadonlyMap([])).toBe(false);
	});
});

describe("getVecType", () => {
	it("returns 'int8' by default", () => {
		expect(getVecType({})).toBe("int8");
	});
	it("returns 'float32' when set", () => {
		expect(getVecType({ MNEMOPI_VEC_TYPE: "float32" })).toBe("float32");
	});
	it("returns 'int8' when set", () => {
		expect(getVecType({ MNEMOPI_VEC_TYPE: "int8" })).toBe("int8");
	});
	it("returns 'bit' when set", () => {
		expect(getVecType({ MNEMOPI_VEC_TYPE: "bit" })).toBe("bit");
	});
	it("normalizes to lowercase", () => {
		expect(getVecType({ MNEMOPI_VEC_TYPE: "FLOAT32" })).toBe("float32");
	});
	it("trims whitespace", () => {
		expect(getVecType({ MNEMOPI_VEC_TYPE: "  int8  " })).toBe("int8");
	});
	it("returns 'float32' for invalid value", () => {
		expect(getVecType({ MNEMOPI_VEC_TYPE: "invalid" })).toBe("float32");
	});
});

describe("quantizeInt8", () => {
	it("quantizes positive values", () => {
		const result = quantizeInt8([0.5, 1.0, 0.0]);
		expect(result[0]).toBe(64);
		expect(result[1]).toBe(127);
		expect(result[2]).toBe(0);
	});
	it("quantizes negative values", () => {
		const result = quantizeInt8([-0.5, -1.0]);
		expect(result[0]).toBe(-64);
		expect(result[1]).toBe(-127);
	});
	it("clamps values above 1", () => {
		const result = quantizeInt8([2.0]);
		expect(result[0]).toBe(127);
	});
	it("clamps values below -1", () => {
		const result = quantizeInt8([-2.0]);
		expect(result[0]).toBe(-127);
	});
	it("handles empty array", () => {
		expect(quantizeInt8([]).length).toBe(0);
	});
	it("handles NaN as 0", () => {
		const result = quantizeInt8([Number.NaN]);
		expect(result[0]).toBe(0);
	});
});

describe("maximallyInformativeBinarization", () => {
	it("packs positive values as 1 bits", () => {
		const result = maximallyInformativeBinarization([1, -1, 1, -1, 1, -1, 1, -1]);
		expect(result.length).toBe(1);
		expect(result[0]).toBe(0b10101010);
	});
	it("packs all positive as 0xFF", () => {
		const result = maximallyInformativeBinarization([1, 1, 1, 1, 1, 1, 1, 1]);
		expect(result[0]).toBe(0xff);
	});
	it("packs all negative as 0x00", () => {
		const result = maximallyInformativeBinarization([-1, -1, -1, -1, -1, -1, -1, -1]);
		expect(result[0]).toBe(0x00);
	});
	it("handles non-multiple of 8", () => {
		const result = maximallyInformativeBinarization([1, 1, 1]);
		expect(result.length).toBe(1);
		expect(result[0] & 0b11100000).toBe(0b11100000);
	});
	it("handles empty array", () => {
		expect(maximallyInformativeBinarization([]).length).toBe(0);
	});
});

describe("hammingDistance", () => {
	it("returns 0 for identical arrays", () => {
		const a = new Uint8Array([0xff, 0x00]);
		expect(hammingDistance(a, a)).toBe(0);
	});
	it("returns total bits for inverted arrays", () => {
		const a = new Uint8Array([0xff]);
		const b = new Uint8Array([0x00]);
		expect(hammingDistance(a, b)).toBe(8);
	});
	it("counts differing bits", () => {
		const a = new Uint8Array([0b10101010]);
		const b = new Uint8Array([0b01010101]);
		expect(hammingDistance(a, b)).toBe(8);
	});
	it("handles partial difference", () => {
		const a = new Uint8Array([0b11110000]);
		const b = new Uint8Array([0b00001111]);
		expect(hammingDistance(a, b)).toBe(8);
	});
	it("handles different lengths", () => {
		const a = new Uint8Array([0xff, 0xff]);
		const b = new Uint8Array([0x00]);
		expect(hammingDistance(a, b)).toBe(16);
	});
	it("accepts ArrayBuffer", () => {
		const a = new Uint8Array([0xff]).buffer;
		const b = new Uint8Array([0x00]).buffer;
		expect(hammingDistance(a, b)).toBe(8);
	});
});

describe("hammingDistanceForDimension", () => {
	it("counts bits up to dimension", () => {
		const a = new Uint8Array([0xff]);
		const b = new Uint8Array([0x00]);
		expect(hammingDistanceForDimension(a, b, 4)).toBe(4);
	});
	it("returns 0 for dimension 0", () => {
		expect(hammingDistanceForDimension(new Uint8Array([0xff]), new Uint8Array([0x00]), 0)).toBe(0);
	});
	it("handles full byte", () => {
		const a = new Uint8Array([0xff]);
		const b = new Uint8Array([0x00]);
		expect(hammingDistanceForDimension(a, b, 8)).toBe(8);
	});
	it("handles multi-byte dimension", () => {
		const a = new Uint8Array([0xff, 0xff]);
		const b = new Uint8Array([0x00, 0x00]);
		expect(hammingDistanceForDimension(a, b, 12)).toBe(12);
	});
});

describe("informationTheoreticScore", () => {
	it("returns 1.0 for distance 0", () => {
		expect(informationTheoreticScore(0, 100)).toBe(1.0);
	});
	it("returns 0.0 for distance equal to dim", () => {
		expect(informationTheoreticScore(100, 100)).toBe(0.0);
	});
	it("returns 0.5 for distance half of dim", () => {
		expect(informationTheoreticScore(50, 100)).toBe(0.5);
	});
	it("returns 0 for dim 0", () => {
		expect(informationTheoreticScore(0, 0)).toBe(0);
	});
	it("returns negative for distance > dim", () => {
		expect(informationTheoreticScore(150, 100)).toBe(-0.5);
	});
});
