// biome-ignore-all lint/suspicious/noBitwiseOperators: SHA-256 requires 32-bit arithmetic.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: The compression loop implements the SHA-256 specification.
const SHA256_CONSTANTS = [
	0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b,
	0x59_f1_11_f1, 0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01,
	0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7,
	0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc,
	0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da, 0x98_3e_51_52,
	0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
	0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc,
	0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85,
	0xa2_bf_e8_a1, 0xa8_1a_66_4b, 0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19,
	0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70, 0x19_a4_c1_16, 0x1e_37_6c_08,
	0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f,
	0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
	0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
] as const;

const INITIAL_HASH = [
	0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f,
	0x9b_05_68_8c, 0x1f_83_d9_ab, 0x5b_e0_cd_19,
] as const;

const rightRotate = (value: number, amount: number): number =>
	(value >>> amount) | (value << (32 - amount));

const readWord = (bytes: Uint8Array, offset: number): number =>
	((bytes[offset] ?? 0) << 24) |
	((bytes[offset + 1] ?? 0) << 16) |
	((bytes[offset + 2] ?? 0) << 8) |
	(bytes[offset + 3] ?? 0);

/** SHA-256 over UTF-8 content, kept free of Node/Bun imports. */
export const hashSkillBody = (body: string): string => {
	const input = new TextEncoder().encode(body);
	const bitLength = input.length * 8;
	const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.length] = 0x80;
	for (let index = 0; index < 8; index += 1) {
		padded[paddedLength - 1 - index] =
			Math.floor(bitLength / 2 ** (index * 8)) & 0xff;
	}

	const hash: number[] = [...INITIAL_HASH];
	const schedule = new Uint32Array(64);
	for (let chunkOffset = 0; chunkOffset < padded.length; chunkOffset += 64) {
		for (let index = 0; index < 16; index += 1) {
			schedule[index] = readWord(padded, chunkOffset + index * 4) >>> 0;
		}
		for (let index = 16; index < 64; index += 1) {
			const first = schedule[index - 15] ?? 0;
			const second = schedule[index - 2] ?? 0;
			const smallSigma0 =
				rightRotate(first, 7) ^ rightRotate(first, 18) ^ (first >>> 3);
			const smallSigma1 =
				rightRotate(second, 17) ^ rightRotate(second, 19) ^ (second >>> 10);
			schedule[index] =
				((schedule[index - 16] ?? 0) +
					smallSigma0 +
					(schedule[index - 7] ?? 0) +
					smallSigma1) >>>
				0;
		}

		let a = hash[0] ?? 0;
		let b = hash[1] ?? 0;
		let c = hash[2] ?? 0;
		let d = hash[3] ?? 0;
		let e = hash[4] ?? 0;
		let f = hash[5] ?? 0;
		let g = hash[6] ?? 0;
		let h = hash[7] ?? 0;
		for (let index = 0; index < 64; index += 1) {
			const bigSigma1 =
				rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
			const choose = (e & f) ^ (~e & g);
			const temporary1 =
				(h +
					bigSigma1 +
					choose +
					(SHA256_CONSTANTS[index] ?? 0) +
					(schedule[index] ?? 0)) >>>
				0;
			const bigSigma0 =
				rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (bigSigma0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temporary1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temporary1 + temporary2) >>> 0;
		}
		hash[0] = ((hash[0] ?? 0) + a) >>> 0;
		hash[1] = ((hash[1] ?? 0) + b) >>> 0;
		hash[2] = ((hash[2] ?? 0) + c) >>> 0;
		hash[3] = ((hash[3] ?? 0) + d) >>> 0;
		hash[4] = ((hash[4] ?? 0) + e) >>> 0;
		hash[5] = ((hash[5] ?? 0) + f) >>> 0;
		hash[6] = ((hash[6] ?? 0) + g) >>> 0;
		hash[7] = ((hash[7] ?? 0) + h) >>> 0;
	}

	return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
};
