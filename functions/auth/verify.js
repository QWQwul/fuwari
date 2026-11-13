/**
 * POST /auth/verify —— 校验口令 + TOTP（或恢复码），换发会话令牌。
 *
 * 返回：{ ok: true, token, expiresAt, user: { login, name } }
 * 失败：{ ok: false, error }，HTTP 401 / 429 / 400。
 */

import { verifyPassword, verifyTotp, issueSession, timingSafeEqual, hmacSha256, b64urlEncode } from "../_lib/security.js";
import { incr, clientKey } from "../_lib/ratelimit.js";

const MAX_ATTEMPTS = 20;
const WINDOW_SECONDS = 600;
const SESSION_TTL = 8 * 3600;

const json = (body, status = 200, extra = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...extra,
		},
	});

export async function onRequestPost(context) {
	try {
		return await handleVerify(context);
	} catch (error) {
		console.error("auth/verify failed:", error?.stack || error);
		return json({ ok: false, error: "服务暂时不可用，请稍后重试" }, 500);
	}
}

async function handleVerify({ request, env }) {
	const limitKey = clientKey(request, "auth-verify");
	if ((await incr(limitKey, WINDOW_SECONDS)) > MAX_ATTEMPTS) {
		return json({ ok: false, error: "尝试次数过多，请 10 分钟后再试" }, 429);
	}

	if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD_HASH) {
		return json({ ok: false, error: "后台尚未完成配置，请联系站点管理员" }, 503);
	}

	const declared = Number(request.headers.get("content-length") || "0");
	if (declared > 4096) return json({ ok: false, error: "请求过大" }, 413);

	let payload;
	try {
		payload = await request.json();
	} catch {
		return json({ ok: false, error: "请求格式错误" }, 400);
	}
	if (!payload || typeof payload !== "object") return json({ ok: false, error: "请求格式错误" }, 400);

	const password = typeof payload.password === "string" ? payload.password : "";
	const code = typeof payload.code === "string" ? payload.code.trim() : "";
	const recovery = typeof payload.recovery === "string" ? payload.recovery.trim() : "";

	if (!password) return json({ ok: false, error: "请输入管理口令" }, 400);
	if (!recovery && !/^\d{6}$/.test(code)) return json({ ok: false, error: "请输入 6 位动态验证码" }, 400);

	// 第一因子：口令，或（口令框里填的）恢复码。
	const secrets = String(env.ADMIN_RECOVERY_HASHES || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	let firstFactorOk = await verifyPassword(env.ADMIN_PASSWORD_HASH, password);
	if (!firstFactorOk && secrets.length > 0) {
		for (const hash of secrets) {
			if (await verifyPassword(hash, password)) {
				firstFactorOk = true;
				break;
			}
		}
	}
	if (!firstFactorOk && recovery) {
		// 兼容「口令框填恢复码、单独恢复码框也填」的情况。
		const candidates = [recovery, password];
		for (const candidate of candidates) {
			for (const hash of secrets) {
				if (await verifyPassword(hash, candidate)) {
					firstFactorOk = true;
					break;
				}
			}
			if (firstFactorOk) break;
		}
	}
	if (!firstFactorOk) return json({ ok: false, error: "口令或恢复码不正确" }, 401);

	// 第二因子：TOTP。
	if (env.ADMIN_TOTP_SECRET) {
		const ok = await verifyTotp(env.ADMIN_TOTP_SECRET, code);
		if (!ok) return json({ ok: false, error: "动态验证码不正确或已过期" }, 401);
	} else if (!recovery) {
		return json({ ok: false, error: "后台尚未配置两步验证" }, 503);
	}

	const { token, expiresAt } = await issueSession(env.SESSION_SECRET, SESSION_TTL, "admin");
	const user = {
		login: env.ADMIN_LOGIN || "QWQwul",
		name: env.ADMIN_NAME || "站点管理员",
		id: (await fingerprint(env.SESSION_SECRET, env.ADMIN_LOGIN || "QWQwul")).slice(0, 12),
	};
	return json({ ok: true, token, expiresAt, user });
}

export async function onRequest({ request }) {
	return json({ ok: false, error: "Method Not Allowed" }, 405, { allow: "POST" });
}

async function fingerprint(secret, value) {
	const digest = await hmacSha256(b64urlToBytesSafe(secret), `admin:${value}`);
	return b64urlEncode(digest);
}

function b64urlToBytesSafe(secret) {
	try {
		const pad = secret.length % 4 === 0 ? "" : "=".repeat(4 - (secret.length % 4));
		const raw = atob(secret.replace(/-/g, "+").replace(/_/g, "/") + pad);
		const out = new Uint8Array(raw.length);
		for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
		return out;
	} catch {
		return new TextEncoder().encode(secret);
	}
}
