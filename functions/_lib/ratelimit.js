/**
 * 极简限流：按 key 在边缘缓存里计数（best-effort，缓存被回收就重新计）。
 */
export async function incr(key, windowSeconds) {
	const cacheKey = new Request(`https://ratelimit.invalid/${encodeURIComponent(key)}`);
	let count = 0;
	try {
		const hit = await caches.default.match(cacheKey);
		if (hit) count = Number.parseInt(await hit.text(), 10) || 0;
	} catch {
		count = 0;
	}
	count += 1;
	try {
		await caches.default.put(
			cacheKey,
			new Response(String(count), {
				headers: { "Cache-Control": `max-age=${windowSeconds}` },
			}),
		);
	} catch {
		// 缓存不可用时放行，不因为限流组件故障挡住登录。
	}
	return count;
}

export function clientKey(request, bucket) {
	const ip =
		request.headers.get("cf-connecting-ip") ||
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		"unknown";
	return `${bucket}:${ip}`;
}
