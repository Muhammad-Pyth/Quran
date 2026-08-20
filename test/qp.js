// qp.js — Quran Pedia section frontend logic

const AYAHS_PER_PAGE = 10;
const SEARCH_PAGE_SIZE = 20;

const qpState = {
    surahs: [],
    mushafs: [],
    currentMushafId: null,
    currentSurah: 1,
    allAyahs: [],
    divergenceMap: {},
    pageIndex: 0,
    morphologyCache: {},
    modal: { surah: null, ayah: null, activeTab: null, activeBook: null },
    lastSearch: null,          // { type: 'global'|'root', query, scope, results:[], offset, hasMore }
    pendingHighlight: null,    // { surah, ayah, term } — set right before navigating to a search hit
};

async function qpFetch(url) {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
}

function qpEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function qpCloseModal(id) { document.getElementById(id).classList.remove('show'); }
function qpOpenModal(id) { document.getElementById(id).classList.add('show'); }

function qpNormalize(text) {
    if (!text) return text;
    return text
        .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g, '')
        .replace(/\u0640/g, '')
        .replace(/[\u0622\u0623\u0625]/g, '\u0627')
        .replace(/\u0629/g, '\u0647')
        .replace(/\u0649/g, '\u064A')
        .trim();
}

// builds a regex that matches `term` against diacritized text, allowing
// optional diacritics between each letter — so highlighting still works
// against the original (non-normalized) display text.
function qpBuildHighlightRegex(term) {
    const normTerm = qpNormalize(term);
    if (!normTerm) return null;
    const DIACRITIC = '[\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E8\\u06EA-\\u06ED\\u0640]*';
    const escaped = normTerm.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // also allow alef/ta-marbuta/alef-maksura variant forms at each position
    const variants = {
        '\u0627': '[\u0627\u0622\u0623\u0625]',
        '\u0647': '[\u0647\u0629]',
        '\u064A': '[\u064A\u0649]',
    };
    const pattern = escaped.map(ch => (variants[ch] || ch) + DIACRITIC).join('');
    try { return new RegExp(pattern, 'g'); } catch (e) { return null; }
}

function qpHighlightTextNode(el, regex) {
    if (!regex) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(node => {
        const text = node.nodeValue;
        regex.lastIndex = 0;
        if (!regex.test(text)) return;
        regex.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let lastIdx = 0, m;
        while ((m = regex.exec(text))) {
            if (m.index === regex.lastIndex) regex.lastIndex++;
            frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
            const mark = qpEl('mark', 'qp-search-mark', m[0]);
            frag.appendChild(mark);
            lastIdx = m.index + m[0].length;
        }
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        node.parentNode.replaceChild(frag, node);
    });
}

// ---------- init ----------

async function qpInit() {
    qpState.surahs = await qpFetch('/api/qp/surahs') || [];
    qpState.mushafs = await qpFetch('/api/qp/mushafs') || [];

    const surahSelect = document.getElementById('qp-surah-select');
    surahSelect.innerHTML = qpState.surahs.map(s =>
        `<option value="${s.surah_number}">${s.surah_number}. ${s.name || ''}</option>`).join('');

    const mushafSelect = document.getElementById('qp-mushaf-select');
    mushafSelect.innerHTML = qpState.mushafs.map(m =>
        `<option value="${m.mushaf_id}">${m.qiraa_name || ''} — ${m.rawi_name || ''} (${m.name})</option>`).join('');

    qpState.currentMushafId = qpState.mushafs[0]?.mushaf_id;
    qpState.currentSurah = 1;

    surahSelect.addEventListener('change', () => { qpState.currentSurah = +surahSelect.value; qpState.pageIndex = 0; qpLoadSurah(); });
    mushafSelect.addEventListener('change', () => { qpState.currentMushafId = +mushafSelect.value; qpState.pageIndex = 0; qpLoadSurah(); });

    document.getElementById('qp-modal-close').onclick = () => qpCloseModal('qp-ayah-modal');
    document.getElementById('qp-root-search-btn').onclick = () => qpOpenRootModal();
    document.getElementById('qp-root-modal-close').onclick = () => qpCloseModal('qp-root-modal');
    document.getElementById('qp-search-modal-close').onclick = () => qpCloseModal('qp-search-modal');

    document.getElementById('qp-search-btn').onclick = () => qpRunGlobalSearch();
    document.getElementById('qp-search-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') qpRunGlobalSearch();
    });
    document.getElementById('qp-root-search-go-btn').onclick = () => qpRunRootSearch();
    document.getElementById('qp-root-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') qpRunRootSearch();
    });

    document.getElementById('qp-back-to-results-bar-btn').onclick = () => qpReopenLastSearch();

    document.addEventListener('click', e => {
        if (!e.target.closest('.qp-popover') && !e.target.closest('.qp-ayah-word')) {
            document.getElementById('qp-word-popover').classList.remove('show');
        }
    });

    ['qp-ayah-modal', 'qp-root-modal', 'qp-search-modal'].forEach(id => {
        document.getElementById(id).addEventListener('click', e => {
            if (e.target.id === id) qpCloseModal(id);
        });
    });

    if (qpState.currentMushafId) qpLoadSurah();
}

