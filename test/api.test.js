'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb } = require('../db');
const { createApp } = require('../server');

let server;
let base;

test.before(async () => {
  const db = openDb(':memory:');
  server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
}

test('기본 학생 계정 alitatest 로 로그인하고 배정된 세트를 볼 수 있다', async () => {
  const api = client();
  const bad = await api('/login', { method: 'POST', body: { username: 'alitatest', password: 'wrong' } });
  assert.equal(bad.status, 401);

  const ok = await api('/login', { method: 'POST', body: { username: 'alitatest', password: 'ekffnsk712' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'student');

  const dash = await api('/dashboard');
  assert.equal(dash.data.classes.length, 1);
  const cls = await api(`/classes/${dash.data.classes[0].id}`);
  assert.equal(cls.data.isTeacher, false);
  assert.equal(cls.data.class.code, undefined, '학생에게는 참여 코드를 노출하지 않는다');
  assert.ok(cls.data.sets.length >= 2);

  const setId = cls.data.sets[0].id;
  const set = await api(`/sets/${setId}`);
  assert.ok(set.data.cards.length >= 2);

  const [c1, c2] = set.data.cards;
  const rec = await api(`/sets/${setId}/records`, {
    method: 'POST',
    body: { mode: 'recall', score: 1, total: 2, results: [{ cardId: c1.id, correct: true }, { cardId: c2.id, correct: false }] },
  });
  assert.equal(rec.status, 200);
  assert.equal(rec.data.summary.known, 1);
  assert.equal(rec.data.summary.best.recall.percent, 50);
});

test('선생님이 클래스/세트를 만들고 학생이 코드로 참여한다', async () => {
  const teacher = client();
  await teacher('/login', { method: 'POST', body: { username: 'teacher', password: 'teacher1234' } });
  const { data: c } = await teacher('/classes', { method: 'POST', body: { name: '테스트반' } });
  assert.match(c.class.code, /^[A-Z0-9]{6}$/);

  const created = await teacher('/sets', {
    method: 'POST',
    body: { title: '과일', classId: c.class.id, cards: [{ term: 'apple', meaning: '사과' }, { term: 'pear', meaning: '배' }, { term: '', meaning: 'x' }] },
  });
  assert.equal(created.status, 200);

  const student = client();
  const su = await student('/signup', { method: 'POST', body: { username: 'kid01', password: 'secret1', name: '학생1' } });
  assert.equal(su.status, 200);

  // 참여 전에는 세트 접근 불가
  assert.equal((await student(`/sets/${created.data.set.id}`)).status, 404);
  const join = await student('/classes/join', { method: 'POST', body: { code: c.class.code.toLowerCase() } });
  assert.equal(join.status, 200);
  const set = await student(`/sets/${created.data.set.id}`);
  assert.equal(set.data.cards.length, 2, '빈 카드는 저장되지 않는다');

  await student(`/sets/${created.data.set.id}/records`, {
    method: 'POST', body: { mode: 'match', score: 2, total: 2, timeMs: 4321 },
  });
  const rank = await student(`/sets/${created.data.set.id}/ranking`);
  assert.equal(rank.data.ranking[0].best_time, 4321);

  // 학생은 세트 수정/클래스 생성 불가
  assert.equal((await student(`/sets/${created.data.set.id}`, { method: 'PUT', body: { title: 'x', cards: [] } })).status, 403);
  assert.equal((await student('/classes', { method: 'POST', body: { name: 'x' } })).status, 403);

  const report = await teacher(`/classes/${c.class.id}/report`);
  assert.equal(report.data.students.length, 1);
  assert.equal(report.data.students[0].sets[created.data.set.id].best.match.bestTime, 4321);
});

test('로그인 없이 API 접근 시 401, 비-JSON 요청은 거부', async () => {
  const api = client();
  assert.equal((await api('/dashboard')).status, 401);
  const res = await fetch(base + '/api/login', { method: 'POST', body: 'username=a', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 415);
});
