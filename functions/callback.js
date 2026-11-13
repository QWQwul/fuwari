export async function onRequestGet({ request, env }) {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const error = url.searchParams.get("error");

	let payload = JSON.stringify({ error: error || "missing_code" });
	let status = "error";

	if (code) {
		try {
			const res = await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({
					client_id: env.GITHUB_CLIENT_ID,
					client_secret: env.GITHUB_CLIENT_SECRET,
					code,
				}),
			});
			const data = await res.json();
			if (data.access_token) {
				payload = JSON.stringify({ token: data.access_token, provider: "github" });
				status = "success";
			} else {
				payload = JSON.stringify({ error: data.error || "token_exchange_failed" });
			}
		} catch (e) {
			payload = JSON.stringify({ error: String(e) });
		}
	}

	const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Authorizing…</title>
<style>body{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#111;color:#eee}</style>
</head>
<body>
<p id="msg">正在完成授权，请稍候…</p>
<script>
(function () {
	var status = ${JSON.stringify(status)};
	var payload = ${JSON.stringify(payload)};
	function send(msg) { if (window.opener) window.opener.postMessage(msg, "*"); }
	send("authorizing:github");
	window.addEventListener("message", function () {
		send("authorization:github:" + status + ":" + payload);
		setTimeout(function () { window.close(); }, 300);
	}, false);
	setTimeout(function () {
		document.getElementById("msg").textContent = status === "success"
			? "授权成功，可以关闭此窗口回到后台了。"
			: "授权失败：" + payload;
	}, 2500);
})();
</script>
</body></html>`;

	return new Response(html, {
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}
