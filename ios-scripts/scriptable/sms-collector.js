// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: blue; icon-glyph: sms;

/**
 * Optional Scriptable adapter for the iOS SMS collector (REQ-202610-1267).
 *
 * Scriptable cannot read SMS messages by itself. Run this script from a
 * Shortcuts personal automation ("Run Script" action) and pass the message
 * content as the shortcut input. Scriptable then posts the exact
 * POST /api/v1/collect payload and shows a local notification.
 *
 * Edit the three values below before first use. Keep the token private:
 * anyone with this script can post to your collector.
 */
const CONFIG = {
  serverUrl: "https://YOUR-SERVER.example.com/api/v1/collect",
  token: "PASTE_YOUR_TOKEN_HERE",
  deviceId: "ios_scriptable_001",
};

/** Reads the shortcut input; supports plain text and rich-text objects. */
function readShortcutInput() {
  const input = args.shortcutParameter;
  if (input === null || input === undefined) {
    return args.plainTexts?.length ? args.plainTexts.join("\n") : "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (typeof input.text === "string") {
    return input.text;
  }
  return String(input);
}

async function collect(rawContent) {
  const payload = {
    device_id: CONFIG.deviceId,
    device_name: Device.name(),
    platform: "ios",
    sender: "",
    raw_content: rawContent,
    timestamp: Date.now(),
  };

  const request = new Request(CONFIG.serverUrl);
  request.method = "POST";
  request.headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-DCC-Token": CONFIG.token,
  };
  request.body = JSON.stringify(payload);
  request.timeoutInterval = 15;

  const startedAt = Date.now();
  const body = await request.loadJSON();
  const status = request.response.statusCode;
  const elapsedMs = Date.now() - startedAt;
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
  }
  return { body, elapsedMs };
}

async function main() {
  const rawContent = readShortcutInput();
  if (!rawContent || !rawContent.trim()) {
    throw new Error("没有收到短信内容：请从快捷指令的「运行脚本」动作传入输入。");
  }

  const { body, elapsedMs } = await collect(rawContent);
  const extracted = body?.data?.extracted_code;
  const notification = new Notification();
  notification.title = "短信已上报";
  notification.body = extracted
    ? `提取码：${extracted}（${elapsedMs}ms）`
    : `已写入网络剪贴板（${elapsedMs}ms）`;
  notification.schedule();

  Script.setShortcutOutput(JSON.stringify(body));
  Script.complete();
}

await main();
