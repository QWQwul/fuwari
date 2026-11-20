/**
 * 把文章里的国外视频嵌入改成走自己的中转站
 *
 * 手机流量下 youtube.com / player.vimeo.com 这些域名全被阻断，
 * 嵌在文章里的 iframe 只会显示一块白板。这里在构建时把 iframe 的 src
 * 换成 https://yt.qwqads.dpdns.org/embed/<id>，由 Cloudflare Worker 代替
 * 浏览器去取视频流，对访客来说就是「能播」喵。
 *
 * 支持的写法：
 *   https://www.youtube.com/embed/<id>
 *   https://www.youtube-nocookie.com/embed/<id>
 *   https://youtu.be/<id>
 *   https://www.youtube.com/watch?v=<id>
 *   https://player.vimeo.com/video/<id>
 */

const YT_HOSTS = new Set([
	"www.youtube.com",
	"youtube.com",
	"m.youtube.com",
	"www.youtube-nocookie.com",
	"youtube-nocookie.com",
	"youtu.be",
]);

const VIMEO_HOSTS = new Set(["player.vimeo.com", "vimeo.com", "www.vimeo.com"]);

/** 从 URL 里抠出视频 id；不是视频链接就返回 null */
export function videoIdFromUrl(raw) {
	if (!raw || typeof raw !== "string") return null;
	let url;
	try {
		url = new URL(raw, "https://example.invalid");
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();

	if (YT_HOSTS.has(host)) {
		// /embed/<id>、/v/<id>、/shorts/<id>、/watch?v=<id>
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "embed" || parts[0] === "v" || parts[0] === "shorts") return parts[1] || null;
		if (parts[0] === "watch") return url.searchParams.get("v");
		if (host === "youtu.be") return parts[0] || null;
		return null;
	}

	if (VIMEO_HOSTS.has(host)) {
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts[0] === "video") return parts[1] || null;
	}

	return null;
}

/** 视频 id 只允许这些字符，避免把奇怪的东西拼进 URL */
const SAFE_ID = /^[A-Za-z0-9_-]{3,40}$/;

/**
 * rehype 插件：遍历 iframe，把国外视频源的 src 指向中转站
 * @param {{site?: string}} options site 是中转站地址，默认读环境变量
 */
export default function rehypeVideoProxy(options = {}) {
	const base = (options.site || process.env.VIDEO_PROXY_SITE || "https://yt.qwqads.dpdns.org").replace(/\/+$/, "");

	const rewriteTag = (tag) => {
		const m = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
		if (!m) return tag;
		const id = videoIdFromUrl(m[2]);
		if (!id || !SAFE_ID.test(id)) return tag;
		return tag.replace(/\bsrc\s*=\s*(["']).*?\1/i, `src="${base}/embed/${id}"`);
	};

	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.type === "element" && node.tagName === "iframe") {
			const props = node.properties || {};
			const src = typeof props.src === "string" ? props.src : "";
			const id = videoIdFromUrl(src);
			if (id && SAFE_ID.test(id)) {
				props.src = `${base}/embed/${id}`;
				// 允许全屏与自动播放，跟原生嵌入的行为保持一致
				props.allow = "autoplay; fullscreen; picture-in-picture; encrypted-media";
				props.allowfullscreen = true;
				props.loading = "lazy";
			}
		}
		// markdown 里的原始 <iframe ...> 在 AST 里可能还是 raw 字符串，
		// 这时用正则替换（rehype-raw 会在更晚的步骤才把它变成 element）
		if (node.type === "raw" && typeof node.value === "string" && node.value.includes("<iframe")) {
			node.value = node.value.replace(/<iframe\b[^>]*>/gi, (tag) => rewriteTag(tag));
		}
		for (const child of node.children || []) walk(child);
	};

	return (tree) => {
		walk(tree);
	};
}
