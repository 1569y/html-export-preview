# HTML Export Preview

**[English](README.md) | 简体中文**

**把 Obsidian 里排好版的笔记，变成可以预览、调整和分享的 HTML 网页。**

不用编写网页代码。先看看导出效果、按需调整排版，再把笔记分享给没有安装 Obsidian 的人。

![HTML Export Preview：笔记预览、右侧排版控制与导出选项](docs/images/preview-editor.png)

*在 Obsidian 中预览网页效果、调整排版并选择导出方式。图为真实插件界面。*

## 为什么使用它？

- **尽量保留笔记原貌。** 基于已经渲染好的**阅读视图**导出，支持保留主题样式、CSS 片段、图片、Mermaid 图表、高亮和 Side Notes 等内容。
- **导出前就能调整。** 可以切换桌面、平板、手机宽度；也可以直接点选图片、Mermaid 图表和表格，调整大小与对齐方式。
- **方便分享，不改原笔记。** 支持导出**单个 HTML 文件**或**HTML + 资源文件夹**；排版调整仅作用于导出结果，不修改原始 Markdown。
- **自由选择保存位置。** 可以导出到 Vault 内外的目录，覆盖已有文件前会进行确认。

## 如何安装

**推荐：从 Obsidian 社区插件安装**

1. 在 Obsidian 中打开 **设置 → 第三方插件（Community plugins）→ 浏览（Browse）**。
2. 搜索 **HTML Export Preview**。
3. 点击安装，并启用插件。

**手动安装：** 从[最新 GitHub Release](https://github.com/1569y/html-export-preview/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`，放入笔记库的 `.obsidian/plugins/html-export-preview/` 目录，重新加载 Obsidian 后启用插件。手动更新时请保留已有的 `data.json`。

## 三步完成导出

1. 打开一篇笔记，通过命令面板搜索 **HTML Export Preview**，或点击插件侧边栏图标，打开预览。
2. 检查网页效果，并在右侧面板调整页面、图片、Mermaid 图表或表格的排版。
3. 选择**单文件 HTML**或**完整资源包**，指定保存位置并导出。

## 更新记录

| 日期（UTC） | 版本 | 更新内容 |
| --- | --- | --- |
| 2026-11-08 | **0.1.2** | 修复 Border 等主题中内嵌 SVG 样式导致 CSS 被显示为正文的问题，改善预览和单文件导出的兼容性。 |
| 2026-11-07 | **0.1.1** | 修复预览元素选中高亮的样式兼容问题，补充中英文说明。 |
| 2026-11-07 | **0.1.0** | 首次发布：支持 HTML 预览、排版调整及两种导出格式。 |

更多版本详情见 [GitHub Releases](https://github.com/1569y/html-export-preview/releases)。

## 已知限制

- **仅支持桌面端**，需要 **Obsidian 1.15.0 或更高版本**。
- 导出以**阅读视图**为基础，不等同于实时预览编辑器；部分主题效果、交互内容和跨笔记链接可能无法完整保留。
- 笔记引用远程字体或 CSS 时，**导出过程**可能需要联网；资源服务器可能获取常规请求信息。插件不会向作者上传笔记或发送使用统计。
- 插件内操作界面目前以**中文**为主。

## 问题反馈

遇到 Bug 或有功能建议？欢迎通过 [GitHub Issues](https://github.com/1569y/html-export-preview/issues) 反馈。建议说明插件版本、Obsidian 版本、使用主题和复现步骤；上传截图前请遮盖私人笔记内容。

## 开发者信息

项目采用 [MIT License](LICENSE) 开源。想从源码构建或运行测试，可以使用：

```bash
npm ci
npm run typecheck
npm test
npm run build
```

正式版本见 [GitHub Releases](https://github.com/1569y/html-export-preview/releases)。作者：[1569y](https://github.com/1569y)。
