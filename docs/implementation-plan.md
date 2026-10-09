# `@someok/ai-quota` 实施计划

## 执行顺序

1. 创建 `docs/implementation-plan.md`，写入本计划全文。
2. 初始化 TypeScript、ESM、Node.js 22、pnpm 工程及测试框架。
3. 完成配置、账号管理、缓存、请求协调和终端渲染。
4. 逐一实现并验证全部服务采集器。
5. 使用脱敏样本运行离线测试，再使用授权凭据进行只读集成测试。
6. 完成构建、包内容和安全检查。

## 核心实现

- 发布包名为 `@someok/ai-quota`，可执行命令为 `ai-quota`，许可证为 MIT。
- 使用 Commander、Zod、`jsonc-parser`、Picocolors、原生 `fetch` 和 Vitest。
- 默认配置为 `~/.config/ai-quota/config.jsonc`；路径优先级为 `--config`、`AI_QUOTA_CONFIG`、默认路径。
- 配置包含 `version: 1` 和扁平 `accounts` 数组。公共字段为 `id`、`provider`、可选 `label`、`enabled`，认证字段按服务使用判别联合校验。
- 配置采用保留注释的原子写入并设置 `0600` 权限；迁移前备份和确认；OAuth 刷新后安全写回，发现并发修改时拒绝覆盖。
- 内部 `ProviderAdapter.collect(account, context)` 返回公共状态封装和服务专属数据；不强制统一不同服务的用量字段。
- 首版只使用内置采集器，不开放外部插件或运行时回退。

## 查询与缓存

- 最多并发查询四个账号，哪个账号先完成就先输出完整区块。
- 单次请求事务超时十秒；仅对网络中断、`429` 和 `5xx` 重试两次。
- 一分钟内复用成功缓存，`--refresh` 强制刷新。
- 缓存保存到 `~/.cache/ai-quota/results.json`，权限为 `0600`，不保存凭据。
- 实时失败时可展示最后成功结果并标记过期，但仍计为失败。
- 退出码：全部成功 `0`；配置、参数错误或全部失败 `1`；部分失败 `2`。

## 服务采集器

- `deepseek`：官方余额接口。
- `codex`：账号独立 OAuth 凭据，直接查询 ChatGPT/Codex 用量接口。
- `opencode-go`：使用工作区编号（`x-org-id`）与包含控制台会话的完整 Cookie 请求
  `/console/api/go/status`，解析五小时、周、月额度。
- `kimi-code`：接口密钥调用 `/coding/v1/usages`。
- `xai-supergrok`：OAuth 令牌查询订阅额度。
- `xai-api-platform`：管理密钥与团队编号查询官方余额、用量和月限额。
- `xiaomi-mimo`：Cookie 并发查询套餐用量、套餐详情和余额三个控制台接口。
- 每种账号仅实现当前最优采集方式；接口变化时明确报告结构不兼容。

## 命令接口

- `ai-quota [provider]`：查询全部或指定服务。
- `ai-quota --account <id>`：查询指定账号；与服务参数同时使用时取交集。
- `ai-quota list`：本地列出所有账号及脱敏状态。
- `ai-quota status [--account <id>]`：绕过缓存执行只读验证。
- `ai-quota account add/edit/remove/enable/disable`：交互式管理账号。
- OAuth 优先设备码，不支持时使用浏览器回调；Cookie 仅支持手工粘贴。
- 支持 `--config`、`--refresh`、`--verbose`，不实现 `--json`、凭据导入、浏览器 Cookie 读取、自更新和持久日志。
- 终端按本机时区显示绝对与相对时间，支持颜色并遵守 `NO_COLOR`。

## 测试与验收

- 离线测试覆盖配置、迁移、权限、脱敏、超时、重试、缓存、并发完成顺序、退出码和所有响应解析器。
- 每个采集器覆盖成功、认证失败、限流、服务端错误、结构变化、字段缺失和超大响应。
- 本机只读集成测试可使用：
  - `/Users/wjx/.config/opencode/opencode-quota/opencode-go.json`
  - `/Users/wjx/.local/share/opencode/auth.json`
- 不修改凭据文件、不发起模型推理、不输出秘密、不保存未脱敏响应；持续集成保持离线。
- 全部账号类型完成添加、查询、验证和管理，且类型检查、测试、构建、包内容及安全检查全部通过后，发布 `1.0.0`；此前使用 `0.x`。
