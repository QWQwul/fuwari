/**
 * /gw/* —— GitHub API 受控网关。
 *
 * 浏览器带来的是本站在登录时签发的会话令牌；本函数校验后，
 * 用只存在于环境变量里的细粒度 PAT 代请求 api.github.com，
 * 并且只放行本仓库内容读写所需要的那些路径。
 */

import { verifySession } from "../_lib/security.js";

const OWNER = "QWQwul";
const REPO = "fuwari";
const MAX_BODY = 12 * 1024 * 1024;
// GitHub 偶尔会慢到 40 秒以上（实测有过 44.5s 的一次上传），
// 20 秒会直接把后台保存打断成「一直转圈」，放宽到 60 秒喵。
const TIMEOUT_MS = 60000;
// GET 请求（读文章列表/内容）走短超时 + 边缘缓存：手机流量下经常单个请求就抖到几十秒，
// 卡住不如快速失败后重试一次，读接口再命中缓存就基本不用等喵。
const GET_TIMEOUT_MS = 20000;
const GET_CACHE_TTL = 45;

// 运营商会对「Cloudflare 边缘 + 443」做 TLS 重置，手机端改用 8443 端口访问，
// 所以 CORS 不能写死带端口的完整 origin，只按主机名放行、并回显实际 Origin 喵。
const ALLOWED_HOSTS = new Set(["ai.qwqads.dpdns.org", "qwqads.dpdns.org", "ai.157478.xyz", "fuwari-git.pages.dev", "localhost", "127.0.0.1"]);

function corsFor(request) {
	const origin = request?.headers?.get("origin") || "";
	let allowed = "https://ai.qwqads.dpdns.org";
	if (origin) {
		try {
			const { protocol, hostname } = new URL(origin);
			if ((protocol === "https:" || protocol === "http:") && ALLOWED_HOSTS.has(hostname)) allowed = origin;
		} catch {
			/* 非法 Origin 就退回默认值 */
		}
	}
	return {
		"access-control-allow-origin": allowed,
		"access-control-allow-headers": "authorization, content-type, accept, x-github-api-version",
		"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"access-control-expose-headers": "link, x-ratelimit-remaining",
		vary: "origin",
	};
}

const json = (body, status = 200, extra = {}, cors = corsFor(null)) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors, ...extra },
	});

/** 只允许 CMS 真正需要的接口，避免会话令牌被当成万能 GitHub 凭据。 */
const ALLOWED_SUBPATHS = [
	/^contents(\/.*)?$/i,
	/^git\/(ref|refs)(\/.*)?$/i,
	/^git\/(commits|trees|blobs|tags|notes)(\/.*)?$/i,
	/^branches(\/.*)?$/i,
	/^commits(\/.*)?$/i,
	/^pulls(\/.*)?$/i,
	/^merges$/i,
	/^collaborators\/[^/]+\/permission$/i,
	/^readme$/i,
	/^git\/matching-refs(\/.*)?$/i,
];

export function isAllowedPath(path) {
	if (path === "user") return true;
	if (path === "rate_limit") return true;
	if (path === "graphql") return true;
	const lower = path.toLowerCase();
	const prefix = `repos/${OWNER}/${REPO}`.toLowerCase();
	if (lower === prefix) return true;
	if (!lower.startsWith(`${prefix}/`)) return false;
	const rest = path.slice(`repos/${OWNER}/${REPO}`.length + 1);
	return ALLOWED_SUBPATHS.some((re) => re.test(rest));
}

function readSession(request) {
	const raw = request.headers.get("authorization") || "";
	const match = /^(?:token|bearer)\s+(.+)$/i.exec(raw.trim());
	return match ? match[1].trim() : "";
}

// 取出 contents 后面的相对路径（全路径形如 repos/<owner>/<repo>/contents/xxx）喵
function contentsRelative(path) {
	const marker = `/contents/`;
	const lower = path.toLowerCase();
	const idx = lower.indexOf(marker);
	if (idx === -1) return null;
	return path.slice(idx + marker.length).split("?")[0];
}

async function callGitHub(path, request, env, timeoutMs = TIMEOUT_MS) {
	const url = new URL(`https://api.github.com/${path}`);
	const incoming = new URL(request.url);
	incoming.searchParams.forEach((value, key) => url.searchParams.append(key, value));

	const method = request.method.toUpperCase();
	const headers = new Headers({
		authorization: `Bearer ${env.GITHUB_API_TOKEN}`,
		accept: request.headers.get("accept") || "application/vnd.github+json",
		"user-agent": "fuwari-cms-gateway",
		"x-github-api-version": "2022-11-28",
	});
	const contentType = request.headers.get("content-type");
	if (contentType) headers.set("content-type", contentType);

	let body;
	if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
		const declared = Number(request.headers.get("content-length") || "0");
		if (declared > MAX_BODY) throw Object.assign(new Error("payload too large"), { status: 413 });
		body = await request.arrayBuffer();
		if (body.byteLength > MAX_BODY) throw Object.assign(new Error("payload too large"), { status: 413 });
	}

	return fetch(url.toString(), {
		method,
		headers,
		body,
		signal: AbortSignal.timeout(timeoutMs),
	});
}

