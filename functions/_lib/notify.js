/**
 * ntfy 推送：把「登录待批准」通知发到管理员手机。
 *
 * 默认用自建的 fuwari-push（ntfy 兼容，ntfy.157478.xyz）：
 *   NTFY_BASE  —— 服务地址
 *   NTFY_TOPIC —— 主题名（即密钥）
 *   NTFY_TOKEN —— 发布令牌，服务端校验 Authorization: Bearer
 *
 * 备用通道（可选）：手机所在网络有时会 reset 到 Cloudflare 的 TCP 443，
 * 那时自建服务推不进去，就顺带往 NTFY_FALLBACK_BASE 也发一份。
 *   NTFY_FALLBACK_BASE  —— 默认 https://ntfy.envs.net（公开服务，无需令牌）
 *   NTFY_FALLBACK_TOKEN —— 备用服务发布令牌（公开服务留空即可）
 */

const enc = new TextEncoder();

function rfc2047(text) {
	const bytes = enc.encode(text);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	const b64 = btoa(bin);
	const chunks = b64.match(/.{1,75}/g) || [b64];
	return chunks.map((c) => `=?UTF-8?B?${c}?=`).join(" ");
}

export function ntfyBase(env) {
	return String(env.NTFY_BASE || "https://ntfy.sh").replace(/\/+$/, "");
}

/**
 * 发送一条通知。所有取值都会做长度限制，避免头部过长被拒。
 * @returns {Promise<{ok:boolean, status:number, error?:string}>}
 */
async function send(base, token, topic, headers, body) {
	try {
		const res = await fetch(`${base}/${encodeURIComponent(topic)}`, {
			method: "POST",
			headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
			body,
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			return { ok: false, status: res.status, error: text.slice(0, 200) };
		}
		return { ok: true, status: res.status };
	} catch (error) {
		return { ok: false, status: 0, error: (error && error.message) || "网络错误" };
	}
}

/**
 * 发送一条通知。所有取值都会做长度限制，避免头部过长被拒。
 * 主通道失败时自动补发到备用通道，返回里带 via 说明走的是哪条。
 * @returns {Promise<{ok:boolean, status:number, via?:string, error?:string}>}
 */
export async function notify(env, { title, message, click = "", actions = [], priority = "high", tags = [] }) {
	const topic = String(env.NTFY_TOPIC || "").trim();
	if (!topic) return { ok: false, status: 0, error: "未配置 NTFY_TOPIC" };

	const headers = {
		Title: rfc2047(String(title).slice(0, 120)),
		Priority: priority,
		"Content-Type": "text/plain; charset=utf-8",
	};
	if (tags.length) headers.Tags = tags.join(",");
	if (click) headers.Click = String(click).slice(0, 900);
	if (actions.length) {
		headers.Actions = actions
			.map((a) => String(a).replace(/[\r\n]+/g, " ").slice(0, 400))
			.join("; ")
			.slice(0, 3000);
	}

	const body = String(message || "").slice(0, 3500);
	const primary = await send(ntfyBase(env), String(env.NTFY_TOKEN || "").trim(), topic, headers, body);
	if (primary.ok) return { ...primary, via: "primary" };

	const fallbackBase = String(env.NTFY_FALLBACK_BASE || "https://ntfy.envs.net").trim().replace(/\/+$/, "");
	if (!fallbackBase) return { ...primary, via: "primary" };

	const fallback = await send(fallbackBase, String(env.NTFY_FALLBACK_TOKEN || "").trim(), topic, headers, body);
	if (fallback.ok) return { ...fallback, via: "fallback" };
	return { ...primary, via: "primary", error: `${primary.error || primary.status} / fallback: ${fallback.error || fallback.status}` };
}

/** ASCII 标签安全化：非 ASCII 会破坏 HTTP 头。 */
export function asciiLabel(text, fallback = "Open") {
	const clean = String(text).replace(/[^\x20-\x7E]/g, "").trim();
	return (clean || fallback).slice(0, 40);
}
