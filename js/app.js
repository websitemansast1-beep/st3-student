// ===== MFX Student App =====
const API = 'https://mrmomd-production.up.railway.app/api';

function toast(msg) {
  let t = document.querySelector('.toast');
  if (t) t.remove();
  t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('on'));
  setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 400); }, 3000);
}

// ===== Global loading / anti-duplicate-click helpers =====
// Every important action (login, start exam, save, submit) routes through
// withButtonLock so a double-click / double-tap can only ever fire ONE
// request: the button is disabled + shows a spinner immediately, and any
// extra clicks while it's busy are ignored until the request settles.
const activeLocks = new Set();
async function withButtonLock(btn, busyText, fn) {
  if (!btn || btn.dataset.locked === '1') return; // already running — ignore the extra click
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

// Full-page loader: shown the instant a data page starts loading (so the
// student sees a spinning circle instead of a blank page while the first
// Sheets read comes back), removed as soon as that page's load function
// finishes — success or failure, it's always removed via .finally().
function showPageLoader() {
  if (document.querySelector('.mfx-page-loader')) return;
  const el = document.createElement('div');
  el.className = 'mfx-page-loader';
  el.innerHTML = '<div class="mfx-page-loader-content"><div class="loader-cube-wrap"><div class="loader-cube"><div class="face face-front"></div><div class="face face-back"></div><div class="face face-right"></div><div class="face face-left"></div><div class="face face-top"></div><div class="face face-bottom"></div></div></div><div class="mfx-page-loader-credit">صنع بواسطة يوسف ماهر</div></div>';
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

// Mobile nav menu — .nav-links used to just disappear on small screens
// (display:none) with no way back to it, which made "لوحتي" / "المتصدرين"
// / "المعلم" unreachable from a phone. Now it's a dropdown toggled by the
// hamburger button added next to the logo; the CSS handles the actual
// show/hide via the "mfx-open" class, this just flips it.
function toggleMfxNav() {
  document.querySelector('.nav-links')?.classList.toggle('mfx-open');
}

function getToken() { return localStorage.getItem('mfx_student_token'); }
function setToken(t) { localStorage.setItem('mfx_student_token', t); }
function getUser() { try { return JSON.parse(localStorage.getItem('mfx_student_user') || '{}'); } catch(e) { return {}; } }
function getRefreshToken() { return localStorage.getItem('mfx_student_refresh_token'); }
function setRefreshToken(t) { localStorage.setItem('mfx_student_refresh_token', t); }
function logout() {
  localStorage.removeItem('mfx_student_token');
  localStorage.removeItem('mfx_student_refresh_token');
  localStorage.removeItem('mfx_student_user');
  location.href = 'login.html';
}

// Reads the JWT's own expiry (exp claim) without a network call, so an
// expired session is caught the instant the page loads instead of only
// after some data request fails with 401. A 5-minute clock-skew grace
// window absorbs a device with a slightly fast clock — otherwise a
// freshly-issued, perfectly valid token could look "already expired".
function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return false;
    const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;
    return Date.now() >= (payload.exp * 1000 + CLOCK_SKEW_TOLERANCE_MS);
  } catch (e) {
    return true; // unreadable token = treat as expired
  }
}

