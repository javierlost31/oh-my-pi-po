import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
};

type OAuthLoginCallbacks = {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
};

type ProviderModelConfig = {
	id: string;
	name: string;
	api?: string;
	baseUrl?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: unknown;
};

type ProviderConfig = {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	models?: ProviderModelConfig[];
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey(credentials: OAuthCredentials): string;
		modifyModels?(models: unknown[], credentials: OAuthCredentials): unknown[];
	};
};

type InputEvent = {
	type: "input";
	text: string;
	images?: unknown[];
	source: "interactive" | "rpc" | "extension";
};

type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: unknown[] }
	| { action: "handled" };

type ExtensionUI = {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text?: string): void;
};

type ExtensionContext = {
	ui: ExtensionUI;
	isIdle(): boolean;
};

type ExtensionCommandContext = {
	ui: ExtensionUI;
	isIdle(): boolean;
};

type ExtensionAPI = {
	registerProvider(name: string, config: ProviderConfig): void;
	on(event: "resources_discover", handler: () => { skillPaths?: string[] }): void;
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void): void;
	on(event: "input", handler: (event: InputEvent, ctx: ExtensionContext) => InputEventResult): void;
	registerShortcut(
		shortcut: string,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (
				argumentPrefix: string,
			) => Array<{ value: string; label?: string; description?: string }> | null;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		},
	): void;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
};

const extensionDir = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(extensionDir, "skills");

const superpowerModes = {
	superpowers: {
		label: "superpowers",
		description: "Use the Superpowers framework to select the right workflow before acting.",
		skills: ["superpowers-using-superpowers"],
	},
	plan: {
		label: "plan",
		description: "Prometheus-style planning: ask clarifying questions, identify ambiguity, and produce a decision trail.",
		skills: ["superpowers-brainstorming", "superpowers-writing-plans"],
	},
	build: {
		label: "build",
		description: "Atlas-style execution: run an approved plan, verify completion, and accumulate learnings.",
		skills: ["superpowers-executing-plans", "superpowers-test-driven-development", "superpowers-requesting-code-review"],
	},
	sisyphus: {
		label: "sisyphus",
		description: "Oh My OpenAgent discipline mode: orchestrate aggressively and keep working until the task is done.",
		skills: ["superpowers-systematic-debugging", "superpowers-test-driven-development", "superpowers-requesting-code-review"],
	},
	prometheus: {
		label: "prometheus",
		description: "Oh My OpenAgent strategic planner: interview, clarify scope, and produce a precise plan before code.",
		skills: ["superpowers-using-superpowers", "superpowers-brainstorming", "superpowers-writing-plans"],
	},
	hephaestus: {
		label: "hephaestus",
		description: "Oh My OpenAgent craftsman mode: autonomous deep implementation for complex engineering tasks.",
		skills: ["superpowers-executing-plans", "superpowers-systematic-debugging", "superpowers-requesting-code-review"],
	},
	atlas: {
		label: "atlas",
		description: "Oh My OpenAgent conductor mode: distribute plan steps, track progress, and verify independently.",
		skills: ["superpowers-executing-plans", "superpowers-requesting-code-review"],
	},
	oracle: {
		label: "oracle",
		description: "Oh My OpenAgent consultant mode: read-only architecture, debugging, and tradeoff analysis.",
		skills: ["superpowers-brainstorming", "superpowers-systematic-debugging"],
	},
	ultrawork: {
		label: "ultrawork",
		description: "Oh My OpenAgent automatic mode: explore, implement, verify, and continue without hand-holding.",
		skills: ["superpowers-using-superpowers", "superpowers-executing-plans", "superpowers-systematic-debugging"],
	},
	debug: {
		label: "debug",
		description: "Use systematic debugging and verification before changing code.",
		skills: ["superpowers-systematic-debugging"],
	},
	review: {
		label: "review",
		description: "Review implementation against the plan and code quality requirements.",
		skills: ["superpowers-requesting-code-review"],
	},
	tdd: {
		label: "tdd",
		description: "Use red-green-refactor test-driven development.",
		skills: ["superpowers-test-driven-development"],
	},
} as const;

type SuperpowerMode = keyof typeof superpowerModes;

const aliases: Record<string, SuperpowerMode> = {
	superpowers: "superpowers",
	plan: "plan",
	build: "build",
	sisyphus: "sisyphus",
	sysiphus: "sisyphus",
	prometheus: "prometheus",
	promethus: "prometheus",
	hephaestus: "hephaestus",
	atlas: "atlas",
	oracle: "oracle",
	ultrawork: "ultrawork",
	ulw: "ultrawork",
	debug: "debug",
	review: "review",
	tdd: "tdd",
};

const modeCycle: SuperpowerMode[] = ["superpowers", "plan", "build", "sisyphus", "prometheus"];
let activeMode: SuperpowerMode = "superpowers";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function model(id: string, name: string, contextWindow = 128000, maxTokens = 8192, reasoning = false) {
	return {
		id,
		name,
		reasoning,
		input: ["text"] as ("text" | "image")[],
		cost: zeroCost,
		contextWindow,
		maxTokens,
	};
}

function multimodalModel(id: string, name: string, contextWindow = 128000, maxTokens = 8192, reasoning = false) {
	return {
		id,
		name,
		reasoning,
		input: ["text", "image"] as ("text" | "image")[],
		cost: zeroCost,
		contextWindow,
		maxTokens,
	};
}

function env(name: string, fallback?: string): string {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : (fallback ?? "");
}

