# st-plot-director

SillyTavern 自动剧情指导插件。AI 对话完成后，自动调用独立 LLM 分析上下文并生成"剧情指导"，以用户消息形式发送给当前 AI，驱动下一轮对话。

## 功能

- **自动循环**：设定轮数后，AI 回复 -> 生成剧情指导 -> 发送 -> AI 回复，全自动循环
- **双运行模式**：全自动模式一键挂机；预览确认模式可逐条审阅、编辑或跳过
- **独立 LLM 调用**：剧情指导由单独的 LLM 生成，不干扰酒馆当前连接的 AI
- **双连接方式**：通过酒馆代理（无 CORS 问题）或直连外部 API
- **API 兼容**：支持 OpenAI 兼容格式和 Claude 原生格式
- **预设系统**：System Prompt 预设管理，支持新建、编辑、删除、导入、导出
- **剧情大纲**：可选填写剧情大纲，引导 LLM 按预定方向推进剧情
- **连接测试**：一键测试 API 连通性

## 安装

将本仓库克隆或下载到 SillyTavern 的第三方扩展目录：

```bash
cd SillyTavern/data/default-user/extensions/third-party
git clone https://github.com/ViaEasy/st-plot-director.git
```

重启 SillyTavern，在扩展面板中即可看到 **Plot Director**。

也可以在酒馆的「扩展」->「安装扩展」中直接填入仓库地址安装。

## 使用

### 基本流程

1. 在扩展面板中找到 **Plot Director** 区域
2. 配置 API 连接信息（地址、Key、模型名称），点击「Test Connection」确认连通
3. 选择或编辑 System Prompt 预设（控制剧情导演的行为风格）
4. 设定循环轮数
5. 勾选「Enable」，点击「Start」
6. 正常发送一条消息开始对话，之后插件将自动接管

### 运行模式

| 模式 | 说明 |
|------|------|
| Full Auto | 剧情指导生成后直接作为用户消息发送，无需人工干预 |
| Preview & Confirm | 每次生成后弹出预览窗口，可编辑内容后发送，或跳过本轮 |

### API 连接方式

| 方式 | 说明 | 适用场景 |
|------|------|----------|
| Via SillyTavern Proxy | 通过酒馆后端代理转发请求 | 远程 API（OpenAI、Claude 等），无 CORS 问题 |
| Direct Request | 插件直接向目标 API 发送请求 | 本地模型（Ollama、LM Studio 等）或已配置 CORS 的服务 |

### 预设管理

- 插件内置一个默认预设，首次加载时自动导入
- 支持导入酒馆原生预设格式（自动提取 `prompts` 数组中 `identifier: "main"` 的内容）
- 支持导入/导出为 JSON 文件

预设格式：

```json
{
    "name": "预设名称",
    "system_prompt": "你是一个剧情导演...",
    "temperature": 0.8,
    "max_tokens": 300,
    "model": ""
}
```

### 剧情大纲

勾选「Enable Outline」后，可在文本框中填写剧情大纲。大纲内容会作为额外的 system 消息传递给剧情导演 LLM，引导其按预定方向生成指导。

## 文件结构

```
st-plot-director/
├── manifest.json            # 扩展声明
├── index.js                 # 主入口：事件监听、循环控制、消息发送、UI 绑定
├── settings.html            # 设置面板
├── style.css                # 样式
├── presets/
│   └── default.json         # 内置默认预设
└── utils/
    ├── api.js               # LLM API 调用封装
    └── preset-manager.js    # 预设管理
```

## 配置项

| 配置 | 默认值 | 说明 |
|------|--------|------|
| Rounds | 5 | 自动循环轮数（1-100） |
| Mode | Full Auto | 全自动 / 预览确认 |
| Connection | Via SillyTavern Proxy | 代理 / 直连 |
| API Type | OpenAI Compatible | OpenAI 兼容 / Claude |
| Temperature | 0.8 | 生成温度 |
| Max Tokens | 300 | 最大生成 token 数 |
| Context Messages | 20 | 发送给剧情导演的最近对话条数 |

## 兼容性

- SillyTavern 1.12.0+
- 支持 OpenAI 兼容 API（OpenAI、DeepSeek、Ollama、LM Studio、vLLM 等）
- 支持 Claude API（Anthropic 原生格式）

## 许可证

MIT
