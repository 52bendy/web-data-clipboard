# PC 端轮询同步示例（PRD §7.2.1）

`backend/scripts/pc-poll-sync.js` 是一个零依赖的 Node.js 20+ 脚本：轮询
`GET /api/v1/clipboard/latest`，发现新内容后写入本机系统剪贴板并弹出桌面通知。

## 快速开始

```sh
# 1. 准备 Token（不要提交到仓库）
export DCC_TOKEN='<API_SECRET_TOKEN>'

# 2. 前台持续轮询（默认 5 秒）
node backend/scripts/pc-poll-sync.js --url http://localhost:3000

# 3. 只执行一次，适合 cron / Windows 任务计划
node backend/scripts/pc-poll-sync.js --url http://localhost:3000 --once

# 4. 从文件读取 Token（推荐，避免 shell history）
node backend/scripts/pc-poll-sync.js --token-file ~/.dcc-token --interval 3
```

`--help` 输出全部参数。常用参数：

| 参数             | 说明                                                 |
| ---------------- | ---------------------------------------------------- |
| `--url <base>`   | 服务地址，默认 `$DCC_URL` 或 `http://localhost:3000` |
| `--token-file`   | 从文件读取 Token（自动 trim）                        |
| `--interval`     | 轮询间隔秒数，默认 5                                 |
| `--state`        | 状态文件，默认 `~/.dcc-clipboard-state.json`         |
| `--once`         | 只轮询一次后退出                                     |
| `--raw`          | 写 `raw_text` 而不是提取后的 `content`               |
| `--no-clipboard` | 只检测更新，不写系统剪贴板                           |
| `--no-notify`    | 不弹桌面通知                                         |
| `--quiet`        | 不输出常规日志                                       |

## 行为

- 首次请求返回 200 后，脚本把 `ETag` 和 `updated_at` 写入状态文件；后续请求带
  `If-None-Match`，服务端返回 304 时不重复写剪贴板。
- 404 表示剪贴板为空或已过期，不写入、不通知；429 会在下一轮重试，并读取
  `Retry-After` 作为提示。
- 只有系统剪贴板写入成功后才会推进状态文件；写入失败会保留旧状态，下一轮重试，
  避免“通知了但剪贴板没写进去”。
- 状态文件以 `0600` 权限创建，内容仅包含 ETag、更新时间、来源设备，不含 Token。

## 各平台依赖

| 平台    | 剪贴板                                     | 通知                             |
| ------- | ------------------------------------------ | -------------------------------- |
| Windows | 系统自带 `clip.exe`                        | PowerShell Toast（失败时仅日志） |
| macOS   | 系统自带 `pbcopy`                          | `osascript display notification` |
| Linux   | `wl-copy` 或 `xclip` 或 `xsel`（任一安装） | `notify-send`（需桌面通知服务）  |

Linux 安装示例（Debian/Ubuntu）：

```sh
sudo apt-get install wl-clipboard       # Wayland
# 或
sudo apt-get install xclip              # X11
sudo apt-get install libnotify-bin      # notify-send
```

## 定时任务示例

Linux/macOS（crontab，每分钟）：

```cron
* * * * * DCC_TOKEN_FILE=$HOME/.dcc-token /usr/bin/node /opt/web-data-clipboard/backend/scripts/pc-poll-sync.js --once --quiet
```

Windows（任务计划程序）：

```powershell
node.exe C:\web-data-clipboard\backend\scripts\pc-poll-sync.js --url http://localhost:3000 --once --quiet
```

## 安全注意

- Token 只通过 `X-DCC-Token` Header 发送，脚本不接受 Query Token。
- 不要把 Token 写入仓库、脚本参数或日志；优先使用 `DCC_TOKEN` 环境变量或
  `--token-file`。
- 生产环境请使用 HTTPS 地址；脚本支持 `http://` 仅便于本地联调。
- 剪贴板内容属于敏感数据，脚本不会把内容写入状态文件或日志（`--quiet` 下只输出
  更新时间和来源设备）。
