import test from "node:test";
import assert from "node:assert/strict";
import { verifyRegistration, verifyAssertion } from "../functions/_lib/webauthn.js";
import { b64urlEncode } from "../functions/_lib/security.js";

const ORIGIN = "https://ai.157478.xyz";
const RP_ID = "ai.157478.xyz";
const te = new TextEncoder();
const td = new TextDecoder();

// ── 最小 CBOR 编码（仅测试用）─────────────────────────────
function head(major, value) {
	const m = major << 5;
	if (value < 24) return Uint8Array.of(m | value);
	if (value < 256) return Uint8Array.of(m | 24, value);
	if (value < 65536) return Uint8Array.of(m | 25, value >> 8, value & 0xff);
	return Uint8Array.of(m | 26, (value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}
const encUint = (n) => head(0, n);
const encNeg = (n) => head(1, -1 - n); // n 为负值，如 -7
const encBytes = (u8) => concat(head(2, u8.length), u8);
const encText = (s) => {
	const b = te.encode(s);
	return concat(head(3, b.length), b);
};
const encArray = (items) => concat(head(4, items.length), ...items);
const encMap = (pairs) => concat(head(5, pairs.length), ...pairs.flat());
function concat(...parts) {
	const len = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(len);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}
function toB64(u8) {
	return Buffer.from(u8).toString("base64url");
}

async function sha256(bytes) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function makeFixture() {
	const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
	const x = Buffer.from(jwk.x, "base64url");
	const y = Buffer.from(jwk.y, "base64url");
	const cose = encMap([
		[encUint(1), encUint(2)],
		[encUint(3), encNeg(-7)],
		[encNeg(-1), encUint(1)],
		[encNeg(-2), encBytes(x)],
		[encNeg(-3), encBytes(y)],
	]);
	const credId = crypto.getRandomValues(new Uint8Array(16));
	const rpIdHash = await sha256(te.encode(RP_ID));
	const authData = concat(
		rpIdHash,
		Uint8Array.of(0x45),
		Uint8Array.of(0, 0, 0, 0),
		new Uint8Array(16),
		Uint8Array.of(credId.length >> 8, credId.length & 0xff),
		credId,
		cose,
	);
	return { keyPair, cose, credId, authData, jwk };
}

test("注册：能从 attestationObject 提取凭据与公钥", async () => {
	const { keyPair, cose, credId, authData } = await makeFixture();
	const challenge = toB64(crypto.getRandomValues(new Uint8Array(32)));
	const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN });
	const attestationObject = encMap([
		[encText("fmt"), encText("none")],
		[encText("attStmt"), encMap([])],
		[encText("authData"), encBytes(authData)],
	]);
	void cose;
	void keyPair;
	const result = await verifyRegistration({
		attestationObject,
		clientDataJSON,
		challenge,
		origin: ORIGIN,
		rpId: RP_ID,
	});
	assert.equal(result.credentialId, toB64(credId));
	assert.equal(result.publicKeyJwk.kty, "EC");
	assert.equal(result.publicKeyJwk.crv, "P-256");
	assert.equal(result.signCount, 0);
});

test("注册：challenge 不匹配会被拒绝", async () => {
	const { authData } = await makeFixture();
	const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: "aaa", origin: ORIGIN });
	const attestationObject = encMap([
		[encText("fmt"), encText("none")],
		[encText("attStmt"), encMap([])],
		[encText("authData"), encBytes(authData)],
	]);
	await assert.rejects(() =>
		verifyRegistration({ attestationObject, clientDataJSON, challenge: "bbb", origin: ORIGIN, rpId: RP_ID }),
	);
});

test("断言：签名正确则通过并返回计数器", async () => {
	const { keyPair, authData, jwk, credId } = await makeFixture();
	const challenge = toB64(crypto.getRandomValues(new Uint8Array(32)));
	const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN });
	const clientHash = await sha256(te.encode(clientDataJSON));
	const signed = concat(authData, clientHash);
	const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, signed));
	const result = await verifyAssertion({
		authenticatorData: authData,
		clientDataJSON,
		signature,
		credential: { id: toB64(credId), publicKeyJwk: jwk, signCount: 0 },
		challenge,
		origin: ORIGIN,
		rpId: RP_ID,
	});
	assert.equal(result.signCount, 0);
});

test("断言：伪造签名会被拒绝", async () => {
	const { authData, jwk, credId } = await makeFixture();
	const challenge = toB64(crypto.getRandomValues(new Uint8Array(32)));
	const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN });
	const signature = crypto.getRandomValues(new Uint8Array(64));
	await assert.rejects(() =>
		verifyAssertion({
			authenticatorData: authData,
			clientDataJSON,
			signature,
			credential: { id: toB64(credId), publicKeyJwk: jwk, signCount: 0 },
			challenge,
			origin: ORIGIN,
			rpId: RP_ID,
		}),
	);
});

test("断言：origin 不匹配会被拒绝", async () => {
	const { authData, jwk, credId, keyPair } = await makeFixture();
	const challenge = toB64(crypto.getRandomValues(new Uint8Array(32)));
	const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge, origin: "https://evil.example" });
	const clientHash = await sha256(te.encode(clientDataJSON));
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, concat(authData, clientHash)),
	);
	await assert.rejects(() =>
		verifyAssertion({
			authenticatorData: authData,
			clientDataJSON,
			signature,
			credential: { id: toB64(credId), publicKeyJwk: jwk, signCount: 0 },
			challenge,
			origin: ORIGIN,
			rpId: RP_ID,
		}),
	);
});
void td;
void b64urlEncode;
