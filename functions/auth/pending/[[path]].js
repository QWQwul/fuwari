/**
 * /auth/pending/* —— 手机确认登录的服务端。
 *
 *   POST /auth/pending                 创建待批准请求并发 ntfy 通知
 *   GET  /auth/pending/<id>            查询状态（浏览器轮询）
 *   GET  /auth/pending/<id>/approve    手机端批准页（带签名）
 *   POST /auth/pending/<id>/approve    批准
 *   POST /auth/pending/<id>/deny       拒绝
 *   POST /auth/pending/<id>/session    批准后换会话令牌
 */

import { issueSession } from "../../_lib/security.js";
import { incr, clientKey } from "../../_lib/ratelimit.js";
import { notify, asciiLabel } from "../../_lib/notify.js";
import {
	createPending,
	getPending,
	setPendingStatus,
	signPending,
	verifyPendingSig,
	describeDevice,
	clientIp,
} from "../../_lib/pending.js";

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});

const html = (body, status = 200) =>
	new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-robots-tag": "noindex, nofollow",
			"referrer-policy": "no-referrer",
		},
	});

export async function onRequestGet({ request, env, params }) {
	const parts = normalize(params.path);
	const id = parts[0];
	if (parts.length === 2 && parts[1] === "approve") return approvalPage(request, env, id);
	if (parts.length === 1) {
		const record = await getPending(env.CMS_KV, id);
		if (!record) return json({ ok: false, error: "请求不存在或已过期" }, 404);
		return json({ ok: true, status: record.status, device: describeDevice(record.ua), ip: record.ip });
	}
	return json({ ok: false, error: "未知路径" }, 404);
}

export async function onRequestPost({ request, env, params }) {
	try {
		const parts = normalize(params.path);
		if (parts.length === 0) return create(request, env);
		const id = parts[0];
		if (parts.length === 2 && parts[1] === "approve") return decide(request, env, id, "approved");
		if (parts.length === 2 && parts[1] === "deny") return decide(request, env, id, "denied");
		if (parts.length === 2 && parts[1] === "session") return session(request, env, id);
		return json({ ok: false, error: "未知路径" }, 404);
	} catch (error) {
		console.error("pending error:", error && (error.stack || error.message));
		return json({ ok: false, error: "服务异常，请稍后重试" }, 500);
	}
}

function normalize(path) {
	if (Array.isArray(path)) return path.filter(Boolean);
	if (typeof path === "string" && path) return path.split("/").filter(Boolean);
	return [];
}

async function create(request, env) {
	if (!env.CMS_KV || !env.NTFY_TOPIC) return json({ ok: false, error: "登录确认尚未配置完成" }, 503);

	const limitKey = clientKey(request, "pending-create");
	if ((await incr(limitKey, 600)) > 12) {
		return json({ ok: false, error: "创建太频繁，请 10 分钟后再试" }, 429);
	}

	const ua = request.headers.get("user-agent") || "";
	const ip = clientIp(request);
	const record = await createPending(env.CMS_KV, { ua, ip });
	const origin = new URL(request.url).origin;
	const sig = await signPending(env.SESSION_SECRET, record.id, "approve");
	const denySig = await signPending(env.SESSION_SECRET, record.id, "deny");
	const approveUrl = `${origin}/auth/pending/${record.id}/approve?sig=${sig}`;
	const denyUrl = `${origin}/auth/pending/${record.id}/approve?sig=${sig}&deny=${denySig}`;

	const device = describeDevice(ua);
	const push = await notify(env, {
		title: "后台登录确认 · " + device,
		message:
			`设备：${device}\n` +
			`IP：${ip}\n` +
			`时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}\n` +
			`校验码：${record.code}\n\n` +
			`批准：${approveUrl}\n` +
			`拒绝：${denyUrl}`,
		click: approveUrl,
		tags: ["lock"],
	});

	if (!push.ok) console.error("ntfy push failed:", push.status, push.error);

	return json({
		ok: true,
		id: record.id,
		code: record.code,
		device,
		ip,
		time: record.createdAt,
		push: { ok: push.ok, error: push.error || null },
	});
}

async function decide(request, env, id, status) {
	let body = {};
	try {
		body = await request.json();
	} catch {
		/* allow empty */
	}
	const action = status === "approved" ? "approve" : "deny";
	const sig = body && typeof body.sig === "string" ? body.sig : new URL(request.url).searchParams.get("sig");
	if (!(await verifyPendingSig(env.SESSION_SECRET, id, action, sig))) {
		return json({ ok: false, error: "签名无效" }, 403);
	}
	const record = await getPending(env.CMS_KV, id);
	if (!record) return json({ ok: false, error: "请求不存在或已过期" }, 404);
	if (record.status !== "waiting") return json({ ok: false, error: "该请求已处理" }, 409);

	const actor = describeDevice(request.headers.get("user-agent") || "") + " · " + clientIp(request);
	const next = await setPendingStatus(env.CMS_KV, record, status, actor);
	return json({ ok: true, status: next.status });
}

