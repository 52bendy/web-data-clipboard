import { spawnSync } from 'node:child_process';

/** Writes text to the OS clipboard using the platform's native utility. */
export function writeSystemClipboard(
  text,
  { platform = process.platform, spawn = spawnSync } = {},
) {
  const candidates =
    platform === 'win32'
      ? [['clip', []]]
      : platform === 'darwin'
        ? [['pbcopy', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];

  const errors = [];
  for (const [command, args] of candidates) {
    const result = spawn(command, args, {
      input: text,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return { ok: true, command };
    }
    errors.push(result.error?.message ?? `${command} exited ${result.status}`);
  }
  return {
    ok: false,
    reason: `no clipboard utility succeeded (${errors.join('; ')})`,
  };
}

/** Best-effort desktop notification; returns false when no notifier works. */
export function notifyDesktop(
  { title, body },
  { platform = process.platform, spawn = spawnSync, env = process.env } = {},
) {
  if (env.DCC_NOTIFY_COMMAND) {
    const result = spawn(env.DCC_NOTIFY_COMMAND, {
      shell: true,
      input: `${title}\n${body}\n`,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...env, DCC_NOTIFY_TITLE: title, DCC_NOTIFY_BODY: body },
    });
    return !result.error && result.status === 0;
  }

  if (platform === 'darwin') {
    const result = spawn(
      'osascript',
      [
        '-e',
        `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return !result.error && result.status === 0;
  }
  if (platform === 'linux') {
    const result = spawn('notify-send', [title, body], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  }
  if (platform === 'win32') {
    return notifyWindows({ title, body }, { spawn, env });
  }
  return false;
}

function escapeAppleScript(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function notifyWindows({ title, body }, { spawn, env }) {
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$nodes = $template.GetElementsByTagName("text")',
    '$nodes.Item(0).AppendChild($template.CreateTextNode($env:DCC_NOTIFY_TITLE)) | Out-Null',
    '$nodes.Item(1).AppendChild($template.CreateTextNode($env:DCC_NOTIFY_BODY)) | Out-Null',
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($template)',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("网络剪切板").Show($toast)',
  ].join('; ');
  const result = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...env,
        DCC_NOTIFY_TITLE: title,
        DCC_NOTIFY_BODY: body,
      },
    },
  );
  return !result.error && result.status === 0;
}
