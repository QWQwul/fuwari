/**
 * /passkey —— 指纹（Passkey）管理页。
 *
 * 这是一个普通页面（不是后台弹窗）：先用口令 + 动态码登录拿到会话，
 * 再在本页启用 / 清除指纹。这样后台登录只需「口令」或「指纹」其一，互不干扰。
 */

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>指纹登录 · QWQ 后台</title>
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
body{margin:0;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font-family:"PingFang SC","Noto Sans SC",system-ui,sans-serif}
.card{width:min(420px,100%);background:var(--bg-soft);border:1px solid var(--border);border-radius:22px;box-shadow:var(--shadow);padding:28px 24px 22px}
h1{font-size:20px;margin:0 0 6px}
.sub{margin:0 0 18px;color:var(--fg-muted);font-size:13px;line-height:1.6}
label{display:block;font-size:12.5px;color:var(--fg-muted);margin:14px 0 6px}
input{width:100%;height:46px;padding:0 14px;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--fg);font-size:15px}
input:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 4px oklch(0.70 0.14 var(--hue) / 0.16)}
button{width:100%;height:46px;margin-top:16px;border:0;border-radius:999px;cursor:pointer;background:var(--primary);color:oklch(0.16 0.02 var(--hue));font-size:15px;font-weight:600}
button:disabled{opacity:.55;cursor:progress}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--border);font-weight:500}
button.danger{background:transparent;color:var(--danger);border:1px solid var(--danger);font-weight:500}
.msg{margin-top:12px;font-size:13px;min-height:19px;color:var(--danger);line-height:1.5}
.msg.ok{color:var(--primary-strong)}
.status{margin-top:14px;font-size:13px;color:var(--fg-muted);line-height:1.6}
.hint{margin-top:16px;font-size:12px;color:var(--fg-muted);line-height:1.6}
.hint a{color:var(--primary-strong)}
[hidden]{display:none!important}
</style>
</head>
<body>
<main class="card">
  <h1>指纹登录</h1>
  <p class="sub">先用口令与动态码验证身份，再启用手机指纹 / 面容作为后台登录方式。</p>

  <section id="loginForm">
    <label for="pw">管理口令</label>
    <input id="pw" type="password" autocomplete="current-password" placeholder="口令" />
    <label for="code">动态验证码</label>
    <input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6 位数字" />
    <button id="go" type="button">验证身份</button>
  </section>

  <section id="panel" hidden>
    <div class="status" id="status">正在读取已注册的指纹…</div>
    <button id="add" type="button">启用指纹登录</button>
    <button id="clear" type="button" class="danger" hidden>清除已注册的指纹</button>
    <button id="back" type="button" class="ghost">完成，回到后台</button>
  </section>

  <div class="msg" id="msg" role="status" aria-live="polite"></div>
  <p class="hint">此页只接受本机操作，会话 8 小时有效。指纹保存在 Cloudflare KV，公钥可验证、私钥只留在手机上。<a href="/admin/">返回后台</a></p>
