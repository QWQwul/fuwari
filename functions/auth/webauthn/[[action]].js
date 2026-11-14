import { verifySession, b64urlDecode, issueSession, b64urlEncode } from "../../_lib/security.js";
import {
	verifyRegistration,
	verifyAssertion,
	putChallenge,
	takeChallenge,
	listCredentials,
	saveCredential,
	updateCredential,
	randomChallenge,
	parseClientData,
} from "../../_lib/webauthn.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY = 64 * 1024;

function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function originOf(request) {
	const url = new URL(request.url);
	return url.origin;
}

function rpIdOf(request) {
	return new URL(request.url).hostname;
}

function sessionFrom(request, env) {
	const auth = request.headers.get("authorization") || "";
	const match = auth.match(/^Bearer\s+(.+)$/i);
	if (!match) return null;
	return verifySession(env.SESSION_SECRET, match[1].trim());
}

function publicKeyOptions(request, { challenge, userVerification = "preferred", allowCredentials = [], mode = "get" }, creds = []) {
	const rpId = rpIdOf(request);
	if (mode === "create") {
		return {
			challenge,
			rp: { id: rpId, name: "QWQ 博客后台" },
			user: { id: b64urlEncode(new TextEncoder().encode("admin:qwq")), name: "admin", displayName: "后台管理员" },
			pubKeyCredParams: [{ type: "public-key", alg: -7 }],
			timeout: 60000,
			attestation: "none",
			authenticatorSelection: {
				residentKey: "required",
				requireResidentKey: true,
				userVerification,
			},
			excludeCredentials: creds.map((c) => ({ type: "public-key", id: c.id })),
		};
	}
	return {
		challenge,
		rpId,
		timeout: 60000,
		userVerification,
		allowCredentials,
	};
}

export async function onRequestPost({ request, env }) {
	const kv = env.CMS_KV;
	if (!kv) return json({ ok: false, error: "KV 未绑定" }, 503);
	if (!env.SESSION_SECRET) return json({ ok: false, error: "缺少 SESSION_SECRET" }, 503);

	const action = new URL(request.url).pathname.split("/").filter(Boolean).pop();
	const raw = await request.text();
	if (raw.length > MAX_BODY) return json({ ok: false, error: "请求过大" }, 413);
	let body = {};
	try {
		body = raw ? JSON.parse(raw) : {};
	} catch {
		return json({ ok: false, error: "JSON 非法" }, 400);
	}

	const origin = originOf(request);
	const rpId = rpIdOf(request);

	try {
		if (action === "register-options" || action === "register-verify" || action === "reset") {
			const session = sessionFrom(request, env);
			if (!session) return json({ ok: false, error: "未登录" }, 401);
		}

		if (action === "reset") {
			await kv.delete("passkeys");
			return json({ ok: true, count: 0 });
		}

		if (action === "register-options") {
			const credentials = await listCredentials(kv);
			const challenge = randomChallenge();
			const challengeId = await putChallenge(kv, challenge);
			return json({
				ok: true,
				challengeId,
				publicKey: publicKeyOptions(request, { challenge, mode: "create", userVerification: "required" }, credentials),
			});
		}

		if (action === "register-verify") {
			const challenge = await takeChallenge(kv, body.challengeId);
			if (!challenge) return json({ ok: false, error: "挑战已过期，请重试" }, 400);
			const clientDataJSON = new TextDecoder().decode(b64urlDecode(body.clientDataJSON));
			const result = await verifyRegistration({
				attestationObject: b64urlDecode(body.attestationObject),
				clientDataJSON,
				challenge,
				origin,
				rpId,
			});
			await saveCredential(kv, {
				id: result.credentialId,
				publicKeyJwk: result.publicKeyJwk,
				signCount: result.signCount,
				rpId,
				aaguid: result.aaguid,
				flags: result.flags,
				backupEligible: result.backupEligible,
				backupState: result.backupState,
				createdAt: new Date().toISOString(),
				lastUsedAt: null,
			});
			console.log("passkey registered:", JSON.stringify({ id: result.credentialId.slice(0, 12), aaguid: result.aaguid, flags: result.flags }));
			return json({ ok: true, credentialId: result.credentialId });
		}

		if (action === "login-options") {
			const credentials = await listCredentials(kv);
			if (credentials.length === 0) return json({ ok: false, error: "未注册指纹" }, 404);
			const challenge = randomChallenge();
			const challengeId = await putChallenge(kv, challenge);
			return json({
				ok: true,
				challengeId,
				publicKey: publicKeyOptions(request, {
					challenge,
					userVerification: "required",
					allowCredentials: [],
				}),
			});
		}

		if (action === "login-verify") {
			const challenge = await takeChallenge(kv, body.challengeId);
			if (!challenge) return json({ ok: false, error: "挑战已过期，请重试" }, 400);
			const credentials = await listCredentials(kv);
			const credential = credentials.find((c) => c.id === body.credentialId);
			if (!credential) return json({ ok: false, error: "凭据不存在" }, 404);
			const clientDataJSON = new TextDecoder().decode(b64urlDecode(body.clientDataJSON));
			const parsedClient = parseClientData(clientDataJSON);
			if (parsedClient.type !== "webauthn.get") return json({ ok: false, error: "断言类型非法" }, 400);
			const result = await verifyAssertion({
				authenticatorData: b64urlDecode(body.authenticatorData),
				clientDataJSON,
				signature: b64urlDecode(body.signature),
				credential,
				challenge,
				origin,
				rpId,
			});
			await updateCredential(kv, credential.id, { signCount: result.signCount, lastUsedAt: new Date().toISOString() });
			const token = await issueSession(env.SESSION_SECRET, 8 * 3600, "admin");
			return json({ ok: true, token, user: { username: "admin", via: "passkey" } });
		}

		return json({ ok: false, error: "未知操作" }, 404);
	} catch (error) {
		console.error("webauthn error:", action, error && error.message);
		return json({ ok: false, error: (error && error.message) || "校验失败" }, 400);
	}
}

export async function onRequestGet({ request, env }) {
	const action = new URL(request.url).pathname.split("/").filter(Boolean).pop();
	if (action === "status") {
		const kv = env.CMS_KV;
		if (!kv) return json({ ok: true, count: 0, kv: false });
		try {
			const list = await listCredentials(kv);
			return json({ ok: true, count: list.length, kv: true });
		} catch (error) {
			console.error("webauthn status:", error?.message);
			return json({ ok: true, count: 0, kv: false });
		}
	}
	return json({ ok: false, error: "只支持 POST" }, 405);
}
