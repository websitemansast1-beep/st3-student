// ===== MFX Student App =====
const API = 'https://web-production-dcdc4.up.railway.app/api';

function toast(msg) {
  let t = document.querySelector('.toast');
  if (t) t.remove();
  t = document.createElement('div');y
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 400); }, 3000);
}

// ===== Global loading / anti-duplicate-click helpers =====
const activeLocks = new Set();
async function withButtonLock(btn, busyText, fn) {
  if (!btn || btn.dataset.locked === '1') return;
  const original = btn.innerHTML;
  btn.dataset.locked = '1';
  btn.disabled = true;
  btn.classList.add('is-loading');
  if (busyText) btn.innerHTML = busyText + '<span class="mfx-spinner"></span>';
  try {
    return await fn();
  } finally {
    btn.dataset.locked = '0';
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.innerHTML = original;
  }
}

function showPageLoader() {
  if (document.querySelector('.mfx-page-loader')) return;
  const el = document.createElement('div');
  el.className = 'mfx-page-loader';
  el.innerHTML = '<div class="mfx-page-loader-content"><div class="mfx-page-loader-ring"></div><div class="mfx-page-loader-credit">صنع بواسطة يوسف ماهر</div></div>';
  document.body.appendChild(el);
}
function hidePageLoader() {
  const el = document.querySelector('.mfx-page-loader');
  if (!el) return;
  el.classList.add('is-hiding');
  setTimeout(() => el.remove(), 200);
}
async function withPageLoader(fn) {
  showPageLoader();
  try {
    return await fn();
  } finally {
    hidePageLoader();
  }
}

function getToken() { return localStorage.getItem('mfx_student_token'); }
function setToken(t) { localStorage.setItem('mfx_student_token', t); }
function getUser() { try { return JSON.parse(localStorage.getItem('mfx_student_user') || '{}'); } catch(e) { return {}; } }
function logout() { localStorage.removeItem('mfx_student_token'); localStorage.removeItem('mfx_student_user'); location.href = 'login.html'; }

function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return false;
    return Date.now() >= payload.exp * 1000;
  } catch (e) {
    return true;
  }
}

// api() now accepts an optional timeoutMs. When set, the request is
// aborted after that many milliseconds and api() throws a clearly-marked
// timeout error instead of leaving the caller's spinner running forever.
// Default stays generous (15s) for normal pages; login passes a tight 4s
// on top of this (see handleLogin below).
async function api(path, opts = {}) {
  const url = API + path;
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const timeoutMs = opts.timeoutMs || 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers }, signal: controller.signal });
    if (res.status === 401) { logout(); return; }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      const timeoutErr = new Error('TIMEOUT');
      timeoutErr.isTimeout = true;
      throw timeoutErr;
    }
    toast('❌ خطأ في الاتصال');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Auth check
function requireAuth() {
  const onLoginPage = location.pathname.includes('login.html');
  const token = getToken();
  if (onLoginPage) return;
  if (!token || isTokenExpired(token)) {
    logout();
  }
}

// Login
// The request now has a hard 10-second ceiling. Before this, if the
// server was slow to answer (busy, cold-starting, whatever) the button
// just sat there spinning indefinitely with no feedback — that "frozen"
// feeling was the actual complaint. Now: at 10 seconds with no answer,
// the request is cancelled, the button re-enables, and the student sees
// a clear "try again" message instead of a screen that looks stuck.
// NOTE: this makes login FAIL FAST when the server is slow, it doesn't
// make the server itself faster — if the backend genuinely needs more
// than 10s under heavy load, this will show "حاول تاني" more often
// rather than eventually succeeding. That trade-off (fast clear failure
// vs. a silent freeze) is what was asked for here.
async function handleLogin(e) {
  e.preventDefault();
  const form = document.getElementById('login-form');
  const btn = document.getElementById('login-submit-btn');
  const code = document.getElementById('login-code')?.value.trim();
  const name = document.getElementById('login-name')?.value.trim();
  const phone = document.getElementById('login-phone')?.value.trim();
  const guardianPhone = document.getElementById('login-guardian-phone')?.value.trim();
  if (!code || !name || !phone || !guardianPhone) { toast('❌ أدخل الكود والاسم ورقم تليفونك ورقم تليفون ولي الأمر'); return; }

  await withButtonLock(btn, 'جاري تسجيل الدخول...', async () => {
    if (form) form.querySelectorAll('input').forEach((i) => i.disabled = true);
    try {
      const data = await api('/auth/student-login', {
        method: 'POST',
        body: JSON.stringify({ code, name, phone, guardianPhone }),
        timeoutMs: 10000
      });
      if (data && data.token) {
        setToken(data.token);
        localStorage.setItem('mfx_student_user', JSON.stringify(data.user));
        toast('✅ تم تسجيل الدخول');
        location.href = 'index.html';
      } else {
        toast('❌ ' + ((data && data.error) || 'كود أو اسم غير صحيح'));
        if (form) form.querySelectorAll('input').forEach((i) => i.disabled = false);
      }
    } catch (err) {
      if (err && err.isTimeout) {
        toast('⏳ السيرفر بطيء دلوقتي — جرّب تاني كمان شوية');
      }
      if (form) form.querySelectorAll('input').forEach((i) => i.disabled = false);
    }
  });
}

// Load my courses
// Runs the actual fetch once. Throws on any failure (timeout, network
// error, bad response) instead of swallowing it — the caller below is
// what decides how to react to a failure vs. a genuinely empty list.
async function fetchMyCoursesOnce_() {
  const data = await api('/students/my-courses', { timeoutMs: 8000 });
  if (!data || data.ok === false) throw new Error((data && data.error) || 'bad response');
  return data;
}

