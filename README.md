# ai-quota

在终端统一查看多个 AI 服务账号的额度、余额和用量。

## 安装

```sh
npm install -g @someok/ai-quota
```

需要 Node.js 22 或更高版本。

## 快速开始

```sh
ai-quota account add
ai-quota
ai-quota codex
ai-quota --account codex-personal
ai-quota list
ai-quota status
```

默认配置文件为 `~/.config/ai-quota/config.jsonc`。该文件可能包含明文凭据，程序会
将权限限制为仅当前用户可读写。

配置路径的优先级是 `--config`、`AI_QUOTA_CONFIG`、默认路径。推荐通过交互命令维护：

```sh
ai-quota account add
ai-quota account edit codex-personal
ai-quota account disable work-deepseek
ai-quota account enable work-deepseek
ai-quota account remove old-account
```

`account add` 会先显示服务选择列表。Codex 和 SuperGrok 使用 OAuth 设备码登录；设备码
不可用时 Codex 自动改用本机浏览器回调。Cookie 类账号只接受手工粘贴，不读取浏览器。

配置使用带注释的 JSONC，核心结构如下（字段会随服务变化）：

```jsonc
{
  "version": 1,
  "accounts": [
    {
      "id": "deepseek-personal",
      "provider": "deepseek",
      "label": "个人账号",
      "enabled": true,
      "apiKey": "明文 API Key"
    }
  ]
}
```

可用服务标识和认证字段：

| 服务标识 | 认证字段 |
| --- | --- |
| `deepseek` | `apiKey` |
| `codex` | `accessToken`、可选 `refreshToken`、`accountId`、`expiresAt` |
| `opencode-go` | `authCookie` |
| `kimi-code` | `apiKey` |
| `xai-supergrok` | `accessToken`、可选 `refreshToken`、`expiresAt` |
| `xai-api-platform` | `managementKey`、`teamId` |
| `xiaomi-mimo` | `cookie` |

## 查询行为

程序最多同时查询四个账号，哪个先完成就先显示哪个完整区块。成功结果缓存一分钟；
`--refresh` 强制实时查询，`status` 则绕过缓存执行只读验证。实时查询失败时会显示最后一次
成功缓存并明确标记为过期，但退出状态仍是失败。

- 全部成功：退出码 `0`
- 参数、配置错误或全部失败：退出码 `1`
- 部分失败：退出码 `2`

支持 `NO_COLOR`。所有时间均按本机时区同时显示绝对时间和相对时间。不提供 `--json`。

## 网络代理

所有 OAuth、令牌刷新和额度请求都会读取标准代理环境变量，同时支持小写和大写形式：

```sh
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897
export all_proxy=socks5://127.0.0.1:7897

ai-quota account add
```

- HTTPS 请求优先使用 `https_proxy`，HTTP 请求使用 `http_proxy`。
- 只设置 `http_proxy` 时，它同时用于 HTTP 和 HTTPS。
- 未设置前两者时，`all_proxy` 可作为 HTTP、HTTPS 或 SOCKS5 代理回退。
- `no_proxy`/`NO_PROXY` 可配置不经过代理的主机，多个值使用逗号或空格分隔。
- 同名变量同时存在时，小写形式优先。

## 支持的服务

- DeepSeek 开放平台
- Codex 订阅
- OpenCode Go
- Kimi Code Plan
- xAI SuperGrok
- xAI 开发者平台
- Xiaomi MiMo

详细设计见 [`docs/implementation-plan.md`](docs/implementation-plan.md)，采集方式与稳定性依据见
[`docs/provider-research.md`](docs/provider-research.md)。

## 开发验证

```sh
pnpm install
pnpm check
pnpm test:live # 仅本机授权的只读额度接口
pnpm pack --dry-run
```

默认测试完全离线。`test:live` 不发起模型推理、不修改凭据，也不保存服务端原始响应。