// Silently exchanges the stored refresh token (30-day lifetime, issued at
// login — see routes/auth.js POST /auth/refresh) for a brand-new access
// token (15-minute lifetime). Without this, a student staying on one page
// for more than 15 minutes (watching a video, reading a lesson) got
// bounced back to login even though a perfectly valid 30-day refresh
// token was sitting unused. Concurrent callers share the same in-flight
// request instead of each firing their own refresh.
let refreshInFlight = null;
async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const res = await fetch(API + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !data.ok || !data.data || !data.data.accessToken) return false;
      setToken(data.data.accessToken);
      return true;
    } catch (e) {
      return false;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function api(path, opts = {}) {
  const url = API + path;
  const doFetch = async () => {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
  };
  try {
    let res = await doFetch();
    // A 401 mid-session (the token expired while the student was
    // actively using the page) used to log them out immediately. Now:
    // try ONE silent refresh + retry first, and only fall back to
    // logout if the refresh itself fails.
    if (res.status === 401) {
      const refreshed = await refreshAccessToken();
      if (!refreshed) { logout(); return; }
      res = await doFetch();
      if (res.status === 401) { logout(); return; }
    }
    return await res.json();
  } catch (e) { toast('❌ خطأ في الاتصال'); throw e; }
}

// Auth check — runs on every page load. Instead of logging the student
// out the instant the access token's 15-minute exp has passed, try a
// silent refresh first and only send them to login if that refresh also
// fails. Returns true/false so the init flow below can wait for it
// before loading any page data.
async function requireAuth() {
  const onLoginPage = location.pathname.includes('login.html');
  if (onLoginPage) return true;

  const token = getToken();
  if (!token) {
    logout();
    return false;
  }

  if (isTokenExpired(token)) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      logout();
      return false;
    }
  }

  return true;
}

// Login
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
        body: JSON.stringify({ code, name, phone, guardianPhone })
      });
      if (data && data.token) {
        setToken(data.token);
        if (data.refreshToken) setRefreshToken(data.refreshToken);
        localStorage.setItem('mfx_student_user', JSON.stringify(data.user));
        toast('✅ تم تسجيل الدخول');
        location.href = 'index.html'; // single navigation — no repeated reloads
      } else {
        toast('❌ ' + ((data && data.error) || 'كود أو اسم غير صحيح'));
        if (form) form.querySelectorAll('input').forEach((i) => i.disabled = false);
      }
    } catch (err) {
      if (form) form.querySelectorAll('input').forEach((i) => i.disabled = false);
    }
  });
}