// Was: any failure here (a slow/failed request, most commonly right
// after the forced reload on back-navigation — see the pageshow
// listener below) rendered the exact same "no courses" empty state as
// a student who genuinely has none. That's what made courses look like
// they "disappeared" on back — it wasn't that the data was gone, the
// fetch had just failed silently and gotten treated as "empty".
// Now: a failed fetch is retried ONCE automatically after a short
// pause (covers a one-off slow moment), and only shown to the student
// as a real, distinct "couldn't load — tap to retry" message if the
// retry also fails — never as the same message as "you have no
// courses".
async function loadMyCourses() {
  const grid = document.getElementById('my-courses');
  const empty = document.getElementById('courses-empty');
  if (!grid) return;
  let data;
  try {
    data = await fetchMyCoursesOnce_();
  } catch (e1) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      data = await fetchMyCoursesOnce_();
    } catch (e2) {
      console.error('loadMyCourses failed twice:', e2);
      grid.innerHTML = '';
      if (empty) {
        empty.style.display = 'block';
        empty.innerHTML = `
          <p style="margin-bottom:10px;">⚠️ تعذر تحميل الكورسات (مش لأنك مالكش كورسات — فيه مشكلة اتصال مؤقتة)</p>
          <button class="btn btn-primary" onclick="withPageLoader(loadMyCourses)">🔄 حاول تاني</button>
        `;
      }
      return;
    }
  }
  try {
    grid.innerHTML = '';
    if (!data.courses || !data.courses.length) {
      if (empty) { empty.style.display = 'block'; empty.innerHTML = '<p>مفيش كورسات مسجل فيها لسه</p>'; }
      return;
    }
    if (empty) empty.style.display = 'none';
    data.courses.forEach(c => {
      const div = document.createElement('div');
      div.className = 'card';
      div.innerHTML = `
        <div class="card-img">${c.icon || '📚'}</div>
        <div class="card-body">
          <span class="card-tag">${c.tag || 'كورس'}</span>
          <h3>${escapeHtml(c.title)}</h3>
          <p>${escapeHtml(c.description || '')}</p>
          <div style="margin:12px 0;">
            <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:0.85rem;">
              <span style="color:var(--text-secondary);">التقدم</span>
              <span style="color:var(--accent-light); font-weight:600;">${c.progress || 0}%</span>
            </div>
            <div class="prog"><div class="prog-fill" style="width:${c.progress || 0}%"></div></div>
          </div>
          <a href="course.html?id=${c.id}" class="btn btn-primary" style="width:100%;">متابعة الكورس</a>
        </div>
      `;
      grid.appendChild(div);
    });
  } catch (e) { grid.innerHTML = ''; if (empty) empty.style.display = 'block'; }
}

// Load course detail
async function loadCourse() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) { toast('❌ كورس غير موجود'); return; }
  try {
    const [c] = await Promise.all([
      api('/units?courseId=' + id),
      loadCourseExams(id)
    ]);
    document.getElementById('course-title').textContent = c.title || 'كورس';
    document.getElementById('course-desc').textContent = c.description || '';
    document.getElementById('course-meta').innerHTML = `
      <span>📚 ${c.units || 0} وحدة</span>
      <span>🎥 ${c.videos || 0} فيديو</span>
      <span>📝 ${c.exams || 0} امتحان</span>
    `;
    document.getElementById('course-badges').innerHTML = `
      ${c.popular ? '<span class="badge badge-warn">🔥 شائع</span>' : ''}
      <span class="badge badge-ok">✓ مسجل</span>
    `;
    renderUnits(c.units || []);
    renderVocabList_(c.vocabulary || []);
  } catch (e) { toast('❌ فشل تحميل الكورس'); }
}

function speakText_(text, lang, rate, onEnd) {
  if (!text) return;
  if (!('speechSynthesis' in window)) { toast('❌ متصفحك مش بيدعم النطق الصوتي'); return; }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang || 'en-US';
  utter.rate = parseFloat(rate) || 1;
  if (onEnd) { utter.onend = utter.onerror = onEnd; }
  window.speechSynthesis.speak(utter);
}

let currentCourseVocab = [];