function envList(name: string, fallback: string[]): string[] {
	const value = process.env[name];
	if (!value || !value.trim()) return fallback;
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function superpowersCycleShortcut(): string {
	return env("PI_SUPERPOWERS_CYCLE_SHORTCUT");
}

function windsurfBaseUrl(): string {
	return env("WINDSURF_BASE_URL", "http://127.0.0.1:3003/v1").replace(/\/+$/, "");
}

function windsurfProxyRoot(): string {
	return env("WINDSURF_PROXY_URL", windsurfBaseUrl().replace(/\/v1$/i, "")).replace(/\/+$/, "");
}

function nineRouterBaseUrl(): string {
	const explicit = env("NINE_ROUTER_BASE_URL", env("ROUTER9_BASE_URL"));
	if (explicit) return explicit.replace(/\/+$/, "");
	const deployment = env("NINE_ROUTER_DEPLOYMENT", "local").toLowerCase();
	if (deployment === "sumopod") {
		return env("NINE_ROUTER_SUMOPOD_BASE_URL", "https://sumopod.com/v1").replace(/\/+$/, "");
	}
	if (deployment === "ubuntu" || deployment === "wsl") {
		return env("NINE_ROUTER_UBUNTU_BASE_URL", env("NINE_ROUTER_WSL_BASE_URL", "http://localhost:20128/v1")).replace(/\/+$/, "");
	}
	return env("NINE_ROUTER_LOCAL_BASE_URL", "http://127.0.0.1:20128/v1").replace(/\/+$/, "");
}

function normalize9RouterBaseUrl(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) return nineRouterBaseUrl();
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function get9RouterDetectedModels(credentials: OAuthCredentials): Array<{ id: string; name?: string }> {
	const models = credentials.models;
	if (!Array.isArray(models)) return [];
	const detected: Array<{ id: string; name?: string }> = [];
	for (const entry of models) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const item: { id: string; name?: string } = { id: entry.id };
		if (typeof entry.name === "string") item.name = entry.name;
		detected.push(item);
	}
	return detected;
}

function infer9RouterModelConfig(id: string, name?: string): ProviderModelConfig {
	const lowerId = id.toLowerCase();
	const contextWindow = lowerId.includes("gemini") ? 1048576 : lowerId.includes("mini") ? 1000000 : lowerId.includes("gpt") ? 400000 : lowerId.includes("kimi") ? 256000 : 200000;
	const maxTokens = lowerId.includes("gpt") ? 128000 : lowerId.includes("gemini") || lowerId.includes("mini") ? 65536 : 64000;
	const reasoning =
		lowerId.includes("thinking") ||
		lowerId.includes("reason") ||
		lowerId.includes("opus") ||
		lowerId.includes("sonnet") ||
		lowerId.includes("gpt") ||
		lowerId.includes("glm") ||
		lowerId.includes("deepseek") ||
		lowerId.includes("qwen");
	return model(id, name ?? id, contextWindow, maxTokens, reasoning);
}

function apply9RouterDetectedModels(models: unknown[], credentials: OAuthCredentials): unknown[] {
	const detected = get9RouterDetectedModels(credentials);
	const template = models.find((entry) => isRecord(entry) && entry.provider === "9router");
	if (!isRecord(template)) return models;
	const baseUrl = typeof credentials.baseUrl === "string" ? credentials.baseUrl : nineRouterBaseUrl();
	if (detected.length === 0) {
		return models.map((entry) => (isRecord(entry) && entry.provider === "9router" ? { ...entry, baseUrl } : entry));
	}
	const dynamicModels = detected.map((entry) => {
		const config = infer9RouterModelConfig(entry.id, entry.name);
		return {
			...template,
			id: config.id,
			name: config.name,
			baseUrl,
			reasoning: config.reasoning,
			input: config.input,
			cost: config.cost,
			contextWindow: config.contextWindow,
			maxTokens: config.maxTokens,
		};
	});
	return [...models.filter((entry) => !(isRecord(entry) && entry.provider === "9router")), ...dynamicModels];
}

async function fetch9RouterModels(apiKey: string, baseUrl = nineRouterBaseUrl()): Promise<Array<{ id: string; name?: string }>> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 10000);
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`9Router model detection failed: ${response.status} ${text}`);
		const data: unknown = JSON.parse(text);
		const rawModels = isRecord(data) && Array.isArray(data.data) ? data.data : [];
		const models = rawModels
			.map((entry) => {
				if (!isRecord(entry) || typeof entry.id !== "string") return undefined;
				return {
					id: entry.id,
					name: typeof entry.name === "string" ? entry.name : entry.id,
				};
			})
			.filter((entry): entry is { id: string; name: string } => !!entry);
		const seen = new Set<string>();
		const uniqueModels = models.filter((entry) => {
			if (seen.has(entry.id)) return false;
			seen.add(entry.id);
			return true;
		});
		if (uniqueModels.length === 0) throw new Error("9Router did not return any models from /v1/models.");
		return uniqueModels;
	} finally {
		clearTimeout(timeout);
	}
}