// ---------- reading view (paginated) ----------

async function qpLoadSurah() {
    const surah = qpState.surahs.find(s => s.surah_number === qpState.currentSurah);
    document.getElementById('qp-surah-header').textContent = surah ? (surah.name || '') : '';

    const [ayahs, divergence] = await Promise.all([
        qpFetch(`/api/qp/ayahs/${qpState.currentMushafId}/${qpState.currentSurah}`),
        qpFetch(`/api/qp/surah/${qpState.currentSurah}/qiraat`),
    ]);

    qpState.allAyahs = ayahs || [];
    qpState.divergenceMap = divergence || {};

    const list = document.getElementById('qp-ayah-list');
    if (!qpState.allAyahs.length) {
        list.innerHTML = '<div class="qp-empty-note">لا يوجد نص لهذا المصحف/السورة</div>';
        return;
    }
    qpRenderPage();
}

function qpRenderPage() {
    const start = qpState.pageIndex * AYAHS_PER_PAGE;
    const pageAyahs = qpState.allAyahs.slice(start, start + AYAHS_PER_PAGE);

    const list = document.getElementById('qp-ayah-list');
    list.innerHTML = '';
    pageAyahs.forEach(a => list.appendChild(qpRenderAyah(a)));

    list.querySelectorAll('.qp-ayah-number').forEach(el => {
        el.addEventListener('click', () => qpOpenAyahModal(qpState.currentSurah, +el.dataset.ayah));
    });

    qpRenderPagerControls();

    // apply pending destination highlight (from a search-result click), if this page contains it
    if (qpState.pendingHighlight && qpState.pendingHighlight.surah === qpState.currentSurah) {
        const { ayah, term } = qpState.pendingHighlight;
        const badge = document.querySelector(`.qp-ayah-number[data-ayah="${ayah}"]`);
        if (badge) {
            const block = badge.closest('.qp-ayah-block');
            const regex = qpBuildHighlightRegex(term);
            if (regex) qpHighlightTextNode(block, regex);
            block.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const firstMark = block.querySelector('mark');
            (firstMark || badge).classList.add('qp-flash-highlight');
            setTimeout(() => (firstMark || badge).classList.remove('qp-flash-highlight'), 2500);
            qpState.pendingHighlight = null;
        }
    }
}

