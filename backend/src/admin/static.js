import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function readFileIfPresent(target) {
  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      return readFileIfPresent(resolve(target, 'index.html'));
    }
    if (!info.isFile()) return null;
    return {
      body: await readFile(target),
      contentType:
        MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
    };
  } catch {
    return null;
  }
}

/**
 * Serves files below the admin static root. The path is decoded and resolved,
 * then checked against the root so `..` or encoded traversal cannot escape it.
 * Extensionless paths fall back to `<path>.html`, matching static hosting.
 */
export function createAdminStatic({ rootDir }) {
  const root = resolve(rootDir);

  return async function serveAdminStatic(pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;

    const relative = decoded.replace(/^\/admin\/?/, '');
    let target = resolve(root, relative || 'index.html');
    if (target !== root && !target.startsWith(`${root}${sep}`)) return null;

    let file = await readFileIfPresent(target);
    if (!file && !extname(target)) {
      target = `${target}.html`;
      if (!target.startsWith(`${root}${sep}`)) return null;
      file = await readFileIfPresent(target);
    }
    return file;
  };
}