function renderVocabList_(words) {
  currentCourseVocab = words || [];
  const list = document.getElementById('vocab-list');
  const empty = document.getElementById('vocab-empty');
  if (!list) return;
  if (!words.length) {
    list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  const langLabels = { 'en-US': 'EN', 'en-GB': 'EN', 'ar-EG': 'AR' };
  list.innerHTML = words.map((w, i) => `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-md);">
      <div style="display:flex; align-items:center; gap:10px;">
        <span class="badge badge-info">${langLabels[w.lang] || w.lang}</span>
        <span style="font-weight:600; font-size:1.05rem;">${escapeHtml(w.text)}</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <select class="inp" id="vocab-rate-${i}" style="width:auto; padding:6px 10px; font-size:0.8rem;">
          <option value="0.7">أبطأ</option>
          <option value="1" selected>عادي</option>
          <option value="1.3">أسرع</option>
        </select>
        <button class="btn btn-primary" id="vocab-play-${i}" style="padding:6px 16px;" onclick="playVocabWord_(${i})">▶ تشغيل</button>
      </div>
    </div>
  `).join('');
}

function playVocabWord_(i) {
  const word = currentCourseVocab[i];
  if (!word) return;
  const rateSel = document.getElementById('vocab-rate-' + i);
  const rate = rateSel ? rateSel.value : (word.rate || 1);
  const btn = document.getElementById('vocab-play-' + i);
  if (btn) { btn.disabled = true; btn.textContent = '🔊 بيتكلم...'; }
  speakText_(word.text, word.lang, rate, () => { if (btn) { btn.disabled = false; btn.textContent = '▶ تشغيل'; } });
}

function renderUnits(units) {
  const list = document.getElementById('units-list');
  const empty = document.getElementById('units-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!units.length) { if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  units.forEach((u, i) => {
    const item = document.createElement('div');
    item.className = 'accordion-item' + (i === 0 ? ' open' : '');
    item.innerHTML = `
      <div class="accordion-header" onclick="toggleAcc(this)">
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="color:var(--accent);">📁</span>
          <h4>${escapeHtml(u.title)}</h4>
        </div>
        <div class="meta">
          <span>${u.videoCount || 0} فيديو</span>
          <span>${u.examCount || 0} امتحان</span>
          <span style="transform:${i===0?'rotate(180deg)':'rotate(0deg)'};">▼</span>
        </div>
      </div>
      <div class="accordion-content">
        ${u.content ? `<div style="padding:12px; margin-bottom:10px; background:var(--bg); border-radius:var(--radius-md); line-height:1.8; white-space:pre-wrap;">${u.content}</div>` : ''}
        <div style="display:flex; flex-direction:column; gap:8px;">
          ${(u.videos || []).map(v => `
            <a href="video.html?id=${v.id}" style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:var(--bg); border-radius:var(--radius-md); text-decoration:none; color:inherit;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span>▶️</span>
                <span>${escapeHtml(v.title)}</span>
                ${v.watched ? '<span class="badge badge-ok">✓ شُاهد</span>' : ''}
              </div>
              <span style="color:var(--text-muted); font-size:0.85rem;">${v.duration || ''}</span>
            </a>
          `).join('')}
          ${(u.presentations || []).map(p => `
            <a href="presentation.html?id=${p.id}" style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:var(--bg); border-radius:var(--radius-md); text-decoration:none; color:inherit;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span>📊</span>
                <span>${escapeHtml(p.title)}</span>
              </div>
              <span style="color:var(--text-muted); font-size:0.85rem;">${p.slideCount ? p.slideCount + ' شريحة' : 'بوربوينت'}</span>
            </a>
          `).join('')}
          ${(u.exams || []).map(ex => `
            <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:var(--bg); border-radius:var(--radius-md);">
              <div style="display:flex; align-items:center; gap:10px;">
                <span>📝</span>
                <span>${escapeHtml(ex.title)}</span>
              </div>
              <a href="exam.html?id=${ex.id}" class="btn btn-primary btn-sm">بدء</a>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    list.appendChild(item);
  });
}

