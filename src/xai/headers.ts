import type { Env } from "../types";
import { boolEnv, DEFAULT_USER_AGENT } from "../config";

const CHAR_MAP: Record<string, string> = {
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "–": "-",
  "—": "-",
  "−": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "\u00a0": " ",
  "\u2007": " ",
  "\u202f": " ",
  "\u200b": "",
  "\u200c": "",
  "\u200d": "",
  "\ufeff": "",
};

function sanitize(value: unknown, stripSpaces = false): string {
  let out = value === undefined || value === null ? "" : String(value);
  out = out.replace(/[‐‑‒–—−‘’“”\u00a0\u2007\u202f\u200b\u200c\u200d\ufeff]/g, (ch) => CHAR_MAP[ch] ?? "");
  out = stripSpaces ? out.replace(/\s+/g, "") : out.trim();
  // Latin-1 safe approximation for cookie/header values.
  return Array.from(out)
    .filter((ch) => ch.charCodeAt(0) <= 255)
    .join("");
}

function base64(input: string): string {
  // btoa is available in Workers; encodeURIComponent handles Unicode before btoa.
  return btoa(unescape(encodeURIComponent(input)));
}

function randomString(chars: string, len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

function statsigId(env: Env): string {
  if (boolEnv(env, "DYNAMIC_STATSIG", true)) {
    if ((crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 2 === 0) {
      const rand = randomString("abcdefghijklmnopqrstuvwxyz0123456789", 5);
      return base64(`e:TypeError: Cannot read properties of null (reading 'children['${rand}']')`);
    }
    const rand = randomString("abcdefghijklmnopqrstuvwxyz", 10);
    return base64(`e:TypeError: Cannot read properties of undefined (reading '${rand}')`);
  }
  return "ZTpUeXBlRXJyb3I6IENhbm5vdCByZWFkIHByb3BlcnRpZXMgb2YgdW5kZWZpbmVkIChyZWFkaW5nICdjaGlsZE5vZGVzJyk=";
}

function majorVersion(browser: string, ua: string): string | undefined {
  const match = `${browser} ${ua}`.match(/(\d{2,3})/);
  return match?.[1];
}

function platformFromUa(ua: string): string | undefined {
  const u = ua.toLowerCase();
  if (u.includes("windows")) return "Windows";
  if (u.includes("mac os x") || u.includes("macintosh")) return "macOS";
  if (u.includes("android")) return "Android";
  if (u.includes("iphone") || u.includes("ipad")) return "iOS";
  if (u.includes("linux")) return "Linux";
  return undefined;
}

function archFromUa(ua: string): string | undefined {
  const u = ua.toLowerCase();
  if (u.includes("aarch64") || u.includes("arm")) return "arm";
  if (u.includes("x86_64") || u.includes("x64") || u.includes("win64") || u.includes("intel")) return "x86";
  return undefined;
}

function clientHints(env: Env, ua: string): Record<string, string> {
  const browser = env.BROWSER || "chrome136";
  const b = browser.toLowerCase();
  const u = ua.toLowerCase();
  const isChromium = ["chrome", "chromium", "edge", "brave"].some((x) => b.includes(x)) || /chrome|chromium|edg/.test(u);
  if (!isChromium || u.includes("firefox") || (u.includes("safari") && !u.includes("chrome"))) return {};
  const ver = majorVersion(browser, ua);
  if (!ver) return {};
  const brand = b.includes("edge") || u.includes("edg") ? "Microsoft Edge" : b.includes("brave") ? "Brave" : b.includes("chromium") ? "Chromium" : "Google Chrome";
  const platform = platformFromUa(ua);
  const arch = archFromUa(ua);
  const mobile = u.includes("mobile") || platform === "Android" || platform === "iOS" ? "?1" : "?0";
  const hints: Record<string, string> = {
    "Sec-Ch-Ua": `"${brand}";v="${ver}", "Chromium";v="${ver}", "Not(A:Brand";v="24"`,
    "Sec-Ch-Ua-Mobile": mobile,
    "Sec-Ch-Ua-Model": "",
  };
  if (platform) hints["Sec-Ch-Ua-Platform"] = `"${platform}"`;
  if (arch) {
    hints["Sec-Ch-Ua-Arch"] = arch;
    hints["Sec-Ch-Ua-Bitness"] = "64";
  }
  return hints;
}

export function buildSsoCookie(token: string, env: Env): string {
  const tok = sanitize(token.startsWith("sso=") ? token.slice(4) : token, true);
  let cookie = `sso=${tok}; sso-rw=${tok}`;
  let extra = sanitize(env.CF_COOKIES || "");
  const clearance = sanitize(env.CF_CLEARANCE || "", true);

  if (clearance && extra) {
    if (/(?:^|;\s*)cf_clearance=/.test(extra)) {
      extra = extra.replace(/(^|;\s*)cf_clearance=[^;]*/, `$1cf_clearance=${clearance}`);
    } else {
      extra = `${extra.replace(/[;\s]+$/g, "")}; cf_clearance=${clearance}`;
    }
  } else if (clearance) {
    extra = `cf_clearance=${clearance}`;
  }
  if (extra) cookie += `; ${extra}`;
  return cookie;
}

export function buildHttpHeaders(
  token: string,
  env: Env,
  options: { contentType?: string | null; origin?: string; referer?: string; accept?: string } = {},
): Headers {
  const ua = sanitize(env.USER_AGENT || DEFAULT_USER_AGENT);
  const origin = sanitize(options.origin || "https://grok.com");
  const referer = sanitize(options.referer || "https://grok.com/");
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  const accept = options.accept || (contentType && contentType !== "application/json" ? "*/*" : "*/*");

  const originHost = safeHost(origin);
  const refHost = safeHost(referer);
  const site = originHost && refHost && originHost === refHost ? "same-origin" : "same-site";

  const headers = new Headers({
    Accept: accept,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Baggage: "sentry-environment=production,sentry-release=d6add6fb0460641fd482d767a335ef72b9b6abb8,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c",
    Origin: origin,
    Priority: "u=1, i",
    Referer: referer,
    "Sec-Fetch-Dest": contentType ? "empty" : "document",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": site,
    "User-Agent": ua,
    "x-statsig-id": statsigId(env),
    "x-xai-request-id": crypto.randomUUID(),
    Cookie: buildSsoCookie(token, env),
    ...clientHints(env, ua),
  });
  if (contentType) headers.set("Content-Type", contentType);
  return headers;
}

function safeHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}
