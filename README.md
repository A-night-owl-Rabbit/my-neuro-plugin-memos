# MemOS 长期记忆插件

> 让 AI 拥有跨会话的长期记忆能力。用户无需任何操作，AI 自动记住对话历史，并能主动回忆。

**后端仓库** → [my-neuro-memos-system](https://github.com/A-night-owl-Rabbit/my-neuro-memos-system)

---

## 快速部署

### 前置要求

- [my-neuro](https://github.com/A-night-owl-Rabbit/my-neuro) 主程序已安装
- Python 3.10+（用于运行后端服务）

### 第一步：部署后端服务

请先按照 **[my-neuro-memos-system](https://github.com/A-night-owl-Rabbit/my-neuro-memos-system)** 仓库的说明完成后端部署：

```bash
git clone https://github.com/A-night-owl-Rabbit/my-neuro-memos-system.git
cd my-neuro-memos-system
pip install -r requirements.txt
# 编辑 config/memos_config.json 填入 LLM API Key
start_memos.bat
```

### 第二步：安装插件

将本仓库的所有文件放入主程序的插件目录：

```
live-2d/plugins/built-in/memos/
├── index.js
├── tools.js
├── memos-client.js
├── metadata.json
├── plugin_config.json
└── README.md
```

### 第三步：启用插件

编辑 `live-2d/plugins/enabled_plugins.json`，确保包含：

```json
{
  "plugins": [
    "built-in/memos"
  ]
}
```

### 第四步：启动

1. **先启动后端**：双击 `memos_system/start_memos.bat`，等待 "Loading model" 完成
2. **再启动主程序**：正常启动 my-neuro 即可

> 插件会自动连接 `http://127.0.0.1:8003`，无需额外配置。

---

## 配置说明

在主程序的插件配置页面可以调整以下选项：

### 基础配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 启用 MemOS | `true` | 总开关，关闭后所有记忆功能停用 |
| MemOS API 地址 | `http://127.0.0.1:8003` | 后端服务地址 |
| 自动注入记忆 | `true` | 用户说话时自动检索相关记忆注入到系统提示词 |
| 注入记忆条数 | `3` | 每次注入的最大记忆条数 |
| 相似度阈值 | `0.6` | 低于此值的记忆不注入（0~1） |
| 自动保存对话 | `true` | LLM 回复后自动累积保存对话到长期记忆 |
| 保存间隔 | `5` 轮 | 每隔多少轮对话批量保存一次 |

### 后端 LLM 配置

以下配置会在插件启动时**自动同步**到后端的 `memos_config.json`，无需手动编辑后端配置文件：

| 配置项 | 说明 |
|--------|------|
| 后端 LLM 模型 / API Key / Base URL | MemOS 后端用于总结对话、提取实体的 LLM |
| 后端备用 LLM | 主 LLM 失败时的自动切换备用模型 |
| 启用 BM25 混合检索 | 开启向量 + 关键词双路检索，提升召回率 |
| BM25 权重 | BM25 在混合检索中的占比，默认 0.3 |
| 启用知识图谱增强 | 利用实体关系图谱扩展检索结果 |
| 自动实体提取 | 添加记忆时提取人名、地点等实体到知识图谱 |
| 图片记忆 | 启用图片上传、截图保存等功能 |
| 图片自动描述 | 上传图片时自动用 LLM 生成描述文本 |

---

## 主要功能

### 自动记忆注入

用户每次说话时，插件自动从后端检索相关记忆并注入到系统提示词。AI 无需调用工具就能"回忆起"历史信息。

### 自动对话保存

LLM 回复后，插件自动将对话累积到缓存，每 N 轮批量发送到后端，由后端 LLM 总结提取后存入向量库。程序退出时会自动保存未达到间隔的缓存。

### Function Call 工具

插件提供 12 个工具，AI 可主动调用：

| 工具 | 功能 |
|------|------|
| `memos_search_memory` | 深度搜索历史记忆 |
| `memos_add_memory` | 手动添加重要信息 |
| `memos_upload_image` | 上传图片到记忆 |
| `memos_search_images` | 搜索图片记忆 |
| `memos_save_screenshot` | 截屏并保存到记忆 |
| `memos_save_image_from_file` | 从本地文件保存图片 |
| `memos_record_tool_usage` | 记录工具使用情况 |
| `memos_search_tool_usage` | 搜索工具使用记录 |
| `memos_import_url` | 导入网页内容到记忆 |
| `memos_import_document` | 导入文档（txt/pdf/md） |
| `memos_correct_memory` | 修正/补充/删除记忆 |
| `memos_get_preferences` | 查询用户偏好摘要 |

---

## 常见问题

**Q: 启动后提示 "MemOS 服务不可用"？**
A: 确保先运行了后端的 `start_memos.bat`，等待 Embedding 模型加载完成后再启动主程序。

**Q: 记忆为什么没有立即保存？**
A: 插件使用批量保存策略，默认每 5 轮对话保存一次。可在配置中调整保存间隔，或程序退出时会自动保存。

**Q: 修改了后端配置为什么没生效？**
A: 插件配置页的后端设置会在下次启动时自动同步。如果需要立即生效，请重启后端服务。

**Q: 需要哪些依赖？**
A: 本插件是 JavaScript 编写的，无需额外安装依赖。后端依赖请参考 [my-neuro-memos-system](https://github.com/A-night-owl-Rabbit/my-neuro-memos-system) 的 `requirements.txt`。

---

## 架构

```
┌──────────────────────┐     HTTP API     ┌──────────────────────────┐
│                      │ ──────────────→  │                          │
│   my-neuro 主程序     │                  │   MemOS 后端服务           │
│   + memos 插件        │ ←────────────── │   (本仓库的后端)            │
│                      │    JSON 响应      │                          │
│  · 自动注入记忆        │                  │  · Qdrant 向量数据库        │
│  · 自动保存对话        │                  │  · NetworkX 知识图谱        │
│  · 12 个 FC 工具      │                  │  · BM25 关键词检索          │
│                      │                  │  · LLM 自动总结            │
└──────────────────────┘                  └──────────────────────────┘
       前端插件                                     后端服务
     (本仓库)                            (my-neuro-memos-system)
```

---

## 相关链接

- 后端仓库：[my-neuro-memos-system](https://github.com/A-night-owl-Rabbit/my-neuro-memos-system)
- 主程序：[my-neuro](https://github.com/A-night-owl-Rabbit/my-neuro)