function qpRenderPagerControls() {
    let pager = document.getElementById('qp-pager');
    if (!pager) {
        pager = qpEl('div');
        pager.id = 'qp-pager';
        pager.className = 'qp-pager';
        document.getElementById('qp-reader-inner').appendChild(pager);
    }
    const totalPages = Math.ceil(qpState.allAyahs.length / AYAHS_PER_PAGE);
    const start = qpState.pageIndex * AYAHS_PER_PAGE + 1;
    const end = Math.min(start + AYAHS_PER_PAGE - 1, qpState.allAyahs.length);

    pager.innerHTML = '';
    const prevBtn = qpEl('button', 'qp-pager-btn', 'السابق ›');
    prevBtn.disabled = qpState.pageIndex === 0;
    prevBtn.onclick = () => { qpState.pageIndex--; qpRenderPage(); document.getElementById('qp-reader').scrollTo(0, 0); };

    const info = qpEl('span', 'qp-pager-info', `آيات ${start}–${end} من ${qpState.allAyahs.length} (صفحة ${qpState.pageIndex + 1}/${totalPages})`);

    const nextBtn = qpEl('button', 'qp-pager-btn', '‹ التالي');
    nextBtn.disabled = qpState.pageIndex >= totalPages - 1;
    nextBtn.onclick = () => { qpState.pageIndex++; qpRenderPage(); document.getElementById('qp-reader').scrollTo(0, 0); };

    pager.appendChild(prevBtn);
    pager.appendChild(info);
    pager.appendChild(nextBtn);
}

function qpRenderAyah(ayah) {
    const block = qpEl('span', 'qp-ayah-block');
    const divergentPhrases = qpState.divergenceMap[ayah.ayah_number] || [];
    const phraseWordSeqs = divergentPhrases.map(p => qpNormalize(p).split(/\s+/).filter(Boolean));

    if (ayah.text.includes('<')) {
        const raw = qpEl('span', 'qp-ayah-raw');
        raw.innerHTML = ayah.text;
        block.appendChild(raw);
    } else {
        const words = ayah.text.trim().split(/\s+/);
        const normWords = words.map(qpNormalize);
        const divergentIdx = new Set();
        phraseWordSeqs.forEach(seq => {
            if (!seq.length) return;
            for (let i = 0; i <= normWords.length - seq.length; i++) {
                let match = true;
                for (let j = 0; j < seq.length; j++) {
                    if (normWords[i + j] !== seq[j]) { match = false; break; }
                }
                if (match) for (let j = 0; j < seq.length; j++) divergentIdx.add(i + j);
            }
        });

        words.forEach((w, i) => {
            const span = qpEl('span', 'qp-ayah-word', w);
            span.dataset.surah = qpState.currentSurah;
            span.dataset.ayah = ayah.ayah_number;
            span.dataset.word = i + 1;
            if (divergentIdx.has(i)) span.classList.add('qp-divergence');
            block.appendChild(span);
            block.appendChild(document.createTextNode(' '));
        });
    }

    const badge = qpEl('span', 'qp-ayah-number', String(ayah.ayah_number));
    badge.dataset.ayah = ayah.ayah_number;
    block.appendChild(badge);
    block.appendChild(document.createTextNode(' '));
    return block;
}

// word click -> fetch morphology for that ayah (cached), show simplified root popover
document.addEventListener('click', async e => {
    const wordEl = e.target.closest('.qp-ayah-word');
    if (!wordEl) return;
    const surah = +wordEl.dataset.surah, ayah = +wordEl.dataset.ayah, wordNum = +wordEl.dataset.word;

    const key = `${surah}:${ayah}`;
    if (!qpState.morphologyCache[key]) {
        const morph = await qpFetch(`/api/qp/ayah/${surah}/${ayah}/morphology`);
        qpState.morphologyCache[key] = {};
        (morph || []).forEach(w => { qpState.morphologyCache[key][w.word_number] = w; });
    }
    const wordData = qpState.morphologyCache[key][wordNum];
    qpShowWordPopover(wordEl, wordData);
});