async function loadCourseExams(courseId) {
  const list = document.getElementById('exams-list');
  const empty = document.getElementById('exams-empty');
  if (!list) return;
  try {
    const data = await api('/exams?courseId=' + courseId);
    list.innerHTML = '';
    const exams = data.exams || [];
    if (!exams.length) { if (empty) empty.style.display = 'block'; return; }
    if (empty) empty.style.display = 'none';
    exams.forEach(ex => {
      const div = document.createElement('div');
      div.style.cssText = 'background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:24px;';
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
          <div>
            <h3 style="margin-bottom:6px;">${escapeHtml(ex.title)}</h3>
            <p style="color:var(--text-secondary); font-size:0.9rem;">${ex.questionCount || 0} سؤال | ${ex.duration || 0} دقيقة</p>
          </div>
          ${ex.completed ? '<span class="badge badge-ok">✓ تم</span>' : '<span class="badge badge-info">جديد</span>'}
        </div>
        <div style="display:flex; gap:12px; flex-wrap:wrap;">
          <a href="exam.html?id=${ex.id}" class="btn btn-primary">${ex.completed ? 'إعادة المحاولة' : 'بدء الامتحان'}</a>
          ${ex.score != null ? `<span style="color:var(--accent-light); font-weight:700; align-self:center;">النتيجة: ${ex.score}%</span>` : ''}
        </div>
      `;
      list.appendChild(div);
    });
  } catch (e) { list.innerHTML = ''; if (empty) empty.style.display = 'block'; }
}

let examState = { examId: null, attemptId: null, questions: [], current: 0, answers: {}, expiresAt: null };
let dirtyAnswerKeys = new Set();

function answersStorageKey_() { return 'mfx_exam_answers_' + examState.attemptId; }
function saveAnswersLocally_() {
  if (!examState.attemptId) return;
  try { localStorage.setItem(answersStorageKey_(), JSON.stringify(examState.answers)); } catch (e) {}
}
function loadAnswersLocally_() {
  try {
    const raw = localStorage.getItem(answersStorageKey_());
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
function clearAnswersLocally_() {
  try { localStorage.removeItem(answersStorageKey_()); } catch (e) {}
}

async function loadExam() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) { toast('❌ امتحان غير موجود'); return; }
  examState.examId = id;
  setExamLoading_(true, 'جاري تحميل الامتحان...');
  try {
    const startRes = await api('/attempts/start', { method: 'POST', body: JSON.stringify({ examId: id }) });
    if (!startRes || !startRes.ok) {
      const container = document.getElementById('questions-container');
      if (container) container.innerHTML = `<div style="text-align:center; padding:40px 0; color:var(--text-secondary);">❌ ${escapeHtml((startRes && startRes.error) || 'تعذر بدء الامتحان')}</div>`;
      toast('❌ ' + ((startRes && startRes.error) || 'تعذر بدء الامتحان'));
      return;
    }
    const attempt = startRes.data;
    examState.attemptId = attempt.id;
    examState.expiresAt = attempt.expiresAt ? new Date(attempt.expiresAt).getTime() : null;
    const data = attempt.exam ? { ...attempt.exam, questions: attempt.questions } : {};
    examState.questions = data.questions || [];

    const serverAnswers = safeParseAnswers_(attempt.answers);
    const localAnswers = loadAnswersLocally_();
    examState.answers = { ...serverAnswers, ...localAnswers };

    document.getElementById('exam-badge').textContent = data.title || 'امتحان';
    document.getElementById('exam-title').textContent = data.description || '';
    const minutes = parseInt(data.timerMinutes, 10) || 0;
    document.getElementById('exam-meta').textContent = `${examState.questions.length} سؤال` + (minutes ? ` | ${minutes} دقيقة` : '');
    setExamLoading_(false);
    renderExam();
    if (examState.expiresAt) startTimer();
    else { const t = document.getElementById('timer'); if (t) t.textContent = '∞'; }
    startAutosaveLoop();
  } catch (e) {
    setExamLoading_(false);
    toast('❌ فشل تحميل الامتحان');
  }
}

function safeParseAnswers_(raw) {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; }
}

function setExamLoading_(isLoading, text) {
  const container = document.getElementById('questions-container');
  if (!container) return;
  if (isLoading) {
    container.innerHTML = `<div style="text-align:center; padding:60px 0; color:var(--text-secondary);">
      <span class="mfx-spinner" style="width:28px; height:28px;"></span>
      <p style="margin-top:12px;">${escapeHtml(text || 'جاري التحميل...')}</p>
    </div>`;
  }
}

function renderExam() {
  const container = document.getElementById('questions-container');
  const empty = document.getElementById('exam-empty');
  if (!examState.questions.length) { container.innerHTML = ''; if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  container.innerHTML = examState.questions.map((q, i) => `
    <div class="q-card" data-idx="${i}" data-qid="${q.id}" style="display:${i===0?'block':'none'}">
      <span class="q-num">السؤال ${i+1}</span>
      <p class="q-text">${escapeHtml(q.text)}</p>
      ${q.type === 'listening' ? renderListeningPlayer_(q) : ''}
      <div class="opts" data-qid="${q.id}">${renderQuestionInput(q)}</div>
    </div>
  `).join('');
  updateProg();

  if (!container.dataset.delegated) {
    container.dataset.delegated = '1';
    container.addEventListener('click', (e) => {
      const optEl = e.target.closest('.opt');
      if (!optEl || !container.contains(optEl)) return;
      const optsWrap = optEl.closest('.opts');
      const qId = optsWrap && optsWrap.dataset.qid;
      const q = examState.questions.find((x) => x.id === qId);
      if (!q) return;
      const idx = Array.from(optsWrap.children).indexOf(optEl);
      if (q.type === 'truefalse') {
        pickOpt(qId, idx === 0 ? 'true' : 'false');
      } else if (q.type === 'multi') {
        toggleMultiOpt(qId, q.options[idx]);
      } else {
        pickOpt(qId, q.options[idx]);
      }
    });
  }
}

function renderListeningPlayer_(q) {
  if (q.ttsText) {
    const rate = parseFloat(q.ttsRate) || 1;
    return `
      <div class="tts-player" data-qid="${q.id}">
        <button type="button" class="btn btn-secondary" id="tts-btn-${q.id}" onclick="playListeningTts_('${q.id}')">▶ تشغيل</button>
        <select class="inp" id="tts-rate-${q.id}" style="width:auto; display:inline-block; margin-right:8px;">
          <option value="0.7"${rate===0.7?' selected':''}>أبطأ</option>
          <option value="1"${rate===1||!q.ttsRate?' selected':''}>عادي</option>
          <option value="1.3"${rate===1.3?' selected':''}>أسرع</option>
        </select>
      </div>`;
  }
  if (q.audioUrl) {
    return `<audio class="q-audio" controls preload="none" src="${escapeAttr_(q.audioUrl)}">متصفحك لا يدعم الصوت</audio>`;
  }
  return '';
}

function playListeningTts_(qId) {
  const q = examState.questions.find((x) => x.id === qId);
  if (!q || !q.ttsText) return;
  const rateSel = document.getElementById('tts-rate-' + qId);
  const rate = rateSel ? rateSel.value : (q.ttsRate || 1);
  const btn = document.getElementById('tts-btn-' + qId);
  if (btn) { btn.disabled = true; btn.textContent = '🔊 بيتكلم...'; }
  speakText_(q.ttsText, q.ttsLang, rate, () => { if (btn) { btn.disabled = false; btn.textContent = '▶ تشغيل'; } });
}

function renderQuestionInput(q) {
  const current = examState.answers[q.id];
  if (q.type === 'mcq' || q.type === 'listening') {
    return (q.options || []).map((opt) => `
      <label class="opt ${current === opt ? 'sel' : ''}">
        <input type="radio" name="q${q.id}" ${current === opt ? 'checked' : ''}>
        <span>${escapeHtml(opt)}</span>
      </label>`).join('');
  }
  if (q.type === 'truefalse') {
    return ['true', 'false'].map((v) => `
      <label class="opt ${String(current) === v ? 'sel' : ''}">
        <input type="radio" name="q${q.id}" ${String(current) === v ? 'checked' : ''}>
        <span>${v === 'true' ? 'صح' : 'غلط'}</span>
      </label>`).join('');
  }
  if (q.type === 'multi') {
    const selected = Array.isArray(current) ? current : [];
    return (q.options || []).map((opt) => `
      <label class="opt ${selected.includes(opt) ? 'sel' : ''}">
        <input type="checkbox" ${selected.includes(opt) ? 'checked' : ''}>
        <span>${escapeHtml(opt)}</span>
      </label>`).join('');
  }
  if (q.type === 'fillblank') {
    return `<input type="text" class="inp" value="${escapeAttr_(current || '')}" oninput="setTextAnswer('${q.id}', this.value)" placeholder="اكتب إجابتك">`;
  }
  return `<textarea class="inp" rows="4" oninput="setTextAnswer('${q.id}', this.value)" placeholder="اكتب إجابتك">${escapeHtml(current || '')}</textarea>`;
}

function updateAnswer_(qId, value) {
  examState.answers[qId] = value;
  dirtyAnswerKeys.add(qId);
  saveAnswersLocally_();
  const optsWrap = document.querySelector(`.opts[data-qid="${qId}"]`);
  const q = examState.questions.find((x) => x.id === qId);
  if (optsWrap && q) optsWrap.innerHTML = renderQuestionInput(q);
  updateProg();
}

function pickOpt(qId, value) { updateAnswer_(qId, value); }
function toggleMultiOpt(qId, value) {
  const arr = Array.isArray(examState.answers[qId]) ? [...examState.answers[qId]] : [];
  const idx = arr.indexOf(value);
  if (idx === -1) arr.push(value); else arr.splice(idx, 1);
  updateAnswer_(qId, arr);
}
function setTextAnswer(qId, value) {
  examState.answers[qId] = value;
  dirtyAnswerKeys.add(qId);
  saveAnswersLocally_();
  updateProg();
}

function isAnswered_(value) {
  return value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);
}

function renderQNav() {
  const nav = document.getElementById('q-nav');
  if (!nav) return;
  nav.innerHTML = examState.questions.map((q, i) => {
    const answered = isAnswered_(examState.answers[q.id]);
    const isCurrent = i === examState.current;
    let cls = 'q-nav-pill';
    if (isCurrent) cls += ' current';
    if (answered) cls += ' answered';
    return `<button type="button" class="${cls}" onclick="goQ(${i})" title="${answered ? 'تمت الإجابة' : 'لسه من غير إجابة'}">${i+1}</button>`;
  }).join('');
  document.getElementById('prev-btn').disabled = examState.current === 0;
  const next = document.getElementById('next-btn');
  if (examState.current === examState.questions.length - 1) {
    next.textContent = 'تسليم 🏁';
    next.onclick = submitExam;
  } else {
    next.textContent = 'التالي →';
    next.onclick = nextQ;
  }
  document.getElementById('submit-btn').disabled = false;
}

function goQ(n) {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  examState.current = n;
  document.querySelectorAll('.q-card').forEach((c, i) => c.style.display = i === n ? 'block' : 'none');
  renderQNav();
}
function nextQ() { if (examState.current < examState.questions.length - 1) goQ(examState.current + 1); }
function prevQ() { if (examState.current > 0) goQ(examState.current - 1); }

function updateProg() {
  const total = examState.questions.length;
  const ans = examState.questions.filter((q) => isAnswered_(examState.answers[q.id])).length;
  const fill = document.getElementById('progress-fill');
  const txt = document.getElementById('progress-text');
  if (fill) fill.style.width = total ? (ans / total * 100) + '%' : '0%';
  if (txt) txt.textContent = ans + ' / ' + total;
  renderQNav();
}

let autosaveInt;
function startAutosaveLoop() {
  clearInterval(autosaveInt);
  autosaveInt = setInterval(runAutosave, 10000);
  window.removeEventListener('beforeunload', runAutosave);
  window.addEventListener('beforeunload', runAutosave);
}
async function runAutosave() {
  if (!examState.attemptId || dirtyAnswerKeys.size === 0) return;
  const keysToSave = [...dirtyAnswerKeys];
  dirtyAnswerKeys.clear();
  const batch = {};
  keysToSave.forEach((k) => { batch[k] = examState.answers[k]; });
  const status = document.getElementById('autosave-status');
  if (status) status.textContent = 'جاري الحفظ...';
  try {
    const res = await api('/attempts/' + examState.attemptId + '/answers', {
      method: 'POST',
      body: JSON.stringify({ answers: batch })
    });
    if (status) status.textContent = (res && res.ok) ? '✓ تم الحفظ' : '';
  } catch (e) {
    keysToSave.forEach((k) => dirtyAnswerKeys.add(k));
    if (status) status.textContent = '';
  }
}

let timerInt;
function startTimer() {
  clearInterval(timerInt);
  const el = document.getElementById('timer');
  const tick = () => {
    const sec = Math.max(0, Math.round((examState.expiresAt - Date.now()) / 1000));
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = (sec % 60).toString().padStart(2, '0');
    if (el) {
      el.textContent = m + ':' + s;
      el.classList.toggle('timer-low', sec <= 60 && sec > 0);
    }
    if (sec <= 0) { clearInterval(timerInt); confirmSubmit(); }
  };
  tick();
  timerInt = setInterval(tick, 1000);
}

function submitExam() {
  const total = examState.questions.length;
  const ans = Object.keys(examState.answers).length;
  const modal = document.getElementById('submit-modal');
  const msg = document.getElementById('modal-msg');
  if (modal) modal.style.display = 'flex';
  if (msg) msg.innerHTML = `أجبت على <strong style="color:var(--text);">${ans}</strong> من <strong style="color:var(--text);">${total}</strong> سؤال.`;
}

function closeModal() { document.getElementById('submit-modal').style.display = 'none'; }

async function confirmSubmit() {
  closeModal();
  clearInterval(timerInt);
  clearInterval(autosaveInt);
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  const confirmBtn = document.querySelector('#submit-modal .btn-primary');
  toast('⏳ جاري تسليم الامتحان...');
  await withButtonLock(confirmBtn, 'جاري التسليم...', async () => {
    try {
      const data = await api('/attempts/' + examState.attemptId + '/submit', {
        method: 'POST',
        body: JSON.stringify({ answers: examState.answers })
      });
      if (!data || !data.ok) {
        toast('❌ ' + ((data && data.error) || 'فشل تسليم الامتحان'));
        return;
      }
      clearAnswersLocally_();
      showSubmissionReceived_();

      if (data.data && data.data.status === 'COMPLETED') {
        showResult(data.data);
        return;
      }
      pollSubmissionStatus_(examState.attemptId);
    } catch (e) {}
  });
}

function showSubmissionReceived_() {
  const modal = document.getElementById('result-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  setResultModalState_({
    icon: '<span class="mfx-spinner" style="width:36px; height:36px; border-width:4px;"></span>',
    title: '✓ تم استلام إجاباتك',
    score: '', rank: 'جاري حفظ الامتحان...', time: '',
    showRetry: false
  });
}

function setResultModalState_({ icon, title, score, rank, time, showRetry }) {
  const iconEl = document.getElementById('result-icon');
  const titleEl = document.getElementById('result-title');
  const scoreEl = document.getElementById('result-score');
  const rankEl = document.getElementById('result-rank');
  const timeEl = document.getElementById('result-time');
  const retryBtn = document.getElementById('result-retry-btn');
  if (iconEl && icon !== undefined) iconEl.innerHTML = icon;
  if (titleEl && title !== undefined) titleEl.textContent = title;
  if (scoreEl && score !== undefined) scoreEl.textContent = score;
  if (rankEl && rank !== undefined) rankEl.textContent = rank;
  if (timeEl && time !== undefined) timeEl.textContent = time;
  if (retryBtn) retryBtn.style.display = showRetry ? 'block' : 'none';
}

async function retrySubmit_() {
  showSubmissionReceived_();
  pollSubmissionStatus_(examState.attemptId);
  try {
    await api('/attempts/' + examState.attemptId + '/submit', {
      method: 'POST',
      body: JSON.stringify({ answers: examState.answers })
    });
  } catch (e) {}
}

function pollSubmissionStatus_(attemptId) {
  const delays = [2000, 4000, 8000];
  let step = 0;
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    let data;
    try {
      data = await api('/attempts/' + attemptId + '/status');
    } catch (e) {}
    const status = data && data.ok && data.data && data.data.status;

    if (status === 'COMPLETED') {
      stopped = true;
      showResult(data.data);
      return;
    }
    if (status === 'FAILED') {
      stopped = true;
      setResultModalState_({
        icon: '⚠️',
        title: 'حدث خطأ أثناء حفظ الامتحان',
        score: '', rank: 'إجاباتك محفوظة محليًا ولم تُفقد — جرّب "إعادة المحاولة"', time: '',
        showRetry: true
      });
      return;
    }

    const delay = delays[Math.min(step, delays.length - 1)];
    step += 1;
    setTimeout(poll, delay);
  };

  setTimeout(poll, delays[0]);
}

function showResult(attempt) {
  const modal = document.getElementById('result-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  if (!attempt || attempt.resultsPublished === false) {
    setResultModalState_({
      icon: '✅', title: 'تم تسليم الامتحان!',
      score: '', rank: 'تم تسليم الامتحان بنجاح.', time: 'سيتم إعلان النتيجة بعد اعتماد المعلم.',
      showRetry: false
    });
    return;
  }
  const pct = Math.round(parseFloat(attempt.percentage) || 0);
  const mins = Math.round((parseFloat(attempt.durationSeconds) || 0) / 60);
  setResultModalState_({
    icon: '🎉', title: 'تم تسليم الامتحان!',
    score: pct + '%',
    rank: attempt.needsManualGrading ? 'بعض الأسئلة تحتاج تصحيح يدوي' : '',
    time: 'الوقت: ' + mins + ' دقيقة',
    showRetry: false
  });
}

function escapeAttr_(str) { return escapeHtml(str).replace(/"/g, '&quot;'); }

// Dashboard
async function loadDashboard() {
  const user = getUser();
  document.getElementById('student-name').textContent = user.name || '—';
  document.getElementById('nav-name').textContent = user.name || '—';
  try {
    const data = await api('/students/dashboard');
    if (data.courses != null) document.getElementById('dash-courses').textContent = data.courses;
    if (data.exams != null) document.getElementById('dash-exams').textContent = data.exams;
    if (data.avgScore != null) document.getElementById('dash-score').textContent = data.avgScore + '%';
    if (data.rank != null) document.getElementById('dash-rank').textContent = '#' + data.rank;

    const prog = document.getElementById('my-progress');
    const progEmpty = document.getElementById('progress-empty');
    if (prog) {
      prog.innerHTML = '';
      if (!data.progress || !data.progress.length) { if (progEmpty) progEmpty.style.display = 'block'; }
      else {
        if (progEmpty) progEmpty.style.display = 'none';
        data.progress.forEach(p => {
          const div = document.createElement('div');
          div.className = 'card';
          div.innerHTML = `
            <div class="card-body">
              <h3>${p.courseTitle}</h3>
              <div style="margin-top:12px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:6px; font-size:0.85rem;">
                  <span style="color:var(--text-secondary);">التقدم</span>
                  <span style="color:var(--accent-light); font-weight:600;">${p.progress}%</span>
                </div>
                <div class="prog"><div class="prog-fill" style="width:${p.progress}%"></div></div>
              </div>
              <div style="margin-top:12px; font-size:0.85rem; color:var(--text-muted);">
                <span>🎥 ${p.videosWatched}/${p.totalVideos} فيديو</span>
                <span style="margin-right:12px;">📝 ${p.examsTaken} امتحان</span>
              </div>
            </div>
          `;
          prog.appendChild(div);
        });
      }
    }

    const recent = document.getElementById('recent-exams');
    const recentEmpty = document.getElementById('exams-empty');
    if (recent) {
      recent.innerHTML = '';
      if (!data.recentExams || !data.recentExams.length) { if (recentEmpty) recentEmpty.style.display = 'block'; }
      else {
        if (recentEmpty) recentEmpty.style.display = 'none';
        data.recentExams.forEach(ex => {
          const div = document.createElement('div');
          div.style.cssText = 'background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-md); padding:16px 20px; display:flex; justify-content:space-between; align-items:center;';
          div.innerHTML = `
            <div>
              <div style="font-weight:600;">${escapeHtml(ex.title)}</div>
              <div style="color:var(--text-muted); font-size:0.85rem; margin-top:2px;">${ex.date || ''}</div>
            </div>
            <span class="badge ${ex.score >= 50 ? 'badge-ok' : 'badge-err'}">${ex.score}%</span>
          `;
          recent.appendChild(div);
        });
      }
    }

    const lb = document.getElementById('leaderboard-list');
    const lbEmpty = document.getElementById('leaderboard-empty');
    if (lb) {
      lb.innerHTML = '';
      if (!data.leaderboard || !data.leaderboard.length) { if (lbEmpty) lbEmpty.style.display = 'block'; }
      else {
        if (lbEmpty) lbEmpty.style.display = 'none';
        data.leaderboard.forEach((s, i) => {
          const div = document.createElement('div');
          div.className = 'leaderboard-item';
          const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other';
          div.innerHTML = `
            <div class="leaderboard-rank ${rankClass}">${i + 1}</div>
            <div style="flex:1;">
              <div style="font-weight:600;">${escapeHtml(s.name)}</div>
              <div style="color:var(--text-muted); font-size:0.85rem;">${s.examsCount} امتحان</div>
            </div>
            <div style="font-weight:700; color:var(--accent-light);">${s.avgScore}%</div>
          `;
          lb.appendChild(div);
        });
      }
    }
  } catch (e) {}
}

// ===== Video player + comments =====
let videoProgressTimer = null;
let videoWatchState = { videoId: null, startedAt: 0, durationSeconds: 0, sentPercentage: 0 };

async function loadVideoPage() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) { toast('❌ فيديو غير موجود'); return; }
  try {
    const res = await api('/videos/' + id);
    const video = res.data;
    if (!video) { toast('❌ الفيديو غير موجود'); return; }
    document.getElementById('video-title').textContent = video.title || 'فيديو';
    document.getElementById('back-to-course').href = 'course.html?id=' + video.unitId;
    const frame = document.getElementById('video-frame');
    if (frame && video.driveFileId) {
      frame.src = 'https://drive.google.com/file/d/' + video.driveFileId + '/preview';
    } else if (frame && video.driveUrl) {
      frame.src = video.driveUrl;
    }

    videoWatchState = { videoId: id, startedAt: Date.now(), durationSeconds: parseFloat(video.durationSeconds) || 0, sentPercentage: 0 };
    startVideoProgressTracking();
    loadComments(id);
  } catch (e) { toast('❌ فشل تحميل الفيديو'); }
}

function startVideoProgressTracking() {
  if (videoProgressTimer) clearInterval(videoProgressTimer);
  videoProgressTimer = setInterval(sendVideoProgress, 15000);
  window.addEventListener('beforeunload', sendVideoProgress);
}

async function sendVideoProgress() {
  if (!videoWatchState.videoId) return;
  const watchSeconds = Math.round((Date.now() - videoWatchState.startedAt) / 1000);
  const watchPercentage = videoWatchState.durationSeconds > 0
    ? Math.min(100, Math.round((watchSeconds / videoWatchState.durationSeconds) * 100))
    : Math.min(95, Math.round(watchSeconds / 3));
  if (watchPercentage <= videoWatchState.sentPercentage) return;
  videoWatchState.sentPercentage = watchPercentage;
  try {
    await api('/videos/' + videoWatchState.videoId + '/progress', {
      method: 'POST',
      body: JSON.stringify({ watchSeconds, watchPercentage })
    });
  } catch (e) {}
}

async function loadComments(videoId) {
  const list = document.getElementById('comments-list');
  const empty = document.getElementById('comments-empty');
  if (!list) return;
  try {
    const res = await api('/comments/video/' + videoId);
    const comments = res.data || [];
    list.innerHTML = '';
    if (!comments.length) { if (empty) empty.style.display = 'block'; return; }
    if (empty) empty.style.display = 'none';
    const me = getUser();
    comments.forEach(c => {
      const div = document.createElement('div');
      div.style.cssText = 'padding:14px; background:var(--bg); border-radius:var(--radius-md); border:1px solid var(--border);';
      const isTeacher = c.authorRole === 'admin';
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span style="font-weight:600; ${isTeacher ? 'color:var(--accent-light);' : ''}">${isTeacher ? '👨‍🏫 ' : ''}${escapeHtml(c.authorName || 'مستخدم')}</span>
          <span style="color:var(--text-muted); font-size:0.75rem;">${formatDate(c.createdAt)}</span>
        </div>
        <p style="color:var(--text-secondary); line-height:1.7;">${escapeHtml(c.text)}</p>
        ${(me.id === c.authorId) ? `<button class="btn btn-ghost btn-sm" style="margin-top:6px; color:var(--danger);" onclick="deleteComment('${c.id}', '${videoId}')">حذف</button>` : ''}
      `;
      list.appendChild(div);
    });
  } catch (e) { if (empty) empty.style.display = 'block'; }
}

