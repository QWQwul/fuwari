import { test } from "node:test";
import assert from "node:assert/strict";
import rehypeVideoProxy, { videoIdFromUrl } from "../src/plugins/rehype-video-proxy.mjs";

const SITE = "https://yt.qwqads.dpdns.org";

const makeTree = (children) => ({ type: "root", children });

test("videoIdFromUrl：各种 YouTube 写法都能抠出 id", () => {
	assert.equal(videoIdFromUrl("https://www.youtube.com/embed/abc123"), "abc123");
	assert.equal(videoIdFromUrl("https://www.youtube.com/v/abc123"), "abc123");
	assert.equal(videoIdFromUrl("https://www.youtube.com/shorts/abc123"), "abc123");
	assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=abc123&t=10"), "abc123");
	assert.equal(videoIdFromUrl("https://youtu.be/abc123?t=10"), "abc123");
	assert.equal(videoIdFromUrl("https://www.youtube-nocookie.com/embed/abc123"), "abc123");
	assert.equal(videoIdFromUrl("https://player.vimeo.com/video/76979871"), "76979871");
	assert.equal(videoIdFromUrl("https://example.com/whatever"), null);
	assert.equal(videoIdFromUrl(""), null);
});

test("iframe 被改写成中转站地址并补上 allow", () => {
	const tree = makeTree([
		{ type: "element", tagName: "iframe", properties: { src: "https://www.youtube.com/embed/abc123" }, children: [] },
	]);
	rehypeVideoProxy({ site: SITE })(tree);
	const p = tree.children[0].properties;
	assert.equal(p.src, `${SITE}/embed/abc123`);
	assert.match(p.allow, /fullscreen/);
	assert.equal(p.allowfullscreen, true);
});

test("非视频 iframe 原样保留", () => {
	const tree = makeTree([
		{ type: "element", tagName: "iframe", properties: { src: "https://example.com/map" }, children: [] },
	]);
	rehypeVideoProxy({ site: SITE })(tree);
	assert.equal(tree.children[0].properties.src, "https://example.com/map");
});

test("危险 id 不被改写", () => {
	const tree = makeTree([
		{ type: "element", tagName: "iframe", properties: { src: "https://www.youtube.com/embed/abc\"onload=alert(1)" }, children: [] },
	]);
	rehypeVideoProxy({ site: SITE })(tree);
	assert.match(tree.children[0].properties.src, /youtube\.com/);
});

test("raw 字符串里的 iframe 也会被改写", () => {
	const tree = makeTree([
		{
			type: "raw",
			value: '<iframe width="560" src="https://www.youtube.com/embed/abc123" frameborder="0"></iframe>',
		},
	]);
	rehypeVideoProxy({ site: SITE })(tree);
	assert.match(tree.children[0].value, new RegExp(`${SITE}/embed/abc123`));
});

test("video 标签自动补 controls / preload / playsinline", () => {
	const tree = makeTree([
		{ type: "element", tagName: "video", properties: { src: "https://video.qwqads.dpdns.org/a.mp4" }, children: [] },
	]);
	rehypeVideoProxy({ site: SITE })(tree);
	const p = tree.children[0].properties;
	assert.equal(p.controls, true);
	assert.equal(p.preload, "metadata");
	assert.equal(p.playsInline, true);
});