async function login9Router(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onAuth({
		url: nineRouterBaseUrl().replace(/\/v1$/i, ""),
		instructions: "Open the 9Router dashboard for local, Ubuntu/WSL, or Sumopod deployment, create or copy an endpoint API key, then paste it here.",
	});
	const apiKey = (await callbacks.onPrompt({ message: "Paste 9Router API key:", placeholder: "sk_9router..." })).trim();
	if (!apiKey) throw new Error("9Router API key cannot be empty.");
	let baseUrl = nineRouterBaseUrl();
	callbacks.onProgress?.(`Checking 9Router endpoint ${baseUrl}/models...`);
	let models: Array<{ id: string; name?: string }> = [];
	try {
		models = await fetch9RouterModels(apiKey, baseUrl);
		callbacks.onProgress?.(`Detected ${models.length} 9Router models.`);
	} catch (error) {
		callbacks.onProgress?.(`9Router endpoint check failed at ${baseUrl}/models: ${error instanceof Error ? error.message : String(error)}`);
		const customBaseUrl = await callbacks.onPrompt({
			message: "Paste reachable 9Router base URL:",
			placeholder: "http://127.0.0.1:20128/v1 or https://sumopod.com/v1",
		});
		baseUrl = normalize9RouterBaseUrl(customBaseUrl);
		callbacks.onProgress?.(`Retrying 9Router endpoint ${baseUrl}/models...`);
		try {
			models = await fetch9RouterModels(apiKey, baseUrl);
			callbacks.onProgress?.(`Detected ${models.length} 9Router models.`);
		} catch (retryError) {
			throw new Error(
				`Could not connect to 9Router at ${baseUrl}/models. Start the local 9Router service or set NINE_ROUTER_BASE_URL to the reachable endpoint, then run /login 9router again. ${retryError instanceof Error ? retryError.message : String(retryError)}`,
			);
		}
	}
	return {
		access: apiKey,
		refresh: apiKey,
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
		baseUrl,
		models,
	};
}

async function refresh9Router(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const apiKey = credentials.refresh || credentials.access;
	if (!apiKey) throw new Error("Stored 9Router credentials do not include an API key. Run /login 9router again.");
	return {
		...credentials,
		access: apiKey,
		refresh: apiKey,
		expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
	};
}

async function postJsonWithTimeout(url: string, body: unknown): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		return await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

function windsurfProxyApiKey(): string {
	return env("WINDSURF_PROXY_API_KEY", env("WINDSURF_API_KEY", "windsurf"));
}

async function registerWindsurfTokenWithProxy(token: string): Promise<{ ok: boolean; message?: string; reachable?: boolean }> {
	const proxyRoot = windsurfProxyRoot();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetch(`${proxyRoot}/auth/login`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Bearer ${windsurfProxyApiKey()}`,
			},
			body: JSON.stringify({ token }),
			signal: controller.signal,
		});
		const responseText = await response.text();
		if (!response.ok) {
			return { ok: false, reachable: true, message: `Windsurf proxy rejected token at ${proxyRoot}/auth/login: ${response.status} ${responseText}` };
		}
		return { ok: true, reachable: true };
	} catch (error) {
		return {
			ok: false,
			reachable: false,
			message: `Windsurf proxy is not reachable at ${proxyRoot}. Token was saved, but start WindsurfAPI on port 3003 before using Windsurf models. ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function detectLocalAntigravityVersion(): string | undefined {
	if (process.env.PI_AI_ANTIGRAVITY_VERSION?.trim()) return process.env.PI_AI_ANTIGRAVITY_VERSION.trim();
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return undefined;
	try {
		const packageJson = readFileSync(join(localAppData, "Programs", "Antigravity", "resources", "app", "package.json"), "utf-8");
		const data = JSON.parse(packageJson) as { version?: string };
		return data.version?.trim() || undefined;
	} catch {}
	return undefined;
}

function configureAntigravityVersion(): void {
	const version = detectLocalAntigravityVersion() ?? "1.107.0";
	process.env.PI_AI_ANTIGRAVITY_VERSION = version;
}

function antigravityPlatform(): string {
	const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
	const arch = process.arch === "arm64" ? "arm64" : "amd64";
	return `${platform}/${arch}`;
}

function antigravityUserAgent(): string {
	return `antigravity/${process.env.PI_AI_ANTIGRAVITY_VERSION || "1.107.0"} ${antigravityPlatform()}`;
}

function getSkillPath(skillName: string): string {
	return join(skillsDir, skillName, "SKILL.md");
}

function loadSkillBlock(skillName: string): string {
	const filePath = getSkillPath(skillName);
	const content = readFileSync(filePath, "utf-8").trim();
	return `<skill name="${skillName}" location="${filePath}">\n${content}\n</skill>`;
}

function buildSuperpowerPrompt(mode: SuperpowerMode, task: string): string {
	const spec = superpowerModes[mode];
	const skillBlocks = spec.skills.map(loadSkillBlock).join("\n\n");
	const requestedTask = task || "Ask me what I want to do, then proceed using this mode.";
	return `Use Pi Superpowers mode: ${spec.label}.\n\nMode behavior: ${spec.description}\n\n${skillBlocks}\n\nTask:\n${requestedTask}`;
}

function parseMode(args: string): { mode: SuperpowerMode | undefined; task: string } {
	const trimmed = args.trim();
	if (!trimmed) return { mode: undefined, task: "" };
	const [candidate = "", ...rest] = trimmed.split(/\s+/);
	const mode = aliases[candidate.toLowerCase()];
	if (!mode) return { mode: undefined, task: trimmed };
	return { mode, task: rest.join(" ").trim() };
}

function setActiveMode(mode: SuperpowerMode, ui?: ExtensionUI): void {
	activeMode = mode;
	ui?.setStatus("superpowers", `mode:${superpowerModes[activeMode].label}`);
}

function cycleActiveMode(ui: ExtensionUI): void {
	const currentIndex = modeCycle.indexOf(activeMode);
	const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modeCycle.length;
	setActiveMode(modeCycle[nextIndex] ?? "superpowers", ui);
	ui.notify(`Pi Superpowers mode: ${superpowerModes[activeMode].label}`, "info");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const data = new TextEncoder().encode(verifier);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return { verifier, challenge };
}

function parseAuthorizationCode(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Redirect URL or authorization code cannot be empty.");
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		if (code) return code;
	} catch {}
	return trimmed;
}

function parseRedirectParams(input: string): { code?: string; state?: string } {
	const trimmed = input.trim();
	if (!trimmed) return {};
	try {
		const url = new URL(trimmed);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {}
	if (trimmed.includes("code=")) {
		const params = new URLSearchParams(trimmed);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: trimmed };
}

function base64Decode(value: string): string {
	return Buffer.from(value, "base64").toString("utf-8");
}

function oauthSuccessHtml(message: string): string {
	return `<!doctype html><html><body><h1>Authentication successful</h1><p>${message}</p></body></html>`;
}

function oauthErrorHtml(message: string): string {
	return `<!doctype html><html><body><h1>Authentication failed</h1><p>${message}</p></body></html>`;
}

async function startAntigravityCallbackServer(expectedState: string): Promise<{
	server: Server;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
	cancelWait: () => void;
}> {
	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});
		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost:51121");
				if (url.pathname !== "/oauth-callback") {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");
				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml(`Google authentication did not complete: ${error}`));
					return;
				}
				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}
				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("OAuth state mismatch."));
					return;
				}
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("Antigravity authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});
		server.on("error", reject);
		server.listen(51121, env("PI_OAUTH_CALLBACK_HOST", "127.0.0.1"), () => {
			resolve({
				server,
				waitForCode: () => waitForCodePromise,
				cancelWait: () => settleWait?.(null),
			});
		});
	});
}

