'use strict';
(() => {
  const $app = document.getElementById('app');
  const $nav = document.getElementById('nav');
  let me = null;
  let cleanup = null; // 현재 화면이 떠날 때 정리할 함수 (타이머, 키 이벤트 등)
  let navSeq = 0; // 화면 전환 번호: 이전 화면의 늦은 응답이 새 화면을 덮어쓰지 않도록 한다
  const STALE = new Error('stale');

  const MODES = {
    memorize: { name: '암기학습', desc: '카드를 뒤집으며 외우기' },
    recall: { name: '리콜학습', desc: '단어 보고 뜻 고르기' },
    spell: { name: '스펠학습', desc: '뜻 보고 철자 쓰기' },
    match: { name: '매칭게임', desc: '짝 맞추기 기록 도전' },
    test: { name: '테스트', desc: '객관식+주관식 시험' },
  };

  // ---------- utils ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const html = (strings, ...vals) =>
    strings.reduce((out, s, i) => {
      if (i === 0) return s;
      const v = vals[i - 1];
      const isRaw = (x) => x && typeof x === 'object' && '__raw' in x;
      const val = isRaw(v) ? v.__raw : Array.isArray(v) ? v.map((x) => (isRaw(x) ? x.__raw : esc(x))).join('') : esc(v);
      return out + val + s;
    }, '');
  const raw = (s) => ({ __raw: s });
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const fmtTime = (ms) => (ms / 1000).toFixed(1) + '초';
  const normalize = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]$/, '');

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const seq = navSeq;
    const res = await fetch('/api' + path, {
      method,
      headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') {
      me = null;
      renderNav();
      location.hash = '#/login';
      throw new Error(data.error || '로그인이 필요합니다.');
    }
    if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
    if (method === 'GET' && seq !== navSeq) throw STALE;
    return data;
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return toast('이 브라우저는 발음 듣기를 지원하지 않습니다.');
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[가-힣]/.test(text) ? 'ko-KR' : 'en-US';
    u.rate = 0.9;
    speechSynthesis.speak(u);
  }

  function render(markup) {
    $app.innerHTML = markup;
    window.scrollTo(0, 0);
  }

  function renderNav() {
    $nav.innerHTML = me
      ? html`<span class="who">${me.name} <span class="tag">${me.role === 'teacher' ? '선생님' : '학생'}</span></span>
          <button class="btn sm" data-action="logout">로그아웃</button>`
      : html`<a class="btn sm" href="#/login">로그인</a>`;
  }

  $nav.addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="logout"]')) {
      await api('/logout', { method: 'POST' }).catch(() => {});
      me = null;
      renderNav();
      location.hash = '#/login';
    }
  });

  // ---------- router ----------
  const routes = [
    [/^\/login$/, viewLogin, false],
    [/^\/signup$/, viewSignup, false],
    [/^\/$/, viewHome],
    [/^\/class\/(\d+)$/, viewClass],
    [/^\/class\/(\d+)\/report$/, viewReport],
    [/^\/set\/new$/, (q) => viewEditSet(null, q)],
    [/^\/set\/(\d+)\/edit$/, (id) => viewEditSet(id)],
    [/^\/set\/(\d+)$/, viewSet],
    [/^\/set\/(\d+)\/(memorize|recall|spell|match|test)$/, viewStudy],
  ];

  async function router() {
    navSeq++;
    if (cleanup) {
      try { cleanup(); } catch {}
      cleanup = null;
    }
    const hash = location.hash.slice(1) || '/';
    const [path, qs] = hash.split('?');
    const query = new URLSearchParams(qs || '');
    for (const [re, view, needAuth = true] of routes) {
      const m = path.match(re);
      if (!m) continue;
      if (needAuth && !me) return (location.hash = '#/login');
      if (!needAuth && me) return (location.hash = '#/');
      try {
        const args = m.slice(1);
        await view(...(args.length ? args : [query]), query);
      } catch (e) {
        if (e === STALE) return;
        render(html`<div class="empty">${e.message} <br><br><a class="btn" href="#/">홈으로</a></div>`);
      }
      return;
    }
    location.hash = '#/';
  }

  // ---------- auth ----------
  function viewLogin() {
    render(html`
      <div class="auth-wrap">
        <div class="auth-hero">
          <h1>LangCard</h1>
          <p>클래스와 함께하는 단어 학습</p>
        </div>
        <form class="card" id="f">
          <label class="field"><span>아이디</span><input class="input" name="username" autocomplete="username" required autofocus></label>
          <label class="field"><span>비밀번호</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
          <div class="error" id="err"></div>
          <button class="btn primary block lg">로그인</button>
          <p class="center small muted">계정이 없나요? <a href="#/signup">회원가입</a></p>
        </form>
      </div>`);
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        me = (await api('/login', { method: 'POST', body: fd })).user;
        renderNav();
        location.hash = '#/';
      } catch (err) {
        document.getElementById('err').textContent = err.message;
      }
    };
  }

  function viewSignup() {
    render(html`
      <div class="auth-wrap">
        <div class="auth-hero"><h1>회원가입</h1><p>학생 또는 선생님으로 시작하세요</p></div>
        <form class="card" id="f">
          <div class="field"><span>회원 유형</span>
            <div class="seg">
              <label><input type="radio" name="role" value="student" checked>학생</label>
              <label><input type="radio" name="role" value="teacher">선생님</label>
            </div>
          </div>
          <label class="field"><span>이름</span><input class="input" name="name" required maxlength="30"></label>
          <label class="field"><span>아이디</span><input class="input" name="username" required pattern="[a-z0-9_]{4,30}" title="영문 소문자/숫자/밑줄 4~30자" autocomplete="username"></label>
          <label class="field"><span>비밀번호</span><input class="input" type="password" name="password" minlength="6" required autocomplete="new-password"></label>
          <div class="error" id="err"></div>
          <button class="btn primary block lg">가입하기</button>
          <p class="center small muted">이미 계정이 있나요? <a href="#/login">로그인</a></p>
        </form>
      </div>`);
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        me = (await api('/signup', { method: 'POST', body: fd })).user;
        renderNav();
        location.hash = '#/';
      } catch (err) {
        document.getElementById('err').textContent = err.message;
      }
    };
  }

  // ---------- home ----------
  const progressBar = (p) => raw(`<div class="progress"><i style="width:${Number(p) || 0}%"></i></div>`);

  function setTile(s, showProgress = true) {
    const p = s.progress;
    return raw(html`
      <a class="card tile" href="#/set/${s.id}">
        <h3>${s.title}</h3>
        <p class="muted small" style="margin:0 0 10px">${s.card_count}단어${s.description ? ' · ' + s.description : ''}</p>
        ${showProgress && p ? raw(html`${progressBar(p.percent)}<p class="small muted" style="margin:6px 0 0">암기 ${p.known}/${p.total} (${p.percent}%)</p>`) : ''}
      </a>`);
  }

  async function viewHome() {
    const { classes, mySets, recent } = await api('/dashboard');
    const teacher = me.role === 'teacher';
    render(html`
      <h1>안녕하세요, ${me.name}님 👋</h1>
      <p class="muted">${teacher ? '클래스를 만들고 단어 세트를 배정해보세요.' : '오늘도 단어 학습을 시작해볼까요?'}</p>

      <div class="section-title">
        <h2>${teacher ? '내 클래스' : '참여 중인 클래스'}</h2>
        ${teacher
          ? raw('<button class="btn sm primary" id="newClass">+ 클래스 만들기</button>')
          : raw('<button class="btn sm primary" id="joinClass">+ 클래스 참여</button>')}
      </div>
      ${classes.length
        ? raw(html`<div class="grid">${classes.map((c) =>
            raw(html`<a class="card tile" href="#/class/${c.id}">
              <h3>${c.name}</h3>
              <p class="muted small" style="margin:0">
                ${teacher ? `학생 ${c.member_count}명 · 세트 ${c.set_count}개` : `${c.teacher_name} 선생님 · 세트 ${c.set_count}개`}
              </p>
              ${teacher ? raw(html`<p style="margin:10px 0 0"><span class="code-badge">${c.code}</span></p>`) : ''}
            </a>`)
          )}</div>`)
        : raw(html`<div class="empty">${teacher ? '아직 만든 클래스가 없습니다.' : '선생님께 받은 클래스 코드로 참여해보세요.'}</div>`)}

      <div class="section-title">
        <h2>내가 만든 세트</h2>
        <a class="btn sm" href="#/set/new">+ 세트 만들기</a>
      </div>
      ${mySets.length
        ? raw(html`<div class="grid">${mySets.map((s) => setTile(s))}</div>`)
        : raw('<div class="empty">직접 단어 세트를 만들어 학습할 수 있어요.</div>')}

      ${recent.length
        ? raw(html`<div class="section-title"><h2>최근 학습</h2></div>
          <div class="card"><ul class="wordlist">${recent.map((r) =>
            raw(html`<li><a href="#/set/${r.set_id}" class="term">${r.title}</a>
              <span>${MODES[r.mode].name}</span>
              <span class="muted small">${r.mode === 'match' && r.time_ms ? fmtTime(r.time_ms) : `${r.score}/${r.total}`}</span></li>`)
          )}</ul></div>`)
        : ''}
    `);
    const nc = document.getElementById('newClass');
    if (nc)
      nc.onclick = async () => {
        const name = prompt('새 클래스 이름을 입력하세요');
        if (!name) return;
        try {
          const { class: c } = await api('/classes', { method: 'POST', body: { name } });
          toast(`클래스가 생성되었습니다. 참여 코드: ${c.code}`);
          location.hash = `#/class/${c.id}`;
        } catch (e) { toast(e.message); }
      };
    const jc = document.getElementById('joinClass');
    if (jc)
      jc.onclick = async () => {
        const code = prompt('선생님께 받은 클래스 코드를 입력하세요');
        if (!code) return;
        try {
          const { class: c } = await api('/classes/join', { method: 'POST', body: { code } });
          toast(`'${c.name}' 클래스에 참여했습니다.`);
          location.hash = `#/class/${c.id}`;
        } catch (e) { toast(e.message); }
      };
  }

  // ---------- class ----------
  async function viewClass(id) {
    const data = await api(`/classes/${id}`);
    const { class: c, isTeacher, sets, members } = data;
    let mySets = [];
    if (isTeacher) mySets = (await api('/dashboard')).mySets.filter((s) => !sets.some((x) => x.id === s.id));
    render(html`
      <p><a href="#/">← 홈</a></p>
      <div class="row between">
        <div>
          <h1 style="margin:0">${c.name}</h1>
          <p class="muted" style="margin:4px 0 0">${c.teacher_name} 선생님 · 학생 ${members.length}명</p>
        </div>
        ${isTeacher
          ? raw(html`<div class="row"><span class="muted small">참여 코드</span><span class="code-badge">${c.code}</span>
              <a class="btn sm" href="#/class/${c.id}/report">학습 현황</a></div>`)
          : ''}
      </div>

      <div class="section-title">
        <h2>단어 세트</h2>
        ${isTeacher
          ? raw(html`<div class="row">
              ${mySets.length ? raw(html`<select class="input" id="assignSel" style="width:auto">
                ${mySets.map((s) => raw(html`<option value="${s.id}">${s.title}</option>`))}</select>
                <button class="btn sm" id="assign">배정</button>`) : ''}
              <a class="btn sm primary" href="#/set/new?class=${c.id}">+ 새 세트</a></div>`)
          : ''}
      </div>
      ${sets.length
        ? raw(html`<div class="grid">${sets.map((s) =>
            isTeacher
              ? raw(html`<div class="card"><a class="tile" href="#/set/${s.id}"><h3>${s.title}</h3>
                  <p class="muted small">${s.card_count}단어</p></a>
                  <button class="btn sm danger" data-unassign="${s.id}">배정 해제</button></div>`)
              : setTile(s)
          )}</div>`)
        : raw('<div class="empty">아직 배정된 세트가 없습니다.</div>')}

      <div class="section-title"><h2>구성원</h2></div>
      ${members.length
        ? raw(html`<div class="card"><ul class="wordlist">${members.map((m) =>
            raw(html`<li><span class="term">${m.name}</span><span class="muted small">${m.username || ''}</span>
              ${isTeacher ? raw(html`<button class="btn sm ghost danger" data-kick="${m.id}">내보내기</button>`) : raw('<span></span>')}</li>`)
          )}</ul></div>`)
        : raw('<div class="empty">참여 코드를 학생들에게 알려주세요.</div>')}

      <p style="margin-top:28px">${isTeacher
        ? raw('<button class="btn danger" id="delClass">클래스 삭제</button>')
        : raw('<button class="btn danger" id="leave">클래스 나가기</button>')}</p>
    `);

    const on = (sel, fn) => { const el = document.getElementById(sel); if (el) el.onclick = fn; };
    const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); router(); } catch (e) { toast(e.message); } };
    on('assign', () => act(() => api(`/classes/${c.id}/sets`, { method: 'POST', body: { setId: Number(document.getElementById('assignSel').value) } }), '세트를 배정했습니다.'));
    on('delClass', async () => {
      if (!confirm('클래스를 삭제할까요? 되돌릴 수 없습니다.')) return;
      await api(`/classes/${c.id}`, { method: 'DELETE' }).catch((e) => toast(e.message));
      location.hash = '#/';
    });
    on('leave', async () => {
      if (!confirm('클래스에서 나갈까요?')) return;
      await api(`/classes/${c.id}/leave`, { method: 'POST' }).catch((e) => toast(e.message));
      location.hash = '#/';
    });
    $app.querySelectorAll('[data-unassign]').forEach((b) =>
      (b.onclick = () => act(() => api(`/classes/${c.id}/sets/${b.dataset.unassign}`, { method: 'DELETE' }), '배정을 해제했습니다.')));
    $app.querySelectorAll('[data-kick]').forEach((b) =>
      (b.onclick = () => confirm('이 학생을 내보낼까요?') && act(() => api(`/classes/${c.id}/members/${b.dataset.kick}`, { method: 'DELETE' }))));
  }

  async function viewReport(id) {
    const { class: c, sets, students } = await api(`/classes/${id}/report`);
    const cell = (p) => {
      if (!p) return '-';
      const modes = Object.keys(MODES).filter((m) => p.best[m]);
      return raw(html`<div><b>${p.percent}%</b></div><div class="small muted">${modes.map((m) => MODES[m].name.slice(0, 2)).join('·') || '미학습'}</div>`);
    };
    render(html`
      <p><a href="#/class/${c.id}">← ${c.name}</a></p>
      <h1>학습 현황</h1>
      <p class="muted">세트별 암기 완료율과 진행한 학습 모드입니다.</p>
      ${students.length && sets.length
        ? raw(html`<div class="card table-scroll"><table class="report">
            <thead><tr><th>학생</th>${sets.map((s) => raw(html`<th>${s.title}</th>`))}</tr></thead>
            <tbody>${students.map((st) =>
              raw(html`<tr><td><b>${st.name}</b><div class="small muted">${st.username}</div></td>
                ${sets.map((s) => raw(html`<td>${cell(st.sets[s.id])}</td>`))}</tr>`)
            )}</tbody></table></div>`)
        : raw('<div class="empty">학생 또는 배정된 세트가 없습니다.</div>')}
    `);
  }

  // ---------- set detail ----------
  async function viewSet(id) {
    const { set, cards, progress, summary } = await api(`/sets/${id}`);
    const best = summary.best;
    const bestText = (m) => {
      const b = best[m];
      if (!b) return '';
      if (m === 'match') return b.bestTime ? `최고 ${fmtTime(b.bestTime)}` : '';
      if (m === 'memorize') return `${b.plays}회 학습`;
      return `최고 ${b.percent}%`;
    };
    render(html`
      <p><a href="javascript:history.back()">← 뒤로</a></p>
      <div class="row between">
        <div class="grow">
          <h1 style="margin:0">${set.title}</h1>
          <p class="muted" style="margin:4px 0 0">${cards.length}단어 · ${set.owner_name}${set.description ? ' · ' + set.description : ''}</p>
        </div>
        ${set.isOwner ? raw(html`<div class="row"><a class="btn sm" href="#/set/${set.id}/edit">편집</a><button class="btn sm danger" id="del">삭제</button></div>`) : ''}
      </div>

      <div class="card" style="margin-top:16px">
        <div class="row between small"><b>암기 완료 ${summary.known} / ${summary.total}</b>
          <button class="btn sm ghost" id="reset">진도 초기화</button></div>
        ${progressBar(summary.percent)}
      </div>

      <div class="section-title"><h2>학습하기</h2></div>
      <div class="modes">
        ${Object.entries(MODES).map(([k, m]) =>
          raw(html`<a class="mode ${k}" href="#/set/${set.id}/${k}">${m.name}<small>${m.desc}</small>
            <span class="best">${bestText(k)}</span></a>`))}
      </div>

      <div class="section-title"><h2>단어 목록</h2><span class="small muted">● 초록: 암기 · 빨강: 복습 필요</span></div>
      <div class="card"><ul class="wordlist">
        ${cards.map((c) => {
          const p = progress[c.id];
          return raw(html`<li>
            <span class="row"><span class="dot ${p ? (p.known ? 'known' : 'unknown') : ''}"></span><span class="term">${c.term}</span></span>
            <span>${c.meaning}</span>
            <button class="icon-btn" data-say="${c.term}" aria-label="발음 듣기">🔊</button>
            ${c.example ? raw(html`<span class="ex">${c.example}</span>`) : ''}
          </li>`);
        })}
      </ul></div>
    `);
    $app.querySelectorAll('[data-say]').forEach((b) => (b.onclick = () => speak(b.dataset.say)));
    document.getElementById('reset').onclick = async () => {
      if (!confirm('이 세트의 암기 진도를 초기화할까요?')) return;
      await api(`/sets/${set.id}/reset`, { method: 'POST' });
      router();
    };
    const del = document.getElementById('del');
    if (del)
      del.onclick = async () => {
        if (!confirm('세트를 삭제할까요? 학습 기록도 함께 삭제됩니다.')) return;
        await api(`/sets/${set.id}`, { method: 'DELETE' });
        toast('삭제되었습니다.');
        location.hash = '#/';
      };
  }

  // ---------- set editor ----------
  async function viewEditSet(id, query) {
    let set = { title: '', description: '' };
    let cards = [{}, {}, {}, {}, {}];
    if (id) {
      const d = await api(`/sets/${id}`);
      if (!d.set.isOwner) throw new Error('편집 권한이 없습니다.');
      set = d.set;
      cards = d.cards;
    }
    const classId = query && query.get ? query.get('class') : null;
    render(html`
      <p><a href="javascript:history.back()">← 뒤로</a></p>
      <h1>${id ? '세트 편집' : '새 단어 세트'}</h1>
      <form id="f" class="stack">
        <div class="card">
          <label class="field"><span>제목</span><input class="input" name="title" value="${set.title}" required maxlength="100" placeholder="예) 수능 필수 영단어 Day 3"></label>
          <label class="field" style="margin:0"><span>설명 (선택)</span><input class="input" name="description" value="${set.description}" maxlength="300"></label>
        </div>
        <div class="card">
          <div class="row between"><h2 style="margin:0">카드</h2>
            <button type="button" class="btn sm" id="bulkBtn">한꺼번에 붙여넣기</button></div>
          <div id="bulk" hidden style="margin-top:12px">
            <p class="small muted">한 줄에 하나씩 <b>단어 [탭 또는 , 또는 =] 뜻 [구분자] 예문</b> 형식으로 붙여넣으세요. 엑셀에서 복사해도 됩니다.</p>
            <textarea class="input" id="bulkText" rows="6" placeholder="apple, 사과&#10;banana	바나나	I like bananas."></textarea>
            <div class="row" style="margin-top:8px"><button type="button" class="btn sm primary" id="bulkAdd">카드로 추가</button></div>
          </div>
          <div id="rows" style="margin-top:14px"></div>
          <button type="button" class="btn block" id="addRow">+ 카드 추가</button>
        </div>
        <div class="error" id="err"></div>
        <button class="btn primary lg block">${id ? '저장하기' : '세트 만들기'}</button>
      </form>
    `);
    const $rows = document.getElementById('rows');
    const rowHtml = (c = {}) => html`<div class="edit-row">
      <span class="n"></span>
      <input class="input" data-k="term" placeholder="단어" value="${c.term || ''}" maxlength="200">
      <input class="input" data-k="meaning" placeholder="뜻" value="${c.meaning || ''}" maxlength="200">
      <input class="input ex-in" data-k="example" placeholder="예문 (선택)" value="${c.example || ''}" maxlength="500">
      <button type="button" class="icon-btn" data-remove aria-label="삭제">✕</button></div>`;
    const renumber = () => $rows.querySelectorAll('.n').forEach((n, i) => (n.textContent = i + 1));
    const addRows = (list) => {
      $rows.insertAdjacentHTML('beforeend', list.map(rowHtml).join(''));
      renumber();
    };
    addRows(cards);
    $rows.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) {
        e.target.closest('.edit-row').remove();
        renumber();
      }
    });
    document.getElementById('addRow').onclick = () => {
      addRows([{}]);
      $rows.lastElementChild.querySelector('input').focus();
    };
    document.getElementById('bulkBtn').onclick = () => {
      const b = document.getElementById('bulk');
      b.hidden = !b.hidden;
    };
    document.getElementById('bulkAdd').onclick = () => {
      const lines = document.getElementById('bulkText').value.split('\n').map((l) => l.trim()).filter(Boolean);
      const parsed = lines.map((l) => {
        const parts = l.includes('\t') ? l.split('\t') : l.includes('=') ? l.split('=') : l.split(/,(.*)/s).filter((x) => x !== undefined);
        let [term = '', meaning = '', ...rest] = parts.map((p) => p.trim());
        // 쉼표 구분일 때 뜻 안의 쉼표를 보존하기 위해 첫 쉼표로만 나눈다
        return { term, meaning, example: rest.join(' ').trim() };
      }).filter((c) => c.term && c.meaning);
      // 비어있는 행 제거 후 추가
      $rows.querySelectorAll('.edit-row').forEach((r) => {
        if ([...r.querySelectorAll('input')].every((i) => !i.value.trim())) r.remove();
      });
      addRows(parsed);
      document.getElementById('bulkText').value = '';
      document.getElementById('bulk').hidden = true;
      toast(`${parsed.length}개의 카드를 추가했습니다.`);
    };
    document.getElementById('f').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const list = [...$rows.querySelectorAll('.edit-row')].map((r) => {
        const o = {};
        r.querySelectorAll('[data-k]').forEach((i) => (o[i.dataset.k] = i.value));
        return o;
      });
      const body = { title: fd.get('title'), description: fd.get('description'), cards: list, classId: classId ? Number(classId) : undefined };
      try {
        if (id) {
          await api(`/sets/${id}`, { method: 'PUT', body });
          toast('저장되었습니다.');
          location.hash = `#/set/${id}`;
        } else {
          const r = await api('/sets', { method: 'POST', body });
          toast('세트가 만들어졌습니다.');
          location.hash = `#/set/${r.set.id}`;
        }
      } catch (err) {
        document.getElementById('err').textContent = err.message;
      }
    };
  }

  // ---------- study ----------
  async function viewStudy(id, mode) {
    const data = await api(`/sets/${id}`);
    if (data.cards.length < 2) throw new Error('학습하려면 카드가 2개 이상 필요합니다.');
    const ctx = { set: data.set, cards: data.cards, pool: data.cards, progress: data.progress, mode };
    ({ memorize: studyMemorize, recall: studyRecall, spell: studySpell, match: studyMatch, test: studyTest })[mode](ctx);
  }

  function studyHeader(ctx, done, total, extra = '') {
    return raw(html`
      <div class="study-head">
        <a class="btn sm ghost" href="#/set/${ctx.set.id}" aria-label="닫기">✕</a>
        ${progressBar(total ? (done / total) * 100 : 0)}
        <span class="count">${extra ? raw(extra) : `${done} / ${total}`}</span>
      </div>
      <p class="small muted" style="margin:-8px 0 12px">${MODES[ctx.mode].name} · ${ctx.set.title}</p>`);
  }

  function bindKeys(handler) {
    const fn = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      handler(e);
    };
    window.addEventListener('keydown', fn);
    const prev = cleanup;
    cleanup = () => {
      window.removeEventListener('keydown', fn);
      if (prev) prev();
    };
  }

  async function saveRecord(ctx, payload) {
    render('<div class="empty">결과 저장 중…</div>');
    try {
      return await api(`/sets/${ctx.set.id}/records`, { method: 'POST', body: { mode: ctx.mode, ...payload } });
    } catch (e) {
      toast('기록 저장 실패: ' + e.message);
    }
  }

  function showResult(ctx, { score, total, wrong = [], extra = '' }) {
    const pct = total ? Math.round((score / total) * 100) : 0;
    const msg = pct === 100 ? '완벽해요! 🎉' : pct >= 80 ? '아주 잘했어요! 👏' : pct >= 50 ? '좋아요, 조금만 더! 💪' : '다시 한번 도전해봐요 📚';
    render(html`
      ${studyHeader(ctx, total, total)}
      <div class="card result">
        <h2>${msg}</h2>
        <div class="score-ring" style="--p:${pct}"><span>${pct}%</span></div>
        <p class="muted">${total}개 중 <b>${score}</b>개 정답 ${raw(extra)}</p>
        ${wrong.length
          ? raw(html`<div class="review"><h3>틀린 단어</h3><ul class="wordlist">${wrong.map((c) =>
              raw(html`<li><span class="term">${c.term}</span><span>${c.meaning}</span>
                ${c.given != null ? raw(html`<span class="small" style="color:var(--bad)">${c.given || '(빈칸)'}</span>`) : raw('<span></span>')}</li>`))}</ul></div>`)
          : ''}
        <div class="row" style="justify-content:center;margin-top:18px">
          <button class="btn primary" id="again">다시 하기</button>
          ${wrong.length && ctx.mode !== 'match' ? raw('<button class="btn" id="retryWrong">틀린 것만 다시</button>') : ''}
          <a class="btn" href="#/set/${ctx.set.id}">세트로 돌아가기</a>
        </div>
      </div>`);
    document.getElementById('again').onclick = () => router();
    const rw = document.getElementById('retryWrong');
    if (rw)
      rw.onclick = () => {
        if (cleanup) { cleanup(); cleanup = null; }
        const ids = new Set(wrong.map((w) => w.id));
        const sub = { ...ctx, cards: ctx.cards.filter((c) => ids.has(c.id)) };
        ({ memorize: studyMemorize, recall: studyRecall, spell: studySpell, test: studyTest })[ctx.mode](sub);
      };
  }

  // 1) 암기학습: 카드 뒤집기 + 알아요/몰라요, 모르는 카드는 다음 라운드에서 반복
  function studyMemorize(ctx) {
    const total = ctx.cards.length;
    const firstAnswer = new Map(); // cardId -> 처음 응답이 '알아요'였는지
    let queue = shuffle(ctx.cards);
    let retry = [];
    let round = 1;
    let flipped = false;

    const flip = () => {
      const el = document.getElementById('flash');
      if (!el) return;
      flipped = !flipped;
      el.classList.toggle('flipped', flipped);
    };
    const answer = (ok) => {
      const c = queue.shift();
      if (!c) return;
      if (!firstAnswer.has(c.id)) firstAnswer.set(c.id, ok);
      if (!ok) retry.push(c);
      show();
    };
    const show = () => {
      if (!queue.length) {
        if (!retry.length) return finish();
        queue = shuffle(retry);
        retry = [];
        round++;
        toast(`${round}라운드: 모르는 단어 ${queue.length}개 복습`);
      }
      const c = queue[0];
      flipped = false;
      const done = total - queue.length - retry.length;
      render(html`
        ${studyHeader(ctx, done, total)}
        <div class="flash-wrap"><div class="flash" id="flash">
          <div class="face front"><div class="big">${c.term}</div><span class="hint">카드를 눌러 뜻 확인 (Space)</span></div>
          <div class="face back"><div class="mid">${c.meaning}</div>${c.example ? raw(html`<div class="muted">${c.example}</div>`) : ''}</div>
        </div></div>
        <div class="row" style="justify-content:center;margin-top:8px"><button class="btn sm ghost" id="say">🔊 발음 듣기</button></div>
        <div class="answer-row">
          <button class="btn dont" id="dont">몰라요 (←)</button>
          <button class="btn know" id="know">알아요 (→)</button>
        </div>`);
      document.getElementById('flash').onclick = flip;
      document.getElementById('say').onclick = () => speak(c.term);
      document.getElementById('know').onclick = () => answer(true);
      document.getElementById('dont').onclick = () => answer(false);
    };
    const finish = async () => {
      const results = [...firstAnswer.entries()].map(([cardId, correct]) => ({ cardId, correct }));
      const score = results.filter((r) => r.correct).length;
      await saveRecord(ctx, { score, total, results });
      showResult(ctx, {
        score, total,
        wrong: ctx.cards.filter((c) => firstAnswer.get(c.id) === false),
        extra: round > 1 ? `<br>(${round}라운드 만에 모두 암기)` : '',
      });
    };
    bindKeys((e) => {
      if (e.code === 'Space') { e.preventDefault(); flip(); }
      else if (e.key === 'ArrowRight') answer(true);
      else if (e.key === 'ArrowLeft') answer(false);
    });
    show();
  }

  // 객관식 보기 생성
  function makeChoices(card, pool, field) {
    const others = shuffle(pool.filter((c) => c.id !== card.id && c[field] !== card[field]));
    const uniq = [];
    for (const o of others) if (!uniq.some((u) => u[field] === o[field])) uniq.push(o);
    return shuffle([card, ...uniq.slice(0, 3)]);
  }

  // 2) 리콜학습: 단어 → 뜻 4지선다, 틀린 단어는 뒤에서 다시 출제
  function studyRecall(ctx) {
    let queue = shuffle(ctx.cards);
    const total = ctx.cards.length;
    const first = new Map();
    let solved = 0;
    let locked = false;
    const show = () => {
      if (!queue.length) return finish();
      locked = false;
      const c = queue[0];
      const choices = makeChoices(c, ctx.pool, 'meaning');
      render(html`
        ${studyHeader(ctx, solved, total)}
        <div class="card prompt-card"><div class="big">${c.term}</div>
          <button class="btn sm ghost" id="say">🔊</button></div>
        <div class="choices">${choices.map((o, i) =>
          raw(html`<button class="choice" data-id="${o.id}"><span class="num">${i + 1}</span>${o.meaning}</button>`))}</div>
        <div class="feedback" id="fb"></div>`);
      document.getElementById('say').onclick = () => speak(c.term);
      $app.querySelectorAll('.choice').forEach((b) => (b.onclick = () => pick(b)));
    };
    const pick = (btn) => {
      if (locked) return;
      locked = true;
      const c = queue[0];
      const ok = Number(btn.dataset.id) === c.id;
      if (!first.has(c.id)) first.set(c.id, ok);
      $app.querySelectorAll('.choice').forEach((b) => {
        b.disabled = true;
        if (Number(b.dataset.id) === c.id) b.classList.add('correct');
      });
      const fb = document.getElementById('fb');
      queue.shift();
      if (ok) {
        solved++;
        fb.className = 'feedback good';
        fb.textContent = '정답!';
      } else {
        btn.classList.add('wrong');
        fb.className = 'feedback bad';
        fb.textContent = `오답 · ${c.term} = ${c.meaning}`;
        queue.splice(Math.min(queue.length, 3), 0, c); // 조금 뒤에 다시 출제
      }
      setTimeout(show, ok ? 650 : 1500);
    };
    const finish = async () => {
      const results = [...first.entries()].map(([cardId, correct]) => ({ cardId, correct }));
      const score = results.filter((r) => r.correct).length;
      await saveRecord(ctx, { score, total, results });
      showResult(ctx, { score, total, wrong: ctx.cards.filter((c) => first.get(c.id) === false) });
    };
    bindKeys((e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 4) {
        const b = $app.querySelectorAll('.choice')[n - 1];
        if (b) pick(b);
      }
    });
    show();
  }

  // 3) 스펠학습: 뜻 → 철자 입력
  function studySpell(ctx) {
    let queue = shuffle(ctx.cards);
    const total = ctx.cards.length;
    const first = new Map();
    const given = new Map();
    let solved = 0;
    const show = () => {
      if (!queue.length) return finish();
      const c = queue[0];
      let hintLevel = 0;
      render(html`
        ${studyHeader(ctx, solved, total)}
        <div class="card prompt-card"><div class="mid">${c.meaning}</div>
          ${c.example ? raw(html`<p class="muted">${c.example.replace(new RegExp(c.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '____')}</p>`) : ''}
        </div>
        <form id="f" style="margin-top:16px">
          <input class="input spell-input" id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="영어 단어를 입력하세요" autofocus>
          <div class="feedback" id="fb"></div>
          <div class="row" style="justify-content:center;margin-top:8px">
            <button type="button" class="btn" id="hint">힌트</button>
            <button class="btn primary" id="submit">확인 (Enter)</button>
          </div>
        </form>`);
      const $in = document.getElementById('ans');
      const fb = document.getElementById('fb');
      $in.focus();
      let checked = false;
      document.getElementById('hint').onclick = () => {
        hintLevel = Math.min(c.term.length, hintLevel + 1);
        fb.className = 'feedback';
        fb.textContent = '힌트: ' + c.term.slice(0, hintLevel) + c.term.slice(hintLevel).replace(/[^\s]/g, '_');
        $in.focus();
      };
      document.getElementById('f').onsubmit = (e) => {
        e.preventDefault();
        if (checked) return next();
        const val = $in.value;
        if (!val.trim()) return;
        checked = true;
        const ok = normalize(val) === normalize(c.term);
        if (!first.has(c.id)) {
          first.set(c.id, ok && hintLevel === 0);
          given.set(c.id, val);
        }
        $in.readOnly = true;
        $in.classList.add(ok ? 'correct' : 'wrong');
        queue.shift();
        if (ok) {
          solved++;
          fb.className = 'feedback good';
          fb.textContent = hintLevel ? '정답! (힌트 사용)' : '정답!';
          speak(c.term);
          setTimeout(next, 800);
        } else {
          fb.className = 'feedback bad';
          fb.textContent = `정답: ${c.term}  — Enter를 눌러 계속`;
          queue.splice(Math.min(queue.length, 3), 0, c);
        }
      };
      let moved = false;
      const next = () => { if (!moved) { moved = true; show(); } };
    };
    const finish = async () => {
      const results = [...first.entries()].map(([cardId, correct]) => ({ cardId, correct }));
      const score = results.filter((r) => r.correct).length;
      await saveRecord(ctx, { score, total, results });
      showResult(ctx, {
        score, total,
        wrong: ctx.cards.filter((c) => first.get(c.id) === false).map((c) => ({ ...c, given: given.get(c.id) })),
      });
    };
    show();
  }

  // 4) 매칭게임: 단어-뜻 타일 짝 맞추기, 시간 기록 (오답 시 +1초 패널티)
  async function studyMatch(ctx) {
    const pairs = shuffle(ctx.cards).slice(0, 6);
    let tiles = shuffle([
      ...pairs.map((c) => ({ id: c.id, kind: 'term', text: c.term })),
      ...pairs.map((c) => ({ id: c.id, kind: 'meaning', text: c.meaning })),
    ]);
    let rankingHtml = '';
    try {
      const { ranking } = await api(`/sets/${ctx.set.id}/ranking`);
      if (ranking.length)
        rankingHtml = html`<div class="card" style="margin-top:16px"><h3>🏆 클래스 랭킹</h3><ol class="ranking" style="padding:0;list-style:none;margin:0">${ranking.slice(0, 5).map((r) =>
          raw(html`<li class="${r.me ? 'me' : ''}"><span>${r.rank}. ${r.name}</span><span>${fmtTime(r.best_time)}</span></li>`))}</ol></div>`;
    } catch {}

    render(html`
      ${studyHeader(ctx, 0, pairs.length)}
      <div class="card center">
        <h2>매칭게임</h2>
        <p class="muted">단어와 뜻을 짝지어 모든 타일을 없애세요.<br>틀리면 1초가 추가됩니다.</p>
        <button class="btn primary lg" id="start">시작하기</button>
      </div>
      ${raw(rankingHtml)}`);
    document.getElementById('start').onclick = start;

    function start() {
      const t0 = performance.now();
      let penalty = 0;
      let selected = null;
      let matched = 0;
      let mistakes = 0;
      render(html`
        <div class="study-head">
          <a class="btn sm ghost" href="#/set/${ctx.set.id}">✕</a>
          <div class="progress"><i id="pbar" style="width:0%"></i></div>
          <span class="timer" id="timer">0.0</span>
        </div>
        <div class="match-grid">${tiles.map((t, i) =>
          raw(html`<button class="match-tile ${t.kind}" data-i="${i}">${t.text}</button>`))}</div>`);
      const $timer = document.getElementById('timer');
      const iv = setInterval(() => ($timer.textContent = ((performance.now() - t0 + penalty) / 1000).toFixed(1)), 100);
      const prev = cleanup;
      cleanup = () => { clearInterval(iv); if (prev) prev(); };
      $app.querySelector('.match-grid').onclick = (e) => {
        const el = e.target.closest('.match-tile');
        if (!el || el.classList.contains('done')) return;
        const t = tiles[el.dataset.i];
        if (!selected) {
          selected = el;
          el.classList.add('selected');
          return;
        }
        if (selected === el) {
          el.classList.remove('selected');
          selected = null;
          return;
        }
        const s = tiles[selected.dataset.i];
        if (s.id === t.id && s.kind !== t.kind) {
          selected.classList.add('done');
          el.classList.add('done');
          matched++;
          document.getElementById('pbar').style.width = (matched / pairs.length) * 100 + '%';
          if (matched === pairs.length) finish();
        } else {
          mistakes++;
          penalty += 1000;
          const a = selected;
          a.classList.add('wrong');
          el.classList.add('wrong');
          setTimeout(() => { a.classList.remove('wrong', 'selected'); el.classList.remove('wrong'); }, 350);
        }
        selected.classList.remove('selected');
        selected = null;
      };
      async function finish() {
        clearInterval(iv);
        const timeMs = Math.round(performance.now() - t0 + penalty);
        await saveRecord(ctx, {
          score: pairs.length, total: pairs.length, timeMs,
          results: pairs.map((c) => ({ cardId: c.id, correct: true })),
        });
        tiles = shuffle(tiles);
        showResult(ctx, {
          score: pairs.length, total: pairs.length,
          extra: `<br>기록 <b>${fmtTime(timeMs)}</b> (실수 ${mistakes}회)`,
        });
      }
    }
  }

  // 5) 테스트: 객관식(단어→뜻, 뜻→단어)과 주관식(철자)을 섞은 시험, 끝날 때까지 정답 공개 안 함
  function studyTest(ctx) {
    const qs = shuffle(ctx.cards).slice(0, 20).map((c, i) => {
      const type = ['mc-term', 'mc-meaning', 'spell'][i % 3];
      return { card: c, type, choices: type === 'spell' ? null : makeChoices(c, ctx.pool, type === 'mc-term' ? 'meaning' : 'term') };
    });
    const ordered = shuffle(qs);
    const answers = new Array(ordered.length).fill(null);
    let idx = 0;
    const show = () => {
      if (idx >= ordered.length) return finish();
      const q = ordered[idx];
      const c = q.card;
      const prompt = q.type === 'mc-term'
        ? raw(html`<p class="small muted">알맞은 뜻을 고르세요</p><div class="big">${c.term}</div>`)
        : q.type === 'mc-meaning'
          ? raw(html`<p class="small muted">알맞은 단어를 고르세요</p><div class="mid">${c.meaning}</div>`)
          : raw(html`<p class="small muted">영어 단어를 쓰세요</p><div class="mid">${c.meaning}</div>`);
      render(html`
        ${studyHeader(ctx, idx, ordered.length)}
        <div class="card prompt-card">${prompt}</div>
        ${q.type === 'spell'
          ? raw(html`<form id="f" style="margin-top:16px"><input class="input spell-input" id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="정답 입력">
              <div class="row" style="justify-content:center;margin-top:10px"><button class="btn primary">다음 (Enter)</button></div></form>`)
          : raw(html`<div class="choices">${q.choices.map((o, i) =>
              raw(html`<button class="choice" data-id="${o.id}"><span class="num">${i + 1}</span>${q.type === 'mc-term' ? o.meaning : o.term}</button>`))}</div>`)}`);
      if (q.type === 'spell') {
        const $in = document.getElementById('ans');
        $in.focus();
        document.getElementById('f').onsubmit = (e) => {
          e.preventDefault();
          answers[idx] = { correct: normalize($in.value) === normalize(c.term), given: $in.value };
          idx++;
          show();
        };
      } else {
        $app.querySelectorAll('.choice').forEach((b) => (b.onclick = () => choose(b)));
      }
    };
    const choose = (b) => {
      const q = ordered[idx];
      const chosen = q.choices.find((o) => o.id === Number(b.dataset.id));
      answers[idx] = { correct: chosen.id === q.card.id, given: q.type === 'mc-term' ? chosen.meaning : chosen.term };
      idx++;
      show();
    };
    bindKeys((e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= 4) {
        const b = $app.querySelectorAll('.choice')[n - 1];
        if (b) choose(b);
      }
    });
    const finish = async () => {
      const results = ordered.map((q, i) => ({ cardId: q.card.id, correct: !!answers[i]?.correct }));
      const score = results.filter((r) => r.correct).length;
      await saveRecord(ctx, { score, total: ordered.length, results });
      showResult(ctx, {
        score, total: ordered.length,
        wrong: ordered.filter((_, i) => !answers[i]?.correct).map((q) => ({ ...q.card, given: answers[ordered.indexOf(q)]?.given ?? '' })),
      });
    };
    show();
  }

  // ---------- boot ----------
  window.addEventListener('hashchange', router);
  (async () => {
    try {
      me = (await api('/me')).user;
    } catch {}
    renderNav();
    router();
  })();
})();