async function postComment() {
  const input = document.getElementById('comment-input');
  const params = new URLSearchParams(location.search);
  const videoId = params.get('id');
  const text = input?.value.trim();
  if (!text) return;
  try {
    const res = await api('/comments/video/' + videoId, { method: 'POST', body: JSON.stringify({ text }) });
    if (res.ok) { input.value = ''; loadComments(videoId); }
    else toast('❌ ' + (res.error || 'فشل إرسال التعليق'));
  } catch (e) {}
}

async function deleteComment(commentId, videoId) {
  try {
    await api('/comments/' + commentId, { method: 'DELETE' });
    loadComments(videoId);
  } catch (e) {}
}

// ===== Presentation viewer =====
async function loadPresentationPage() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) { toast('❌ ملف غير موجود'); return; }
  try {
    const res = await api('/presentations/' + id);
    const item = res.data;
    if (!item) { toast('❌ الملف غير موجود'); return; }
    document.getElementById('presentation-title').textContent = item.title || 'عرض تقديمي';
    document.getElementById('back-to-course').href = 'course.html?id=' + item.unitId;
    const frame = document.getElementById('presentation-frame');
    const previewUrl = item.driveFileId
      ? 'https://drive.google.com/file/d/' + item.driveFileId + '/preview'
      : item.driveUrl;
    if (frame) frame.src = previewUrl;
    renderPresentationWatermark();
    setupPresentationDeterrents();
  } catch (e) { toast('❌ فشل تحميل العرض التقديمي'); }
}

