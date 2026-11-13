#!/usr/bin/env node
/**
 * 备用发布通道：不经过后台、不经过 Pages Functions，直接用 PAT 调 GitHub API
 * 提交一个文件到仓库。后台或网关出故障时用它兜底。
 *
 *   GITHUB_TOKEN=github_pat_xxx node scripts/publish.mjs \
 *     --file src/content/posts/hello.md --message "docs: 新增「hello」"
 *
 * 也可用 --content "..." 直接给正文，或 --delete 删除远端文件。
 * 令牌只需要 QWQwul/fuwari 的 Contents: Read and write。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const OWNER = "QWQwul";
const REPO = "fuwari";
const BRANCH = "main";
const API = "https://api.github.com";

function parseArgs(argv) {
	const out = { file: "", message: "", content: "", delete: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--file") out.file = argv[++i] ?? "";
		else if (arg === "--message" || arg === "-m") out.message = argv[++i] ?? "";
		else if (arg === "--content") out.content = argv[++i] ?? "";
		else if (arg === "--delete") out.delete = true;
		else if (arg === "--dry-run") out.dryRun = true;
		else if (arg === "--help" || arg === "-h") out.help = true;
		else throw new Error(`未知参数：${arg}`);
	}
	return out;
}

function usage() {
	console.log(`用法：
  GITHUB_TOKEN=... node scripts/publish.mjs --file <仓库内路径> --message "<提交说明>" [--content "<正文>"] [--dry-run]
  GITHUB_TOKEN=... node scripts/publish.mjs --delete --file <仓库内路径> --message "<提交说明>"`);
}

function requireToken() {
	const token = process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN;
	if (!token) {
		console.error("缺少 GITHUB_TOKEN 环境变量（细粒度 PAT，Contents: Read and write）。");
		process.exit(1);
	}
	return token;
}

async function api(token, path, init = {}) {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"user-agent": "fuwari-publish-script",
			"x-github-api-version": "2022-11-28",
			...(init.headers ?? {}),
		},
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	let data = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = null;
	}
	return { status: res.status, data, text };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) return usage();
	if (!args.file) throw new Error("缺少 --file");
	if (!args.message) throw new Error("缺少 --message");
	const repoPath = args.file.replace(/^\/+/, "").replace(/^\.\//, "");
	const encoded = repoPath.split("/").map(encodeURIComponent).join("/");

	const token = requireToken();
	const remote = await api(token, `/repos/${OWNER}/${REPO}/contents/${encoded}?ref=${BRANCH}`);
	const isFile = remote.status === 200 && remote.data?.type === "file";
	if (remote.status !== 200 && remote.status !== 404) {
		console.error(`读取远端失败：HTTP ${remote.status} ${remote.text.slice(0, 300)}`);
		process.exit(1);
	}

	if (args.delete) {
		if (!isFile) {
			console.log("远端没有这个文件，无需删除。");
			return;
		}
		const res = await api(token, `/repos/${OWNER}/${REPO}/contents/${encoded}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: args.message, sha: remote.data.sha, branch: BRANCH }),
		});
		if (res.status >= 300) {
			console.error(`删除失败：HTTP ${res.status} ${res.text.slice(0, 300)}`);
			process.exit(1);
		}
		console.log(`已删除 ${repoPath}（commit ${res.data?.commit?.sha?.slice(0, 7)}）`);
		return;
	}

	let body = args.content;
	if (!body) {
		const local = resolve(process.cwd(), repoPath);
		if (!existsSync(local)) throw new Error(`本地文件不存在：${local}`);
		body = readFileSync(local, "utf8");
	}
	const payload = Buffer.from(body, "utf8").toString("base64");

	const summary = `${args.message}${isFile ? "" : "（新增）"}`;
	if (args.dryRun) {
		console.log(`[dry-run] 将写入 ${repoPath}，${Buffer.byteLength(body, "utf8")} 字节，说明：${summary}`);
		return;
	}

	const res = await api(token, `/repos/${OWNER}/${REPO}/contents/${encoded}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			message: summary,
			content: payload,
			branch: BRANCH,
			...(isFile ? { sha: remote.data.sha } : {}),
		}),
	});
	if (res.status >= 300) {
		console.error(`提交失败：HTTP ${res.status} ${res.text.slice(0, 400)}`);
		process.exit(1);
	}
	console.log(`已提交 ${repoPath}（commit ${res.data?.commit?.sha?.slice(0, 7)}）`);
	console.log("GitHub 会在 1～2 分钟后触发 Cloudflare Pages 自动部署。");
}

main().catch((error) => {
	console.error(error?.message || error);
	process.exit(1);
});
