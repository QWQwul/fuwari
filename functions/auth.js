/**
 * /auth —— 后台登录页（口令 + TOTP）。
 *
 * 流程：Decap CMS 打开本页弹窗 → 用户输入口令与 6 位动态码 →
 * POST /auth/verify 换取短时效会话令牌 → 通过 postMessage 把令牌交回后台。
 * 浏览器永远拿不到 GitHub PAT，PAT 只存在于 Pages 环境变量里。
 */

import { issueSession, verifyDevice } from "./_lib/security.js";

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>后台登录 · QWQ</title>
<style>
:root{
  --hue:60;
  --bg:oklch(0.972 0.012 var(--hue));
  --bg-soft:oklch(0.995 0.006 var(--hue));
  --fg:oklch(0.28 0.028 var(--hue));
  --fg-muted:oklch(0.52 0.022 var(--hue));
  --border:oklch(0.90 0.018 var(--hue));
  --primary:oklch(0.70 0.14 var(--hue));
  --primary-strong:oklch(0.62 0.15 var(--hue));
  --danger:oklch(0.60 0.19 25);
  --shadow:0 18px 60px -24px oklch(0.45 0.10 var(--hue) / 0.35);
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:oklch(0.17 0.014 var(--hue));
    --bg-soft:oklch(0.215 0.016 var(--hue));
    --fg:oklch(0.94 0.012 var(--hue));
    --fg-muted:oklch(0.72 0.016 var(--hue));
    --border:oklch(0.30 0.018 var(--hue));
    --primary:oklch(0.74 0.13 var(--hue));
    --primary-strong:oklch(0.80 0.12 var(--hue));
    --shadow:0 18px 60px -20px oklch(0 0 0 / 0.6);
    color-scheme:dark;
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  display:grid;
  place-items:center;
  padding:24px;
  background:
    radial-gradient(1100px 600px at 12% -10%, oklch(0.70 0.14 var(--hue) / 0.18), transparent 60%),
    radial-gradient(900px 520px at 110% 110%, oklch(0.62 0.15 calc(var(--hue) + 18) / 0.14), transparent 55%),
    var(--bg);
  color:var(--fg);
  font-family:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.card{
  width:min(420px,100%);
  background:var(--bg-soft);
  border:1px solid var(--border);
  border-radius:22px;
  box-shadow:var(--shadow);
  padding:30px 26px 24px;
  position:relative;
  overflow:hidden;
}
.card::before{
  content:"";
  position:absolute;inset:0 0 auto;height:3px;
  background:linear-gradient(90deg,transparent,var(--primary),transparent);
}
.badge{
  width:56px;height:56px;border-radius:16px;
  background:oklch(0.70 0.14 var(--hue) / 0.14);
  border:1px solid oklch(0.70 0.14 var(--hue) / 0.28);
  display:grid;place-items:center;
  font-size:26px;margin-bottom:16px;
}
h1{font-size:21px;margin:0 0 6px;letter-spacing:.2px}
.sub{margin:0 0 22px;color:var(--fg-muted);font-size:13px;line-height:1.6}
label{display:block;font-size:12.5px;color:var(--fg-muted);margin:14px 0 6px}
input{
  width:100%;height:46px;padding:0 14px;
  border-radius:12px;border:1px solid var(--border);
  background:var(--bg);color:var(--fg);font-size:15px;
  transition:border-color .18s ease,box-shadow .18s ease;
}
input::placeholder{color:oklch(0.62 0.02 var(--hue) / 0.75)}
input:focus{
  outline:none;border-color:var(--primary);
  box-shadow:0 0 0 4px oklch(0.70 0.14 var(--hue) / 0.16);
}
.row{display:flex;gap:10px}
.row input{flex:1}
button{
  width:100%;height:46px;margin-top:22px;
  border:0;border-radius:999px;cursor:pointer;
  background:var(--primary);color:oklch(0.16 0.02 var(--hue));
  font-size:15px;font-weight:600;letter-spacing:.3px;
  transition:transform .16s ease,background .16s ease,opacity .16s ease;
}
button:hover:not(:disabled){background:var(--primary-strong);transform:translateY(-1px)}
button:disabled{opacity:.55;cursor:progress;transform:none}
.msg{margin-top:14px;font-size:13px;min-height:19px;color:var(--danger);line-height:1.5}
.msg.ok{color:var(--primary-strong)}
.hint{margin-top:18px;font-size:12px;color:var(--fg-muted);line-height:1.6}
.hint a{color:var(--primary-strong)}
details{margin-top:16px;font-size:12.5px;color:var(--fg-muted)}
summary{cursor:pointer;user-select:none}
details label{margin-top:10px}
</style>
</head>
<body>
<main class="card">
  <div class="badge">✦</div>
  <h1>内容后台</h1>
  <p class="sub">请输入管理口令与动态验证码。这里是唯一入口，登录后浏览器只会拿到短时效会话令牌。</p>
  <form id="f" autocomplete="off">
    <label for="pw">管理口令</label>
    <input id="pw" name="password" type="password" placeholder="口令" autocomplete="current-password" required />
    <label for="code">动态验证码</label>
    <div class="row">
      <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6 位数字" autocomplete="one-time-code" required />
    </div>
    <details id="recoveryBox">
      <summary>手机丢失？使用恢复码</summary>
      <label for="recovery">恢复码（一码一用，用后请轮换）</label>
      <input id="recovery" name="recovery" type="text" placeholder="RECOVERY CODE" autocomplete="off" />
    </details>
    <button id="go" type="submit">登录</button>
    <div class="msg" id="msg" role="status" aria-live="polite"></div>
  </form>
  <p class="hint">会话 8 小时自动失效。若连续输错会被临时限制，等待 10 分钟再试。</p>
</main>
<script>
(function(){
  var form=document.getElementById("f"),msg=document.getElementById("msg"),btn=document.getElementById("go");
  var opener=window.opener,handshaken=false,pendingPayload=null;
  function send(msgText){if(opener&&!opener.closed){try{opener.postMessage(msgText,window.location.origin);}catch(e){}}}
  var codeEl=document.getElementById("code"),pwEl=document.getElementById("pw"),rcEl=document.getElementById("recovery");
  function say(text,ok){msg.textContent=text||"";msg.className="msg"+(ok?" ok":"");}
  window.addEventListener("message",function(ev){
    if(ev.origin!==window.location.origin)return;
    if(ev.data==="authorizing:github"){
      handshaken=true;
      if(pendingPayload){send(pendingPayload);pendingPayload=null;}
    }
  });
  var hsTries=0,hsTimer=setInterval(function(){
    if(handshaken||hsTries++>40){clearInterval(hsTimer);return;}
    send("authorizing:github");
  },250);
  function deliver(token){
    var payload="authorization:github:success:"+JSON.stringify({token:token,provider:"github"});
    if(handshaken){send(payload);}else{pendingPayload=payload;}
    btn.disabled=true;btn.textContent="已登录，正在返回…";
    say("登录成功，正在返回后台…",true);
  }
  form.addEventListener("submit",function(ev){
    ev.preventDefault();
    var password=pwEl.value,code=codeEl.value.trim(),recovery=rcEl.value.trim();
    if(!password){say("请输入管理口令");return;}
    if(!recovery&&!/^\\d{6}$/.test(code)){say("请输入 6 位动态验证码");return;}
    btn.disabled=true;say("正在验证…",true);
    fetch("/auth/verify",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({password:password,code:code,recovery:recovery||undefined})
    }).then(function(r){return r.json().catch(function(){return {ok:false,error:"服务返回异常"};});})
      .then(function(data){
        if(data&&data.ok&&data.token){deliver(data.token);return;}
        btn.disabled=false;btn.textContent="登录";
        say((data&&data.error)||"登录失败，请重试");
      })
      .catch(function(){btn.disabled=false;btn.textContent="登录";say("网络异常，请重试");});
  });
  pwEl.focus();
})();
</script>
</body>
</html>`;


const AUTO_PAGE = (token) => `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>正在进入后台 · QWQ</title>
<style>
:root{--bg:#f7f2e6;--fg:#6f6a5c;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#12100c;--fg:#a9a294}}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:var(--bg);color:var(--fg);font:14px/1.7 "Noto Sans SC",system-ui,sans-serif;text-align:center;padding:24px}
a{color:inherit;opacity:.6;font-size:12px;margin-top:14px;display:inline-block}
</style></head>
<body>
<div>
  <p>已识别为本机设备，正在进入后台…</p>
  <a href="/auth?forget=1">不是本人？退出本机信任</a>
</div>
<script>
(function(){
  var token = ${JSON.stringify(token)};
  var opener = window.opener;
  function send(m){ if(opener && !opener.closed){ try{ opener.postMessage(m, window.location.origin); }catch(e){} } }
  function done(){
    send("authorization:github:success:" + JSON.stringify({token: token, provider: "github"}));
    setTimeout(function(){ try{ window.close(); }catch(e){} }, 600);
  }
  var handshake = false;
  window.addEventListener("message", function(ev){
    if(ev.origin !== window.location.origin) return;
    if(ev.data === "authorizing:github"){ handshake = true; done(); }
  });
  var tries = 0;
  var timer = setInterval(function(){
    if(handshake || tries++ > 40){ clearInterval(timer); return; }
    send("authorizing:github");
  }, 250);
  // 没有 opener（直接访问）时 3 秒后跳回后台
  if(!opener){ setTimeout(function(){ location.replace("/admin/"); }, 1500); }
})();
</script>
</body></html>`;

export async function onRequestGet({ request, env }) {
	const url = new URL(request.url);
	if (url.searchParams.get("forget") === "1") {
		return new Response(PAGE, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"set-cookie": "fw_dev=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
			},
		});
	}

	const ua = request.headers.get("user-agent") || "";
	const cookieHeader = request.headers.get("cookie") || "";
	const deviceCookie = cookieHeader
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith("fw_dev="));
	if (deviceCookie && env?.SESSION_SECRET) {
		const device = await verifyDevice(env.SESSION_SECRET, deviceCookie.slice(7), { ua });
		if (device) {
			const session = await issueSession(env.SESSION_SECRET, 8 * 3600, "admin");
			return new Response(AUTO_PAGE(session.token), {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"x-robots-tag": "noindex, nofollow",
					"referrer-policy": "no-referrer",
				},
			});
		}
	}

	return new Response(PAGE, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-robots-tag": "noindex, nofollow",
			"x-frame-options": "DENY",
			"referrer-policy": "no-referrer",
		},
	});
}

export async function onRequest() {
	return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
}