function qpShowWordPopover(anchorEl, wordData) {
    const pop = document.getElementById('qp-word-popover');
    pop.innerHTML = '';

    const roots = new Set();
    (wordData?.segments || []).forEach(s => { if (s.root) roots.add(s.root); });

    if (!roots.size) {
        pop.appendChild(qpEl('div', 'qp-empty-note', 'لا جذر متاح لهذه الكلمة'));
    } else {
        roots.forEach(root => {
            const line = qpEl('div', 'qp-popover-root', `الجذر: ${root}`);
            line.onclick = () => { qpOpenRootModal(root); pop.classList.remove('show'); };
            pop.appendChild(line);
        });
    }

    const rect = anchorEl.getBoundingClientRect();
    pop.style.top = (window.scrollY + rect.bottom + 4) + 'px';
    pop.style.left = Math.max(8, rect.left - 40) + 'px';
    pop.classList.add('show');
}

// ---------- ayah modal (tafsir / qira'at / asbab / e3rab / nasekh) ----------

const QP_SERVICE_LABELS = { tafsir: 'التفسير', asbab: 'أسباب النزول', e3rab: 'الإعراب', nasekh: 'الناسخ والمنسوخ' };

async function qpOpenAyahModal(surah, ayah, preferTab, preferBookId) {
    qpState.modal = { surah, ayah, activeTab: preferTab || null, activeBook: preferBookId || null };
    await qpRenderModalForCurrentAyah();
    qpOpenModal('qp-ayah-modal');
}

async function qpRenderModalForCurrentAyah() {
    const { surah, ayah } = qpState.modal;
    const ayahRow = qpState.allAyahs.find(a => a.ayah_number === ayah);
    document.getElementById('qp-modal-ayah-ref').textContent = `آية ${surah}:${ayah}`;
    document.getElementById('qp-modal-ayah-text').textContent = ayahRow ? ayahRow.text : '';

    const [books, divergence] = await Promise.all([
        qpFetch(`/api/qp/ayah/${surah}/${ayah}/books`),
        qpFetch(`/api/qp/ayah/${surah}/${ayah}/qiraat`),
    ]);

    const tabs = [];
    if (divergence && divergence.length) tabs.push({ key: 'qiraat', label: 'القراءات' });
    ['tafsir', 'asbab', 'e3rab', 'nasekh'].forEach(t => {
        if (books && books[t] && books[t].length) tabs.push({ key: t, label: QP_SERVICE_LABELS[t] });
    });

    const tabBar = document.getElementById('qp-tabs');
    tabBar.innerHTML = '';

    const navWrap = qpEl('div', 'qp-modal-nav');
    const prevBtn = qpEl('button', 'qp-modal-nav-btn', 'الآية السابقة ›');
    const nextBtn = qpEl('button', 'qp-modal-nav-btn', '‹ الآية التالية');
    const idx = qpState.allAyahs.findIndex(a => a.ayah_number === ayah);
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx < 0 || idx >= qpState.allAyahs.length - 1;
    prevBtn.onclick = () => qpModalNavigate(-1);
    nextBtn.onclick = () => qpModalNavigate(1);
    navWrap.appendChild(prevBtn);
    navWrap.appendChild(nextBtn);
    tabBar.appendChild(navWrap);

    if (!tabs.length) {
        document.getElementById('qp-tab-body').innerHTML = '<div class="qp-empty-note">لا توجد بيانات إضافية لهذه الآية</div>';
        return;
    }

    let activeKey = qpState.modal.activeTab && tabs.some(t => t.key === qpState.modal.activeTab)
        ? qpState.modal.activeTab : tabs[0].key;

    tabs.forEach(t => {
        const btn = qpEl('button', 'qp-tab-btn' + (t.key === activeKey ? ' active' : ''), t.label);
        btn.onclick = () => {
            qpState.modal.activeTab = t.key;
            qpState.modal.activeBook = null;
            tabBar.querySelectorAll('.qp-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            qpShowTab(t.key, surah, ayah, books, divergence);
        };
        tabBar.appendChild(btn);
    });

    qpState.modal.activeTab = activeKey;
    qpShowTab(activeKey, surah, ayah, books, divergence);
}

async function qpModalNavigate(direction) {
    const idx = qpState.allAyahs.findIndex(a => a.ayah_number === qpState.modal.ayah);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= qpState.allAyahs.length) return;
    qpState.modal.ayah = qpState.allAyahs[newIdx].ayah_number;
    await qpRenderModalForCurrentAyah();
}

