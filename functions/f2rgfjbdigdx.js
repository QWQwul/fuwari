/**
 * 紧急入口（隐蔽路径，不对外引用）
 *
 * 仅用口令登录，不依赖手机确认；口令散列存放在 Pages 环境变量里，
 * 口令随机生成、只在生成时展示一次，服务端只存不可逆散列。
 *
 * 这里故意做成单文件：路径即入口，任何页面都不链接它。
 */

import { verifyPassword, issueSession } from "./_lib/security.js";
import { incr, clientKey } from "./_lib/ratelimit.js";
import { audit, describeDevice, clientIp } from "./_lib/pending.js";

const MAX_ATTEMPTS = 6;

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

const page = (body, status = 200) =>
	new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-robots-tag": "noindex, nofollow",
			"referrer-policy": "no-referrer",
		},
	});

export async function onRequestGet() {
	return page(LOGIN_PAGE);
}

export async function onRequestPost({ request, env }) {
	try {
		if (!env.EMERGENCY_PASSWORD_HASH) return json({ ok: false, error: "未配置" }, 503);

		const limitKey = clientKey(request, "emergency");
		if ((await incr(limitKey, 900)) > MAX_ATTEMPTS) {
			return json({ ok: false, error: "尝试次数过多，请 15 分钟后再试" }, 429);
		}

		let body = {};
		try {
			body = await request.json();
		} catch {
			return json({ ok: false, error: "请求格式错误" }, 400);
		}
		const password = body && typeof body.password === "string" ? body.password : "";
		if (!password || password.length > 200) return json({ ok: false, error: "请输入口令" }, 400);

		const ok = await verifyPassword(env.EMERGENCY_PASSWORD_HASH, password);
		if (!ok) {
			await audit(env.CMS_KV, {
				id: "emergency",
				status: "denied",
				actor: describeDevice(request.headers.get("user-agent") || "") + " · " + clientIp(request),
				ip: clientIp(request),
				ua: request.headers.get("user-agent") || "",
			});
			return json({ ok: false, error: "口令不正确" }, 401);
		}

		const { token, expiresAt } = await issueSession(env.SESSION_SECRET, 8 * 3600, "admin");
		await audit(env.CMS_KV, {
			id: "emergency",
			status: "approved",
			actor: describeDevice(request.headers.get("user-agent") || "") + " · " + clientIp(request),
			ip: clientIp(request),
			ua: request.headers.get("user-agent") || "",
		});
		return json({ ok: true, token, expiresAt });
	} catch (error) {
		console.error("emergency login failed:", error && (error.stack || error.message));
		return json({ ok: false, error: "服务异常" }, 500);
	}
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<meta name="referrer" content="no-referrer" />
<title>·</title>
<style>
:root{--hue:60;--bg:oklch(0.965 0.01 var(--hue));--card:oklch(0.995 0.006 var(--hue));--fg:oklch(0.28 0.028 var(--hue));--muted:oklch(0.52 0.022 var(--hue));--line:oklch(0.90 0.018 var(--hue));--primary:oklch(0.70 0.14 var(--hue));color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.17 0.014 var(--hue));--card:oklch(0.215 0.016 var(--hue));--fg:oklch(0.94 0.012 var(--hue));--muted:oklch(0.72 0.016 var(--hue));--line:oklch(0.30 0.018 var(--hue));--primary:oklch(0.74 0.13 var(--hue));color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:22px;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif}
.card{width:min(360px,100%);background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px}
label{font-size:12.5px;color:var(--muted)}
input{width:100%;height:44px;margin-top:8px;padding:0 12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font-size:15px}
button{width:100%;height:44px;margin-top:14px;border:0;border-radius:999px;background:var(--primary);color:oklch(0.16 0.02 var(--hue));font-weight:600;font-size:15px;cursor:pointer}
#msg{margin-top:12px;font-size:13px;color:var(--muted);min-height:18px;line-height:1.6}
#out{margin-top:12px;font-size:12px;color:var(--muted);word-break:break-all;line-height:1.6}
</style></head>
<body><main class="card">
<label for="pw">口令</label>
<input id="pw" type="password" autocomplete="off" autofocus />
<button id="go">进入</button>
<div id="msg"></div><div id="out"></div>
</main>
<script>
(function(){
  var pw=document.getElementById("pw"),go=document.getElementById("go"),msg=document.getElementById("msg"),out=document.getElementById("out");
  function submit(){
    if(!pw.value){msg.textContent="请输入口令";return;}
    go.disabled=true;msg.textContent="验证中…";
    fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:pw.value})})
      .then(function(r){return r.json();})
      .then(function(d){
        go.disabled=false;
        if(!d||!d.ok){msg.textContent=(d&&d.error)||"登录失败";return;}
        var opener=window.opener;
        if(opener&&!opener.closed){
          var payload="authorization:github:success:"+JSON.stringify({token:d.token,provider:"github"});
          try{opener.postMessage(payload,window.location.origin);}catch(e){}
          msg.textContent="已登录，正在返回后台…";
          setTimeout(function(){try{window.close();}catch(e){}},800);
        }else{
          msg.textContent="登录成功，请回到后台页面继续（或直接打开 /admin/）。";
          out.textContent="令牌有效期 8 小时。";
        }
      })
      .catch(function(){go.disabled=false;msg.textContent="网络异常";});
  }
  go.addEventListener("click",submit);
  pw.addEventListener("keydown",function(e){if(e.key==="Enter")submit();});
  pw.focus();
})();
</script>
</body></html>`;