export async function onRequest({ request, env, params }) {
	const CORS = corsFor(request);
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

	if (!env.SESSION_SECRET) return json({ message: "网关尚未配置 SESSION_SECRET" }, 503, {}, CORS);
	if (!env.GITHUB_API_TOKEN) return json({ message: "网关尚未配置 GITHUB_API_TOKEN" }, 503, {}, CORS);

	const token = readSession(request);
	let session = null;
	if (token) {
		try {
			session = await verifySession(env.SESSION_SECRET, token);
		} catch {
			session = null;
		}
	}
	if (!session) return json({ message: "会话已失效，请重新登录后台" }, 401, {}, CORS);

	const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
	let path = segments.map((s) => String(s)).join("/");
	if (!path) return json({ message: "缺少接口路径" }, 400, {}, CORS);
	// Sveltia 在配置 api_root 时会走 GitHub Enterprise 风格路径（api/v3/…），这里剥掉前缀喵
	path = path.replace(/^api\/v3\/?/i, "");
	path = path.replace(/^api\/graphql$/i, "graphql");
	if (!isAllowedPath(path)) return json({ message: `接口不允许：${path}` }, 403, {}, CORS);

	const method = request.method.toUpperCase();
	if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
		return json({ message: "方法不允许" }, 405, {}, CORS);
	}

	const isGet = method === "GET";
	const incoming = new URL(request.url);
	// 只给「读文章/读目录」这类 GET 加边缘缓存，其余（commits、trees 等）保持实时喵
	const relative = contentsRelative(path);
	const cacheable = isGet && relative !== null;
	const cacheKey = cacheable
		? new Request(`https://gw-cache.internal/${path}${incoming.search}`, { method: "GET" })
		: null;

	let response;
	if (cacheKey && typeof caches !== "undefined") {
		const hit = await caches.default.match(cacheKey).catch((e) => { console.error("cache match fail", e); return null; });
		if (hit) {
			const cachedHeaders = new Headers(hit.headers);
			for (const [k, v] of Object.entries(CORS)) cachedHeaders.set(k, v);
			cachedHeaders.set("x-gw-cache", "hit");
			return new Response(hit.body, { status: hit.status, headers: cachedHeaders });
		}
	}

	try {
		response = await callGitHub(path, request, env, isGet ? GET_TIMEOUT_MS : TIMEOUT_MS);
		if (isGet && response.status >= 500) {
			await new Promise((r) => setTimeout(r, 350));
			response = await callGitHub(path, request, env, GET_TIMEOUT_MS);
		}
	} catch (error) {
		// 读请求网络抖动时再试一次，写请求不能重试（可能已经提交成功）喵
		if (isGet) {
			try {
				response = await callGitHub(path, request, env, GET_TIMEOUT_MS);
			} catch {
				response = null;
			}
		}
		if (!response) {
			const status = error?.status === 413 ? 413 : 502;
			const message = status === 413 ? "上传内容过大" : "无法连接 GitHub API，请稍后重试";
			return json({ message }, status, {}, CORS);
		}
	}

	const headers = new Headers();
	const passthrough = ["content-type", "link", "etag", "location", "x-ratelimit-remaining", "x-ratelimit-reset"];
	for (const name of passthrough) {
		const value = response.headers.get(name);
		if (value) headers.set(name, value);
	}
	headers.set("cache-control", isGet ? `public, max-age=${GET_CACHE_TTL}` : "no-store");
	for (const [k, v] of Object.entries(CORS)) headers.set(k, v);

	if (response.status === 401 || response.status === 403) {
		const detail = await response.text().catch(() => "");
		return json(
			{
				message:
					response.status === 401
						? "服务端 GitHub 凭据无效，请管理员更新 GITHUB_API_TOKEN"
						: "GitHub 拒绝访问该资源（权限不足）",
				github: { status: response.status, detail: detail.slice(0, 400) },
			},
			response.status === 401 ? 502 : 403,
			{},
			CORS,
		);
	}

	// 写完之后把对应文件的缓存清掉，避免刚保存完又读到旧内容喵
	if (!isGet && response.status < 300 && typeof caches !== "undefined" && relative) {
		const file = relative.replace(/\/+$/, "");
		const targets = [file];
		const parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
		if (parent) targets.push(parent);
		for (const t of targets) {
			for (const v of ["", "?ref=main"]) {
				caches.default.delete(new Request(`https://gw-cache.internal/repos/${OWNER}/${REPO}/contents/${t}${v}`)).catch(() => {});
			}
		}
	}

	// 先读成 buffer，缓存和响应各用一份（body 流只能消费一次喵）
	const payload = await response.arrayBuffer();
	if (cacheKey && cacheable && response.status === 200 && typeof caches !== "undefined") {
		const cacheHeaders = new Headers(headers);
		cacheHeaders.delete("vary");
		cacheHeaders.delete("set-cookie");
		cacheHeaders.set("cache-control", `public, max-age=${GET_CACHE_TTL}`);
		try {
			await caches.default.put(cacheKey, new Response(payload, { status: 200, headers: cacheHeaders }));
			headers.set("x-gw-cache", "stored");
		} catch (e) {
			headers.set("x-gw-cache", "store-failed: " + String(e?.message || e).slice(0, 60));
		}
	}

	return new Response(payload, { status: response.status, headers });
}