async function discoverAntigravityProject(accessToken: string, callbacks?: OAuthLoginCallbacks): Promise<string> {
	const configuredProject = env("ANTIGRAVITY_PROJECT_ID");
	if (configuredProject) return configuredProject;
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": antigravityUserAgent(),
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "IDE_UNSPECIFIED",
			platform: "PLATFORM_UNSPECIFIED",
			pluginType: "GEMINI",
		}),
	};
	for (const endpoint of [
		"https://daily-cloudcode-pa.sandbox.googleapis.com",
		"https://autopush-cloudcode-pa.sandbox.googleapis.com",
		"https://cloudcode-pa.googleapis.com",
	]) {
		try {
			callbacks?.onProgress?.(`Checking Antigravity project at ${endpoint}...`);
			const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					metadata: {
						ideType: "IDE_UNSPECIFIED",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
					},
				}),
			});
			if (!response.ok) continue;
			const data = (await response.json()) as { cloudaicompanionProject?: string | { id?: string } };
			if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
				return data.cloudaicompanionProject;
			}
			if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object" && data.cloudaicompanionProject.id) {
				return data.cloudaicompanionProject.id;
			}
		} catch {}
	}
	return "rising-fact-p41fc";
}

async function loginAntigravity(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const clientId = env(
		"ANTIGRAVITY_CLIENT_ID",
		base64Decode(""),
	);
	const clientSecret = env("ANTIGRAVITY_CLIENT_SECRET", base64Decode(""));
	const authUrl = env("ANTIGRAVITY_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth");
	const tokenUrl = env("ANTIGRAVITY_TOKEN_URL", "https://oauth2.googleapis.com/token");
	const redirectUri = env("ANTIGRAVITY_REDIRECT_URI", "http://localhost:51121/oauth-callback");
	const scope = env(
		"ANTIGRAVITY_SCOPE",
		[
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
		].join(" "),
	);
	const { verifier, challenge } = await generatePKCE();
	callbacks.onProgress?.("Starting Antigravity OAuth callback server...");
	const server = await startAntigravityCallbackServer(verifier);
	try {
		const params = new URLSearchParams({
			client_id: clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			scope,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});
		callbacks.onAuth({
			url: `${authUrl}?${params.toString()}`,
			instructions: "Sign in with your Google account in the browser to authenticate Antigravity. If the callback does not return automatically, paste the final redirect URL.",
		});
		callbacks.onProgress?.("Waiting for Google OAuth callback...");
		let manualInput: string | undefined;
		let manualError: Error | undefined;
		const manualPromise = callbacks.onManualCodeInput
			? callbacks
					.onManualCodeInput()
					.then((input) => {
						manualInput = input;
						server.cancelWait();
					})
					.catch((error: unknown) => {
						manualError = error instanceof Error ? error : new Error(String(error));
						server.cancelWait();
					})
			: undefined;
		const result = await server.waitForCode();
		if (!result?.code && manualPromise) await manualPromise;
		if (manualError) throw manualError;
		const parsedManual = manualInput ? parseRedirectParams(manualInput) : undefined;
		const code = result?.code || parsedManual?.code;
		const state = result?.state || parsedManual?.state;
		if (!code) throw new Error("No Antigravity authorization code received.");
		if (state && state !== verifier) throw new Error("Antigravity OAuth state mismatch.");
		callbacks.onProgress?.("Exchanging Antigravity authorization code...");
		const response = await fetch(tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
				code_verifier: verifier,
			}).toString(),
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`Antigravity token exchange failed: ${response.status} ${text}`);
		const data = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
		if (!data.access_token) throw new Error("Antigravity token response did not include access_token.");
		if (!data.refresh_token) throw new Error("Antigravity token response did not include refresh_token.");
		const projectId = await discoverAntigravityProject(data.access_token, callbacks);
		return {
			access: data.access_token,
			refresh: data.refresh_token,
			expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
			projectId,
		};
	} finally {
		server.server.close();
	}
}

