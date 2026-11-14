/**
 * 安全工具：口令散列校验、TOTP、会话签名。
 * 只依赖 WebCrypto，Cloudflare Pages Functions 原生可用。
 */

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
	const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
	const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
	const raw = atob(b64);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

export function toHex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 常数时间比较，避免按字节提前返回。 */
export function timingSafeEqual(a, b) {
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	}
	return diff === 0;
}

export async function hmacSha256(keyBytes, message) {
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

async function sha1(bytes) {
	return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

/**
 * HMAC-SHA1（用 digest 手工拼，避免依赖运行时对 HMAC-SHA1 的支持；
 * Cloudflare Workers 的 WebCrypto 不保证注册 SHA-1 的 HMAC）。
 */
export async function hmacSha1(keyBytes, messageBytes) {
	const blockSize = 64;
	let key = keyBytes;
	if (key.length > blockSize) key = await sha1(key);
	const padded = new Uint8Array(blockSize);
	padded.set(key);

	const inner = new Uint8Array(blockSize + messageBytes.length);
	for (let i = 0; i < blockSize; i++) inner[i] = padded[i] ^ 0x36;
	inner.set(messageBytes, blockSize);

	const innerHash = await sha1(inner);
	const outer = new Uint8Array(blockSize + innerHash.length);
	for (let i = 0; i < blockSize; i++) outer[i] = padded[i] ^ 0x5c;
	outer.set(innerHash, blockSize);
	return sha1(outer);
}

export async function pbkdf2(password, saltBytes, iterations, length = 32) {
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
		key,
		length * 8,
	);
	return new Uint8Array(bits);
}

/**
 * 校验形如 `pbkdf2$sha256$<iterations>$<saltB64url>$<hashB64url>` 的口令散列。
 * 缺失或格式错误一律返回 false，不抛异常。
 */
export async function verifyPassword(stored, password) {
	if (typeof stored !== "string" || typeof password !== "string") return false;
	const parts = stored.trim().split("$");
	if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
	const iterations = Number.parseInt(parts[2], 10);
	if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 1000000) return false;
	if (password.length === 0 || password.length > 512) return false;
	let salt;
	let expected;
	try {
		salt = b64urlDecode(parts[3]);
		expected = b64urlDecode(parts[4]);
	} catch {
		return false;
	}
	if (salt.length < 8 || expected.length < 16) return false;
	const actual = await pbkdf2(password, salt, iterations, expected.length);
	return timingSafeEqual(actual, expected);
}

/** 生成口令散列（脚本侧与管理页共用同一格式）。 */
export async function makePasswordHash(password, iterations = 210000) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await pbkdf2(password, salt, iterations, 32);
	return `pbkdf2$sha256$${iterations}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(input) {
	const clean = String(input).toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
	let bits = 0;
	let value = 0;
	const out = [];
	for (const ch of clean) {
		const idx = BASE32_ALPHABET.indexOf(ch);
		if (idx === -1) throw new Error("bad base32");
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

/** 校验 TOTP（默认 30 秒一步、6 位、允许前后各 1 步时钟漂移）。 */
export async function verifyTotp(secretBase32, code, { period = 30, digits = 6, window = 1 } = {}) {
	if (!/^\d{6}$/.test(String(code ?? "").trim())) return false;
	const secret = base32Decode(secretBase32);
	const counter = Math.floor(Date.now() / 1000 / period);
	const target = String(code).trim();
	for (let offset = -window; offset <= window; offset++) {
		const step = counter + offset;
		const buf = new ArrayBuffer(8);
		const view = new DataView(buf);
		view.setUint32(0, Math.floor(step / 2 ** 32));
		view.setUint32(4, step >>> 0);
		const mac = await hmacSha1(secret, new Uint8Array(buf));
		const idx = mac[mac.length - 1] & 0x0f;
		const bin =
			((mac[idx] & 0x7f) << 24) |
			((mac[idx + 1] & 0xff) << 16) |
			((mac[idx + 2] & 0xff) << 8) |
			(mac[idx + 3] & 0xff);
		const otp = String(bin % 10 ** digits).padStart(digits, "0");
		if (timingSafeEqual(enc.encode(otp), enc.encode(target))) return true;
	}
	return false;
}

export function newTotpSecret() {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	let bits = 0;
	let value = 0;
	let out = "";
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/** 会话令牌：base64url(payload).base64url(HMAC-SHA256)。 */
export async function issueSession(secret, ttlSeconds = 8 * 3600, sub = "admin") {
	const keyBytes = b64urlDecode(secret);
	const now = Math.floor(Date.now() / 1000);
	const payload = { sub, iat: now, exp: now + ttlSeconds, jti: b64urlEncode(crypto.getRandomValues(new Uint8Array(9))) };
	const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
	const sig = b64urlEncode(await hmacSha256(keyBytes, body));
	return { token: `${body}.${sig}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
}

export async function verifySession(secret, token) {
	if (typeof token !== "string" || token.length < 20 || token.length > 2048) return null;
	const dot = token.indexOf(".");
	if (dot <= 0 || dot === token.length - 1) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	let expectedSig;
	try {
		expectedSig = b64urlEncode(await hmacSha256(b64urlDecode(secret), body));
	} catch {
		return null;
	}
	if (!timingSafeEqual(enc.encode(sig), enc.encode(expectedSig))) return null;
	let payload;
	try {
		payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
	} catch {
		return null;
	}
	if (!payload || typeof payload.exp !== "number") return null;
	if (payload.exp * 1000 < Date.now()) return null;
	return payload;
}