function renderPresentationWatermark() {
  const layer = document.getElementById('presentation-watermark');
  if (!layer) return;
  const user = getUser();
  const label = `${user.name || ''} · ${user.code || ''}`;
  let html = '';
  for (let row = 0; row < 6; row++) {
    html += `<div style="position:absolute; top:${row * 18}%; left:${(row % 2) * -8}%; width:130%; display:flex; gap:60px; opacity:0.16; transform:rotate(-18deg); white-space:nowrap; font-size:0.8rem; color:#fff;">`;
    for (let col = 0; col < 6; col++) html += `<span>${escapeHtml(label)}</span>`;
    html += '</div>';
  }
  layer.innerHTML = html;
}

function setupPresentationDeterrents() {
  const viewer = document.getElementById('presentation-viewer');
  if (!viewer) return;

  viewer.addEventListener('contextmenu', (e) => e.preventDefault());
  viewer.addEventListener('dragstart', (e) => e.preventDefault());
  viewer.style.userSelect = 'none';

  const cover = document.getElementById('presentation-blur-cover');
  const blurNow = () => { if (cover) cover.style.display = 'flex'; };
  const unblurNow = () => { if (cover) cover.style.display = 'none'; };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) blurNow(); else unblurNow();
  });
  window.addEventListener('blur', blurNow);
  window.addEventListener('focus', unblurNow);

  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const blocked =
      key === 'printscreen' ||
      (e.ctrlKey && (key === 'p' || key === 's' || key === 'u')) ||
      key === 'f12' ||
      (e.ctrlKey && e.shiftKey && (key === 'i' || key === 'c' || key === 'j'));
    if (blocked) {
      e.preventDefault();
      toast('❌ العرض ده محمي');
    }
  });
}

