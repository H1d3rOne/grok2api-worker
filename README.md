# grok2api-worker

Cloudflare Worker 版 Grok API 转换服务，提供 OpenAI / Anthropic 兼容入口，并内置一个轻量 Web 管理页。

> 本仓库不包含任何真实 token、API key、Cloudflare 账号 ID 或本地部署信息。请通过 Wrangler secrets 或管理页自行配置。

## 功能

- `GET /admin`：Web 管理页，支持模型选择聊天、Token 池管理、Token 文件导入。
- `GET /health`：运行状态、可用模型数量、Token 池统计。
- `GET /v1/models`、`GET /v1/models/{model}`。
- `POST /v1/chat/completions`：OpenAI Chat Completions 兼容。
- `POST /v1/responses`、`POST /v1/response`：OpenAI Responses 兼容。
- `POST /v1/messages`：Anthropic Messages 兼容。
- `POST /v1/images/generations`：图片生成兼容入口，目前主要支持 `grok-imagine-image-lite`。
- Token 池：
  - 支持 `generic/basic/super/heavy` 分层。
  - 支持多 token 轮询。
  - 上游返回 401/403 时自动记录错误、禁用失效 token，并切换到下一个可用 token。
  - 管理页和 API 只返回脱敏 token。

三个文本接口默认都是**非流式**；只有请求体显式传 `{"stream": true}` 时才返回 SSE。

## 快速开始：本地运行

```bash
git clone https://github.com/<your-name>/grok2api-worker.git
cd grok2api-worker
npm install
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```ini
API_KEY=change-me
GROK_TOKENS=your-sso-token
```

启动：

```bash
npm run dev
```

打开：

- 管理页：`http://127.0.0.1:8787/admin`
- 健康检查：`http://127.0.0.1:8787/health`

如果本地访问上游需要代理，可使用：

```bash
npm run dev:proxy
```

`dev:proxy` 只影响本地 `wrangler dev`，部署到 Cloudflare 后不会使用你本机的代理。

## 部署到 Cloudflare Workers

### 1. 登录 Cloudflare

```bash
npx wrangler login
```

### 2. 创建 KV 命名空间

管理页 Token 池需要 KV 持久化。推荐直接运行：

```bash
npm run setup:kv
```

脚本会创建 `TOKEN_STORE`，并把生成的 namespace id 写入 `wrangler.toml`。

也可以手动执行：

```bash
npx wrangler kv namespace create TOKEN_STORE
```

然后把输出中的 `id` 填到 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "TOKEN_STORE"
id = "your-kv-namespace-id"
```

### 3. 设置 secrets

```bash
npx wrangler secret put API_KEY
npx wrangler secret put GROK_TOKENS
```

可选：

```bash
npx wrangler secret put GROK_BASIC_TOKENS
npx wrangler secret put GROK_SUPER_TOKENS
npx wrangler secret put GROK_HEAVY_TOKENS
npx wrangler secret put CF_CLEARANCE
npx wrangler secret put CF_COOKIES
```

### 4. 部署

```bash
npm run typecheck
npm run deploy
```

## GitHub Actions 部署

仓库内置 `.github/workflows/deploy.yml`。使用前需要在 GitHub 仓库 Secrets 中配置：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Worker 运行时 secrets（如 `API_KEY`、`GROK_TOKENS`）仍建议用 Wrangler 设置：

```bash
npx wrangler secret put API_KEY
npx wrangler secret put GROK_TOKENS
```

## 调用示例

```bash
BASE="https://your-worker.your-subdomain.workers.dev"
KEY="change-me"
```

Chat Completions：

```bash
curl "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.3",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

Responses：

```bash
curl "$BASE/v1/responses" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.3",
    "input": "你好"
  }'
```

Anthropic Messages：

```bash
curl "$BASE/v1/messages" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.3",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

流式输出：

```json
{
  "stream": true
}
```

## 主要配置

配置位于 `wrangler.toml` 的 `[vars]`，敏感值必须用 Wrangler secrets。

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `API_KEY` | 空 | 下游客户端 Bearer key；不设置则不鉴权。应使用 secret。 |
| `GROK_TOKENS` | 空 | 通用 SSO token，支持 CSV、换行或 JSON 数组。应使用 secret。 |
| `GROK_BASIC_TOKENS` / `GROK_SUPER_TOKENS` / `GROK_HEAVY_TOKENS` | 空 | 分层账号池。应使用 secret。 |
| `ACCOUNT_POOL_JSON` | 空 | 账号池 JSON，例如 `{"basic":["..."],"super":["..."],"heavy":["..."]}`。 |
| `TOKEN_STORE` | 无 | KV binding，用于管理页 Token 池持久化。 |
| `THINKING` | `true` | 是否输出 reasoning 内容。 |
| `CONSOLE_WEB_SEARCH` | `true` | Console 模型是否默认注入 `web_search` 工具。 |
| `USE_CONSOLE_UPSTREAM` | `false` | `true` 时 Console 模型直连 Console Responses 上游；`false` 时走 app-chat 转换。 |
| `ENABLE_APP_CHAT_MODELS` | `true` | 是否启用 app-chat 路径模型。 |
| `USE_VPC_EGRESS` | `false` | 是否使用 Cloudflare Gateway / Workers VPC 出站。需要额外配置 `[[vpc_networks]]`。 |
| `WORKER_EXPOSE_ALL_MODELS` | `false` | 是否暴露 Worker 未完整支持的图片/视频模型。 |
| `ENABLE_CORS` | `true` | 是否启用 CORS。 |
| `ALLOWED_ORIGINS` | `*` | 允许的 CORS Origin，多个用逗号分隔。 |

## Cloudflare Gateway / VPC 出站

默认不启用。若你的账号已经配置 Workers VPC / Gateway 出站：

1. 在 `wrangler.toml` 取消 `[[vpc_networks]]` 注释并填入自己的 `network_id`。
2. 设置：

```toml
[vars]
USE_VPC_EGRESS = "true"
```

未配置 `EGRESS` binding 时不要开启，否则请求会返回配置错误。

## 隐私与发布注意事项

- 不要提交 `.dev.vars`、`.env`、`.wrangler/`、`node_modules/`。
- 不要把真实 SSO token、API key、Cloudflare namespace id、account id 写入 README 或 issue。
- `wrangler.toml` 中的 `TOKEN_STORE` id 是占位符，新部署者需要自行创建并替换。

## 开发检查

```bash
npm run typecheck
```