async function session(request, env, id) {
	let body = {};
	try {
		body = await request.json();
	} catch {
		/* ignore */
	}
	const keyboard = body && typeof body.code === "string" ? body.code : "";
	const record = await getPending(env.CMS_KV, id);
	if (!record) return json({ ok: false, error: "请求不存在或已过期" }, 404);
	if (record.status !== "approved") return json({ ok: false, error: "尚未获得手机批准" }, 403);
	if (!keyboard || keyboard !== record.code) return json({ ok: false, error: "校验码不匹配" }, 403);

	await setPendingStatus(env.CMS_KV, record, "used", "浏览器换取令牌");
	const { token, expiresAt } = await issueSession(env.SESSION_SECRET, 8 * 3600, "admin");
	return json({ ok: true, token, expiresAt, user: { username: "admin", via: "phone-approval" } });
}

async function approvalPage(request, env, id) {
	const url = new URL(request.url);
	const sig = url.searchParams.get("sig") || "";
	const denySig = url.searchParams.get("deny") || "";
	const record = await getPending(env.CMS_KV, id);
	if (!record) return html(page("请求无效", "这个请求不存在或已经过期。", ""), 404);
	if (!(await verifyPendingSig(env.SESSION_SECRET, id, "approve", sig))) {
		return html(page("签名无效", "链接可能被修改过，请重新在浏览器发起登录。", ""), 403);
	}
	const device = describeDevice(record.ua);
	const time = new Date(record.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
	const done = record.status !== "waiting";
	const body = done
		? page("已处理", `这个请求已${record.status === "denied" ? "被拒绝" : "处理完成"}。`, "")
		: page(
				"有人正在登录后台",
				`<div class="row"><span>设备</span><b>${escapeHtml(device)}</b></div>
         <div class="row"><span>IP</span><b>${escapeHtml(record.ip)}</b></div>
         <div class="row"><span>时间</span><b>${escapeHtml(time)}</b></div>
         <div class="row"><span>校验码</span><b>${escapeHtml(record.code)}</b></div>
         <p class="warn">如果这不是你本人操作，请点「拒绝」。</p>
         <button id="ok" data-act="approve" data-sig="${escapeHtml(sig)}">批准登录</button>
         <button id="no" class="ghost" data-act="deny" data-sig="${escapeHtml(denySig || sig)}">拒绝</button>`,
			);
	return html(body);
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(title, inner, _unused) {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)} · 登录确认</title>
<style>
:root{--hue:60;--bg:oklch(0.972 0.012 var(--hue));--card:oklch(0.995 0.006 var(--hue));--fg:oklch(0.28 0.028 var(--hue));--muted:oklch(0.52 0.022 var(--hue));--line:oklch(0.90 0.018 var(--hue));--primary:oklch(0.70 0.14 var(--hue));--danger:oklch(0.60 0.19 25);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.17 0.014 var(--hue));--card:oklch(0.215 0.016 var(--hue));--fg:oklch(0.94 0.012 var(--hue));--muted:oklch(0.72 0.016 var(--hue));--line:oklch(0.30 0.018 var(--hue));--primary:oklch(0.74 0.13 var(--hue));color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:22px;background:var(--bg);color:var(--fg);font-family:"PingFang SC","Noto Sans SC",system-ui,sans-serif}
.card{width:min(400px,100%);background:var(--card);border:1px solid var(--line);border-radius:22px;padding:26px 22px;box-shadow:0 18px 60px -24px oklch(0.45 0.10 var(--hue)/.35)}
h1{font-size:19px;margin:0 0 14px}
.row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px dashed var(--line);font-size:14px}
.row span{color:var(--muted)}.row b{font-weight:600;text-align:right;word-break:break-all}
.warn{margin-top:14px;font-size:13px;color:var(--danger);line-height:1.6}
p{font-size:14px;line-height:1.7;color:var(--muted)}
button{width:100%;height:46px;margin-top:14px;border:0;border-radius:999px;background:var(--primary);color:oklch(0.16 0.02 var(--hue));font-size:15px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
#msg{margin-top:12px;font-size:13px;color:var(--muted);min-height:18px}
</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1>${inner}<div id="msg"></div></main>
<script>
document.querySelectorAll("button[data-act]").forEach(function(b){
  b.addEventListener("click",function(){
    b.disabled=true;
    var base=location.pathname.indexOf("/approve")>=0?location.pathname.slice(0,location.pathname.indexOf("/approve")):location.pathname;
    fetch(base+"/"+b.dataset.act,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sig:b.dataset.sig})})
      .then(function(r){return r.json();})
      .then(function(d){
        var ok=d&&d.ok;
        document.getElementById("msg").textContent=ok?(d.status==="approved"?"已批准，请回到电脑上继续":"已拒绝"):((d&&d.error)||"操作失败");
        document.querySelectorAll("button[data-act]").forEach(function(x){x.disabled=true;});
        if(ok){
          var h=document.querySelector("h1"); if(h) h.textContent=(d.status==="approved"?"已批准登录":"已拒绝登录");
          var w=document.querySelector(".warn"); if(w) w.remove();
          document.getElementById("msg").textContent=(d.status==="approved"?"正在返回后台…":"已拒绝，若不是你本人操作请检查账号");
          if(d.status==="approved") setTimeout(function(){location.replace("/admin/");},600);
        }
      })
      .catch(function(){document.getElementById("msg").textContent="网络异常，请重试";b.disabled=false;});
  });
});
</script></body></html>`;
}