</main>
<script>
(function(){
  var pwEl=document.getElementById("pw"),codeEl=document.getElementById("code");
  var goBtn=document.getElementById("go"),msgEl=document.getElementById("msg");
  var loginForm=document.getElementById("loginForm"),panel=document.getElementById("panel");
  var statusEl=document.getElementById("status"),addBtn=document.getElementById("add"),clearBtn=document.getElementById("clear"),backBtn=document.getElementById("back");
  var token=null,supported=!!(window.PublicKeyCredential&&navigator.credentials&&navigator.credentials.create);

  function say(text,ok){msgEl.textContent=text||"";msgEl.className="msg"+(ok?" ok":"");}
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
  function withTimeout(promise,ms,label){
    return Promise.race([promise,new Promise(function(_,reject){
      setTimeout(function(){reject(new Error(label+"超时（"+Math.round(ms/1000)+" 秒）"));},ms);
    })]);
  }
  function authHeaders(extra){var h=extra||{};h.authorization="Bearer "+token;return h;}

  function refreshStatus(){
    return fetch("/auth/webauthn/status").then(function(r){return r.json();}).then(function(st){
      var count=(st&&st.count)||0;
      if(count>0){
        statusEl.textContent="已注册 "+count+" 个指纹。点下面按钮可以再添加一台设备（或同机重新注册）。";
        clearBtn.hidden=false;
      }else{
        statusEl.textContent="还没有注册指纹。";
        clearBtn.hidden=true;
      }
      return count;
    });
  }

  goBtn.addEventListener("click",function(){
    var password=pwEl.value,code=codeEl.value.trim();
    if(!password){say("请输入管理口令");return;}
    if(!/^[0-9]{6}$/.test(code)){say("请输入 6 位动态验证码");return;}
    goBtn.disabled=true;say("正在验证…",true);
    fetch("/auth/verify",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:password,code:code})})
      .then(function(r){return r.json();})
      .then(function(d){
        goBtn.disabled=false;
        if(!d||!d.ok||!d.token)throw new Error((d&&d.error)||"验证失败");
        token=d.token;
        loginForm.hidden=true;panel.hidden=false;say("");
        if(!supported)say("这台浏览器不支持指纹注册");
        refreshStatus().catch(function(){statusEl.textContent="读取状态失败，可直接尝试注册。";});
      })
      .catch(function(e){goBtn.disabled=false;say((e&&e.message)||"验证失败，请重试");});
  });

  addBtn.addEventListener("click",function(){
    if(!token)return;
    addBtn.disabled=true;say("正在唤起系统指纹…",true);
    fetch("/auth/webauthn/register-options",{method:"POST",headers:authHeaders({"content-type":"application/json"}),body:"{}"})
      .then(function(r){return r.json();})
      .then(function(opt){
        if(!opt||!opt.ok)throw new Error((opt&&opt.error)||"无法开始注册");
        var pk=opt.publicKey;
        pk.challenge=b64ToBuf(pk.challenge);
        pk.user.id=b64ToBuf(pk.user.id);
        pk.excludeCredentials=(pk.excludeCredentials||[]).map(function(c){return {type:c.type,id:b64ToBuf(c.id)};});
        return withTimeout(navigator.credentials.create({publicKey:pk}),120000,"系统指纹")
          .then(function(cred){
            if(!cred)throw new Error("没有返回凭据");
            return fetch("/auth/webauthn/register-verify",{method:"POST",headers:authHeaders({"content-type":"application/json"}),body:JSON.stringify({challengeId:opt.challengeId,clientDataJSON:bufToB64(cred.response.clientDataJSON),attestationObject:bufToB64(cred.response.attestationObject)})});
          });
      })
      .then(function(r){return r.json();})
      .then(function(res){
        addBtn.disabled=false;
        if(!res||!res.ok)throw new Error((res&&res.error)||"注册失败");
        say("指纹已启用，回到后台点「用指纹 / 面容登录」即可",true);
        return refreshStatus();
      })
      .catch(function(e){
        addBtn.disabled=false;
        var name=(e&&e.name&&e.name!=="Error")?e.name+"：":"";
        say(name+((e&&e.message)||"注册失败，请重试"));
      });
  });

  clearBtn.addEventListener("click",function(){
    if(!token)return;
    clearBtn.disabled=true;say("正在清除…",true);
    fetch("/auth/webauthn/reset",{method:"POST",headers:authHeaders({"content-type":"application/json"}),body:"{}"})
      .then(function(r){return r.json();})
      .then(function(res){
        clearBtn.disabled=false;
        if(!res||!res.ok)throw new Error((res&&res.error)||"清除失败");
        say("已清除全部指纹，可以重新注册",true);
        return refreshStatus();
      })
      .catch(function(e){clearBtn.disabled=false;say((e&&e.message)||"清除失败");});
  });

  backBtn.addEventListener("click",function(){location.href="/admin/";});

  if(!supported){say("这台浏览器不支持指纹登录（需要 HTTPS 与系统生物识别）");}
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
			"referrer-policy": "no-referrer",
		},
	});
}

export async function onRequest() {
	return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
}