function qpShowTab(key, surah, ayah, books, divergence) {
    const body = document.getElementById('qp-tab-body');
    body.innerHTML = '';

    if (key === 'qiraat') {
        if (!divergence.length) { body.appendChild(qpEl('div', 'qp-empty-note', 'لا اختلافات قراءات لهذه الآية')); return; }
        divergence.forEach(d => {
            const row = qpEl('div', 'qp-divergence-row');
            row.appendChild(qpEl('div', 'qp-divergence-word', d.ayah_word));
            d.variants.forEach(v => {
                const line = qpEl('div', 'qp-divergence-variant');
                const rawi = qpEl('span', 'qp-divergence-rawi', `${v.rawi_name} (${v.qiraa_name})`);
                line.appendChild(rawi);
                line.appendChild(document.createTextNode(' — ' + v.qiraa_text));
                row.appendChild(line);
            });
            body.appendChild(row);
        });
        return;
    }

    const list = (books && books[key]) || [];
    if (!list.length) { body.appendChild(qpEl('div', 'qp-empty-note', 'لا محتوى متاح')); return; }

    const select = qpEl('select', 'qp-book-dropdown');
    list.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.book_id;
        opt.textContent = b.name + (b.author_name ? ' — ' + b.author_name : '');
        select.appendChild(opt);
    });
    const contentDiv = qpEl('div', 'qp-book-content', 'جارٍ التحميل...');
    body.appendChild(select);
    body.appendChild(contentDiv);

    const wantedBookId = qpState.modal.activeBook && list.some(b => b.book_id === qpState.modal.activeBook)
        ? qpState.modal.activeBook : list[0].book_id;
    select.value = wantedBookId;

    const loadContent = async (bookId) => {
        qpState.modal.activeBook = bookId;
        contentDiv.textContent = 'جارٍ التحميل...';
        const data = await qpFetch(`/api/qp/book_content/${bookId}/${surah}/${ayah}`);
        contentDiv.innerHTML = data ? data.content_html : '<div class="qp-empty-note">لا يوجد نص لهذا المصدر عند هذه الآية</div>';

        // apply destination highlight if this content is what a tafsir search hit navigated us to
        if (qpState.pendingHighlight && qpState.pendingHighlight.surah === surah && qpState.pendingHighlight.ayah === ayah) {
            const regex = qpBuildHighlightRegex(qpState.pendingHighlight.term);
            if (regex) qpHighlightTextNode(contentDiv, regex);
            const firstMark = contentDiv.querySelector('mark');
            if (firstMark) {
                firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
                firstMark.classList.add('qp-flash-highlight');
                setTimeout(() => firstMark.classList.remove('qp-flash-highlight'), 2500);
            }
            qpState.pendingHighlight = null;
        }
    };
    select.addEventListener('change', e => loadContent(+e.target.value));
    loadContent(wantedBookId);
}

// ---------- root search ----------

function qpOpenRootModal(prefillRoot) {
    qpOpenModal('qp-root-modal');
    const input = document.getElementById('qp-root-input');
    document.getElementById('qp-root-results').innerHTML = '';
    document.getElementById('qp-root-load-more-wrap').innerHTML = '';
    if (prefillRoot) { input.value = prefillRoot; qpRunRootSearch(); }
}

async function qpRunRootSearch() {
    const root = document.getElementById('qp-root-input').value.trim();
    if (!root) return;
    qpState.lastSearch = { type: 'root', query: root, results: [], offset: 0, hasMore: false };
    document.getElementById('qp-root-results').innerHTML = '';
    await qpLoadMoreRootResults();
}

