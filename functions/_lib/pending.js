/**
 * 待批准登录（手机确认流程）的存取与签名。
 *
 * KV 结构：
 *   pending:<id> -> { id, ua, ip, code, createdAt, expiresAt, status }
 * 状态：waiting / approved / denied / expired / used
 */

import { b64urlEncode, b64urlDecode, hmacSha256, timingSafeEqual } from "./security.js";

const TTL_SECONDS = 180;
const enc = new TextEncoder();

export function randomId(bytes = 12) {
	const raw = crypto.getRandomValues(new Uint8Array(bytes));
	let s = "";
	for (const b of raw) s += b.toString(16).padStart(2, "0");
	return s;
}

export function randomCode() {
	const raw = crypto.getRandomValues(new Uint8Array(4));
	let n = 0;
	for (const b of raw) n = (n * 256 + b) % 1000000;
	return String(n).padStart(6, "0");
}

/** 设备描述：浏览器 + 系统，尽量短。 */
export function describeDevice(ua = "") {
	const u = String(ua);
	const browser =
		/EdgA?\//.test(u) ? "Edge" :
		/Chrome\//.test(u) ? "Chrome" :
		/Firefox\//.test(u) ? "Firefox" :
		/Safari\//.test(u) ? "Safari" :
		"浏览器";
	const os =
		/Android/.test(u) ? "Android" :
		/iPhone|iPad|iOS/.test(u) ? "iOS" :
		/Windows/.test(u) ? "Windows" :
		/Mac OS X/.test(u) ? "macOS" :
		/Linux/.test(u) ? "Linux" :
		"未知系统";
	const mobile = /Mobile|Android|iPhone/.test(u);
	return `${browser} / ${os}${mobile ? " · 移动端" : " · 桌面端"}`;
}

export function clientIp(request) {
	return (
		request.headers.get("cf-connecting-ip") ||
		request.headers.get("x-real-ip") ||
		(request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
		"未知"
	);
}

export async function createPending(kv, { ua, ip }) {
	const id = randomId(12);
	const code = randomCode();
	const now = Date.now();
	const record = {
		id,
		ua: String(ua).slice(0, 300),
		ip,
		code,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + TTL_SECONDS * 1000).toISOString(),
		status: "waiting",
	};
	await kv.put(`pending:${id}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS + 120 });
	return record;
}

export async function getPending(kv, id) {
	if (!/^[a-f0-9]{12,40}$/.test(String(id || ""))) return null;
	const raw = await kv.get(`pending:${id}`);
	if (!raw) return null;
	try {
		const record = JSON.parse(raw);
		if (record.status === "waiting" && Date.parse(record.expiresAt) < Date.now()) {
			record.status = "expired";
		}
		return record;
	} catch {
		return null;
	}
}

export async function setPendingStatus(kv, record, status, actor = "") {
	const next = { ...record, status, [`${status}At`]: new Date().toISOString() };
	if (actor) next.actor = String(actor).slice(0, 200);
	await kv.put(`pending:${record.id}`, JSON.stringify(next), { expirationTtl: TTL_SECONDS + 120 });
	await audit(kv, { id: record.id, status, actor, ip: record.ip, ua: record.ua });
	return next;
}

/** 审计日志：最近 200 条，30 天。 */
export async function audit(kv, entry) {
	try {
		const raw = await kv.get("audit:recent");
		const list = Array.isArray(JSON.parse(raw || "[]")) ? JSON.parse(raw || "[]") : [];
		list.unshift({ at: new Date().toISOString(), ...entry });
		await kv.put("audit:recent", JSON.stringify(list.slice(0, 200)), { expirationTtl: 30 * 86400 });
	} catch {
		/* 审计失败不影响主流程 */
	}
}

async function hmac(secret, message) {
	const key = b64urlDecodeSafe(secret);
	return hmacSha256(key, message);
}

export async function signPending(secret, id, action) {
	const mac = await hmac(secret, `pending:${action}:${id}`);
	return b64urlEncode(mac).slice(0, 43);
}

export async function verifyPendingSig(secret, id, action, sig) {
	if (typeof sig !== "string" || !sig) return false;
	const expected = await signPending(secret, id, action);
	return timingSafeEqual(enc.encode(expected), enc.encode(sig));
}

function b64urlDecodeSafe(secret) {
	const s = String(secret || "");
	try {
		return b64urlDecode(s);
	} catch {
		return enc.encode(s);
	}
}
