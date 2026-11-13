import { test } from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes, createHmac } from "node:crypto";

import {
	base32Decode,
	issueSession,
	makePasswordHash,
	verifyPassword,
	verifySession,
	verifyTotp,
	b64urlEncode,
} from "../functions/_lib/security.js";
import { isAllowedPath } from "../functions/gw/[[path]].js";

const b64url = (buf) =>
	Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("口令散列：正确口令通过，错误口令与坏格式都被拒绝", async () => {
	const hash = await makePasswordHash("correct horse battery staple");
	assert.equal(await verifyPassword(hash, "correct horse battery staple"), true);
	assert.equal(await verifyPassword(hash, "correct horse battery stapl"), false);
	assert.equal(await verifyPassword(hash, ""), false);
	assert.equal(await verifyPassword("", "x"), false);
	assert.equal(await verifyPassword("pbkdf2$sha1$210000$a$b", "x"), false);
	assert.equal(await verifyPassword("pbkdf2$sha256$10$aaaa$bbbb", "x"), false);
});

test("口令散列：与 node:crypto 的 PBKDF2 结果一致（跨实现兼容）", async () => {
	const salt = randomBytes(16);
	const expected = pbkdf2Sync("跨实现口令", salt, 210000, 32, "sha256");
	const stored = `pbkdf2$sha256$210000$${b64url(salt)}$${b64url(expected)}`;
	assert.equal(await verifyPassword(stored, "跨实现口令"), true);
});

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function totpAt(secretBase32, atMs) {
	const clean = secretBase32.replace(/[\s-]/g, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const bytes = [];
	for (const ch of clean) {
		value = (value << 5) | BASE32.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	const step = Math.floor(atMs / 1000 / 30);
	const counter = Buffer.alloc(8);
	counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
	counter.writeUInt32BE(step >>> 0, 4);
	const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
	const offset = mac[mac.length - 1] & 0x0f;
	const bin =
		((mac[offset] & 0x7f) << 24) |
		((mac[offset + 1] & 0xff) << 16) |
		((mac[offset + 2] & 0xff) << 8) |
		(mac[offset + 3] & 0xff);
	return String(bin % 1_000_000).padStart(6, "0");
}

test("TOTP：当前码通过、错误码拒绝、支持一步时钟漂移", async () => {
	const secret = "JBSWY3DPEHPK3PXP";
	assert.equal(await verifyTotp(secret, totpAt(secret, Date.now())), true);
	assert.equal(await verifyTotp(secret, totpAt(secret, Date.now() - 30_000)), true);
	assert.equal(await verifyTotp(secret, totpAt(secret, Date.now() - 5 * 60_000)), false);
	assert.equal(await verifyTotp(secret, "000000"), false);
	assert.equal(await verifyTotp(secret, "12ab56"), false);
});

test("base32 解码结果与手算一致", () => {
	assert.deepEqual(Array.from(base32Decode("JBSWY3DP")), Array.from(Buffer.from("Hello")));
});

test("会话令牌：签发可验、过期拒绝、篡改拒绝、换密钥拒绝", async () => {
	const secret = b64url(randomBytes(32));
	const other = b64url(randomBytes(32));

	const { token, expiresAt } = await issueSession(secret, 60);
	assert.ok(token.includes("."));
	assert.ok(Date.parse(expiresAt) > Date.now());
	assert.equal((await verifySession(secret, token))?.sub, "admin");
	assert.equal(await verifySession(other, token), null);
	assert.equal(await verifySession(secret, `${token}x`), null);
	assert.equal(await verifySession(secret, token.slice(0, token.indexOf("."))), null);
	assert.equal(await verifySession(secret, ""), null);

	const expired = await issueSession(secret, -10);
	assert.equal(await verifySession(secret, expired.token), null);
});

test("网关白名单：只放行本仓库内容相关接口", () => {
	assert.equal(isAllowedPath("user"), true);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari"), true);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari/contents/src/content/posts/a.md"), true);
	assert.equal(isAllowedPath("repos/qwqwul/fuwari/contents/x"), true);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari/git/refs/heads/main"), true);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari/git/blobs/abc"), true);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari/collaborators/QWQwul/permission"), true);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari/pulls/1"), true);

	assert.equal(isAllowedPath("repos/other/fuwari/contents/x"), false);
	assert.equal(isAllowedPath("repos/QWQwul/other/contents/x"), false);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari/actions/secrets"), false);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari/hooks"), false);
	assert.equal(isAllowedPath("repos/QWQwul/fuwari/transfer"), false);
	assert.equal(isAllowedPath("user/keys"), false);
	assert.equal(isAllowedPath("orgs/QWQwul"), false);
});
