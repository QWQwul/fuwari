---
title: Markdown 扩展功能
published: 2024-05-01
updated: 2024-11-29
description: '进一步了解 Fuwari 中的 Markdown 功能'
image: ''
tags: [演示, 示例, Markdown, Fuwari]
category: '示例'
draft: false 
---

## GitHub 仓库卡片
你可以添加指向 GitHub 仓库的动态卡片，页面加载时会从 GitHub API 拉取仓库信息。

::github{repo="Fabrizz/MMM-OnSpotify"}

用 `::github{repo="<owner>/<repo>"}` 代码即可创建 GitHub 仓库卡片。

```markdown
::github{repo="saicaca/fuwari"}
```

## 提示块（Admonitions）

支持以下几种提示块：`note` `tip` `important` `warning` `caution`

:::note
强调用户即使快速浏览也应当留意的信息。
:::

:::tip
帮助用户更顺利完成任务的可选信息。
:::

:::important
用户成功所需的关键信息。
:::

:::warning
需要用户立即关注、可能存在风险的重要内容。
:::

:::caution
某个操作可能带来的负面后果。
:::

### 基本语法

```markdown
:::note
强调用户即使快速浏览也应当留意的信息。
:::

:::tip
帮助用户更顺利完成任务的可选信息。
:::
```

### 自定义标题

提示块的标题可以自定义。

:::note[我的自定义标题]
这是一条带自定义标题的提示。
:::

```markdown
:::note[MY CUSTOM TITLE]
This is a note with a custom title.
:::
```

### GitHub 语法

> [!TIP]
> 也支持 [GitHub 语法](https://github.com/orgs/community/discussions/16925)。

```
> [!NOTE]
> The GitHub syntax is also supported.

> [!TIP]
> The GitHub syntax is also supported.
```

### 剧透

你可以给文字加上剧透效果，文本同样支持 **Markdown** 语法。

内容 :spoiler[被隐藏了 **嘿嘿**]！

```markdown
The content :spoiler[is hidden **ayyy**]!

```
