/**
 * /auth —— 后台登录页（口令 + TOTP）。
 *
 * 流程：Decap CMS 打开本页弹窗 → 用户输入口令与 6 位动态码 →
 * POST /auth/verify 换取短时效会话令牌 → 通过 postMessage 把令牌交回后台。
 * 浏览器永远拿不到 GitHub PAT，PAT 只存在于 Pages 环境变量里。
 */



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
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--border);font-weight:500}
button.ghost:hover:not(:disabled){background:var(--bg);border-color:var(--primary);transform:none}
#after{display:none}
#after.on{display:block}
#after .sep{height:1px;background:var(--border);margin:22px 0 4px}
#after p{margin:14px 0 0;font-size:13px;color:var(--fg-muted);line-height:1.6}
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
  <div class="sep" style="height:1px;background:var(--border);margin:22px 0 0"></div>
  <button id="pk" type="button" class="ghost">用指纹 / 面容登录</button>
  <div id="after">
    <div class="sep"></div>
    <p id="afterText">已通过口令验证。可以顺手启用指纹登录，下次一键进入。</p>
    <button id="enablePk" type="button">启用指纹登录</button>
    <button id="enter" type="button" class="ghost">直接进入后台</button>
  </div>
  <p class="hint">会话 8 小时自动失效。若连续输错会被临时限制，等待 10 分钟再试。</p>
