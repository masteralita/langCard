'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, hashPassword, verifyPassword, tx } = require('./db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};
const MODES = ['memorize', 'recall', 'spell', 'match', 'test'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) fail(413, '요청이 너무 큽니다.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail(400, '잘못된 JSON 형식입니다.');
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function createApp(db) {
  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    session: db.prepare(
      'SELECT u.id, u.username, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
    ),
    isMember: db.prepare('SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?'),
    classById: db.prepare('SELECT * FROM classes WHERE id = ?'),
    setById: db.prepare(
      'SELECT s.*, u.name AS owner_name FROM sets s JOIN users u ON u.id = s.owner_id WHERE s.id = ?'
    ),
    cards: db.prepare('SELECT id, term, meaning, example FROM cards WHERE set_id = ? ORDER BY position'),
  };

  function canAccessClass(user, cls) {
    return cls.teacher_id === user.id || !!q.isMember.get(cls.id, user.id);
  }

  function canAccessSet(user, set) {
    if (set.owner_id === user.id) return true;
    return !!db
      .prepare(
        `SELECT 1 FROM class_sets cs JOIN classes c ON c.id = cs.class_id
         LEFT JOIN class_members m ON m.class_id = c.id AND m.user_id = ?
         WHERE cs.set_id = ? AND (c.teacher_id = ? OR m.user_id IS NOT NULL) LIMIT 1`
      )
      .get(user.id, set.id, user.id);
  }

  function loadClass(user, id) {
    const cls = q.classById.get(Number(id));
    if (!cls || !canAccessClass(user, cls)) fail(404, '클래스를 찾을 수 없습니다.');
    return cls;
  }

  function loadSet(user, id) {
    const set = q.setById.get(Number(id));
    if (!set || !canAccessSet(user, set)) fail(404, '세트를 찾을 수 없습니다.');
    return set;
  }

  function requireTeacher(user) {
    if (user.role !== 'teacher') fail(403, '선생님 계정만 사용할 수 있습니다.');
  }

  function normalizeCards(cards) {
    if (!Array.isArray(cards)) fail(400, '카드 목록이 필요합니다.');
    const list = cards
      .map((c) => ({ term: str(c?.term), meaning: str(c?.meaning), example: str(c?.example, 500) }))
      .filter((c) => c.term && c.meaning);
    if (list.length < 2) fail(400, '단어와 뜻이 모두 입력된 카드가 2개 이상 필요합니다.');
    if (list.length > 500) fail(400, '카드는 최대 500개까지 만들 수 있습니다.');
    return list;
  }

  function writeCards(setId, cards) {
    db.prepare('DELETE FROM cards WHERE set_id = ?').run(setId);
    const add = db.prepare(
      'INSERT INTO cards (set_id, position, term, meaning, example) VALUES (?, ?, ?, ?, ?)'
    );
    cards.forEach((c, i) => add.run(setId, i, c.term, c.meaning, c.example));
  }

  function newClassCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      let code = '';
      for (const b of crypto.randomBytes(6)) code += alphabet[b % alphabet.length];
      if (!db.prepare('SELECT 1 FROM classes WHERE code = ?').get(code)) return code;
    }
  }

  function setSummary(userId, setId) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE set_id = ?').get(setId).n;
    const known = db
      .prepare(
        'SELECT COUNT(*) AS n FROM card_progress p JOIN cards c ON c.id = p.card_id WHERE c.set_id = ? AND p.user_id = ? AND p.known = 1'
      )
      .get(setId, userId).n;
    const best = {};
    for (const r of db
      .prepare(
        `SELECT mode, MAX(CAST(score AS REAL) / total) AS ratio, MIN(time_ms) AS best_time, COUNT(*) AS plays
         FROM study_records WHERE user_id = ? AND set_id = ? AND total > 0 GROUP BY mode`
      )
      .all(userId, setId)) {
      best[r.mode] = {
        percent: Math.round(r.ratio * 100),
        bestTime: r.mode === 'match' ? r.best_time : null,
        plays: r.plays,
      };
    }
    return { total, known, percent: total ? Math.round((known / total) * 100) : 0, best };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$'
    );
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  route(
    'POST',
    '/api/signup',
    async ({ body, res }) => {
      const username = str(body.username, 30).toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      const name = str(body.name, 30);
      const role = body.role === 'teacher' ? 'teacher' : 'student';
      if (!/^[a-z0-9_]{4,30}$/.test(username))
        fail(400, '아이디는 영문 소문자/숫자/밑줄 4~30자여야 합니다.');
      if (password.length < 6) fail(400, '비밀번호는 6자 이상이어야 합니다.');
      if (!name) fail(400, '이름을 입력해주세요.');
      if (q.userByName.get(username)) fail(409, '이미 사용 중인 아이디입니다.');
      const id = db
        .prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)')
        .run(username, hashPassword(password), name, role).lastInsertRowid;
      startSession(res, id);
      return { user: { id: Number(id), username, name, role } };
    },
    { auth: false }
  );

  route(
    'POST',
    '/api/login',
    async ({ body, res }) => {
      const user = q.userByName.get(str(body.username, 30).toLowerCase());
      const password = typeof body.password === 'string' ? body.password : '';
      if (!user || !verifyPassword(password, user.password_hash))
        fail(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
      startSession(res, user.id);
      return { user: { id: user.id, username: user.username, name: user.name, role: user.role } };
    },
    { auth: false }
  );

  route(
    'POST',
    '/api/logout',
    async ({ req, res }) => {
      const token = parseCookies(req.headers.cookie).sid;
      if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return { ok: true };
    },
    { auth: false }
  );

  route('GET', '/api/me', async ({ user }) => ({ user }), { auth: false });

  route('GET', '/api/dashboard', async ({ user }) => {
    const classes =
      user.role === 'teacher'
        ? db
            .prepare(
              `SELECT c.*, (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id) AS member_count,
               (SELECT COUNT(*) FROM class_sets cs WHERE cs.class_id = c.id) AS set_count
               FROM classes c WHERE c.teacher_id = ? ORDER BY c.id DESC`
            )
            .all(user.id)
        : db
            .prepare(
              `SELECT c.*, u.name AS teacher_name,
               (SELECT COUNT(*) FROM class_sets cs WHERE cs.class_id = c.id) AS set_count
               FROM classes c JOIN class_members m ON m.class_id = c.id JOIN users u ON u.id = c.teacher_id
               WHERE m.user_id = ? ORDER BY m.joined_at DESC`
            )
            .all(user.id);
    const mySets = db
      .prepare(
        `SELECT s.id, s.title, s.description, (SELECT COUNT(*) FROM cards c WHERE c.set_id = s.id) AS card_count
         FROM sets s WHERE s.owner_id = ? ORDER BY s.updated_at DESC, s.id DESC`
      )
      .all(user.id)
      .map((s) => ({ ...s, progress: setSummary(user.id, s.id) }));
    const recent = db
      .prepare(
        `SELECT r.set_id, s.title, r.mode, r.score, r.total, r.time_ms, r.created_at
         FROM study_records r JOIN sets s ON s.id = r.set_id WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 8`
      )
      .all(user.id);
    return { classes, mySets, recent };
  });

  // ----- classes -----
  route('POST', '/api/classes', async ({ user, body }) => {
    requireTeacher(user);
    const name = str(body.name, 50);
    if (!name) fail(400, '클래스 이름을 입력해주세요.');
    const code = newClassCode();
    const id = db
      .prepare('INSERT INTO classes (name, code, teacher_id) VALUES (?, ?, ?)')
      .run(name, code, user.id).lastInsertRowid;
    return { class: { id: Number(id), name, code } };
  });

  route('POST', '/api/classes/join', async ({ user, body }) => {
    if (user.role !== 'student') fail(403, '학생 계정만 클래스에 참여할 수 있습니다.');
    const code = str(body.code, 20).toUpperCase();
    const cls = db.prepare('SELECT * FROM classes WHERE code = ?').get(code);
    if (!cls) fail(404, '해당 코드의 클래스가 없습니다.');
    db.prepare('INSERT OR IGNORE INTO class_members (class_id, user_id) VALUES (?, ?)').run(cls.id, user.id);
    return { class: { id: cls.id, name: cls.name } };
  });

  route('GET', '/api/classes/:id', async ({ user, params }) => {
    const cls = loadClass(user, params.id);
    const isTeacher = cls.teacher_id === user.id;
    const teacher = db.prepare('SELECT name FROM users WHERE id = ?').get(cls.teacher_id);
    const sets = db
      .prepare(
        `SELECT s.id, s.title, s.description, cs.assigned_at,
         (SELECT COUNT(*) FROM cards c WHERE c.set_id = s.id) AS card_count
         FROM class_sets cs JOIN sets s ON s.id = cs.set_id WHERE cs.class_id = ? ORDER BY cs.assigned_at DESC, s.id DESC`
      )
      .all(cls.id)
      .map((s) => ({ ...s, progress: isTeacher ? null : setSummary(user.id, s.id) }));
    const members = db
      .prepare(
        `SELECT u.id, u.name, u.username, m.joined_at FROM class_members m JOIN users u ON u.id = m.user_id
         WHERE m.class_id = ? ORDER BY u.name`
      )
      .all(cls.id);
    return {
      class: { id: cls.id, name: cls.name, code: isTeacher ? cls.code : undefined, teacher_name: teacher.name },
      isTeacher,
      sets,
      members: isTeacher ? members : members.map(({ id, name }) => ({ id, name })),
    };
  });

  route('DELETE', '/api/classes/:id', async ({ user, params }) => {
    const cls = loadClass(user, params.id);
    if (cls.teacher_id !== user.id) fail(403, '권한이 없습니다.');
    db.prepare('DELETE FROM classes WHERE id = ?').run(cls.id);
    return { ok: true };
  });

  route('POST', '/api/classes/:id/leave', async ({ user, params }) => {
    const cls = loadClass(user, params.id);
    db.prepare('DELETE FROM class_members WHERE class_id = ? AND user_id = ?').run(cls.id, user.id);
    return { ok: true };
  });

  route('POST', '/api/classes/:id/sets', async ({ user, params, body }) => {
    const cls = loadClass(user, params.id);
    if (cls.teacher_id !== user.id) fail(403, '권한이 없습니다.');
    const set = q.setById.get(Number(body.setId));
    if (!set || set.owner_id !== user.id) fail(404, '세트를 찾을 수 없습니다.');
    db.prepare('INSERT OR IGNORE INTO class_sets (class_id, set_id) VALUES (?, ?)').run(cls.id, set.id);
    return { ok: true };
  });

  route('DELETE', '/api/classes/:id/sets/:setId', async ({ user, params }) => {
    const cls = loadClass(user, params.id);
    if (cls.teacher_id !== user.id) fail(403, '권한이 없습니다.');
    db.prepare('DELETE FROM class_sets WHERE class_id = ? AND set_id = ?').run(cls.id, Number(params.setId));
    return { ok: true };
  });

  route('DELETE', '/api/classes/:id/members/:userId', async ({ user, params }) => {
    const cls = loadClass(user, params.id);
    if (cls.teacher_id !== user.id) fail(403, '권한이 없습니다.');
    db.prepare('DELETE FROM class_members WHERE class_id = ? AND user_id = ?').run(cls.id, Number(params.userId));
    return { ok: true };
  });

  route('GET', '/api/classes/:id/report', async ({ user, params }) => {
    const cls = loadClass(user, params.id);
    if (cls.teacher_id !== user.id) fail(403, '권한이 없습니다.');
    const sets = db
      .prepare(
        'SELECT s.id, s.title FROM class_sets cs JOIN sets s ON s.id = cs.set_id WHERE cs.class_id = ? ORDER BY s.id'
      )
      .all(cls.id);
    const students = db
      .prepare(
        'SELECT u.id, u.name, u.username FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? ORDER BY u.name'
      )
      .all(cls.id)
      .map((s) => ({
        ...s,
        sets: Object.fromEntries(sets.map((set) => [set.id, setSummary(s.id, set.id)])),
      }));
    return { class: { id: cls.id, name: cls.name }, sets, students };
  });

  // ----- sets -----
  route('POST', '/api/sets', async ({ user, body }) => {
    const title = str(body.title, 100);
    if (!title) fail(400, '세트 제목을 입력해주세요.');
    const cards = normalizeCards(body.cards);
    const id = tx(db, () => {
      const id = db
        .prepare('INSERT INTO sets (title, description, owner_id) VALUES (?, ?, ?)')
        .run(title, str(body.description, 300), user.id).lastInsertRowid;
      writeCards(id, cards);
      if (body.classId) {
        const cls = q.classById.get(Number(body.classId));
        if (cls && cls.teacher_id === user.id)
          db.prepare('INSERT OR IGNORE INTO class_sets (class_id, set_id) VALUES (?, ?)').run(cls.id, id);
      }
      return Number(id);
    });
    return { set: { id } };
  });

  route('GET', '/api/sets/:id', async ({ user, params }) => {
    const set = loadSet(user, params.id);
    const progress = Object.fromEntries(
      db
        .prepare(
          'SELECT p.card_id, p.known, p.correct, p.wrong FROM card_progress p JOIN cards c ON c.id = p.card_id WHERE c.set_id = ? AND p.user_id = ?'
        )
        .all(set.id, user.id)
        .map((p) => [p.card_id, { known: !!p.known, correct: p.correct, wrong: p.wrong }])
    );
    return {
      set: {
        id: set.id,
        title: set.title,
        description: set.description,
        owner_name: set.owner_name,
        isOwner: set.owner_id === user.id,
      },
      cards: q.cards.all(set.id),
      progress,
      summary: setSummary(user.id, set.id),
    };
  });

  route('PUT', '/api/sets/:id', async ({ user, params, body }) => {
    const set = loadSet(user, params.id);
    if (set.owner_id !== user.id) fail(403, '권한이 없습니다.');
    const title = str(body.title, 100);
    if (!title) fail(400, '세트 제목을 입력해주세요.');
    const cards = normalizeCards(body.cards);
    tx(db, () => {
      db.prepare("UPDATE sets SET title = ?, description = ?, updated_at = datetime('now') WHERE id = ?").run(
        title,
        str(body.description, 300),
        set.id
      );
      writeCards(set.id, cards);
    });
    return { ok: true };
  });

  route('DELETE', '/api/sets/:id', async ({ user, params }) => {
    const set = loadSet(user, params.id);
    if (set.owner_id !== user.id) fail(403, '권한이 없습니다.');
    db.prepare('DELETE FROM sets WHERE id = ?').run(set.id);
    return { ok: true };
  });

  route('POST', '/api/sets/:id/records', async ({ user, params, body }) => {
    const set = loadSet(user, params.id);
    const mode = body.mode;
    if (!MODES.includes(mode)) fail(400, '알 수 없는 학습 모드입니다.');
    const total = Math.max(0, Math.floor(Number(body.total) || 0));
    const score = Math.min(total, Math.max(0, Math.floor(Number(body.score) || 0)));
    const timeMs = body.timeMs == null ? null : Math.max(0, Math.floor(Number(body.timeMs) || 0));
    const results = Array.isArray(body.results) ? body.results.slice(0, 1000) : [];
    const cardIds = new Set(q.cards.all(set.id).map((c) => c.id));
    tx(db, () => {
      db.prepare(
        'INSERT INTO study_records (user_id, set_id, mode, score, total, time_ms) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(user.id, set.id, mode, score, total, timeMs);
      const upsert = db.prepare(
        `INSERT INTO card_progress (user_id, card_id, known, correct, wrong) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, card_id) DO UPDATE SET known = excluded.known,
           correct = correct + excluded.correct, wrong = wrong + excluded.wrong, updated_at = datetime('now')`
      );
      for (const r of results) {
        const id = Number(r?.cardId);
        if (!cardIds.has(id)) continue;
        const ok = !!r.correct;
        upsert.run(user.id, id, ok ? 1 : 0, ok ? 1 : 0, ok ? 0 : 1);
      }
    });
    return { summary: setSummary(user.id, set.id) };
  });

  route('POST', '/api/sets/:id/reset', async ({ user, params }) => {
    const set = loadSet(user, params.id);
    db.prepare(
      'DELETE FROM card_progress WHERE user_id = ? AND card_id IN (SELECT id FROM cards WHERE set_id = ?)'
    ).run(user.id, set.id);
    return { summary: setSummary(user.id, set.id) };
  });

  route('GET', '/api/sets/:id/ranking', async ({ user, params }) => {
    const set = loadSet(user, params.id);
    // 같은 클래스(이 세트가 배정된 클래스 중 내가 속한 곳) 사람들끼리의 매칭게임 최고 기록
    const rows = db
      .prepare(
        `SELECT u.id, u.name, MIN(r.time_ms) AS best_time FROM study_records r JOIN users u ON u.id = r.user_id
         WHERE r.set_id = ? AND r.mode = 'match' AND r.score = r.total AND r.time_ms IS NOT NULL
           AND (r.user_id = ? OR r.user_id IN (
             SELECT m2.user_id FROM class_sets cs
             JOIN classes c ON c.id = cs.class_id
             JOIN class_members m2 ON m2.class_id = c.id
             LEFT JOIN class_members me ON me.class_id = c.id AND me.user_id = ?
             WHERE cs.set_id = ? AND (me.user_id IS NOT NULL OR c.teacher_id = ?)))
         GROUP BY u.id ORDER BY best_time ASC LIMIT 20`
      )
      .all(set.id, user.id, user.id, set.id, user.id);
    return { ranking: rows.map((r, i) => ({ rank: i + 1, ...r, me: r.id === user.id })) };
  });

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      userId,
      Date.now() + SESSION_TTL_MS
    );
    res.setHeader(
      'Set-Cookie',
      `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
    );
  }

  function serveStatic(req, res, pathname) {
    let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(PUBLIC_DIR)) file = path.join(PUBLIC_DIR, 'index.html');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) file = path.join(PUBLIC_DIR, 'index.html');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      return serveStatic(req, res, url.pathname);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!r) fail(404, '존재하지 않는 API입니다.');
      // CSRF 방어: 상태 변경 요청은 JSON 본문으로만 받는다
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json'))
        fail(415, 'Content-Type: application/json 이 필요합니다.');
      const m = url.pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const token = parseCookies(req.headers.cookie).sid;
      const user = (token && q.session.get(token, Date.now())) || null;
      if (r.auth && !user) fail(401, '로그인이 필요합니다.');
      const body = req.method === 'GET' ? {} : await readJson(req);
      const data = await r.handler({ req, res, user: user && { ...user }, params, body, query: url.searchParams });
      res.writeHead(200).end(JSON.stringify(data));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res.writeHead(status).end(JSON.stringify({ error: status === 500 ? '서버 오류가 발생했습니다.' : e.message }));
    }
  };
}

if (require.main === module) {
  const db = openDb();
  const port = Number(process.env.PORT) || 3000;
  http.createServer(createApp(db)).listen(port, () => {
    console.log(`LangCard 서버 실행 중: http://localhost:${port}`);
  });
}

module.exports = { createApp };
