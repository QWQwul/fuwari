/**
 * /auth —— 后台登录弹窗：手机确认登录（ntfy 推送 → 手机点批准）。
 *
 * 流程：
 *   1. 弹窗打开即创建「待批准登录」，服务器推送通知到手机；
 *   2. 弹窗每 2 秒轮询状态；
 *   3. 手机批准后凭 code 换取 8 小时会话令牌，postMessage 回后台。
 *
 * 紧急通道是另一个隐蔽路径，不在此页出现。
 */

export async function onRequestGet() {
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

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>登录确认 · QWQ 后台</title>
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
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:22px;background:
  radial-gradient(120% 80% at 50% 0%, oklch(0.70 0.14 var(--hue) / 0.10), transparent 60%), var(--bg);
  color:var(--fg);font-family:"PingFang SC","Noto Sans SC",system-ui,sans-serif}
.card{width:min(400px,100%);background:var(--bg-soft);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow);padding:26px 22px 20px;text-align:center}
.badge{width:52px;height:52px;margin:0 auto 14px;border-radius:16px;display:grid;place-items:center;background:oklch(0.70 0.14 var(--hue) / 0.16);font-size:24px}
h1{font-size:19px;margin:0 0 6px}
.sub{margin:0 0 18px;color:var(--fg-muted);font-size:13px;line-height:1.6}
.spinner{width:34px;height:34px;margin:6px auto 14px;border-radius:50%;border:3px solid var(--border);border-top-color:var(--primary);animation:spin 900ms linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:26px;letter-spacing:6px;margin:4px 0 12px;color:var(--primary-strong)}
.meta{font-size:12.5px;color:var(--fg-muted);line-height:1.8;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:10px 12px;text-align:left;word-break:break-all}
.msg{margin-top:14px;font-size:13px;min-height:19px;color:var(--fg-muted);line-height:1.6}
.msg.err{color:var(--danger)}
.msg.ok{color:var(--primary-strong)}
button{width:100%;height:44px;margin-top:16px;border:0;border-radius:999px;cursor:pointer;background:var(--primary);color:oklch(0.16 0.02 var(--hue));font-size:15px;font-weight:600}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--border);font-weight:500}
.hint{margin-top:16px;font-size:11.5px;color:var(--fg-muted);line-height:1.7}
[hidden]{display:none!important}
</style>
</head>
<body>
<main class="card">
  <div class="badge" id="icon">✦</div>
  <h1 id="title">等待手机确认</h1>
  <p class="sub" id="sub">已向你的手机发送登录确认通知，请在手机上点「批准」。</p>
  <div class="spinner" id="spin"></div>
  <div class="code" id="code">······</div>
  <div class="meta" id="meta">正在获取本机信息…</div>
  <div class="msg" id="msg"></div>
  <button id="retry" type="button" class="ghost" hidden>重新发送确认</button>
  <p class="hint">如果不是你本人操作，请直接在手机上点「拒绝」。此窗口 3 分钟内未批准会自动失效。</p>
</main>
<script>
(function(){
  var opener=window.opener;
  var titleEl=document.getElementById("title"),subEl=document.getElementById("sub");
  var codeEl=document.getElementById("code"),metaEl=document.getElementById("meta");
  var msgEl=document.getElementById("msg"),spinEl=document.getElementById("spin");
  var retryEl=document.getElementById("retry"),iconEl=document.getElementById("icon");
  var polling=null,pendingId=null,pendingCode=null,deadline=0;

  function say(t,cls){msgEl.textContent=t||"";msgEl.className="msg"+(cls?" "+cls:"");}
  function send(m){if(opener&&!opener.closed){try{opener.postMessage(m,window.location.origin);}catch(e){}}}
  function cleanup(){if(polling){clearTimeout(polling);polling=null;}}

  function deliver(token){
    var payload="authorization:github:success:"+JSON.stringify({token:token,provider:"github"});
    send(payload);
    var tries=0;
    var t=setInterval(function(){
      tries++;
      if(!opener||opener.closed||tries>8){clearInterval(t);return;}
      send(payload);
    },350);
    titleEl.textContent="已批准，正在进入后台";
    subEl.textContent="登录成功，这个窗口会自动关闭。";
    spinEl.hidden=true;iconEl.textContent="✓";codeEl.hidden=true;
    say("登录成功",'ok');
    setTimeout(function(){try{window.close();}catch(e){}},1200);
  }

  function fail(text){
    cleanup();
    spinEl.hidden=true;iconEl.textContent="!";
    titleEl.textContent="登录未完成";
    subEl.textContent="这次登录没有获得批准。";
    say(text,'err');
    retryEl.hidden=false;
  }

  function start(){
    cleanup();
    retryEl.hidden=true;spinEl.hidden=false;iconEl.textContent="✦";codeEl.hidden=false;
    titleEl.textContent="等待手机确认";
    subEl.textContent="已向你的手机发送登录确认通知，请在手机上点「批准」。";
    say("");
    fetch("/auth/pending",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})
      .then(function(r){return r.json().catch(function(){return {ok:false,error:"服务返回异常"};});})
      .then(function(d){
        if(!d||!d.ok)throw new Error((d&&d.error)||"无法创建登录请求");
        pendingId=d.id;pendingCode=d.code;
        codeEl.textContent=d.code;
        metaEl.innerHTML="";
        var lines=[["设备",d.device||"未知"],["IP",d.ip||"未知"],["发起时间",d.time||""]];
        lines.forEach(function(p){
          var row=document.createElement("div");
          row.textContent=p[0]+"：" + p[1];
          metaEl.appendChild(row);
        });
        if(d.push&&d.push.ok===false){say("通知发送失败："+(d.push.error||"未知错误")+"，请稍后重试",'err');}
        deadline=Date.now()+120000;
        poll();
      })
      .catch(function(e){fail((e&&e.message)||"网络异常");});
  }

  function poll(){
    if(!pendingId)return;
    if(Date.now()>deadline){fail("等待超时，请重新发送确认");return;}
    polling=setTimeout(function(){
      fetch("/auth/pending/"+pendingId).then(function(r){return r.json();}).then(function(d){
        if(!d||!d.ok){fail((d&&d.error)||"查询失败");return;}
        if(d.status==="approved"){
          titleEl.textContent="手机已批准";
          subEl.textContent="正在换取登录令牌…";
          spinEl.hidden=true;iconEl.textContent="✓";
          fetch("/auth/pending/"+pendingId+"/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:pendingCode})})
            .then(function(r){return r.json();})
            .then(function(s){
              if(s&&s.ok&&s.token){deliver(s.token);}
              else{fail((s&&s.error)||"令牌签发失败");}
            })
            .catch(function(){fail("令牌签发失败，请重试");});
          return;
        }
        if(d.status==="denied"){fail("这次登录被拒绝");return;}
        if(d.status==="expired"){fail("请求已过期，请重新发送");return;}
        poll();
      }).catch(function(){poll();});
    },2000);
  }

  // 手机批准页会把一次性令牌写进 localStorage，这里直接用它完成握手喵
  var boot=null;
  try{boot=localStorage.getItem("fw_token_bootstrap");}catch(e){}
  if(boot){
    try{localStorage.removeItem("fw_token_bootstrap");}catch(e){}
    titleEl.textContent="正在进入后台";
    subEl.textContent="使用刚才手机批准的登录…";
    spinEl.hidden=false;
    send("authorizing:github");
    setTimeout(function(){deliver(boot);},250);
  }else{
    retryEl.addEventListener("click",start);
    start();
  }
})();
</script>
</body>
</html>`;
