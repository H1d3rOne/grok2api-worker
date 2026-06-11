# grok2api-worker

Cloudflare Worker 版 Grok API 转换服务，提供 OpenAI / Anthropic 兼容接口和一个简单管理页。

## 支持接口

- `GET /admin`：管理页，可聊天、选择模型、管理下游 API Keys 和 Grok Token 池
- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`，兼容别名：`POST /v1/response`
- `POST /v1/messages`
- `POST /v1/images/generations`

默认都是非流式；需要流式时在请求体里传：

```json
{"stream": true}
```

## 本地运行

```bash
npm install
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars`：

```ini
ADMIN_PASSWORD=admin-change-me
API_KEY=change-me
GROK_TOKENS=your-sso-token
```

启动：

```bash
npm run dev
```

打开管理页：

```txt
http://127.0.0.1:8787/admin
```

如果本地访问上游需要代理：

```bash
npm run dev:proxy
```

## 部署到 Cloudflare Worker

1. 登录 Cloudflare：

```bash
npx wrangler login
```

2. 创建 KV，用于保存管理页新增的 API Keys 和 Token 池：

```bash
npm run setup:kv
```

3. 设置密钥：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put API_KEY
npx wrangler secret put GROK_TOKENS
```

4. 部署：

```bash
npm run deploy
```

## 常用配置

敏感信息不要写进 `wrangler.toml`，请用 `wrangler secret put`。

- `ADMIN_PASSWORD`：管理页登录密码，必须单独设置，不会使用 `API_KEY` 兜底
- `API_KEY`：下游调用 `/v1/*` 的 Bearer key；也可以在管理页新增 API Key（保存到 KV）
- `GROK_TOKENS`：Grok SSO token，支持多个，逗号或换行分隔
- `GROK_BASIC_TOKENS` / `GROK_SUPER_TOKENS` / `GROK_HEAVY_TOKENS`：分层 Token 池
- `TOKEN_STORE`：KV binding，管理页新增的 API Keys 和 Token 池需要它
- `USE_CONSOLE_UPSTREAM`：是否直连 Console 上游，默认 `false`
- `ENABLE_APP_CHAT_MODELS`：是否启用 app-chat 路径模型，默认 `true`
- `USE_VPC_EGRESS`：是否使用 Cloudflare VPC/Gateway 出站，默认 `false`

## 调用示例

```bash
curl "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.3",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

```bash
curl "$BASE/v1/responses" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.3",
    "input": "你好"
  }'
```

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

## 注意

不要提交以下文件或内容：

- `.dev.vars`
- `.wrangler/`
- 真实管理密码 / API key
- 真实 SSO token
- Cloudflare account id / KV namespace id
