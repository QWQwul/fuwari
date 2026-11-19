// 为 public/uploads 下的图片生成响应式 WebP 变体，构建时自动补齐缺失的喵
// 用法：node scripts/optimize-images.mjs  （pnpm build 会自动先跑一次）
import { readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC_DIR = path.resolve("public/uploads");
const OUT_DIR = path.join(SRC_DIR, "opt");
const WIDTHS = [480, 800, 1200];
const EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);

async function main() {
	let names = [];
	try {
		names = await readdir(SRC_DIR);
	} catch {
		return; // 没有目录就直接跳过
	}
	await mkdir(OUT_DIR, { recursive: true });

	let made = 0;
	let skipped = 0;
	for (const name of names) {
		const ext = path.extname(name).toLowerCase();
		if (!EXTS.has(ext)) continue;
		const src = path.join(SRC_DIR, name);
		const info = await stat(src);
		if (!info.isFile()) continue;

		const base = path.basename(name, path.extname(name));
		const meta = await sharp(src).metadata();
		const srcWidth = meta.width ?? 0;

		for (const w of WIDTHS) {
			if (srcWidth && srcWidth <= w && ext === ".webp") {
				skipped++;
				continue; // 原图比目标还小，不用生成
			}
			const out = path.join(OUT_DIR, `${base}-${w}.webp`);
			try {
				const outInfo = await stat(out);
				if (outInfo.mtimeMs >= info.mtimeMs) {
					skipped++;
					continue;
				}
			} catch {
				// 不存在，需要生成
			}
			await sharp(src)
				.resize({ width: w, withoutEnlargement: true })
				.webp({ quality: 78, effort: 4 })
				.toFile(out);
			made++;
		}
	}
	if (made || skipped) {
		console.log(`[images] 生成 ${made} 个 WebP 变体，跳过 ${skipped} 个已最新`);
	}
}

main().catch((err) => {
	console.error("[images] 优化失败：", err.message);
	process.exitCode = 1;
});
