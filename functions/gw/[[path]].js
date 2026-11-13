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
const TIMEOUT_MS = 20000;

const CORS = {
	"access-control-allow-origin": "https://ai.157478.xyz",
	"access-control-allow-headers": "authorization, content-type, accept, x-github-api-version",
	"access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
	"access-control-expose-headers": "link, x-ratelimit-remaining",
};

const json = (body, status = 200, extra = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS, ...extra },
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

async function callGitHub(path, request, env) {
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
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
}

export async function onRequest({ request, env, params }) {
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

	const token = readSession(request);
	if (!token) return json({ message: "缺少会话令牌，请重新登录后台" }, 401);

	if (!env.SESSION_SECRET) return json({ message: "网关尚未配置 SESSION_SECRET" }, 503);
	if (!env.GITHUB_API_TOKEN) return json({ message: "网关尚未配置 GITHUB_API_TOKEN" }, 503);

	let session;
	try {
		session = await verifySession(env.SESSION_SECRET, token);
	} catch {
		session = null;
	}
	if (!session) return json({ message: "会话已失效，请重新登录后台" }, 401);

	const segments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
	const path = segments.map((s) => String(s)).join("/");
	if (!path) return json({ message: "缺少接口路径" }, 400);
	if (!isAllowedPath(path)) return json({ message: `接口不允许：${path}` }, 403);

	const method = request.method.toUpperCase();
	if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
		return json({ message: "方法不允许" }, 405);
	}

	let response;
	try {
		response = await callGitHub(path, request, env);
		if (method === "GET" && response.status >= 500) {
			await new Promise((r) => setTimeout(r, 350));
			response = await callGitHub(path, request, env);
		}
	} catch (error) {
		const status = error?.status === 413 ? 413 : 502;
		const message = status === 413 ? "上传内容过大" : "无法连接 GitHub API，请稍后重试";
		return json({ message }, status);
	}

	const headers = new Headers();
	const passthrough = ["content-type", "link", "etag", "location", "x-ratelimit-remaining", "x-ratelimit-reset"];
	for (const name of passthrough) {
		const value = response.headers.get(name);
		if (value) headers.set(name, value);
	}
	headers.set("cache-control", "no-store");
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
		);
	}

	return new Response(response.body, { status: response.status, headers });
}
