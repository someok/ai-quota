# 服务采集方式调查

调查结论以官方接口优先；官方未公开的订阅额度接口则使用当前客户端或控制台实际采用的
只读接口。后者可能变化，因此解析器会在字段结构变化时直接报告不兼容，不静默回退。

| 服务 | 最优方式 | 认证 | 只读来源 |
| --- | --- | --- | --- |
| DeepSeek | 官方 API | API Key | `GET https://api.deepseek.com/user/balance` |
| Codex | ChatGPT/Codex 用量 API | 独立 OAuth | `GET https://chatgpt.com/backend-api/wham/usage` |
| OpenCode Go | 控制台 JSON 接口 | 工作区编号 + 完整 Cookie | `GET https://opencode.ai/console/api/go/status` |
| Kimi Code | 用量 API | API Key | `GET https://api.kimi.com/coding/v1/usages` |
| xAI SuperGrok | 订阅额度 API | OAuth | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` |
| xAI API Platform | 官方 Management API | Management Key + Team ID | 余额、月限额、历史用量三个接口 |
| Xiaomi MiMo | 控制台 JSON 接口 | 完整 Cookie | 套餐用量、套餐详情、余额三个接口 |

## 主要证据

- [DeepSeek 官方余额接口](https://api-docs.deepseek.com/api/get-user-balance/)明确提供
  `/user/balance` 及余额字段。
- [xAI 官方 Management API](https://docs.x.ai/developers/rest-api-reference/management)要求
  Management Key；[Billing Management](https://docs.x.ai/developers/rest-api-reference/management/billing)
  公开了 `prepaid/balance`、`postpaid/spending-limits` 和 `usage`。
- Codex 设备码、浏览器 OAuth 和刷新行为依据
  [OpenAI Codex 源码](https://github.com/openai/codex/tree/main/codex-rs/login/src)；用量接口响应、
  Kimi、SuperGrok 和 MiMo 的当前解析形态参考
  [`slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota)。
- OpenCode Go 依据 2026-10-09 浏览器实测确认：`/console/api/go/status` 需要 `x-org-id` 请求头
  （控制台 URL 中的工作区编号）以及包含 `__Host-console_session` 的控制台 Cookie；缺 `x-org-id`
  返回 400 `org_required`，缺会话返回 401，工作区不匹配返回 404。读取 `access.meters` 中的
  `fiveHour`、`week`、`month`，以 `usedMicroCents / limitMicroCents` 计算使用率；`resetsAt`
  为 `null` 时不显示重置时间，不依赖页面 HTML。主站 `auth` Cookie 对接口无效。
- xAI SuperGrok 的设备码、浏览器回调与令牌刷新协议依据
  [OpenCode xAI 客户端实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/xai.ts)。

## 稳定性边界

DeepSeek 与 xAI Management 属于公开官方接口。其余订阅或控制台接口没有相同的公开稳定性
承诺；本工具只实现表中的单一路径，响应缺字段、返回登录页或出现无法识别的 HTML 时会明确
失败。所有调用都只读取用量、额度或余额，不调用模型推理接口。
