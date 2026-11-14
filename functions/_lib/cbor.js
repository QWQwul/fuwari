/**
 * 极简 CBOR 解码器（只覆盖 WebAuthn 用到的类型）。
 * 支持：uint/负整数、字节串、文本、数组、映射、布尔、null、简单值、标签（跳过）。
 */

export function decodeCbor(bytes) {
	const view = new Uint8Array(bytes);
	let offset = 0;

	function readLength(additional) {
		if (additional < 24) return additional;
		if (additional === 24) return view[offset++];
		if (additional === 25) {
			const v = (view[offset] << 8) | view[offset + 1];
			offset += 2;
			return v;
		}
		if (additional === 26) {
			const v = ((view[offset] << 24) | (view[offset + 1] << 16) | (view[offset + 2] << 8) | view[offset + 3]) >>> 0;
			offset += 4;
			return v;
		}
		throw new Error("CBOR: unsupported length");
	}

	function readItem() {
		const initial = view[offset++];
		const major = initial >> 5;
		let additional = initial & 0x1f;
		if (major === 0) return readLength(additional);
		if (major === 1) return -1 - readLength(additional);
		if (major === 2) {
			const len = readLength(additional);
			const out = view.slice(offset, offset + len);
			offset += len;
			return out;
		}
		if (major === 3) {
			const len = readLength(additional);
			const out = new TextDecoder().decode(view.slice(offset, offset + len));
			offset += len;
			return out;
		}
		if (major === 4) {
			const len = readLength(additional);
			const out = [];
			for (let i = 0; i < len; i++) out.push(readItem());
			return out;
		}
		if (major === 5) {
			const len = readLength(additional);
			const out = {};
			for (let i = 0; i < len; i++) {
				const key = readItem();
				out[String(key)] = readItem();
			}
			return out;
		}
		if (major === 6) {
			readLength(additional);
			return readItem();
		}
		if (major === 7) {
			if (additional === 20) return false;
			if (additional === 21) return true;
			if (additional === 22) return null;
			if (additional === 23) return undefined;
			if (additional === 25) {
				const v = (view[offset] << 8) | view[offset + 1];
				offset += 2;
				return v;
			}
			if (additional === 26) {
				const b = new DataView(view.buffer, view.byteOffset + offset, 4);
				offset += 4;
				return b.getFloat32(0);
			}
			if (additional === 27) {
				const b = new DataView(view.buffer, view.byteOffset + offset, 8);
				offset += 8;
				return b.getFloat64(0);
			}
			return undefined;
		}
		throw new Error("CBOR: unsupported major type " + major);
	}

	return readItem();
}
