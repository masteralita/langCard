'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(password, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','teacher')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS class_members (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (class_id, user_id)
);
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  term TEXT NOT NULL,
  meaning TEXT NOT NULL,
  example TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS class_sets (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (class_id, set_id)
);
CREATE TABLE IF NOT EXISTS card_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  known INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, card_id)
);
CREATE TABLE IF NOT EXISTS study_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_id INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('memorize','recall','spell','match','test')),
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  time_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_records_set ON study_records(set_id, mode);
CREATE INDEX IF NOT EXISTS idx_cards_set ON cards(set_id, position);
`;

// 기본 학생 계정 (요청된 계정). 비밀번호는 평문이 아닌 scrypt 해시로만 보관한다.
const SEED_STUDENT = {
  username: 'alitatest',
  name: '알리타',
  passwordHash:
    '1f5747072cc4a603a32e9efab45a6bf0:bf3b1804ad93da1e49801c4ec806aa8b32c25c44bf8c0aaaedb059262bc3aeb9c15c5dcf400f7863837bda7ff0deffb5fed6cf548f773afc87c5d85bc45c392d',
};

const SAMPLE_SETS = [
  {
    title: '중학 필수 영단어 Day 1',
    description: '일상에서 자주 쓰는 기본 동사와 명사',
    cards: [
      ['apple', '사과', 'I eat an apple every morning.'],
      ['borrow', '빌리다', 'Can I borrow your pen?'],
      ['careful', '조심하는, 신중한', 'Be careful when you cross the street.'],
      ['decide', '결정하다', 'She decided to study abroad.'],
      ['enough', '충분한', 'We have enough time.'],
      ['forget', '잊다', "Don't forget your homework."],
      ['grow', '자라다, 기르다', 'Plants grow fast in summer.'],
      ['history', '역사', 'I like reading about history.'],
      ['invite', '초대하다', 'He invited me to his party.'],
      ['journey', '여행, 여정', 'The journey took three hours.'],
    ],
  },
  {
    title: '중학 필수 영단어 Day 2',
    description: '감정과 상태를 나타내는 형용사',
    cards: [
      ['angry', '화난', 'Why are you so angry?'],
      ['brave', '용감한', 'The brave firefighter saved the child.'],
      ['curious', '호기심이 많은', 'Cats are curious animals.'],
      ['delicious', '맛있는', 'This soup is delicious.'],
      ['excited', '신이 난, 흥분한', 'The kids were excited about the trip.'],
      ['famous', '유명한', 'She is a famous singer.'],
      ['gentle', '온화한, 부드러운', 'He spoke in a gentle voice.'],
      ['honest', '정직한', 'Thank you for being honest.'],
    ],
  },
];

function openDb(file = process.env.DB_FILE || path.join(__dirname, 'data', 'langcard.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seed(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  tx(db, () => {
    const addUser = db.prepare(
      'INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, ?)'
    );
    const teacherPw = process.env.SEED_TEACHER_PASSWORD || 'teacher1234';
    const teacherId = addUser.run('teacher', hashPassword(teacherPw), '김선생', 'teacher').lastInsertRowid;
    const studentId = addUser.run(
      SEED_STUDENT.username,
      process.env.SEED_STUDENT_PASSWORD
        ? hashPassword(process.env.SEED_STUDENT_PASSWORD)
        : SEED_STUDENT.passwordHash,
      SEED_STUDENT.name,
      'student'
    ).lastInsertRowid;

    const classId = db
      .prepare('INSERT INTO classes (name, code, teacher_id) VALUES (?, ?, ?)')
      .run('중1 영어반', 'ENG101', teacherId).lastInsertRowid;
    db.prepare('INSERT INTO class_members (class_id, user_id) VALUES (?, ?)').run(classId, studentId);

    for (const s of SAMPLE_SETS) {
      const setId = db
        .prepare('INSERT INTO sets (title, description, owner_id) VALUES (?, ?, ?)')
        .run(s.title, s.description, teacherId).lastInsertRowid;
      const addCard = db.prepare(
        'INSERT INTO cards (set_id, position, term, meaning, example) VALUES (?, ?, ?, ?, ?)'
      );
      s.cards.forEach(([t, m, e], i) => addCard.run(setId, i, t, m, e));
      db.prepare('INSERT INTO class_sets (class_id, set_id) VALUES (?, ?)').run(classId, setId);
    }
  });
}

module.exports = { openDb, hashPassword, verifyPassword, tx };
