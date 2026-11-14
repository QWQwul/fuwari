/**
 * WebAuthn（Passkey）服务端校验：只需要注册与断言两条路径。
 * 依赖 _lib/cbor.js 与 WebCrypto。
 */
import { decodeCbor } from "./cbor.js";
import { b64urlEncode, b64urlDecode } from "./security.js";

const te = new TextEncoder();

export function parseClientData(jsonText) {
	let data;
	try {
		data = JSON.parse(jsonText);
	} catch {
		throw new Error("clientDataJSON 不是合法 JSON");
	}
	if (data.type !== "webauthn.create" && data.type !== "webauthn.get") {
		throw new Error("clientData type 非法");
	}
	return data;
}

/** 解析 authenticatorData；credentialId 与 COSE 公钥只在注册时有。 */
export function parseAuthData(bytes) {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (view.length < 37) throw new Error("authenticatorData 太短");
	const rpIdHash = view.slice(0, 32);
	const flags = view[32];
	const signCount = ((view[33] << 24) | (view[34] << 16) | (view[35] << 8) | view[36]) >>> 0;
	const parsed = { rpIdHash, flags, signCount, credentialId: null, coseKey: null, extensions: null, aaguid: null };
	let offset = 37;
	const hasAttested = (flags & 0x40) !== 0;
	if (hasAttested) {
		if (view.length < offset + 18) throw new Error("attested 数据不完整");
		parsed.aaguid = toHexString(view.slice(offset, offset + 16));
		const credIdLen = (view[offset + 16] << 8) | view[offset + 17];
		offset += 18;
		parsed.credentialId = view.slice(offset, offset + credIdLen);
		offset += credIdLen;
		parsed.coseKey = decodeCbor(view.slice(offset));
		// COSE key 结束后若还有扩展数据，长度不固定，这里不再解析。
	}
	return parsed;
}

/** COSE(EC2 P-256) → WebCrypto JWK。 */
function coseField(cose, key) {
	return cose[key] !== undefined ? cose[key] : cose[String(key)];
}

export function coseToJwk(cose) {
	if (Number(coseField(cose, 1)) !== 2) throw new Error("只支持 EC2 公钥");
	if (Number(coseField(cose, 3)) !== -7) throw new Error("只支持 ES256");
	if (Number(coseField(cose, -1)) !== 1) throw new Error("只支持 P-256");
	const x = coseField(cose, -2);
	const y = coseField(cose, -3);
	if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error("公钥坐标缺失");
	return {
		kty: "EC",
		crv: "P-256",
		x: b64urlEncode(x),
		y: b64urlEncode(y),
		ext: true,
	};
}

