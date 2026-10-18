require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();

// Giới hạn dung lượng nhận vào 100KB để chống ngốn RAM
app.use(express.json({ limit: '100kb' }));

// CORS thủ công siêu nhẹ
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Khởi tạo SQLite tối ưu dung lượng và I/O cho VPS cấu hình yếu
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -2000'); // Cache tối đa ~2MB RAM
db.pragma('temp_store = MEMORY');

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    page_id TEXT PRIMARY KEY,
    page_name TEXT,
    access_token TEXT,
    updated_at INTEGER
  )
`);

// Prepared Statements sẵn sàng để tiết kiệm CPU
const upsertPageStmt = db.prepare(`
  INSERT INTO pages (page_id, page_name, access_token, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(page_id) DO UPDATE SET
    page_name = excluded.page_name,
    access_token = excluded.access_token,
    updated_at = excluded.updated_at
`);
const getPageTokenStmt = db.prepare('SELECT access_token FROM pages WHERE page_id = ?');
const getAllPagesStmt = db.prepare('SELECT page_id, page_name FROM pages');
const countPagesStmt = db.prepare('SELECT COUNT(*) as count FROM pages');

const { FB_APP_ID, FB_APP_SECRET, REDIRECT_URI, PORT = 3000, HOST = '127.0.0.1' } = process.env;

// Hàm gọi fetch có timeout 12s tránh rò rỉ bộ nhớ
async function fetchMeta(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(12000),
  });
}

// 0. Healthcheck
app.get('/health', (req, res) => {
  const { count } = countPagesStmt.get();
  res.json({ status: 'ok', total_pages: count });
});

// 1. Luồng Login (dự phòng khi cần kết nối thêm)
app.get('/auth/login', (req, res) => {
  if (!FB_APP_ID) return res.status(500).send('Chưa cấu hình FB_APP_ID trong .env');
  const scope = 'pages_manage_posts,pages_manage_engagement,pages_read_engagement';
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&response_type=code`;
  res.redirect(url);
});

// 2. Callback xử lý Token vĩnh viễn
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Thiếu mã xác thực (code)');

  try {
    const tokenUrl = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`;
    const tokenRes = await (await fetchMeta(tokenUrl)).json();
    if (!tokenRes.access_token) throw new Error(JSON.stringify(tokenRes));

    const longUrl = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${tokenRes.access_token}`;
    const longRes = await (await fetchMeta(longUrl)).json();

    const accountsUrl = `https://graph.facebook.com/v21.0/me/accounts?access_token=${longRes.access_token}&limit=100`;
    const accountsRes = await (await fetchMeta(accountsUrl)).json();

    const pages = accountsRes.data || [];
    const now = Date.now();

    const insertMany = db.transaction((items) => {
      for (const p of items) {
        upsertPageStmt.run(p.id, p.name, p.access_token, now);
      }
    });
    insertMany(pages);

    res.send(`<h3>Thành công! Đã nạp ${pages.length} Fanpage vào hệ thống VPS.</h3>`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. API danh sách Page cho n8n
app.get('/api/pages', (req, res) => {
  const pages = getAllPagesStmt.all();
  res.json(pages.map((p) => ({ name: p.page_name, value: p.page_id })));
});

// 4. API Đăng Video & Comment
app.post('/api/publish', async (req, res) => {
  const { page_id, video_url, caption, comment } = req.body;
  if (!page_id || !video_url) {
    return res.status(400).json({ error: 'Thiếu page_id hoặc video_url' });
  }

  const page = getPageTokenStmt.get(page_id);
  if (!page) {
    return res.status(404).json({ error: 'Không tìm thấy Page trong Database' });
  }

  try {
    // Bước A: Tải video lên Page
    const videoBody = new URLSearchParams({
      file_url: video_url,
      description: caption || '',
      access_token: page.access_token,
    });
    const vRes = await (await fetchMeta(`https://graph.facebook.com/v21.0/${page_id}/videos`, {
      method: 'POST',
      body: videoBody,
    })).json();

    if (!vRes.id) throw new Error(JSON.stringify(vRes));

    // Bước B: Đăng Comment đầu tiên (nếu có)
    let commentId = null;
    if (comment && comment.trim() !== '') {
      const cBody = new URLSearchParams({
        message: comment,
        access_token: page.access_token,
      });
      const cRes = await (await fetchMeta(`https://graph.facebook.com/v21.0/${vRes.id}/comments`, {
        method: 'POST',
        body: cBody,
      })).json();
      commentId = cRes.id || null;
    }

    res.json({
      success: true,
      page_id,
      video_id: vRes.id,
      comment_id: commentId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[FB Gateway] Đang hoạt động tại http://${HOST}:${PORT}`);
});