// Load my courses
async function loadMyCourses() {
  const grid = document.getElementById('my-courses');
  const empty = document.getElementById('courses-empty');
  if (!grid) return;
  try {
    const data = await api('/students/my-courses');
    grid.innerHTML = '';
    if (!data.courses || !data.courses.length) {
      if (empty) empty.style.display = 'block';
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
    // These two are independent — fire them together, and reuse the
    // course-detail response for the units accordion instead of the old
    // code's second (redundant) call to the same endpoint.
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

// Course vocabulary — AI-read words/phrases (Web Speech API, no audio
// files). Same idea as the Listening-question player on the exam page.
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

// Found a real bug: the play button used to build its onclick as
// `playVocabWord_(0, ${JSON.stringify(w.text)}, ...)` — JSON.stringify
// always wraps a string in DOUBLE quotes, and that was sitting inside an
// HTML onclick="..." attribute which is ALSO double-quoted. That breaks
// the attribute for literally every word, not just ones with special
// characters — the button never worked at all. Fixed by only ever
// passing a plain integer index through the attribute and looking the
// actual word up from currentCourseVocab (the real data), never
// round-tripping arbitrary text through generated HTML/JS.
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

// Exam
// examState.attemptId / expiresAt come from the server (POST /attempts/start)
// — the server's clock is the only source of truth for when time is up.
// examState.answers is mirrored into localStorage on every change so a
// refresh (or the browser dying) never loses an answer that hasn't made it
// to the server yet.
let examState = { examId: null, attemptId: null, questions: [], current: 0, answers: {}, expiresAt: null };
let dirtyAnswerKeys = new Set(); // which question IDs changed since the last autosave

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
    // ONE request: /attempts/start returns the attempt AND the exam's
    // metadata + questions together (previously this was two separate
    // requests — start, then a second GET /exams/:id). Idempotent and
    // deduped server-side, so a double-tap or a page reload never creates
    // a second attempt.
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

    // Resume any answers already saved on the server for this attempt,
    // then let localStorage fill in anything saved locally that a slow
    // network hadn't autosaved yet (local always wins — it's newer).
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

  // Answer clicks are handled by ONE delegated listener instead of an
  // inline onclick per option. Found during a review: the old inline
  // onclick embedded the option's raw TEXT straight into the HTML
  // attribute (`onclick="pickOpt('id', ${JSON.stringify(opt)})"`) — if an
  // option ever contained a double-quote character (e.g. an English
  // question quoting a phrase, or a possessive like "student's"), the
  // browser's HTML parser would read that quote as the END of the
  // onclick attribute and silently truncate/break the handler. That
  // option would then just... not respond to clicks. Delegation reads
  // the option's value from examState.questions (the actual data),
  // never from re-parsed HTML/JS-in-an-attribute, so no amount of
  // punctuation in the question text can break it. Attached once, on
  // the container that's never itself replaced (only its children are).
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

// Listening questions play one of two ways:
//  - ttsText: the browser's own AI voice reads it aloud (Web Speech API) —
//    no audio file, no upload, no hosting, works the instant it's typed.
//  - audioUrl: the older file-upload path, kept for exams already using it.
// Nothing plays automatically and nothing is fetched until the student
// actually presses play — this never blocks or slows down opening the exam.
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
  // essay
  return `<textarea class="inp" rows="4" oninput="setTextAnswer('${q.id}', this.value)" placeholder="اكتب إجابتك">${escapeHtml(current || '')}</textarea>`;
}

// Selecting an option updates just that question's option list in place
// (not the whole exam) — this is what stops a <audio> listening player
// from being torn down and restarted every time an answer is picked, and
// avoids re-rendering all N questions for a single click. The click
// itself is handled by the delegated listener set up once in renderExam().
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
    // Clear at a glance: filled = answered, outlined = still empty,
    // glowing ring = the one you're on right now — so a student can jump
    // straight to what's left instead of paging through everything again.
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
  // Stop any TTS still speaking the previous question — otherwise it
  // keeps talking over the next question the student's now looking at.
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
  renderQNav(); // keep the navigator's answered/unanswered pills in sync
}

// ===== Autosave =====
// Batches every answer changed since the last save into ONE request,
// on a fixed interval — never one request per click. Skips the request
// entirely if nothing changed since the last tick.
let autosaveInt;
function startAutosaveLoop() {
  clearInterval(autosaveInt);
  autosaveInt = setInterval(runAutosave, 10000);
  // Defensive: remove before re-adding, so if this is ever called more
  // than once in one page life (it isn't today, but nothing enforces
  // that), the browser doesn't end up firing autosave twice on unload.
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
    // Failed silently — the keys are still in examState/localStorage,
    // so re-add them to be retried on the next tick instead of losing them.
    keysToSave.forEach((k) => dirtyAnswerKeys.add(k));
    if (status) status.textContent = '';
  }
}

// ===== Server-anchored countdown =====
// The countdown always recomputes from examState.expiresAt (a server
// timestamp), never from a locally-ticked "minutes left" counter — so a
// slow tab, a laptop sleeping, or clock drift can't desync the timer from
// what the server will actually enforce.
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
      // Clear visual urgency in the last minute — color alone (not a
      // popup, not a sound) so it doesn't interrupt whatever the student
      // is doing, but it's impossible to miss.
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

// Submit now returns immediately (202 PROCESSING) — the actual Sheets
// write happens in a batch on the server. We show the "received" state
// right away, then poll /:id/status with growing intervals (2s, 4s, 8s,
// then staying at 8s) until it settles, instead of holding one long HTTP
// connection open or hammering the server every second.
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
        // Already flushed (e.g. queue was empty and flushed instantly) —
        // no need to poll at all.
        showResult(data.data);
        return;
      }
      pollSubmissionStatus_(examState.attemptId);
    } catch (e) {}
  });
}

// Step 1 of the two-step message from the spec: confirm receipt instantly,
// independently of whether Sheets has actually been written to yet. Shows
// a real animated spinner (not emoji) while the queue processes this.
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

// Manual retry after a terminal FAILED status — the queue already retried
// automatically server-side (see submissionQueue.js) before giving up, so
// polling further wouldn't help; re-submitting starts a fresh attempt at
// queueing (still idempotent — the attempt id is unchanged).
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