</main>
<script>
(function(){
  var form=document.getElementById("f"),msg=document.getElementById("msg"),btn=document.getElementById("go");
  var opener=window.opener,handshaken=false,pendingPayload=null;
  var codeEl=document.getElementById("code"),pwEl=document.getElementById("pw"),rcEl=document.getElementById("recovery");
  var pkBtn=document.getElementById("pk"),after=document.getElementById("after"),afterText=document.getElementById("afterText");
  var enablePk=document.getElementById("enablePk"),enterBtn=document.getElementById("enter");
  var sessionToken=null,supported=!!(window.PublicKeyCredential&&navigator.credentials&&navigator.credentials.get);
  var countdownTimer=null,remaining=0;

  function send(m){if(opener&&!opener.closed){try{opener.postMessage(m,window.location.origin);}catch(e){}}}
  function say(text,ok){msg.textContent=text||"";msg.className="msg"+(ok?" ok":"");}

  window.addEventListener("message",function(ev){
    if(ev.origin!==window.location.origin)return;
    if(ev.data==="authorizing:github"){handshaken=true;if(pendingPayload){send(pendingPayload);}}
  });

  var hsTries=0,hsTimer=setInterval(function(){
    if(handshaken||hsTries++>20){clearInterval(hsTimer);return;}
    send("authorizing:github");
  },250);

  function b64ToBuf(s){
    var b64=s.split("-").join("+").split("_").join("/");
    var pad=b64.length%4;if(pad)b64+=("====").slice(0,4-pad);
    var raw=atob(b64),out=new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
    return out.buffer;
  }
  function bufToB64(buf){
    var u=new Uint8Array(buf),s="";
    for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);
    return btoa(s).split("+").join("-").split("/").join("_").split("=").join("");
  }

  // 关键：不再依赖握手。Sveltia 不握手时也要把令牌送出去，重复几次直到窗口关闭。
  function deliver(token){
    var payload="authorization:github:success:"+JSON.stringify({token:token,provider:"github"});
    pendingPayload=payload;
    send(payload);
    var tries=0;
    var t=setInterval(function(){
      tries++;
      if(!opener||opener.closed||tries>10){clearInterval(t);return;}
      send(payload);
    },400);
    if(countdownTimer){clearInterval(countdownTimer);countdownTimer=null;}
    btn.disabled=true;btn.textContent="已登录，正在返回…";
    say("登录成功，正在返回后台…",true);
    setTimeout(function(){try{window.close();}catch(e){}},1800);
  }

  function showAfter(token){
    sessionToken=token;
    form.style.display="none";
    after.className="on";
    pkBtn.style.display="none";
    say("");
    var left=8;
    afterText.textContent="已通过口令验证。"+(supported?"可启用指纹登录，下次一键进入。":"");
    if(supported&&remaining===0){/* noop */}
    var tick=function(){
      left--;
      if(left<=0){clearInterval(countdownTimer);countdownTimer=null;deliver(sessionToken);return;}
      afterText.textContent="已通过口令验证。"+(supported?"可启用指纹登录，":"")+left+" 秒后自动进入后台。";
    };
    if(countdownTimer)clearInterval(countdownTimer);
    countdownTimer=setInterval(tick,1000);
    afterText.textContent="已通过口令验证。"+(supported?"可启用指纹登录，":"")+"8 秒后自动进入后台。";
  }

  form.addEventListener("submit",function(ev){
    ev.preventDefault();
    var password=pwEl.value,code=codeEl.value.trim(),recovery=rcEl.value.trim();
    if(!password){say("请输入管理口令");return;}
    if(!recovery&&!/^[0-9]{6}$/.test(code)){say("请输入 6 位动态验证码");return;}
    btn.disabled=true;say("正在验证…",true);
    fetch("/auth/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:password,code:code,recovery:recovery||undefined})})
      .then(function(r){return r.json().catch(function(){return {ok:false,error:"服务返回异常"};});})
      .then(function(data){
        if(data&&data.ok&&data.token){
          if(supported){showAfter(data.token);}else{deliver(data.token);}
          return;
        }
        btn.disabled=false;btn.textContent="登录";say((data&&data.error)||"登录失败，请重试");
      })
      .catch(function(){btn.disabled=false;btn.textContent="登录";say("网络异常，请重试");});
  });

  enterBtn.addEventListener("click",function(){
    if(sessionToken)deliver(sessionToken);
  });

  enablePk.addEventListener("click",function(){
    if(!sessionToken)return;
    if(countdownTimer){clearInterval(countdownTimer);countdownTimer=null;}
    enablePk.disabled=true;say("正在唤起系统指纹…",true);
    fetch("/auth/webauthn/register-options",{method:"POST",headers:{authorization:"Bearer "+sessionToken,"content-type":"application/json"},body:"{}"})
      .then(function(r){return r.json();})
      .then(function(opt){
        if(!opt||!opt.ok)throw new Error((opt&&opt.error)||"无法开始注册");
        var pk=opt.publicKey;
        pk.challenge=b64ToBuf(pk.challenge);
        pk.user.id=b64ToBuf(pk.user.id);
        pk.excludeCredentials=(pk.excludeCredentials||[]).map(function(c){return {type:c.type,id:b64ToBuf(c.id)};});
        return navigator.credentials.create({publicKey:pk}).then(function(cred){
          if(!cred)throw new Error("未创建凭据");
          return fetch("/auth/webauthn/register-verify",{method:"POST",headers:{authorization:"Bearer "+sessionToken,"content-type":"application/json"},body:JSON.stringify({challengeId:opt.challengeId,clientDataJSON:bufToB64(cred.response.clientDataJSON),attestationObject:bufToB64(cred.response.attestationObject)})});
        });
      })
      .then(function(r){return r.json();})
      .then(function(res){
        enablePk.disabled=false;
        if(res&&res.ok){
          enablePk.style.display="none";
          afterText.textContent="指纹登录已启用，下次可直接用指纹进入。";
          say("指纹登录已启用",true);
          setTimeout(function(){deliver(sessionToken);},900);
        }else{
          throw new Error((res&&res.error)||"启用失败");
        }
      })
      .catch(function(e){enablePk.disabled=false;say((e&&e.message)||"启用失败，请重试");});
  });

  pkBtn.addEventListener("click",function(){
    if(!supported){say("这台浏览器不支持指纹登录");return;}
    pkBtn.disabled=true;say("正在唤起系统指纹…",true);
    fetch("/auth/webauthn/login-options",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})
      .then(function(r){return r.json();})
      .then(function(opt){
        if(!opt||!opt.ok)throw new Error((opt&&opt.error)||"尚未注册指纹，请先用口令登录并启用");
        var pk=opt.publicKey;
        pk.challenge=b64ToBuf(pk.challenge);
        pk.allowCredentials=(pk.allowCredentials||[]).map(function(c){return {type:c.type,id:b64ToBuf(c.id)};});
        return navigator.credentials.get({publicKey:pk}).then(function(cred){
          if(!cred)throw new Error("未返回凭据");
          return fetch("/auth/webauthn/login-verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({challengeId:opt.challengeId,credentialId:bufToB64(cred.rawId),authenticatorData:bufToB64(cred.response.authenticatorData),clientDataJSON:bufToB64(cred.response.clientDataJSON),signature:bufToB64(cred.response.signature)})});
        });
      })
      .then(function(r){return r.json();})
      .then(function(res){
        pkBtn.disabled=false;
        if(res&&res.ok&&res.token){deliver(res.token);}
        else{throw new Error((res&&res.error)||"指纹登录失败");}
      })
      .catch(function(e){pkBtn.disabled=false;say((e&&e.message)||"指纹登录失败");});
  });

  pwEl.focus();
})();
</script>
</body>
</html>`;


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