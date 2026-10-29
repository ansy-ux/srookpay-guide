// dist/ 를 http://localhost:4321 로 띄우는 미리보기용 서버
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const PORT = 4321;
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') return res.writeHead(302, { Location: '/index.html' }).end();
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  // /capture/... 는 캡처 비교 보고서 보기용 (capture/out/<시각>/report.html), /content/... 는 보고서의 기존 이미지
  const file = /^[/\\](capture|content)[/\\]/.test(safe) ? join(HERE, safe) : join(DIST, safe);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