async function qpLoadMoreRootResults() {
    const s = qpState.lastSearch;
    const data = await qpFetch(`/api/qp/root/${encodeURIComponent(s.query)}?offset=${s.offset}&limit=${SEARCH_PAGE_SIZE}`);
    const results = (data && data.results) || [];
    s.results.push(...results);
    s.offset += results.length;
    s.hasMore = data ? data.has_more : false;

    const container = document.getElementById('qp-root-results');
    if (!s.results.length) { container.appendChild(qpEl('div', 'qp-empty-note', 'لا نتائج')); }
    results.forEach(h => {
        const row = qpEl('div', 'qp-root-hit', `${h.surah_number}:${h.ayah_number} — ${h.word_text}`);
        row.onclick = () => {
            qpState.pendingHighlight = { surah: h.surah_number, ayah: h.ayah_number, term: h.word_text };
            qpNavigateToAyah(h.surah_number, h.ayah_number, () => qpCloseModal('qp-root-modal'));
        };
        container.appendChild(row);
    });

    qpRenderLoadMoreButton('qp-root-load-more-wrap', s.hasMore, qpLoadMoreRootResults);
    qpUpdateBackToResultsBar();
}

// ---------- global search ----------

async function qpRunGlobalSearch() {
    const q = document.getElementById('qp-search-input').value.trim();
    const scope = document.getElementById('qp-search-scope').value;
    if (!q) return;

    qpState.lastSearch = { type: 'global', query: q, scope, results: [], offset: 0, hasMore: false };
    document.getElementById('qp-search-results').innerHTML = '';
    document.getElementById('qp-search-load-more-wrap').innerHTML = '';
    qpOpenModal('qp-search-modal');
    await qpLoadMoreGlobalResults();
}

async function qpLoadMoreGlobalResults() {
    const s = qpState.lastSearch;
    const url = s.scope === 'ayahs'
        ? `/api/qp/search/ayahs?q=${encodeURIComponent(s.query)}&offset=${s.offset}&limit=${SEARCH_PAGE_SIZE}`
        : `/api/qp/search/books?q=${encodeURIComponent(s.query)}&offset=${s.offset}&limit=${SEARCH_PAGE_SIZE}`;
    const data = await qpFetch(url);
    const results = (data && data.results) || [];
    s.results.push(...results);
    s.offset += results.length;
    s.hasMore = data ? data.has_more : false;

    const container = document.getElementById('qp-search-results');
    if (!s.results.length) { container.appendChild(qpEl('div', 'qp-empty-note', 'لا نتائج')); }

    results.forEach(h => {
        const surahNum = Number(h.surah_number);
        const ayahNum = Number(h.ayah_number);
        const row = qpEl('div', 'qp-root-hit');

        if (s.scope === 'ayahs') {
            row.appendChild(qpEl('strong', null, `${h.surah_name} ${surahNum}:${ayahNum}`));
            row.appendChild(document.createElement('br'));
            const snippet = qpEl('span', 'qp-search-hit-snippet');
            snippet.innerHTML = h.snippet || h.text || '';
            row.appendChild(snippet);
            row.onclick = () => {
                qpState.pendingHighlight = { surah: surahNum, ayah: ayahNum, term: s.query };
                qpNavigateToAyah(surahNum, ayahNum, () => qpCloseModal('qp-search-modal'));
            };
        } else {
            row.appendChild(qpEl('strong', null, `${h.book_name} — ${surahNum}:${ayahNum}`));
            const snippet = qpEl('div', 'qp-search-hit-snippet');
            snippet.innerHTML = h.snippet || '';
            row.appendChild(snippet);
            row.onclick = () => {
                qpState.pendingHighlight = { surah: surahNum, ayah: ayahNum, term: s.query };
                qpNavigateToAyah(surahNum, ayahNum, () => {
                    qpCloseModal('qp-search-modal');
                    qpOpenAyahModal(surahNum, ayahNum, 'tafsir', h.book_id);
                });
            };
        }
        container.appendChild(row);
    });

    qpRenderLoadMoreButton('qp-search-load-more-wrap', s.hasMore, qpLoadMoreGlobalResults);
    qpUpdateBackToResultsBar();
}

