import { defineCollection, z } from "astro:content";

/**
 * 后台（Sveltia CMS）清空可选字段时会写成空字符串 `updated: ''`，
 * 直接喂给 z.date() 会报 InvalidContentEntryDataError 让整站构建失败。
 * 这里统一把空字符串 / null 归一成 undefined 喵。
 */
const blankToUndefined = (value: unknown) =>
	value === "" || value === null || value === undefined ? undefined : value;

const postsCollection = defineCollection({
	schema: z.object({
		title: z.string(),
		published: z.date(),
		updated: z.preprocess(blankToUndefined, z.date().optional()),
		draft: z.boolean().optional().default(false),
		pinned: z.boolean().optional().default(false),
		description: z.string().optional().default(""),
		image: z.preprocess(blankToUndefined, z.string().optional().default("")),
		tags: z.array(z.string()).optional().default([]),
		category: z.string().optional().nullable().default(""),
		lang: z.string().optional().default(""),

		/* For internal use */
		prevTitle: z.string().default(""),
		prevSlug: z.string().default(""),
		nextTitle: z.string().default(""),
		nextSlug: z.string().default(""),
	}),
});
const specCollection = defineCollection({
	schema: z.object({}),
});
export const collections = {
	posts: postsCollection,
	spec: specCollection,
};