// Graduated polling: 2s, 4s, 8s, then holds at 8s. Stops immediately on
// COMPLETED or FAILED — never polls once a second, never polls forever,
// and never keeps polling once there's nothing left to wait for.
function pollSubmissionStatus_(attemptId) {
  const delays = [2000, 4000, 8000];
  let step = 0;
  let stopped = false;

  const poll = async () => {
    if (stopped) return;
    let data;
    try {
      data = await api('/attempts/' + attemptId + '/status');
    } catch (e) {
      // Connection hiccup — just try again on the same backoff schedule.
    }
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
    // Results not published yet — never show a score/rank the student
    // wasn't meant to see, even transiently.
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

    // Progress
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

    // Recent exams
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

    // Leaderboard
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
    : Math.min(95, Math.round(watchSeconds / 3)); // rough fallback if no duration is set
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

// Tiles the student's name + code across the presentation area so any
// screenshot or photo of the screen is traceable back to them. This is a
// deterrent, not a real block — nothing on the web can stop someone from
// literally photographing their own screen.
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

// A handful of low-friction deterrents against the *casual* "right click,
// save" or "select all, copy" path. None of this stops a determined
// person with a phone camera or a screen recorder — that's simply not
// something any website can prevent.
function setupPresentationDeterrents() {
  const viewer = document.getElementById('presentation-viewer');
  if (!viewer) return;

  viewer.addEventListener('contextmenu', (e) => e.preventDefault());
  viewer.addEventListener('dragstart', (e) => e.preventDefault());
  viewer.style.userSelect = 'none';

  const cover = document.getElementById('presentation-blur-cover');
  const blurNow = () => { if (cover) cover.style.display = 'flex'; };
  const unblurNow = () => { if (cover) cover.style.display = 'none'; };

  // Hide the content the moment the tab loses focus or is backgrounded —
  // makes casual screen-recording apps (which usually need the tab
  // visible/focused) capture a blurred cover instead of the real slides.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) blurNow(); else unblurNow();
  });
  window.addEventListener('blur', blurNow);
  window.addEventListener('focus', unblurNow);

  // Block the most common keyboard shortcuts someone would reach for
  // first (Print, Save, DevTools). Anyone who actually knows what
  // they're doing can still get around this — it just raises the floor
  // above "accidentally easy".
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
document.addEventListener('DOMContentLoaded', async () => {
  const path = location.pathname;
  if (path.includes('login.html')) {
    // Login page never has a token to check — nothing to await.
    requireAuth();
    // Pre-fill the code when a student arrives via a QR-code deep link
    // (login.html?code=XXXX) instead of typing it in by hand.
    const qrCode = new URLSearchParams(location.search).get('code');
    const codeInput = document.getElementById('login-code');
    if (qrCode && codeInput) codeInput.value = qrCode;
    return;
  }

  // Every other page: wait for requireAuth() to finish (including its
  // silent refresh attempt, if one was needed) before deciding whether to
  // load page data — otherwise the FIRST api() call could race an
  // in-flight refresh and 401 before the new token was saved.
  const authed = await requireAuth();
  if (!authed) return; // already redirected to login.html

  if (path.includes('index.html')) withPageLoader(loadMyCourses);
  if (path.includes('course.html')) withPageLoader(loadCourse);
  if (path.includes('exam.html')) withPageLoader(loadExam);
  if (path.includes('dashboard.html')) withPageLoader(loadDashboard);
  if (path.includes('video.html')) withPageLoader(loadVideoPage);
  if (path.includes('presentation.html')) withPageLoader(loadPresentationPage);
  if (path.includes('chat.html')) withPageLoader(loadChatPage);
});

// When the browser restores a page from its back/forward cache (e.g. the
// student hits the back button), it shows the old DOM as-is without
// re-running any of the code above — including the login check. That's
// what made an expired/logged-out session look like it was still showing
// "the old page". Forcing a fresh load re-runs requireAuth() and re-fetches
// real data instead.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

window.onclick = e => {
  if (e.target.id === 'submit-modal') closeModal();
};