function qpRenderLoadMoreButton(wrapId, hasMore, loadFn) {
    const wrap = document.getElementById(wrapId);
    wrap.innerHTML = '';
    if (!hasMore) return;
    const btn = qpEl('button', 'qp-load-more-btn', 'تحميل المزيد ↓');
    btn.onclick = () => loadFn();
    wrap.appendChild(btn);
}

// ---------- back-to-results bar ----------

function qpUpdateBackToResultsBar() {
    const bar = document.getElementById('qp-back-to-results-bar');
    bar.classList.toggle('show', !!qpState.lastSearch);
}

function qpReopenLastSearch() {
    const s = qpState.lastSearch;
    if (!s) return;
    if (s.type === 'root') {
        qpOpenModal('qp-root-modal');
        document.getElementById('qp-root-input').value = s.query;
        const container = document.getElementById('qp-root-results');
        container.innerHTML = '';
        s.results.forEach(h => {
            const row = qpEl('div', 'qp-root-hit', `${h.surah_number}:${h.ayah_number} — ${h.word_text}`);
            row.onclick = () => {
                qpState.pendingHighlight = { surah: h.surah_number, ayah: h.ayah_number, term: h.word_text };
                qpNavigateToAyah(h.surah_number, h.ayah_number, () => qpCloseModal('qp-root-modal'));
            };
            container.appendChild(row);
        });
        qpRenderLoadMoreButton('qp-root-load-more-wrap', s.hasMore, qpLoadMoreRootResults);
    } else {
        qpOpenModal('qp-search-modal');
        document.getElementById('qp-search-input').value = s.query;
        document.getElementById('qp-search-scope').value = s.scope;
        const container = document.getElementById('qp-search-results');
        container.innerHTML = '';
        s.results.forEach(h => {
            const surahNum = Number(h.surah_number);
            const ayahNum = Number(h.ayah_number);
            const row = qpEl('div', 'qp-root-hit');
            if (s.scope === 'ayahs') {
                row.appendChild(qpEl('strong', null, `${h.surah_name} ${surahNum}:${ayahNum}`));
                row.appendChild(document.createElement('br'));
                const snippet = qpEl('span', 'qp-search-hit-snippet');
                snippet.innerHTML = h.snippet || h.text || '';
                row.appendChild(snippet);
                row.onclick = () => {
                    qpState.pendingHighlight = { surah: surahNum, ayah: ayahNum, term: s.query };
                    qpNavigateToAyah(surahNum, ayahNum, () => qpCloseModal('qp-search-modal'));
                };
            } else {
                row.appendChild(qpEl('strong', null, `${h.book_name} — ${surahNum}:${ayahNum}`));
                const snippet = qpEl('div', 'qp-search-hit-snippet');
                snippet.innerHTML = h.snippet || '';
                row.appendChild(snippet);
                row.onclick = () => {
                    qpState.pendingHighlight = { surah: surahNum, ayah: ayahNum, term: s.query };
                    qpNavigateToAyah(surahNum, ayahNum, () => {
                        qpCloseModal('qp-search-modal');
                        qpOpenAyahModal(surahNum, ayahNum, 'tafsir', h.book_id);
                    });
                };
            }
            container.appendChild(row);
        });
        qpRenderLoadMoreButton('qp-search-load-more-wrap', s.hasMore, qpLoadMoreGlobalResults);
    }
}

// ---------- shared navigate ----------

async function qpNavigateToAyah(surahNum, ayahNum, afterClose) {
    if (qpState.currentSurah !== surahNum) {
        document.getElementById('qp-surah-select').value = surahNum;
        qpState.currentSurah = surahNum;
        qpState.pageIndex = 0;
        await qpLoadSurah();
    }
    const idx = qpState.allAyahs.findIndex(a => a.ayah_number === ayahNum);
    if (idx >= 0) {
        qpState.pageIndex = Math.floor(idx / AYAHS_PER_PAGE);
        qpRenderPage();
    }
    if (afterClose) afterClose();
}

document.addEventListener('DOMContentLoaded', qpInit);
