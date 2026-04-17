import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { PLUGINS_DIR, PLUGINS_TESTS_DIR, PLUGIN_MAX_RETRIES, PLUGIN_TIMEOUT_SECONDS } from "../config.js";
import { loadPlugin, registerCommand, unloadPlugin } from "./loader.js";

function ensureDirs(): void {
  if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  if (!fs.existsSync(PLUGINS_TESTS_DIR)) fs.mkdirSync(PLUGINS_TESTS_DIR, { recursive: true });
}

function runTest(testPath: string): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    let lastEventTime = Date.now();
    let resolved = false;
    const timeoutMs = PLUGIN_TIMEOUT_SECONDS * 1000;

    const child = spawn("node", [testPath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (data) => {
      output += data.toString();
      lastEventTime = Date.now();
    });

    child.stderr.on("data", (data) => {
      output += data.toString();
      lastEventTime = Date.now();
    });

    const timer = setInterval(() => {
      if (resolved) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - lastEventTime > timeoutMs) {
        resolved = true;
        child.kill("SIGTERM");
        clearInterval(timer);
        resolve({ success: false, output: `Test timed out after ${PLUGIN_TIMEOUT_SECONDS}s` });
      }
    }, 5000);

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearInterval(timer);
      resolve({ success: code === 0, output: output.trim() });
    });

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      clearInterval(timer);
      resolve({ success: false, output: `Failed to run test: ${err.message}` });
    });
  });
}

export async function createOrModifyPlugin(
  name: string,
  code: string,
  testCode: string,
  existing: boolean = false
): Promise<string> {
  ensureDirs();

  const pluginPath = path.join(PLUGINS_DIR, `plugin-${name}.js`);
  const testPath = path.join(PLUGINS_TESTS_DIR, `test-${name}.js`);

  console.log(`[pluginTool] ${existing ? "Modifying" : "Creating"}: ${name}`);

  if (existing && fs.existsSync(pluginPath)) {
    try {
      unloadPlugin(name);
    } catch {}
  }

  fs.writeFileSync(pluginPath, code);
  fs.writeFileSync(testPath, testCode);

  for (let attempt = 1; attempt <= PLUGIN_MAX_RETRIES; attempt++) {
    console.log(`[pluginTool] Test attempt ${attempt}/${PLUGIN_MAX_RETRIES}`);
    const result = await runTest(testPath);

    if (result.success) {
      try {
        await loadPlugin(pluginPath);
        await registerCommand(name);
        return `✅ ${existing ? "Modified" : "Created"} capability: ${name}`;
      } catch (err) {
        return `❌ Failed to load: ${err}`;
      }
    }

    if (attempt >= PLUGIN_MAX_RETRIES) {
      try {
        if (fs.existsSync(pluginPath)) fs.unlinkSync(pluginPath);
        if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
      } catch {}
      const truncated = result.output.length > 1500 ? result.output.slice(0, 1500) + "..." : result.output;
      return `❌ Failed after ${PLUGIN_MAX_RETRIES} attempts.\n\nError: ${truncated}`;
    }

    const truncated = result.output.length > 1500 ? result.output.slice(0, 1500) + "..." : result.output;
    return `Test failed (attempt ${attempt}/${PLUGIN_MAX_RETRIES}):\n${truncated}`;
  }

  return "❌ Unexpected error";
}

export function deletePlugin(name: string): string {
  const pluginPath = path.join(PLUGINS_DIR, `plugin-${name}.js`);
  const testPath = path.join(PLUGINS_TESTS_DIR, `test-${name}.js`);
  const exists = fs.existsSync(pluginPath);

  try {
    unloadPlugin(name);
  } catch {}

  if (fs.existsSync(pluginPath)) fs.unlinkSync(pluginPath);
  if (fs.existsSync(testPath)) fs.unlinkSync(testPath);

  if (exists) return `🗑️ Deleted: ${name}`;
  return `⚠️ Not found: ${name}`;
}

export function getExistingPlugin(name: string): string | null {
  const pluginPath = path.join(PLUGINS_DIR, `plugin-${name}.js`);
  if (!fs.existsSync(pluginPath)) return null;
  return fs.readFileSync(pluginPath, "utf-8");
}