async function refreshAntigravity(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const clientId = env(
		"ANTIGRAVITY_CLIENT_ID",
		base64Decode(""),
	);
	const clientSecret = env("ANTIGRAVITY_CLIENT_SECRET", base64Decode(""));
	const tokenUrl = env("ANTIGRAVITY_TOKEN_URL", "https://oauth2.googleapis.com/token");
	const projectId = typeof credentials.projectId === "string" ? credentials.projectId : env("ANTIGRAVITY_PROJECT_ID", "rising-fact-p41fc");
	if (!credentials.refresh) throw new Error("Stored Antigravity credentials do not include a refresh token. Run /login again.");
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: credentials.refresh,
			grant_type: "refresh_token",
		}).toString(),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Antigravity token refresh failed: ${response.status} ${text}`);
	const data = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!data.access_token) throw new Error("Antigravity refresh response did not include access_token.");
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? credentials.refresh,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
		projectId,
	};
}

async function exchangeWindsurfCode(code: string, verifier: string): Promise<OAuthCredentials> {
	const tokenUrl = env("WINDSURF_TOKEN_URL");
	const clientId = env("WINDSURF_CLIENT_ID");
	const clientSecret = env("WINDSURF_CLIENT_SECRET");
	const redirectUri = env("WINDSURF_REDIRECT_URI", "http://localhost:1455/oauth/callback");
	if (!tokenUrl) throw new Error("WINDSURF_TOKEN_URL is required for Windsurf OAuth login.");
	if (!clientId) throw new Error("WINDSURF_CLIENT_ID is required for Windsurf OAuth login.");
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: clientId,
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier,
	});
	if (clientSecret) body.set("client_secret", clientSecret);
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Windsurf token exchange failed: ${response.status} ${text}`);
	const data = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!data.access_token) throw new Error("Windsurf token response did not include access_token.");
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? "",
		expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
	};
}

async function loginWindsurf(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const authUrl = env("WINDSURF_AUTH_URL");
	const clientId = env("WINDSURF_CLIENT_ID");
	const tokenUrl = env("WINDSURF_TOKEN_URL");
	const redirectUri = env("WINDSURF_REDIRECT_URI", "http://localhost:1455/oauth/callback");
	const scope = env("WINDSURF_SCOPE", "openid profile email");
	if (!authUrl || !clientId || !tokenUrl) {
		callbacks.onAuth({
			url: "https://windsurf.com/show-auth-token",
			instructions:
				"Copy the temporary authentication token from Windsurf, then paste it here. If the local WindsurfAPI proxy is running, Pi will register it automatically.",
		});
		const windsurfToken = (
			callbacks.onManualCodeInput
				? await callbacks.onManualCodeInput()
				: await callbacks.onPrompt({ message: "Paste Windsurf authentication token:" })
		).trim();
		if (!windsurfToken) throw new Error("Windsurf authentication token cannot be empty.");
		const proxyRegistration = await registerWindsurfTokenWithProxy(windsurfToken);
		if (!proxyRegistration.ok && proxyRegistration.reachable) throw new Error(proxyRegistration.message ?? "Windsurf proxy rejected token.");
		if (!proxyRegistration.ok && proxyRegistration.message) callbacks.onProgress?.(proxyRegistration.message);
		return {
			access: windsurfProxyApiKey(),
			refresh: windsurfToken,
			expires: Date.now() + (proxyRegistration.ok ? 365 * 24 * 60 * 60 * 1000 : 30 * 1000),
		};
	}
	const { verifier, challenge } = await generatePKCE();
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirectUri,
		scope,
		code_challenge: challenge,
		code_challenge_method: "S256",
	});
	callbacks.onAuth({
		url: `${authUrl}?${params.toString()}`,
		instructions: "Open this URL in your browser, finish login, then paste the final redirect URL or authorization code.",
	});
	const input = callbacks.onManualCodeInput
		? await callbacks.onManualCodeInput()
		: await callbacks.onPrompt({ message: "Paste Windsurf redirect URL or authorization code:" });
	return exchangeWindsurfCode(parseAuthorizationCode(input), verifier);
}

