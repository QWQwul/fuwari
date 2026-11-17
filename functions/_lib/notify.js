/**
 * ntfy 推送：把「登录待批准」通知发到管理员手机。
 *
 * 默认用自建的 fuwari-push（ntfy 兼容，ntfy.157478.xyz）：
 *   NTFY_BASE  —— 服务地址
 *   NTFY_TOPIC —— 主题名（即密钥）
 *   NTFY_TOKEN —— 发布令牌，服务端校验 Authorization: Bearer
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
export async function notify(env, { title, message, actions = [], priority = "high", tags = [] }) {
	const topic = String(env.NTFY_TOPIC || "").trim();
	if (!topic) return { ok: false, status: 0, error: "未配置 NTFY_TOPIC" };

	const headers = {
		Title: rfc2047(String(title).slice(0, 120)),
		Priority: priority,
	};
	const token = String(env.NTFY_TOKEN || "").trim();
	if (token) headers.Authorization = `Bearer ${token}`;
	if (tags.length) headers.Tags = tags.join(",");
	if (actions.length) {
		// Actions: view, 标签, URL, clear=true; ...
		headers.Actions = actions
			.map((a) => String(a).replace(/[\r\n]+/g, " ").slice(0, 400))
			.join("; ")
			.slice(0, 3000);
	}

	try {
		const res = await fetch(`${ntfyBase(env)}/${encodeURIComponent(topic)}`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
			body: String(message || "").slice(0, 3500),
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

/** ASCII 标签安全化：非 ASCII 会破坏 HTTP 头。 */
export function asciiLabel(text, fallback = "Open") {
	const clean = String(text).replace(/[^\x20-\x7E]/g, "").trim();
	return (clean || fallback).slice(0, 40);
}
