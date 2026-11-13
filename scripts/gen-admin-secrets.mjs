#!/usr/bin/env node
/**
 * 生成后台登录所需的三组密钥值，输出可直接填进 Cloudflare Pages 环境变量的内容。
 *
 *   node scripts/gen-admin-secrets.mjs [口令] [恢复码数量]
 *
 * 不传口令就随机生成一个强口令并打印出来（只打印这一次，请立刻保存到密码管理器）。
 */
import { pbkdf2Sync, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const ITERATIONS = 210000;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function hashPassword(password) {
	const salt = randomBytes(16);
	const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
	return `pbkdf2$sha256$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

function toBase32(buf) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

function totp(secretBase32, at = Date.now()) {
	const alphabet = BASE32;
	const clean = secretBase32.replace(/[\s-]/g, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const bytes = [];
	for (const ch of clean) {
		const idx = alphabet.indexOf(ch);
		if (idx === -1) throw new Error("bad base32 secret");
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	const step = Math.floor(at / 1000 / 30);
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

const alphabetWords = "correct-horse-battery-staple-lantern-orbit-cabin".split("-");
function randomPassphrase() {
	const words = [];
	for (let i = 0; i < 4; i++) words.push(alphabetWords[Math.floor(Math.random() * alphabetWords.length)]);
	return `${words.join("-")}-${randomBytes(2).toString("hex")}`;
}

const password = process.argv[2] || randomPassphrase();
const recoveryCount = Number.parseInt(process.argv[3] || "8", 10);

const totpSecret = toBase32(randomBytes(20));
const sessionSecret = b64url(randomBytes(32));
const recoveryCodes = Array.from({ length: recoveryCount }, () => {
	const raw = randomBytes(5).toString("hex").toUpperCase();
	return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
});
const recoveryHashes = recoveryCodes.map((code) => hashPassword(code));

const out = {
	ADMIN_PASSWORD_HASH: hashPassword(password),
	ADMIN_TOTP_SECRET: totpSecret,
	SESSION_SECRET: sessionSecret,
	ADMIN_RECOVERY_HASHES: recoveryHashes.join(","),
};

console.log("=== 1. 管理口令（只显示这一次，请存进密码管理器）===");
console.log(password);
console.log("");
console.log("=== 2. 验证器（TOTP）===");
console.log(`密钥: ${totpSecret}`);
console.log(`当前动态码: ${totp(totpSecret)}（30 秒刷新）`);
console.log(
	`otpauth://totp/fuwari%20admin?secret=${totpSecret}&issuer=${encodeURIComponent("QWQwul Blog")}&algorithm=SHA1&digits=6&period=30`,
);
console.log("");
console.log("=== 3. 恢复码（手机丢了用；每码一次，用后请重新生成）===");
recoveryCodes.forEach((code, i) => console.log(`${String(i + 1).padStart(2, "0")}. ${code}`));
console.log("");
console.log("=== 4. 填进 Pages 环境变量（Settings → Variables and Secrets，类型选 Secret）===");
for (const [key, value] of Object.entries(out)) {
	console.log(`${key}=${value}`);
	console.log("");
}

// 自检
const first = out.ADMIN_PASSWORD_HASH.split("$");
const checkSalt = Buffer.from(first[3].replace(/-/g, "+").replace(/_/g, "/"), "base64");
const check = pbkdf2Sync(password, checkSalt, ITERATIONS, 32, "sha256");
if (!timingSafeEqual(check, Buffer.from(first[4].replace(/-/g, "+").replace(/_/g, "/"), "base64"))) {
	console.error("自检失败：口令散列无法复现");
	process.exit(1);
}