async function refreshWindsurf(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const tokenUrl = env("WINDSURF_TOKEN_URL");
	const clientId = env("WINDSURF_CLIENT_ID");
	const clientSecret = env("WINDSURF_CLIENT_SECRET");
	if (!tokenUrl || !clientId) {
		const windsurfToken = credentials.refresh || credentials.access;
		const proxyRegistration = windsurfToken ? await registerWindsurfTokenWithProxy(windsurfToken) : { ok: false };
		return {
			...credentials,
			access: windsurfProxyApiKey(),
			expires: Date.now() + (proxyRegistration.ok ? 365 * 24 * 60 * 60 * 1000 : 30 * 1000),
		};
	}
	if (!tokenUrl) throw new Error("WINDSURF_TOKEN_URL is required for Windsurf OAuth refresh.");
	if (!clientId) throw new Error("WINDSURF_CLIENT_ID is required for Windsurf OAuth refresh.");
	if (!credentials.refresh) throw new Error("Stored Windsurf credentials do not include a refresh token. Run /login again.");
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: clientId,
		refresh_token: credentials.refresh,
	});
	if (clientSecret) body.set("client_secret", clientSecret);
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Windsurf token refresh failed: ${response.status} ${text}`);
	const data = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!data.access_token) throw new Error("Windsurf refresh response did not include access_token.");
	return {
		access: data.access_token,
		refresh: data.refresh_token ?? credentials.refresh,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000 - 5 * 60 * 1000,
	};
}

function registerChinaProviders(pi: ExtensionAPI): void {
	pi.registerProvider("qwen-china", {
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		apiKey: "DASHSCOPE_API_KEY",
		api: "openai-completions",
		models: [
			model("qwen3-coder-plus", "Qwen3 Coder Plus", 1000000, 65536),
			model("qwen3-coder-flash", "Qwen3 Coder Flash", 1000000, 65536),
			model("qwen-plus", "Qwen Plus", 128000, 8192),
			model("qwen-max", "Qwen Max", 32768, 8192),
		],
	});
	pi.registerProvider("deepseek-china", {
		baseUrl: "https://api.deepseek.com/v1",
		apiKey: "DEEPSEEK_API_KEY",
		api: "openai-completions",
		models: [model("deepseek-chat", "DeepSeek Chat", 64000, 8192), model("deepseek-reasoner", "DeepSeek Reasoner", 64000, 8192, true)],
	});
	pi.registerProvider("moonshot-china", {
		baseUrl: "https://api.moonshot.cn/v1",
		apiKey: "MOONSHOT_API_KEY",
		api: "openai-completions",
		models: [model("moonshot-v1-8k", "Moonshot v1 8K", 8192, 4096), model("moonshot-v1-32k", "Moonshot v1 32K", 32768, 4096), model("moonshot-v1-128k", "Moonshot v1 128K", 128000, 4096)],
	});
	pi.registerProvider("zhipu-china", {
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiKey: "ZHIPU_API_KEY",
		api: "openai-completions",
		models: [model("glm-4-flash", "GLM-4 Flash", 128000, 4096), model("glm-4-plus", "GLM-4 Plus", 128000, 4096)],
	});
	pi.registerProvider("baichuan-china", {
		baseUrl: "https://api.baichuan-ai.com/v1",
		apiKey: "BAICHUAN_API_KEY",
		api: "openai-completions",
		models: [model("Baichuan4", "Baichuan 4", 32768, 4096), model("Baichuan3-Turbo", "Baichuan 3 Turbo", 32768, 4096)],
	});
}

function register9RouterProvider(pi: ExtensionAPI): void {
	const nineRouterOAuth: ProviderConfig["oauth"] = {
		name: "9Router",
		login: login9Router,
		refreshToken: refresh9Router,
		getApiKey: (credentials: OAuthCredentials) => credentials.refresh || credentials.access,
		modifyModels: apply9RouterDetectedModels,
	};
	const defaults = [
		["cc/claude-opus-4-7", "Claude Opus 4.7 (Claude Code)", 200000, 64000, true],
		["cc/claude-opus-4-6", "Claude Opus 4.6 (Claude Code)", 200000, 64000, true],
		["cc/claude-sonnet-4-6", "Claude Sonnet 4.6 (Claude Code)", 200000, 64000, true],
		["cc/claude-haiku-4-5-20251001", "Claude Haiku 4.5 (Claude Code)", 200000, 64000, false],
		["cx/gpt-5.5", "GPT-5.5 (Codex)", 400000, 128000, true],
		["cx/gpt-5.4", "GPT-5.4 (Codex)", 400000, 128000, true],
		["cx/gpt-5.3-codex", "GPT-5.3 Codex", 400000, 128000, true],
		["gh/gpt-5.4", "GPT-5.4 (GitHub Copilot)", 400000, 128000, true],
		["gh/claude-opus-4.7", "Claude Opus 4.7 (GitHub Copilot)", 200000, 64000, true],
		["gh/claude-sonnet-4.6", "Claude Sonnet 4.6 (GitHub Copilot)", 200000, 64000, true],
		["gh/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview (GitHub Copilot)", 1048576, 65535, true],
		["cu/claude-4.6-opus-max", "Claude 4.6 Opus Max (Cursor)", 200000, 64000, true],
		["cu/claude-4.5-sonnet-thinking", "Claude 4.5 Sonnet Thinking (Cursor)", 200000, 64000, true],
		["glm/glm-5.1", "GLM-5.1", 128000, 32768, true],
		["glm/glm-5", "GLM-5", 128000, 32768, true],
		["glm/glm-4.7", "GLM-4.7", 128000, 32768, true],
		["minimax/MiniMax-M2.7", "MiniMax M2.7", 1000000, 65536, false],
		["kimi/kimi-k2.5", "Kimi K2.5", 256000, 64000, false],
		["kimi/kimi-k2.5-thinking", "Kimi K2.5 Thinking", 256000, 64000, true],
		["kr/claude-sonnet-4.5", "Claude Sonnet 4.5 (Kiro)", 200000, 64000, true],
		["kr/glm-5", "GLM-5 (Kiro)", 128000, 32768, true],
		["kr/MiniMax-M2.5", "MiniMax M2.5 (Kiro)", 1000000, 65536, false],
		["kr/qwen3-coder-next", "Qwen3 Coder Next (Kiro)", 256000, 32768, true],
		["kr/deepseek-3.2", "DeepSeek 3.2 (Kiro)", 128000, 32768, true],
		["vertex/gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview (Vertex)", 1048576, 65535, true],
		["vertex/gemini-3-flash-preview", "Gemini 3 Flash Preview (Vertex)", 1048576, 65535, true],
	] as const;
	const names = new Map<string, string>(defaults.map(([id, name]) => [id, name]));
	const specs = new Map<string, { contextWindow: number; maxTokens: number; reasoning: boolean }>(
		defaults.map(([id, _name, contextWindow, maxTokens, reasoning]) => [id, { contextWindow, maxTokens, reasoning }]),
	);
	const modelIds = envList("NINE_ROUTER_MODEL_IDS", defaults.map(([id]) => id));
	pi.registerProvider("9router", {
		baseUrl: nineRouterBaseUrl(),
		apiKey: "NINE_ROUTER_API_KEY",
		api: "openai-completions",
		models: modelIds.map((id) => {
			const spec = specs.get(id) ?? { contextWindow: 128000, maxTokens: 32768, reasoning: false };
			return model(id, names.get(id) ?? id, spec.contextWindow, spec.maxTokens, spec.reasoning);
		}),
		oauth: nineRouterOAuth,
	});
}

function registerWindsurfProvider(pi: ExtensionAPI): void {
	const windsurfOAuth: ProviderConfig["oauth"] & { usesCallbackServer: boolean } = {
		name: "Windsurf",
		usesCallbackServer: true,
		login: loginWindsurf,
		refreshToken: refreshWindsurf,
		getApiKey: (credentials: OAuthCredentials) =>
			!env("WINDSURF_AUTH_URL") || !env("WINDSURF_TOKEN_URL") || !env("WINDSURF_CLIENT_ID")
				? env("WINDSURF_PROXY_API_KEY", env("WINDSURF_API_KEY", "windsurf"))
				: credentials.access,
	};
	const windsurfModels = [
		{ id: "adaptive", name: "Adaptive", input: 0.5, output: 2, cacheRead: 0.1, contextWindow: 256000, maxTokens: 64000, reasoning: false },
		{ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking", input: 5, output: 25, cacheRead: 0.5, contextWindow: 200000, maxTokens: 64000, reasoning: true },
		{ id: "claude-opus-4-7-low-thinking", name: "Claude Opus 4.7 Low Thinking", input: 2.5, output: 12.5, cacheRead: 0.25, contextWindow: 200000, maxTokens: 64000, reasoning: true },
		{ id: "claude-opus-4-7-medium-thinking", name: "Claude Opus 4.7 Medium Thinking", input: 2.5, output: 12.5, cacheRead: 0.25, contextWindow: 200000, maxTokens: 64000, reasoning: true },
		{ id: "claude-opus-4-7-high-thinking", name: "Claude Opus 4.7 High Thinking", input: 2.5, output: 12.5, cacheRead: 0.25, contextWindow: 200000, maxTokens: 64000, reasoning: true },
		{ id: "claude-opus-4-7-xhigh-thinking", name: "Claude Opus 4.7 XHigh Thinking", input: 2.5, output: 12.5, cacheRead: 0.25, contextWindow: 200000, maxTokens: 64000, reasoning: true },
		{ id: "claude-opus-4-7-max-thinking", name: "Claude Opus 4.7 Max Thinking", input: 2.5, output: 12.5, cacheRead: 0.25, contextWindow: 200000, maxTokens: 64000, reasoning: true },
		{ id: "claude-sonnet-4-6-thinking", name: "Claude Sonnet 4.6 Thinking", input: 3, output: 15, cacheRead: 0.3, contextWindow: 200000, maxTokens: 64000, reasoning: true },
		{ id: "gpt-5.3-codex-medium", name: "GPT-5.3-Codex Medium", input: 1.75, output: 14, cacheRead: 0.17, contextWindow: 400000, maxTokens: 128000, reasoning: true },
		{ id: "gpt-5.4-low-thinking", name: "GPT-5.4 Low Thinking", input: 2.5, output: 15, cacheRead: 0.25, contextWindow: 400000, maxTokens: 128000, reasoning: true },
		{ id: "kimi-k2.5", name: "Kimi K2.5", input: 0, output: 0, cacheRead: 0, contextWindow: 256000, maxTokens: 64000, reasoning: false },
		{ id: "swe-1.6", name: "SWE-1.6", input: 0.3, output: 1.5, cacheRead: 0.03, contextWindow: 256000, maxTokens: 64000, reasoning: true },
		{ id: "swe-1.6-fast", name: "SWE-1.6 Fast", input: 0.3, output: 1.5, cacheRead: 0.03, contextWindow: 256000, maxTokens: 64000, reasoning: true },
	];
	const enabledModelIds = new Set(envList("WINDSURF_MODEL_IDS", windsurfModels.map((entry) => entry.id)));
	pi.registerProvider("windsurf", {
		baseUrl: windsurfBaseUrl(),
		apiKey: "WINDSURF_PROXY_API_KEY",
		api: "openai-completions",
		models: windsurfModels
			.filter((entry) => enabledModelIds.has(entry.id))
			.map((entry) => ({
				id: entry.id,
				name: entry.name,
				reasoning: entry.reasoning,
				input: ["text"] as ("text" | "image")[],
				cost: { input: entry.input / 1_000_000, output: entry.output / 1_000_000, cacheRead: entry.cacheRead / 1_000_000, cacheWrite: 0 },
				contextWindow: entry.contextWindow,
				maxTokens: entry.maxTokens,
			})),
		oauth: windsurfOAuth,
	});
}

function registerAntigravityProvider(pi: ExtensionAPI): void {
	const antigravityOAuth: ProviderConfig["oauth"] & { usesCallbackServer: boolean } = {
		name: "Antigravity (Google)",
		usesCallbackServer: true,
		login: loginAntigravity,
		refreshToken: refreshAntigravity,
		getApiKey: (credentials: OAuthCredentials) =>
			JSON.stringify({
				token: credentials.access,
				projectId:
					typeof credentials.projectId === "string" ? credentials.projectId : env("ANTIGRAVITY_PROJECT_ID", "rising-fact-p41fc"),
			}),
	};
	const baseUrl = env("ANTIGRAVITY_BASE_URL", "https://daily-cloudcode-pa.sandbox.googleapis.com");
	const providerConfig: ProviderConfig = {
		apiKey: "ANTIGRAVITY_API_KEY",
		api: "google-gemini-cli",
		models: [
			multimodalModel("gemini-3.1-pro-high", "Gemini 3.1 Pro High (Antigravity)", 1048576, 65535, true),
			multimodalModel("gemini-3.1-pro-low", "Gemini 3.1 Pro Low (Antigravity)", 1048576, 65535, true),
			multimodalModel("gemini-3-flash", "Gemini 3 Flash (Antigravity)", 1048576, 65535, true),
			multimodalModel("claude-opus-4-6-thinking", "Claude Opus 4.6 Thinking (Antigravity)", 200000, 64000, true),
			multimodalModel("claude-sonnet-4-6", "Claude Sonnet 4.6 (Antigravity)", 200000, 64000, true),
			multimodalModel("claude-opus-4-5-thinking", "Claude Opus 4.5 Thinking (Antigravity)", 200000, 64000, true),
			multimodalModel("claude-sonnet-4-5", "Claude Sonnet 4.5 (Antigravity)", 200000, 64000),
			multimodalModel("claude-sonnet-4-5-thinking", "Claude Sonnet 4.5 Thinking (Antigravity)", 200000, 64000, true),
			model("gpt-oss-120b-medium", "GPT-OSS 120B Medium (Antigravity)", 131072, 32768),
		],
		oauth: antigravityOAuth,
	};
	providerConfig.baseUrl = baseUrl;
	pi.registerProvider("google-antigravity", providerConfig);
}

async function runSuperpowerMode(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext, forcedMode?: SuperpowerMode): Promise<void> {
	let { mode, task } = parseMode(args);
	if (forcedMode) {
		mode = forcedMode;
		task = args.trim();
	}
	if (!mode) {
		const selected = await ctx.ui.select(
			"Select Pi Superpowers mode",
			Object.values(superpowerModes).map((entry) => `${entry.label} - ${entry.description}`),
		);
		if (!selected) return;
		mode = aliases[selected.split(" - ")[0].trim()];
	}
	if (!mode) {
		ctx.ui.notify("Unknown Superpowers mode.", "warning");
		return;
	}
	setActiveMode(mode, ctx.ui);
	const prompt = buildSuperpowerPrompt(mode, task);
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}
	ctx.ui.notify(`Activated ${superpowerModes[mode].label}.`, "info");
}

function registerModeCommand(pi: ExtensionAPI, name: string, mode: SuperpowerMode): void {
	pi.registerCommand(name, {
		description: superpowerModes[mode].description,
		handler: async (args: string, ctx: ExtensionCommandContext) => runSuperpowerMode(pi, args, ctx, mode),
	});
}

export default function piSuperpowers(pi: ExtensionAPI) {
	configureAntigravityVersion();
	registerChinaProviders(pi);
	register9RouterProvider(pi);
	registerWindsurfProvider(pi);
	registerAntigravityProvider(pi);
	pi.on("resources_discover", () => ({ skillPaths: [skillsDir] }));
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		setActiveMode(activeMode, ctx.ui);
	});
	pi.on("input", (event: InputEvent, _ctx: ExtensionContext) => {
		if (event.source !== "interactive") return { action: "continue" };
		const text = event.text.trim();
		if (!text || text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
		return { action: "transform", text: buildSuperpowerPrompt(activeMode, event.text), images: event.images };
	});
	const cycleShortcut = superpowersCycleShortcut();
	if (cycleShortcut) {
		pi.registerShortcut(cycleShortcut, {
			description: "Cycle Pi Superpowers mode",
			handler: (ctx: ExtensionContext) => {
				cycleActiveMode(ctx.ui);
			},
		});
	}
	pi.registerCommand("superpowers", {
		description: "Use Superpowers modes: superpowers, plan, build, sisyphus, prometheus, hephaestus, atlas, oracle, ultrawork, debug, review, tdd",
		getArgumentCompletions: (prefix: string) => {
			const values = Object.keys(superpowerModes).filter((value) => value.startsWith(prefix.toLowerCase()));
			return values.length ? values.map((value) => ({ value, label: value, description: superpowerModes[value as SuperpowerMode].description })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => runSuperpowerMode(pi, args, ctx),
	});
	registerModeCommand(pi, "plan", "plan");
	registerModeCommand(pi, "build", "build");
	registerModeCommand(pi, "sisyphus", "sisyphus");
	registerModeCommand(pi, "sysiphus", "sisyphus");
	registerModeCommand(pi, "prometheus", "prometheus");
	registerModeCommand(pi, "promethus", "prometheus");
	registerModeCommand(pi, "hephaestus", "hephaestus");
	registerModeCommand(pi, "atlas", "atlas");
	registerModeCommand(pi, "oracle", "oracle");
	registerModeCommand(pi, "ultrawork", "ultrawork");
}
