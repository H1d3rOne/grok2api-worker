#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG = resolve(process.cwd(), "wrangler.toml");
const PLACEHOLDER = "REPLACE_WITH_TOKEN_STORE_KV_NAMESPACE_ID";

if (!existsSync(CONFIG)) {
  console.error("wrangler.toml not found. Run this script from the project root.");
  process.exit(1);
}

const current = readFileSync(CONFIG, "utf8");
if (!current.includes(PLACEHOLDER)) {
  console.log("wrangler.toml already appears to contain a TOKEN_STORE namespace id.");
  process.exit(0);
}

console.log("Creating Cloudflare KV namespace TOKEN_STORE...");
let output = "";
try {
  output = execFileSync("npx", ["wrangler", "kv", "namespace", "create", "TOKEN_STORE"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  const stderr = error?.stderr?.toString?.() || "";
  const stdout = error?.stdout?.toString?.() || "";
  console.error(stdout || stderr || error.message);
  process.exit(error.status || 1);
}

process.stdout.write(output);
const match = output.match(/id\s*=\s*"([^"]+)"/);
if (!match) {
  console.error("Could not parse namespace id from wrangler output. Paste it into wrangler.toml manually.");
  process.exit(1);
}

const namespaceId = match[1];
writeFileSync(CONFIG, current.replace(PLACEHOLDER, namespaceId));
console.log(`Updated wrangler.toml TOKEN_STORE id: ${namespaceId}`);
