# QSP 本地化工具

[English](README.md) | 简体中文

一个本地优先的工具，用于导入、翻译、校对并导出 QSP 游戏、Twine 故事、章节文档和本地化 JSON。提供命令行与浏览器界面，项目数据保存在本地文件中。

```text
源文件 -> 导入器 -> 项目译文池 -> AI 翻译 -> 人工校对 -> 导出
```

## 环境要求

- Node.js 18 或更高版本。
- AI 翻译需要一个兼容 OpenAI 接口的服务，支持 Responses API 或 Chat Completions。
- 支持的源文件：`.qsp`、`.html` 或 `.htm`（Twine 2 / SugarCube）、`.json`（原文到译文的映射）、`.md`、`.markdown` 或 `.txt`。

QSP 转换器已包含在仓库中，无需安装依赖。

## 快速开始

1. 复制 API 配置模板：

   ```powershell
   Copy-Item rule\api.example.json rule\api.json
   ```

2. 在 `rule/api.json` 中设置服务端点和模型。API 密钥可以写在该文件中，也可以通过 `OPENAI_API_KEY` 环境变量提供；`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 也支持使用环境变量。
3. 启动浏览器界面：

   ```powershell
   npm run ui
   ```

   Windows 上也可以运行 `start-ui.bat`，参数会传给界面。

4. 打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)，导入源文件，然后翻译、校对并导出。服务只监听本机，可在界面中停止，也可按 Ctrl+C。

## 支持的格式

- **QSP（`.qsp`）**：从地点、动作和代码字面量中提取可翻译文本；导出时由导入器维护格式结构。
- **Twine 2 / SugarCube（`.html`、`.htm`）**：提取段落正文及链接、按钮文字；宏、代码、注释和链接目标保持不变。
- **本地化 JSON（`.json`）**：读取以原文为键、已有译文为值的对象；导出时保持键序。
- **章节文本（`.md`、`.markdown`、`.txt`）**：按章节标题分段，导入非空段落。目录导入会按文件名顺序合并文件。

## 翻译与校对

项目条目保存在译文池中，每个批次一个文件。状态不是 `ok` 或 `manual` 的条目会提交翻译。

| 状态 | 含义 | 下次翻译 |
|---|---|---|
| `server_error` | 尚未翻译，或请求、响应未能正常完成 | 重新提交 |
| `invalid` | 已收到响应，但未通过格式校验 | 重新提交 |
| `ok` | 通过导入器的格式校验 | 跳过 |
| `manual` | 用户已应用译文 | 重新开放前跳过 |

错误按条目记录，不会清除同批次已保存的译文。要把人工修改的条目交回 AI，可在界面中重新开放，或使用 `reopen` 命令；已有文本会保留。

## 命令行

所有命令也可以通过 `node src/adapters/cli.mjs` 运行。使用 `--help` 查看当前命令列表。

```text
node src/adapters/cli.mjs projects
node src/adapters/cli.mjs import <source|directory> <name> [--importer=qsp] [--rules file] [--glossary file] [--rebuild]
node src/adapters/cli.mjs translate <name> [--from=1] [--to=20] [--limit=100] [--conc=6]
node src/adapters/cli.mjs status <name>
node src/adapters/cli.mjs find <name> <query> [--status=ok,manual] [--regex] [--limit=20]
node src/adapters/cli.mjs edit <name> <changes.json>
node src/adapters/cli.mjs reopen <name> <entry-id...>
node src/adapters/cli.mjs build <name> [-o file | --dir directory] [--name=file] [--raw]
node src/adapters/cli.mjs check <name>
node src/adapters/cli.mjs ui [--port=4173]
```

`edit` 接受数组，例如 `[{ "id": "b-0001:0001", "translation": "..." }]`，也接受以条目 ID 或原文为键、译文为值的对象。编辑后的条目标记为 `manual`。

`build` 必须指定导出位置：用 `-o` 指定文件路径，或用 `--dir` 指定目录，两者不能同时使用。通过 `--dir` 导出时，可用 `--name` 修改建议文件名。`--raw` 导出未翻译的源文件。

`--rebuild` 会先在临时目录重新导入源文件，通过校验后再替换项目。条目按 ID 或原文匹配时会保留已有译文；如果无法读取旧批次，重建会中止。

## 项目数据

- 全局 `rule/` 保存默认值。新项目会获得自己的提示词、术语表和导入规则副本。
- `rule/api.json` 保存本地 API 设置并被 Git 忽略；如其中包含凭据，不要分享该文件。
- `project/<name>/source/` 保存由导入器管理的源文件。请将其视为只读；译文应在译文池或界面中修改。
- `project/<name>/pool/` 保存原文、译文和状态。
- `project/<name>/logs/ai-requests/` 保存模型请求和响应记录，其中可能包含提示词与项目文本；分享前请先检查内容。

命令行导入时，可用 `--rules` 和 `--glossary` 指定项目配置文件。在界面中，配置会保存到当前选中项目的副本；未选项目时，提示词和术语表保存为全局默认值。

## 测试

```powershell
npm test
```

测试使用本地样例，不会调用在线模型。请使用小型人工构造数据，不要加入真实游戏、小说或项目文本。

## 许可

本仓库自有代码以 [Apache-2.0 许可证](LICENSE) 发布。内置的 QSP 转换器保留其 MIT 许可证，见 [`importers/qsp/qsp-lib/@qsp/converters/LICENSE`](importers/qsp/qsp-lib/@qsp/converters/LICENSE)。QSP 引擎是独立项目，本仓库不包含该引擎。
