# 文件预览

资料面板里的文件对话框按扩展名挂载不同的预览组件。所有预览都读取**所选版本**的不可变 blob，因此切换版本、恢复历史版本时预览内容一致。

## 支持的类型

| 类型 | 扩展名 | 预览 |
| --- | --- | --- |
| Markdown | `.md` / `.markdown` | GFM 渲染（表格、任务列表、代码块、链接），可切换源码；HTML 经白名单清洗 |
| Excel | `.xlsx` / `.xlsm` / `.xltx` / `.xltm` | 工作表标签、冻结窗格、值/公式切换、格式化数字、合并单元格、隐藏行列、列宽拖拽、缩放、单元格选择、名称框跳转、行/列虚拟化 |
| PDF | `.pdf` | 原文（浏览器原生阅读器，版本化文件流 + HTTP Range）/ 文本（页导航、全文检索、命中高亮、无文字页提示） |
| 音频 | `.mp3` / `.wav` / `.m4a` / `.aac` / `.flac` / `.ogg` / `.opus` | 原生播放器 + 语音转写面板（状态、进度、全文、SRT、复制、下载） |
| 图片 | `.png` / `.jpg` / `.jpeg` / `.webp` / `.svg` 等 | 版本化图片流 |
| 文本 | `.txt` / `.json` / `.html` 等 | 原始文本 |

旧版 `.xls` 不解析，会显示下载入口；请在 Excel 中另存为 `.xlsx` 后再上传。

## 实现

- **Excel 解析**：`services/workbook/export_preview.py` 用 openpyxl 读取 workbook（值模式 + 公式模式），输出压缩 JSON 到 `data/doc-cache/<sha>.preview.vN.json.gz`。输出包含工作表列表、单元格值/公式/样式索引、合并区域、冻结窗格、列宽行高和隐藏状态。
- **缓存与队列**：`lib/excel-preview.mjs` 按 blob sha256 缓存解析结果，串行执行 Python 子进程，最多在内存中保留两个 workbook；同一 sha 的并发请求会合并。
- **接口**：
  - `GET /api/materials/:id/versions/:v/workbook`：工作簿 manifest（表结构、样式表、统计）。
  - `GET /api/materials/:id/versions/:v/workbook/sheets/:sheet`：单表数据。
  - `GET /api/materials/:id/versions/:v/file`：版本化原文件，支持 `Range` 与 `download=1`。
- **前端**：`app.js` 的 `mountMarkdown` / `mountExcel` / `mountPdf`，以及 `renderXlsxGrid` 行/列双向虚拟化。Excel 预览的样式表会编译成 `.xst-*` CSS 类，避免每个单元格写内联样式。
- **PDF 解析**：`services/pdf/parse_pdf.py` 用 pdfplumber 提取页文本、段落和章节（pypdf 补元数据/书签并兜底），按 blob sha 缓存到 `data/doc-cache/pdf/<sha>.json.gz`；同一份解析结果同时供 `pdf_read` 工具和「文本」视图使用，详见 [pdf-reading.md](pdf-reading.md)。
- **PDF 接口**：`GET /api/materials/:id/pdf`（结构）、`GET /api/materials/:id/versions/:v/pdf?page=2-3|query=…`（正文/检索）、`POST /api/materials/:id/pdf/search`。
- **音频 / ASR**：`app.js` 的 `mountAudio` 用版本化文件流播放原音频；`GET /api/materials/:id/versions/:v/asr` 读取该版本的转写状态与全文，`…/asr/content?format=txt|srt` 下载。状态由服务端 `lib/asr-status.mjs` 统一，SSE 更新时只刷新文本面板，不重建 audio 元素，避免播放中断。详见 [asr.md](asr.md)。
- **Markdown**：`marked` 在浏览器中按需从 `/vendor/marked.umd.js` 加载，渲染结果再经过 DOM 白名单清洗；相对路径图片会解析到工作空间文件接口。

## 已知边界

- 预览是只读的，不重新计算公式；公式单元格显示 Excel 保存的缓存值。
- 图表、图片、批注、条件格式的计算结果不渲染。
- 冻结窗格超过 8 行或 8 列时，该方向按普通视图显示（避免财务模型中异常宽的冻结区域遮住整屏），并在预览顶部提示。
- 单表最多解析 4000 行 × 320 列；超出时提示已截断。
- PDF 的翻页/缩放/打印使用浏览器原生 PDF 阅读器。
- PDF「文本」视图只展示有文本层的页面；扫描页会标注「需要 OCR」，不在预览里做识别。

## 运行要求

- Node.js 24+（项目使用 `node:sqlite`）。
- Python 3 + `openpyxl`（与 `workbook_query` 共用）、`pdfplumber` + `pypdf`（PDF 文本；`reportlab` 仅测试 fixture 需要）。
- 音频转写需要 `.env.local` 的 `ASR_API_KEY`；没有密钥时音频仍可播放，面板会提示配置。`npm run test:asr` 可离线验证完整流程。
- 修改 `server.mjs` 后需要重启 `npm start`；只改 `app.js` / `styles.css` 刷新页面即可。
