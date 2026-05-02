# Pi Superpowers Local Extension

This project-local extension adds `/superpowers` and extra model providers to Pi.

## Usage

Start Pi in this repository and run:

```powershell
/reload
/superpowers
/plan design a feature
/build execute the current plan
/sysiphus finish this task completely
/promethus design the architecture
/superpowers plan build a feature
/superpowers build execute the current plan
/superpowers sisyphus fix this bug
/superpowers prometheus design the architecture
```

Press `PageUp` in Pi to cycle the active Superpowers mode shown in the footer: `superpowers`, `plan`, `build`, `sisyphus`, `prometheus`.

Normal prompts are automatically wrapped with the active mode. Slash commands and bash commands are not wrapped.

Oh My OpenAgent-inspired modes are available as direct commands: `/sisyphus`, `/sysiphus`, `/prometheus`, `/promethus`, `/hephaestus`, `/atlas`, `/oracle`, `/ultrawork`.

## Login Providers

Run:

```powershell
/login
```

API-key providers available with this setup:

- `qwen-china` via `DASHSCOPE_API_KEY`
- `deepseek-china` via `DEEPSEEK_API_KEY`
- `moonshot-china` via `MOONSHOT_API_KEY`
- `zhipu-china` via `ZHIPU_API_KEY`
- `baichuan-china` via `BAICHUAN_API_KEY`
- `opencode-go` via `OPENCODE_API_KEY` (built into Pi)
- `windsurf` via `WINDSURF_API_KEY` or OAuth
- `google-antigravity` via Google OAuth browser login

The Windsurf provider includes the current self-serve models from the Windsurf models documentation, including `adaptive`, Claude Opus/Sonnet 4.6/4.7 thinking variants, GPT-5.3-Codex Medium, GPT-5.4 Low Thinking, Kimi K2.5, SWE-1.6, and SWE-1.6 Fast.

Antigravity appears in `/login` as `Antigravity (Google)`. Choose it to open Google sign-in in your browser. After login, Pi stores the OAuth token and project id for the `google-antigravity` provider.

## OpenCode Go API

Pi already includes OpenCode Go with the official OpenAI-compatible endpoint:

```text
https://opencode.ai/zen/go/v1
```

Setup:

```powershell
$env:OPENCODE_API_KEY="your-opencode-go-api-key"
```

Then run:

```powershell
/login
/model opencode-go/kimi-k2.6
```

## Windsurf Login

Windsurf does not publish a direct OpenAI-compatible LLM endpoint. This extension uses a local WindsurfAPI-compatible proxy:

```text
http://127.0.0.1:3003/v1
```

Start the proxy before using Windsurf models. `/login` still accepts and saves the Windsurf token if the proxy is not running, then retries proxy registration when the token is refreshed. `/login` for Windsurf opens:

```text
https://windsurf.com/show-auth-token
```

Copy the temporary authentication token from that page and paste it into Pi. If the proxy is running, Pi registers the token with:

```text
http://127.0.0.1:3003/auth/login
```

Optional proxy settings:

```powershell
$env:WINDSURF_BASE_URL="http://127.0.0.1:3003/v1"
$env:WINDSURF_PROXY_URL="http://127.0.0.1:3003"
$env:WINDSURF_PROXY_API_KEY="your-proxy-api-key-if-configured"
```

If you have official Windsurf OAuth endpoints, you can configure the full browser redirect flow with environment variables.

Required for full OAuth:

```powershell
$env:WINDSURF_AUTH_URL="https://example.com/oauth/authorize"
$env:WINDSURF_TOKEN_URL="https://example.com/oauth/token"
$env:WINDSURF_CLIENT_ID="your-client-id"
```

Optional:

```powershell
$env:WINDSURF_CLIENT_SECRET="your-client-secret"
$env:WINDSURF_REDIRECT_URI="http://localhost:1455/oauth/callback"
$env:WINDSURF_SCOPE="openid profile email"
$env:WINDSURF_MODEL_IDS="windsurf-cascade,another-model"
```

Then run `/login`, choose subscription login, select `Windsurf`, open the browser URL, finish login, and paste the final redirect URL or authorization code.