// ===== Chat with teacher =====
let chatPollTimer = null;
async function loadChatPage() {
  const user = getUser();
  const nameEl = document.getElementById('nav-name');
  if (nameEl) nameEl.textContent = user.name || '—';
  await refreshChatMessages();
  if (chatPollTimer) clearInterval(chatPollTimer);
  chatPollTimer = setInterval(refreshChatMessages, 8000);
}

async function refreshChatMessages() {
  const box = document.getElementById('chat-messages');
  const empty = document.getElementById('chat-empty');
  if (!box) return;
  try {
    const res = await api('/chat/me');
    const messages = res.data || [];
    if (!messages.length) {
      box.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = messages.map(m => {
      const mine = m.senderRole === 'student';
      return `
        <div style="align-self:${mine ? 'flex-start' : 'flex-end'}; max-width:75%;">
          <div style="background:${mine ? 'var(--bg)' : 'var(--accent)'}; color:${mine ? 'var(--text)' : '#fff'}; padding:10px 14px; border-radius:var(--radius-md); line-height:1.6;">
            ${escapeHtml(m.text)}
          </div>
          <div style="color:var(--text-muted); font-size:0.7rem; margin-top:4px; text-align:${mine ? 'right' : 'left'};">${formatDate(m.createdAt)}</div>
        </div>
      `;
    }).join('');
    if (wasNearBottom) box.scrollTop = box.scrollHeight;
  } catch (e) {}
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input?.value.trim();
  if (!text) return;
  input.value = '';
  try {
    const res = await api('/chat/me', { method: 'POST', body: JSON.stringify({ text }) });
    if (!res.ok) toast('❌ ' + (res.error || 'فشل إرسال الرسالة'));
    await refreshChatMessages();
    const box = document.getElementById('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
  } catch (e) {}
}

// ===== small helpers =====
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('ar-EG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

// UI Helpers
function switchTab(tab, id) {
  tab.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  const container = tab.closest('div').parentElement;
  container.querySelectorAll('[id^="tab-"]').forEach(c => c.style.display = 'none');
  const target = container.querySelector('#tab-' + id);
  if (target) target.style.display = 'block';
}

function toggleAcc(header) {
  const item = header.closest('.accordion-item');
  item.classList.toggle('open');
  const arrow = header.querySelector('.meta span:last-child, span:last-child');
  if (arrow) arrow.style.transform = item.classList.contains('open') ? 'rotate(180deg)' : 'rotate(0deg)';
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  requireAuth();
  const path = location.pathname;
  if (path.includes('login.html')) {
    const qrCode = new URLSearchParams(location.search).get('code');
    const codeInput = document.getElementById('login-code');
    if (qrCode && codeInput) codeInput.value = qrCode;
    return;
  }
  if (path.includes('index.html')) withPageLoader(loadMyCourses);
  if (path.includes('course.html')) withPageLoader(loadCourse);
  if (path.includes('exam.html')) withPageLoader(loadExam);
  if (path.includes('dashboard.html')) withPageLoader(loadDashboard);
  if (path.includes('video.html')) withPageLoader(loadVideoPage);
  if (path.includes('presentation.html')) withPageLoader(loadPresentationPage);
  if (path.includes('chat.html')) withPageLoader(loadChatPage);
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

window.onclick = e => {
  if (e.target.id === 'submit-modal') closeModal();
};
