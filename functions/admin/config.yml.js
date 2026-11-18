/**
 * 动态输出 /admin/config.yml：把静态配置里写死的站点地址换成「当前访问的 origin」。
 *
 * 为什么要这样：手机所在运营商会对「Cloudflare 边缘 + 443」做 TLS 重置，
 * 后台只能用 https://ai.157478.xyz:8443 打开；若配置里仍是 443 的地址，
 * Sveltia 会去连被拦的 api_root / base_url，登录与内容接口全部失败喵。
 *
 * 静态文件仍是唯一事实来源（public/admin/config.yml），这里只做地址替换。
 */

const CANONICAL = "https://ai.157478.xyz";

export async function onRequest({ request, env }) {
	const assetUrl = new URL("/admin/config.yml", request.url);
	let text;
	try {
		const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), { headers: { accept: "text/yaml" } }));
		text = await res.text();
	} catch {
		return new Response("config.yml 读取失败", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
	}

	const origin = new URL(request.url).origin;
	if (origin && origin !== CANONICAL) {
		text = text.split(CANONICAL).join(origin);
	}

	return new Response(text, {
		headers: {
			"content-type": "text/yaml; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}