function toHexString(bytes) {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

export async function sha256(bytes) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const HOST_RP_SUFFIX = "";

export function rpIdFromOrigin(origin) {
	const u = new URL(origin);
	return u.hostname;
}

/** DER(ASN.1) ECDSA 签名 → P1363(r||s)。 */
export function derToP1363(der, size = 32) {
	const view = der instanceof Uint8Array ? der : new Uint8Array(der);
	let offset = 0;
	if (view[offset++] !== 0x30) throw new Error("签名不是 DER 序列");
	let lenByte = view[offset++];
	let seqLen = lenByte;
	if (lenByte & 0x80) {
		const n = lenByte & 0x7f;
		seqLen = 0;
		for (let i = 0; i < n; i++) seqLen = (seqLen << 8) | view[offset++];
	}
	if (view[offset++] !== 0x02) throw new Error("r 不是 DER 整数");
	let rLen = view[offset++];
	if (rLen & 0x80) rLen = 0;
	const r = view.slice(offset, offset + rLen);
	offset += rLen;
	if (view[offset++] !== 0x02) throw new Error("s 不是 DER 整数");
	let sLen = view[offset++];
	const s = view.slice(offset, offset + sLen);
	const out = new Uint8Array(size * 2);
	out.set(trimLeadingZeros(r, size), 0);
	out.set(trimLeadingZeros(s, size), size);
	return out;
}

function trimLeadingZeros(bytes, size) {
	let i = 0;
	while (i < bytes.length - size && bytes[i] === 0) i++;
	const out = new Uint8Array(size);
	const slice = bytes.slice(i);
	out.set(slice.subarray(Math.max(0, slice.length - size)), size - slice.length);
	return out;
}

export async function verifyRegistration({ attestationObject, clientDataJSON, challenge, origin, rpId }) {
	const clientData = parseClientData(clientDataJSON);
	if (clientData.type !== "webauthn.create") throw new Error("注册类型不符");
	if (clientData.challenge !== challenge) throw new Error("challenge 不匹配");
	if (clientData.origin !== origin) throw new Error("origin 不匹配");
	const att = decodeCbor(attestationObject);
	if (!(att.authData instanceof Uint8Array)) throw new Error("attestationObject 缺少 authData");
	const parsed = parseAuthData(att.authData);
	const expectRp = await sha256(te.encode(rpId));
	if (b64urlEncode(parsed.rpIdHash) !== b64urlEncode(expectRp)) throw new Error("rpIdHash 不匹配");
	if ((parsed.flags & 0x01) === 0) throw new Error("缺少用户在场标志");
	if (!parsed.credentialId || !parsed.coseKey) throw new Error("注册数据缺少凭据");
	return {
		credentialId: b64urlEncode(parsed.credentialId),
		publicKeyJwk: coseToJwk(parsed.coseKey),
		signCount: parsed.signCount,
		aaguid: parsed.aaguid || "unknown",
		flags: parsed.flags,
		backupEligible: (parsed.flags & 0x08) !== 0,
		backupState: (parsed.flags & 0x10) !== 0,
	};
}

export async function verifyAssertion({ authenticatorData, clientDataJSON, signature, credential, challenge, origin, rpId }) {
	const clientData = parseClientData(clientDataJSON);
	if (clientData.type !== "webauthn.get") throw new Error("断言类型不符");
	if (clientData.challenge !== challenge) throw new Error("challenge 不匹配");
	if (clientData.origin !== origin) throw new Error("origin 不匹配");
	const parsed = parseAuthData(authenticatorData);
	const expectRp = await sha256(te.encode(rpId));
	if (b64urlEncode(parsed.rpIdHash) !== b64urlEncode(expectRp)) throw new Error("rpIdHash 不匹配");
	if ((parsed.flags & 0x01) === 0) throw new Error("缺少用户在场标志");
	const key = await crypto.subtle.importKey("jwk", credential.publicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	const clientHash = await sha256(te.encode(clientDataJSON));
	const signedData = new Uint8Array(authenticatorData.length + clientHash.length);
	signedData.set(authenticatorData, 0);
	signedData.set(clientHash, authenticatorData.length);
	let sig;
	try {
		sig = derToP1363(signature);
	} catch {
		sig = signature;
	}
	const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, signedData);
	if (!ok) throw new Error("签名校验失败");
	const counter = parsed.signCount;
	const prev = Number(credential.signCount || 0);
	if (prev !== 0 && counter !== 0 && counter <= prev) throw new Error("签名计数器未增长（可能被克隆）");
	return { signCount: counter };
}

// ── challenge / 凭据存取（KV）────────────────────────────────
export async function putChallenge(kv, challenge) {
	const id = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
	await kv.put(`chal:${id}`, challenge, { expirationTtl: 300 });
	return id;
}

export async function takeChallenge(kv, id) {
	if (!id) return null;
	const value = await kv.get(`chal:${id}`);
	if (value) await kv.delete(`chal:${id}`).catch(() => {});
	return value;
}

export async function listCredentials(kv) {
	const stored = await kv.get("passkeys", "json");
	return Array.isArray(stored) ? stored : [];
}

export async function saveCredential(kv, credential) {
	const list = await listCredentials(kv);
	const next = list.filter((item) => item.id !== credential.id);
	next.push(credential);
	await kv.put("passkeys", JSON.stringify(next));
	return next;
}

export async function updateCredential(kv, id, patch) {
	const list = await listCredentials(kv);
	const next = list.map((item) => (item.id === id ? { ...item, ...patch } : item));
	await kv.put("passkeys", JSON.stringify(next));
}

export function randomChallenge() {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export { b64urlEncode, b64urlDecode };
