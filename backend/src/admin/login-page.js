import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeHtml, htmlResponse } from './responses.js';

/** Login and notice pages are HTML shells rendered from `login.html`. */
export function createLoginPages({ staticRoot }) {
  let loginTemplate = null;

  async function getLoginTemplate() {
    if (loginTemplate !== null) return loginTemplate;
    try {
      loginTemplate = await readFile(join(staticRoot, 'login.html'), 'utf8');
    } catch {
      loginTemplate = defaultLoginTemplate();
    }
    return loginTemplate;
  }

  async function renderLoginHtml({
    error = '',
    next = '',
    username = '',
  } = {}) {
    const template = await getLoginTemplate();
    return template
      .replaceAll(
        '{{ERROR}}',
        error
          ? `<div class="alert" role="alert">${escapeHtml(error)}</div>`
          : '',
      )
      .replaceAll('{{NEXT}}', escapeHtml(next))
      .replaceAll('{{USERNAME}}', escapeHtml(username));
  }

  async function renderLoginPage(status, options = {}, headers = {}) {
    return htmlResponse(status, await renderLoginHtml(options), headers);
  }

  async function renderNoticePage(status, title, message) {
    const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/admin/login.css"></head>
<body class="auth-page"><main class="auth-card"><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(message)}</p></main></body>
</html>`;
    return htmlResponse(status, html);
  }

  return { renderLoginHtml, renderLoginPage, renderNoticePage };
}

function defaultLoginTemplate() {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>管理后台登录</title><link rel="stylesheet" href="/admin/login.css"></head>
<body class="auth-page"><main class="auth-card"><h1>管理后台</h1>{{ERROR}}
<form method="post" action="/admin/login"><input type="hidden" name="next" value="{{NEXT}}">
<label>用户名<input name="username" value="{{USERNAME}}" autocomplete="username" required></label>
<label>密码<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">登录</button></form></main></body></html>`;
}
