# 更新日志

## 2026-03-29

### 记忆注入与时间展示

- **自动注入文案**：检索到的每条记忆在写入系统提示词时，附带 **本地化的日期与时间（精确到秒）**，便于模型理解记忆发生或记录的时间顺序。
- **`memos_search_memory` 工具**：返回结果中的时间与注入格式一致（含时分秒）；支持从 `payload` 中读取 `created_at` / `timestamp`（兼容嵌套结构）。

### 说明

- 本仓库 **不包含** 任何 API Key、对话人设或私有提示词；请在本地 `plugin_config.json` 中自行填写密钥。
- 需配合 [my-neuro-memos-system](https://github.com/A-night-owl-Rabbit/my-neuro-memos-system) 后端同日的 `/search` 相关修复，图谱-only 命中记忆才能稳定返回时间字段。
