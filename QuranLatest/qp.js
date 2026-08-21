// qp.js — Quran Pedia section frontend logic
//
// Architecture mirrors hk- (Hadith) in parent/app.js: ONE overlay, two panes,
// swapped via .hidden — never multiple stacked modals:
//   - #qp-results-pane: the reader (surah + paginated ayahs) OR search
//     results (ayahs/books/root), depending on the active mode tab. State is
//     preserved per mode when you leave it, same as hkSearchState.
//   - #qp-detail-pane: an UNLIMITED-DEPTH stack (qpDetailStack) of detail
//     views — an ayah's tafsir/qiraat/etc, or a root's occurrence list.
//     Clicking a root FROM WITHIN a tafsir view pushes a new entry on top
//     rather than closing/replacing anything (fixes item #8: navigating to
//     a search hit, or drilling into a root from inside a tafsir, no longer
//     loses your place). "🔍 نتائج البحث" always jumps back to the results
//     pane regardless of stack depth; "السابق" pops one level.

const AYAHS_PER_PAGE = 10;
const SEARCH_PAGE_SIZE = 20;

// Mirrors DEFAULT_MUSHAF_ID in quran_pedia_bp.py. Item #1: the reader can
// now switch between any mushaf/riwayah with real text (Warsh, Qalun, etc.)
// for DISPLAY purposes — but root-click and tafsir/qira'at detail views
// always read against THIS edition specifically, since morphology_words
// and book_content are only aligned with Hafs's own text. Switching the
// reader's mushaf never changes what a word-click or ayah-detail shows.
const QP_DEFAULT_MUSHAF_ID = 1;

const qpState = {
    surahs: [],
    mushafs: [],                // every mushaf with real ayah text (item #1)
    currentMushafId: QP_DEFAULT_MUSHAF_ID,  // which edition the READER displays
    currentSurah: 1,
    allAyahs: [],
    divergenceMap: {},
    pageIndex: 0,
    morphologyCache: {},       // key `${surah}:${ayah}` -> { byWordNumber, alignment }
    mode: 'reader',            // 'reader' | 'ayahs' | 'books' | 'root'
    searchState: {
        ayahs: { query: '', results: [], offset: 0, hasMore: false, summary: '' },
        books: { query: '', results: [], offset: 0, hasMore: false, summary: '' },
        root:  { query: '', results: [], offset: 0, hasMore: false, summary: '' },
    },
    readerScrollTop: 0,
};

// Unlimited-depth detail stack. Each entry:
//   { type: 'ayah', surah, ayah, activeTab, activeBook, pendingHighlight }
//   { type: 'root', root }  (its own results live in searchState.root instead
//     of being duplicated per stack entry, matching how root-search-as-a-mode
//     already works; the stack entry just marks "we're viewing this detail")
const qpDetailStack = [];

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

// Item #8: user-facing numbers should render in Arabic-Indic numerals
// (٠١٢٣٤٥٦٧٨٩), matching the rest of the Arabic UI — API calls, dataset
// values, and internal state all stay Western-digit (untouched), this only
// converts text actually shown to the user.
const QP_ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
function qpArabicNum(n) {
    return String(n).replace(/[0-9]/g, d => QP_ARABIC_DIGITS[+d]);
}

// Item (b): universal tashkeel toggle — shown by default, applies to
// tafsir/qira'at/asbab/e3rab/nasekh detail views and search results, but
// NEVER to the mushaf reader itself (#qp-ayah-list), which always stays
// diacritized regardless of this toggle's state. Mirrors Shamela's own
// TASHKEEL_REGEX exactly (parent/app.js) so toggling behaves identically
// across the whole app.
const QP_TASHKEEL_REGEX = /[\u064B-\u065F\u0670]/g;
let qpTashkeelVisible = true;

function qpStripTashkeel(html) {
    return html.replace(QP_TASHKEEL_REGEX, '');
}

// Applies the current tashkeel state to a container's HTML. Only meant for
// containers OUTSIDE the reader (detail body, search results) — called
// once right after their content is set.
function qpApplyTashkeelState(container) {
    if (qpTashkeelVisible || !container) return;
    container.innerHTML = qpStripTashkeel(container.innerHTML);
}

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
    const variants = {
        '\u0627': '[\u0627\u0622\u0623\u0625]',
        '\u0647': '[\u0647\u0629]',
        '\u064A': '[\u064A\u0649]',
    };
    const pattern = escaped.map(ch => (variants[ch] || ch) + DIACRITIC).join('');
    try { return new RegExp(pattern, 'g'); } catch (e) { return null; }
}

function qpHighlightTextNode(el, regex) {
    if (!regex) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    let firstMark = null;
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
            if (!firstMark) firstMark = mark;
            frag.appendChild(mark);
            lastIdx = m.index + m[0].length;
        }
        frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        node.parentNode.replaceChild(frag, node);
    });
    return firstMark;
}

// Item (d): highlight marks persist until the user's NEXT left-click
// anywhere on the page, then disappear — not a fixed timeout, not
// permanent. qpClearActiveHighlights() un-wraps every currently-marked
// node back to plain text (merging adjacent text nodes isn't necessary
// for correctness, just leaves the DOM slightly more fragmented, which is
// harmless). The listener is registered fresh each time a highlight is
// applied and removes itself after firing once, so repeated searches
// don't accumulate multiple listeners.
function qpClearActiveHighlights() {
    document.querySelectorAll('mark.qp-search-mark').forEach(mark => {
        const parent = mark.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
    });
}

let qpHighlightClearListener = null;

function qpApplyDestinationHighlight(container, term) {
    const regex = qpBuildHighlightRegex(term);
    if (!regex) return;
    requestAnimationFrame(() => {
        // clear any highlight left over from a previous search before
        // applying a new one, and drop that search's pending click-listener
        // so it doesn't fire later and clear the WRONG (new) highlight
        if (qpHighlightClearListener) {
            document.removeEventListener('click', qpHighlightClearListener);
            qpHighlightClearListener = null;
        }
        qpClearActiveHighlights();

        const firstMark = qpHighlightTextNode(container, regex);
        if (firstMark) {
            firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });

            qpHighlightClearListener = () => {
                qpClearActiveHighlights();
                document.removeEventListener('click', qpHighlightClearListener);
                qpHighlightClearListener = null;
            };
            // registered on a fresh microtask/next tick so the click that
            // TRIGGERED this navigation (e.g. clicking a search result)
            // doesn't itself immediately clear the highlight it just created
            setTimeout(() => document.addEventListener('click', qpHighlightClearListener), 0);
        }
    });
}

// ---------- overlay open/close ----------

function qpOpenOverlay() {
    document.getElementById('qp-overlay').classList.add('show');
    if (!qpState.surahs.length) qpInitData();
}

function qpCloseOverlay() {
    document.getElementById('qp-overlay').classList.remove('show');
    // state intentionally left untouched — reopening restores this view,
    // same convention as hkOverlay.
}

// ---------- init ----------

async function qpInitData() {
    qpState.surahs = await qpFetch('/api/qp/surahs') || [];
    qpState.mushafs = await qpFetch('/api/qp/mushafs') || [];

    const surahSelect = document.getElementById('qp-surah-select');
    surahSelect.innerHTML = qpState.surahs.map(s =>
        `<option value="${s.surah_number}">${qpArabicNum(s.surah_number)}. ${s.name || ''}</option>`).join('');

    const mushafSelect = document.getElementById('qp-mushaf-select');
    mushafSelect.innerHTML = qpState.mushafs.map(m =>
        `<option value="${m.mushaf_id}">${m.qiraa_name || ''} — ${m.rawi_name || ''}</option>`).join('');
    mushafSelect.value = QP_DEFAULT_MUSHAF_ID;

    qpState.currentSurah = 1;
    qpState.currentMushafId = QP_DEFAULT_MUSHAF_ID;
    if (qpState.mushafs.length) qpLoadSurah();
}

function qpInit() {
    document.getElementById('btn-qp-toggle').addEventListener('click', qpOpenOverlay);
    document.getElementById('qp-close').addEventListener('click', qpCloseOverlay);
    document.getElementById('qp-overlay').addEventListener('click', e => {
        if (e.target.id === 'qp-overlay') qpCloseOverlay();
    });

    document.getElementById('qp-surah-select').addEventListener('change', e => {
        qpState.currentSurah = +e.target.value;
        qpState.pageIndex = 0;
        qpLoadSurah();
    });

    // Item #1: switching the reader's mushaf/qira'ah only changes what
    // text is displayed here — word-click-to-root and every detail view
    // (tafsir/qira'at/asbab/e3rab/nasekh) still reads against
    // QP_DEFAULT_MUSHAF_ID regardless of this selection, since that's the
    // only edition morphology_words/book_content align with.
    document.getElementById('qp-mushaf-select').addEventListener('change', e => {
        qpState.currentMushafId = +e.target.value;
        qpState.pageIndex = 0;
        qpLoadSurah();
    });

    document.querySelectorAll('.hk-mode-tab').forEach(tab => {
        tab.addEventListener('click', () => qpSwitchMode(tab.dataset.qpMode));
    });

    const input = document.getElementById('qp-search-input');
    const submitBtn = document.getElementById('qp-search-submit');
    const clearBtn = document.getElementById('qp-search-clear');

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') qpRunSearch(qpState.mode, input.value.trim());
    });
    submitBtn.addEventListener('click', () => qpRunSearch(qpState.mode, input.value.trim()));

    // Item #2: clear button visibility follows Hadith's own convention
    // (.toc-search-clear) — hidden when empty, shown once there's text.
    input.addEventListener('input', () => {
        clearBtn.classList.toggle('hidden', input.value === '');
    });
    clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.classList.add('hidden');
        qpRunSearch(qpState.mode, '');
        input.focus();
    });

    document.getElementById('qp-detail-back').addEventListener('click', qpPopDetail);
    document.getElementById('qp-detail-results').addEventListener('click', qpShowResultsLayer);

    // Item (b): tashkeel toggle. Applies to detail views (tafsir/qira'at/
    // asbab/e3rab/nasekh — except qira'at variant readings, which are
    // Qur'anic text and always stay diacritized), search result snippets
    // from tafsir (not ayah/root text), and the "عن هذه السورة" prose
    // section — but NEVER the mushaf text in #qp-ayah-list itself.
    const tashkeelBtn = document.getElementById('qp-btn-tashkeel');
    tashkeelBtn.addEventListener('click', () => {
        qpTashkeelVisible = !qpTashkeelVisible;
        tashkeelBtn.classList.toggle('active-toggle', !qpTashkeelVisible);
        tashkeelBtn.textContent = qpTashkeelVisible ? '◌ التشكيل' : '◌ بدون تشكيل';

        // capture scroll offsets before touching anything, so re-rendering
        // never visually shakes/jumps the page — same technique as
        // Shamela's own setupTashkeelToggle() (parent/app.js).
        const modalEl = document.querySelector('.qp-modal');
        const modalScrollTop = modalEl ? modalEl.scrollTop : 0;
        const bookContentEl = document.querySelector('.qp-book-content');
        const bookContentScrollTop = bookContentEl ? bookContentEl.scrollTop : 0;
        const readerScrollEl = document.getElementById('qp-reader-scroll');
        const readerScrollTop = readerScrollEl ? readerScrollEl.scrollTop : 0;

        const detailPane = document.getElementById('qp-detail-pane');
        if (!detailPane.classList.contains('hidden')) {
            // re-render whatever's on top of the detail stack in place
            const top = qpDetailStack[qpDetailStack.length - 1];
            if (top) qpRenderDetailEntry(top);
        } else if (qpState.mode !== 'reader') {
            qpRenderSearchResults(qpState.mode);
        }
        // the mushaf text itself (#qp-ayah-list) is deliberately never
        // touched — only its neighboring "عن هذه السورة" section responds,
        // re-fetched fresh since it's cheap and avoids re-deriving from
        // already-stripped HTML.
        if (qpState.mode === 'reader') {
            qpFetch(`/api/qp/surahs/${qpState.currentSurah}`).then(qpRenderSurahAbout);
        }

        requestAnimationFrame(() => {
            if (modalEl) modalEl.scrollTop = modalScrollTop;
            const newBookContentEl = document.querySelector('.qp-book-content');
            if (newBookContentEl) newBookContentEl.scrollTop = bookContentScrollTop;
            if (readerScrollEl) readerScrollEl.scrollTop = readerScrollTop;
        });
    });

    // Item (a): qira'at-divergence underline visibility toggle — hidden by
    // default. Pure CSS gate (body.qp-show-divergence), no re-render
    // needed since .qp-divergence classes are already applied to the
    // relevant words regardless of this toggle's state.
    const divergenceBtn = document.getElementById('qp-btn-divergence');
    divergenceBtn.addEventListener('click', () => {
        const showing = document.body.classList.toggle('qp-show-divergence');
        divergenceBtn.classList.toggle('active-toggle', showing);
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.qp-popover') && !e.target.closest('.qp-ayah-word')) {
            document.getElementById('qp-word-popover').classList.remove('show');
        }
    });
}

// ---------- mode switching (reader / ayahs search / books search / root search) ----------

function qpSwitchMode(mode) {
    qpState.mode = mode;
    document.querySelectorAll('.hk-mode-tab').forEach(t => t.classList.toggle('active', t.dataset.qpMode === mode));

    const isReader = mode === 'reader';
    document.getElementById('qp-reader-controls').classList.toggle('hidden', !isReader);
    document.getElementById('qp-reader-scroll').classList.toggle('hidden', !isReader);
    document.getElementById('qp-search-box-wrap').classList.toggle('hidden', isReader);
    document.getElementById('qp-results-summary').classList.toggle('hidden', isReader);
    document.getElementById('qp-results-list').classList.toggle('hidden', isReader);

    const input = document.getElementById('qp-search-input');
    const clearBtn = document.getElementById('qp-search-clear');
    if (!isReader) {
        const s = qpState.searchState[mode];
        input.value = s.query;
        input.placeholder = mode === 'root' ? 'اكتب الجذر (مثال: سمو)' : 'ابحث...';
        clearBtn.classList.toggle('hidden', s.query === '');
        qpRenderSearchResults(mode);
    }
}

// ---------- reading view (paginated) ----------

async function qpLoadSurah() {
    const surah = qpState.surahs.find(s => s.surah_number === qpState.currentSurah);
    document.getElementById('qp-surah-header').textContent = surah ? (surah.name || '') : '';

    const [ayahs, divergence, surahDetail] = await Promise.all([
        qpFetch(`/api/qp/ayahs/${qpState.currentMushafId}/${qpState.currentSurah}`),
        qpFetch(`/api/qp/surah/${qpState.currentSurah}/qiraat`),
        qpFetch(`/api/qp/surahs/${qpState.currentSurah}`),
    ]);

    qpState.allAyahs = ayahs || [];
    qpState.divergenceMap = divergence || {};
    qpRenderSurahAbout(surahDetail);

    const list = document.getElementById('qp-ayah-list');
    if (!qpState.allAyahs.length) {
        list.innerHTML = '<div class="qp-empty-note">لا يوجد نص لهذه السورة</div>';
        return;
    }
    qpRenderPage();
}

// Item #6: surahs carries real editorial content (intro, virtues, Prophetic
// guidance, revelation-occasion notes, chronological descent order) that
// was fetched via surah_detail() but never rendered anywhere. Collapsed by
// default — it's supplementary, not something that should push the ayah
// text further down the page every time you open a surah.
const QP_ABOUT_SECTIONS = [
    ['introduction_html', 'نبذة عن السورة'],
    ['grace_html', 'فضائل السورة'],
    ['prophet_guidance_html', 'هدي النبي ﷺ في هذه السورة'],
    ['revelation_html', 'مناسبة النزول'],
];

// Item #12: the source HTML (Quranpedia export) contains inline
// style="font: 18pt " / "font: 15pt " attributes on quoted-ayah and
// citation spans, plus leftover Microsoft Word export artifacts
// (<!--[if gte mso 9]>...--> XML comments). Inline styles win over any
// external CSS by specificity, so these silently overrode our own
// font-size rules — that's the actual cause of the reported abrupt
// font-size jumps inside "عن هذه السورة" (and potentially book content,
// though not seen in the sample checked). Strips both before rendering;
// does not touch real semantic markup (span classes, data attributes) or
// wrapping structure, which qpRenderBookContent's footnote logic still
// needs intact.
function qpSanitizeSourceHtml(html) {
    if (!html) return html;
    return html
        .replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, '')  // MS Word conditional comments
        .replace(/<!--\[if[^\]]*\]>/gi, '').replace(/<!\[endif\]-->/gi, '')  // any unmatched leftovers
        .replace(/\sstyle="[^"]*"/gi, '');  // inline font-size/style overrides
}

function qpRenderSurahAbout(detail) {
    const host = document.getElementById('qp-surah-about');
    host.innerHTML = '';
    if (!detail) { host.classList.add('hidden'); return; }

    const sections = QP_ABOUT_SECTIONS.filter(([key]) => detail[key]);
    if (!sections.length) { host.classList.add('hidden'); return; }
    host.classList.remove('hidden');

    const toggle = qpEl('button', 'qp-about-toggle',
        detail.descent_order ? `عن هذه السورة (الترتيب النزولي: ${qpArabicNum(detail.descent_order)}) ▾` : 'عن هذه السورة ▾');
    const body = qpEl('div', 'qp-about-body hidden');

    sections.forEach(([key, label]) => {
        const section = qpEl('div', 'qp-about-section');
        section.appendChild(qpEl('div', 'qp-about-label', label));
        const content = qpEl('div', 'qp-about-content');
        content.innerHTML = qpSanitizeSourceHtml(detail[key]);
        qpApplyTashkeelState(content);
        section.appendChild(content);
        body.appendChild(section);
    });

    toggle.onclick = () => {
        const willShow = body.classList.contains('hidden');
        body.classList.toggle('hidden');
        toggle.textContent = toggle.textContent.replace(willShow ? '▾' : '▴', willShow ? '▴' : '▾');
    };

    host.appendChild(toggle);
    host.appendChild(body);
}

function qpRenderPage() {
    const start = qpState.pageIndex * AYAHS_PER_PAGE;
    const pageAyahs = qpState.allAyahs.slice(start, start + AYAHS_PER_PAGE);

    const list = document.getElementById('qp-ayah-list');
    list.innerHTML = '';
    pageAyahs.forEach(a => list.appendChild(qpRenderAyah(a)));

    list.querySelectorAll('.qp-ayah-number').forEach(el => {
        if (el.classList.contains('qp-non-hafs')) return;  // display-only mushaf — no detail view to open
        el.addEventListener('click', () => qpPushAyahDetail(qpState.currentSurah, +el.dataset.ayah));
    });

    qpRenderPagerControls();
}

function qpRenderPagerControls() {
    const pager = document.getElementById('qp-pager');
    const totalPages = Math.ceil(qpState.allAyahs.length / AYAHS_PER_PAGE);
    const start = qpState.pageIndex * AYAHS_PER_PAGE + 1;
    const end = Math.min(start + AYAHS_PER_PAGE - 1, qpState.allAyahs.length);

    pager.innerHTML = '';
    pager.className = 'qp-pager';
    const prevBtn = qpEl('button', 'qp-pager-btn', '← السابق');
    prevBtn.disabled = qpState.pageIndex === 0;
    prevBtn.onclick = () => { qpState.pageIndex--; qpRenderPage(); document.getElementById('qp-reader-scroll').scrollTo(0, 0); };

    const info = qpEl('span', 'qp-pager-info',
        `آيات ${qpArabicNum(start)}–${qpArabicNum(end)} من ${qpArabicNum(qpState.allAyahs.length)} (صفحة ${qpArabicNum(qpState.pageIndex + 1)}/${qpArabicNum(totalPages)})`);

    const nextBtn = qpEl('button', 'qp-pager-btn', 'التالي →');
    nextBtn.disabled = qpState.pageIndex >= totalPages - 1;
    nextBtn.onclick = () => { qpState.pageIndex++; qpRenderPage(); document.getElementById('qp-reader-scroll').scrollTo(0, 0); };

    pager.appendChild(prevBtn);
    pager.appendChild(info);
    pager.appendChild(nextBtn);
}

function qpRenderAyah(ayah) {
    const block = qpEl('span', 'qp-ayah-block');
    const divergentPhrases = qpState.divergenceMap[ayah.ayah_number] || [];
    const phraseWordSeqs = divergentPhrases.map(p => qpNormalize(p).split(/\s+/).filter(Boolean));

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

    // Item: non-Hafs mushafs are DISPLAY-ONLY in the reader — every
    // feature this app offers (root/morphology, tafsir, qira'at, asbab,
    // e3rab, nasekh) is keyed to Hafs's own surah/ayah/word numbering, so
    // none of it is meaningful when a different mushaf's text is on
    // screen. Word spans and the ayah-number badge stay in the DOM (so the
    // reading layout doesn't shift) but lose their interactive affordances
    // entirely when not on Hafs — see qp.css .qp-non-hafs for the visual
    // cue (no pointer cursor, no hover background).
    const isHafs = qpState.currentMushafId === QP_DEFAULT_MUSHAF_ID;

    words.forEach((w, i) => {
        // Displayed word index i does NOT reliably equal the morphology
        // word_number — pause marks and multi-token Corpus entries (e.g.
        // "يا أيها") break that assumption. The click handler resolves the
        // real word_number via the server's /morphology alignment response.
        // Item #7: no more always-on highlighting for ordinary words — only
        // qira'at-divergent words get a persistent visual marker; plain
        // words only respond on hover (see qp.css), the click affordance
        // being discoverable via cursor + hover background alone.
        const span = qpEl('span', 'qp-ayah-word' + (isHafs ? '' : ' qp-non-hafs'), w);
        span.dataset.surah = qpState.currentSurah;
        span.dataset.ayah = ayah.ayah_number;
        span.dataset.tokenIndex = i;
        if (isHafs && divergentIdx.has(i)) span.classList.add('qp-divergence');
        block.appendChild(span);
        block.appendChild(document.createTextNode(' '));
    });

    const badge = qpEl('span', 'qp-ayah-number' + (isHafs ? '' : ' qp-non-hafs'), qpArabicNum(ayah.ayah_number));
    badge.dataset.ayah = ayah.ayah_number;
    block.appendChild(badge);
    block.appendChild(document.createTextNode(' '));
    return block;
}

// word click -> fetch morphology+alignment for that ayah (cached), show root popover.
document.addEventListener('click', async e => {
    const wordEl = e.target.closest('.qp-ayah-word');
    if (!wordEl) return;
    if (wordEl.classList.contains('qp-non-hafs')) return;  // display-only mushaf — root/morphology data doesn't correspond to this text at all
    const surah = +wordEl.dataset.surah, ayah = +wordEl.dataset.ayah, tokenIndex = +wordEl.dataset.tokenIndex;

    const key = `${surah}:${ayah}`;
    if (!qpState.morphologyCache[key]) {
        const data = await qpFetch(`/api/qp/ayah/${surah}/${ayah}/morphology`);
        const byWordNumber = {};
        (data?.words || []).forEach(w => { byWordNumber[w.word_number] = w; });
        qpState.morphologyCache[key] = { byWordNumber, alignment: data?.alignment || [] };
    }
    const cache = qpState.morphologyCache[key];
    const tok = cache.alignment[tokenIndex];
    if (!tok || !tok.clickable) {
        qpShowWordPopover(wordEl, null);
        return;
    }
    const wordData = cache.byWordNumber[tok.word_number];
    qpShowWordPopover(wordEl, wordData);
});

function qpShowWordPopover(anchorEl, wordData) {
    const pop = document.getElementById('qp-word-popover');
    pop.innerHTML = '';

    // Item #7: the popover previously showed ONLY the root, discarding
    // pos/inflection/lemma/pattern that morphology_segments already carries.
    const segs = wordData?.segments || [];
    if (!segs.length) {
        pop.appendChild(qpEl('div', 'qp-empty-note', 'لا بيانات صرفية متاحة لهذه الكلمة'));
    } else {
        segs.forEach(s => {
            const segBox = qpEl('div', 'qp-popover-segment');
            if (s.pos) segBox.appendChild(qpEl('div', 'qp-popover-pos', s.pos));
            if (s.inflection) segBox.appendChild(qpEl('div', 'qp-popover-inflection', s.inflection));
            if (s.lemma) segBox.appendChild(qpEl('div', 'qp-popover-lemma', `اللفظ: ${s.lemma}`));
            if (s.pattern) segBox.appendChild(qpEl('div', 'qp-popover-pattern', `الوزن: ${s.pattern}`));
            if (s.root) {
                const rootLine = qpEl('div', 'qp-popover-root', `الجذر: ${s.root}`);
                rootLine.onclick = () => qpPushRootDetail(s.root);
                segBox.appendChild(rootLine);
            }
            pop.appendChild(segBox);
        });
    }

    const rect = anchorEl.getBoundingClientRect();
    pop.style.top = (window.scrollY + rect.bottom + 4) + 'px';
    pop.style.left = Math.max(8, rect.left - 40) + 'px';
    pop.classList.add('show');
}

// ---------- results pane <-> detail pane (mirrors hkShowResultsLayer / hkShowDetailLayer) ----------

function qpShowResultsLayer() {
    document.getElementById('qp-detail-pane').classList.add('hidden');
    document.getElementById('qp-results-pane').classList.remove('hidden');
    document.getElementById('qp-modal-title').textContent = 'القرآن الكريم';
    if (qpState.mode === 'reader') {
        document.getElementById('qp-reader-scroll').scrollTop = qpState.readerScrollTop || 0;
    }
}

function qpShowDetailLayer() {
    document.getElementById('qp-results-pane').classList.add('hidden');
    document.getElementById('qp-detail-pane').classList.remove('hidden');
    const top = qpDetailStack[qpDetailStack.length - 1];
    if (top) qpRenderDetailEntry(top);
}

function qpPopDetail() {
    qpDetailStack.pop();
    if (!qpDetailStack.length) {
        qpShowResultsLayer();
    } else {
        qpRenderDetailEntry(qpDetailStack[qpDetailStack.length - 1]);
    }
}

// Pushes an ayah detail view (tafsir/qiraat/asbab/e3rab/nasekh tabs) onto
// the stack. `pendingHighlight`, if given, is the search term to highlight
// + scroll to once the relevant tab/book content has loaded (item #8).
function qpPushAyahDetail(surah, ayah, opts) {
    opts = opts || {};
    if (qpState.mode === 'reader') qpState.readerScrollTop = document.getElementById('qp-reader-scroll').scrollTop;
    qpDetailStack.push({
        type: 'ayah', surah, ayah,
        activeTab: opts.preferTab || null,
        activeBook: opts.preferBookId || null,
        pendingHighlight: opts.pendingHighlight || null,
    });
    qpShowDetailLayer();
}

function qpPushRootDetail(root) {
    qpDetailStack.push({ type: 'root', root });
    qpState.searchState.root.query = root;
    qpState.searchState.root.results = [];
    qpState.searchState.root.offset = 0;
    qpShowDetailLayer();
    qpLoadMoreSearchResults('root');
}

async function qpRenderDetailEntry(entry) {
    if (entry.type === 'ayah') {
        await qpRenderAyahDetail(entry);
    } else if (entry.type === 'root') {
        qpRenderRootDetail(entry);
    }
}

// ---------- ayah detail (tafsir / qira'at / asbab / e3rab / nasekh) ----------

const QP_SERVICE_LABELS = { tafsir: 'التفسير', asbab: 'أسباب النزول', e3rab: 'الإعراب', nasekh: 'الناسخ والمنسوخ' };

async function qpRenderAyahDetail(entry) {
    const { surah, ayah } = entry;
    const surahMeta = qpState.surahs.find(s => s.surah_number === surah);
    const surahLabel = surahMeta ? ` (${surahMeta.name})` : '';
    document.getElementById('qp-modal-title').textContent = `آية ${qpArabicNum(surah)}:${qpArabicNum(ayah)}${surahLabel}`;

    const body = document.getElementById('qp-detail-body');
    body.innerHTML = '<div class="loading-msg">جارٍ التحميل...</div>';

    // Item #1 changed qpState.allAyahs to hold whichever mushaf the READER
    // currently displays (could be Warsh, Qalun, etc.) — but every detail
    // view (tafsir/qira'at/asbab/e3rab/nasekh, root lookups) is Hafs-based
    // data, so it must always show Hafs's OWN ayah text regardless of what
    // the reader is showing. Only reuse qpState.allAyahs when the reader
    // both matches this surah AND is currently on the default (Hafs)
    // mushaf; otherwise fetch Hafs text directly and cache it on the entry.
    const readerHasHafsText = qpState.currentSurah === surah && qpState.currentMushafId === QP_DEFAULT_MUSHAF_ID;
    const ayahsSameSurah = readerHasHafsText ? qpState.allAyahs : null;

    const [ayahRow, books, divergence] = await Promise.all([
        ayahsSameSurah
            ? Promise.resolve(ayahsSameSurah.find(a => a.ayah_number === ayah))
            : qpFetch(`/api/qp/ayahs/${QP_DEFAULT_MUSHAF_ID}/${surah}`).then(rows =>
                (rows || []).find(a => a.ayah_number === ayah)),
        qpFetch(`/api/qp/ayah/${surah}/${ayah}/books`),
        qpFetch(`/api/qp/ayah/${surah}/${ayah}/qiraat`),
    ]);

    // stale guard: if the user has since popped/navigated away from this
    // exact entry (e.g. rapid clicking), don't clobber whatever's rendering now
    if (qpDetailStack[qpDetailStack.length - 1] !== entry) return;

    body.innerHTML = '';

    const ayahTextDiv = qpEl('div', 'qp-modal-ayah-text');
    if (ayahRow) {
        ayahTextDiv.appendChild(document.createTextNode(ayahRow.text + ' '));
        ayahTextDiv.appendChild(qpEl('span', 'qp-ayah-number qp-ayah-number-static', qpArabicNum(ayah)));
    }
    body.appendChild(ayahTextDiv);

    // Bug fix (surfaced during the #12 pass, updated for item #1): prev/next
    // ayah navigation and the qira'at-context display both need the FULL
    // Hafs surah — reuse qpState.allAyahs only when the reader is already
    // showing this exact surah in Hafs; otherwise fetch once and cache on
    // the entry so repeated prev/next clicks don't refetch.
    const surahAyahs = readerHasHafsText
        ? qpState.allAyahs
        : (entry._surahAyahsCache || (entry._surahAyahsCache =
            await qpFetch(`/api/qp/ayahs/${QP_DEFAULT_MUSHAF_ID}/${surah}`) || []));

    if (qpDetailStack[qpDetailStack.length - 1] !== entry) return;  // re-check after the possible await above

    const navWrap = qpEl('div', 'qp-modal-nav');
    const idx = surahAyahs.findIndex(a => a.ayah_number === ayah);
    const prevBtn = qpEl('button', 'qp-modal-nav-btn', '← الآية السابقة');
    const nextBtn = qpEl('button', 'qp-modal-nav-btn', 'الآية التالية →');
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx < 0 || idx >= surahAyahs.length - 1;
    prevBtn.onclick = () => qpNavigateAyahDetail(-1, surahAyahs);
    nextBtn.onclick = () => qpNavigateAyahDetail(1, surahAyahs);
    navWrap.appendChild(prevBtn);
    navWrap.appendChild(nextBtn);
    body.appendChild(navWrap);

    const tabs = [];
    if (divergence && divergence.length) tabs.push({ key: 'qiraat', label: 'القراءات' });
    ['tafsir', 'asbab', 'e3rab', 'nasekh'].forEach(t => {
        if (books && books[t] && books[t].length) tabs.push({ key: t, label: QP_SERVICE_LABELS[t] });
    });

    if (!tabs.length) {
        body.appendChild(qpEl('div', 'qp-empty-note', 'لا توجد بيانات إضافية لهذه الآية'));
        return;
    }

    const tabBar = qpEl('div', 'qp-tabs');
    const tabBody = qpEl('div', 'qp-tab-body');
    body.appendChild(tabBar);
    body.appendChild(tabBody);

    let activeKey = entry.activeTab && tabs.some(t => t.key === entry.activeTab) ? entry.activeTab : tabs[0].key;

    tabs.forEach(t => {
        const btn = qpEl('button', 'qp-tab-btn' + (t.key === activeKey ? ' active' : ''), t.label);
        btn.onclick = () => {
            entry.activeTab = t.key;
            entry.activeBook = null;
            tabBar.querySelectorAll('.qp-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            qpRenderTab(t.key, entry, tabBody, books, divergence, surahAyahs);
        };
        tabBar.appendChild(btn);
    });

    entry.activeTab = activeKey;
    qpRenderTab(activeKey, entry, tabBody, books, divergence, surahAyahs);
}

async function qpNavigateAyahDetail(direction, surahAyahs) {
    const entry = qpDetailStack[qpDetailStack.length - 1];
    if (!entry || entry.type !== 'ayah') return;
    const list = surahAyahs || (qpState.currentSurah === entry.surah ? qpState.allAyahs : entry._surahAyahsCache) || [];
    const idx = list.findIndex(a => a.ayah_number === entry.ayah);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= list.length) return;
    entry.ayah = list[newIdx].ayah_number;
    entry.activeBook = null;
    await qpRenderAyahDetail(entry);
}

function qpRenderTab(key, entry, tabBody, books, divergence, surahAyahs) {
    tabBody.innerHTML = '';

    if (key === 'qiraat') {
        qpRenderQiraatTab(entry, tabBody, divergence, surahAyahs);
        return;
    }

    const list = (books && books[key]) || [];
    if (!list.length) { tabBody.appendChild(qpEl('div', 'qp-empty-note', 'لا محتوى متاح')); return; }

    const select = qpEl('select', 'qp-book-dropdown');
    list.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.book_id;
        let label = b.name + (b.author_name ? ' — ' + b.author_name : '');
        if (b.parts && b.parts > 1) label += ` (${qpArabicNum(b.parts)} أجزاء)`;
        opt.textContent = label;
        select.appendChild(opt);
    });
    const contentDiv = qpEl('div', 'qp-book-content', 'جارٍ التحميل...');
    tabBody.appendChild(select);
    tabBody.appendChild(contentDiv);

    // Item #10, corrected diagnosis: content_html per (book, surah, ayah) is
    // NOT truncated — it's the complete, correctly-scoped commentary for
    // that ayah (verified: ayah 1 entries legitimately run long because
    // classical tafsir opens with surah-level commentary there). The real
    // gap was navigation: nothing let you continue to the NEXT ayah's
    // entry for the SAME book without leaving the tafsir view. This button
    // does that in place, keeping the same active book/tab.
    const continueWrap = qpEl('div', 'qp-continue-wrap');
    tabBody.appendChild(continueWrap);

    const wantedBookId = entry.activeBook && list.some(b => b.book_id === entry.activeBook)
        ? entry.activeBook : list[0].book_id;
    select.value = wantedBookId;

    const loadContent = async (bookId) => {
        entry.activeBook = bookId;
        contentDiv.textContent = 'جارٍ التحميل...';
        continueWrap.innerHTML = '';
        const data = await qpFetch(`/api/qp/book_content/${bookId}/${entry.surah}/${entry.ayah}`);
        if (!data) {
            contentDiv.innerHTML = '<div class="qp-empty-note">لا يوجد نص لهذا المصدر عند هذه الآية</div>';
            return;
        }
        contentDiv.innerHTML = qpRenderBookContent(data.content_html);
        qpApplyTashkeelState(contentDiv);

        if (entry.pendingHighlight) {
            qpApplyDestinationHighlight(contentDiv, entry.pendingHighlight);
            entry.pendingHighlight = null;
        }

        const idx = surahAyahs.findIndex(a => a.ayah_number === entry.ayah);
        if (idx >= 0 && idx < surahAyahs.length - 1) {
            const nextAyah = surahAyahs[idx + 1].ayah_number;
            const btn = qpEl('button', 'qp-continue-btn', `متابعة إلى تفسير الآية ${qpArabicNum(nextAyah)} →`);
            btn.onclick = async () => {
                entry.ayah = nextAyah;
                // full re-render (updates the ayah-text banner and nav
                // buttons too, not just this tab's content) but keeps
                // activeTab/activeBook, so it lands back on the same book.
                await qpRenderAyahDetail(entry);
            };
            continueWrap.appendChild(btn);
        }
    };
    select.addEventListener('change', e => loadContent(+e.target.value));
    loadContent(wantedBookId);
}

// Item #11: real footnote markup exists in the data as `<div class="foot-notes">`
// blocks scattered inline within content_html (verified: 8 such blocks in a
// single 31K-char entry, roughly evenly spaced — this mirrors classical
// print pagination, where each printed page gets its own footnote list).
// Crucially, numbering RESETS per block — "(١)" in the third block refers
// to a different note than "(١)" in the first — so linking must be scoped
// to the body segment immediately preceding each block, not global.
function qpRenderBookContent(html) {
    if (!html) return html;
    html = qpSanitizeSourceHtml(html);  // item #12: strip inline font-size overrides + Word export cruft before any structural parsing below

    // Split into alternating [bodySegment, footnotesDiv, bodySegment, ...].
    // parts[0] is always a body segment (possibly empty); every even index
    // after that is body, every odd index is a full "<div ...>...</div>".
    const parts = html.split(/(<div class="foot-notes">[\s\S]*?<\/div>)/);

    let bodyOut = '';
    const allFootnoteItemsHtml = [];
    let fnCounter = 0;

    for (let i = 0; i < parts.length; i++) {
        const isFootnoteDiv = i % 2 === 1;
        if (!isFootnoteDiv) {
            bodyOut += parts[i];  // provisionally; may get marker links retrofitted below
            continue;
        }

        const inner = parts[i].replace(/^<div class="foot-notes">/, '').replace(/<\/div>$/, '');
        const entries = [];

        // Scheme A (seen in most tafsir entries): bare "(N) note text" lines
        // separated by <br>, with the (N) markers appearing as plain text
        // in the body — these get fully re-parsed, renumbered, and linked
        // by us (see below).
        //
        // Scheme B (seen in at least one book, id=134): the source ALREADY
        // provides real, correctly-matched <a href="#foonote-X"> / <span
        // id="foonote-X"> pairs — no renumbering needed or wanted. The
        // previous version of this function silently dropped these because
        // they don't match scheme A's bare-(N) regex, which broke every
        // link of this kind (href survived in the body since it's outside
        // this div, but its target span was discarded here). Preserve
        // these verbatim instead of trying to re-parse them.
        const schemeBSpans = [...inner.matchAll(/<span class='foot-note' id='([^']+)'>([\s\S]*?)<\/span>/g)];
        if (schemeBSpans.length) {
            schemeBSpans.forEach(m => {
                allFootnoteItemsHtml.push(
                    `<div class="qp-footnote-item" id="${m[1]}">${m[2]}</div>`
                );
            });
            continue;  // scheme B needs no marker-linking pass — hrefs in the body already point at m[1] correctly
        }

        inner.split(/<br\s*\/?>/i).forEach(line => {
            const m = line.match(/^\s*\r?\(([\u0660-\u0669\d]+)\)\s*(.*)$/s);
            if (m && m[2].trim()) {
                fnCounter++;
                entries.push({ marker: m[1], text: m[2].trim(), anchorId: `qp-fn-${fnCounter}` });
            }
        });
        if (!entries.length) continue;

        // Link markers only within the body segment that directly precedes
        // this footnotes block (parts[i-1]) — that segment is the last
        // thing appended to bodyOut, so replace just that tail. Markers
        // inside a <span class="book-ayah ...">...</span> block are the
        // Qur'anic verse's OWN ayah numbering (identical "(N)" format,
        // e.g. "﴿...الرَّحِيمِ (١) الْحَمْدُ...(٢)﴾") — those must be
        // left untouched, or they get misidentified as footnote refs.
        const localMap = {};
        entries.forEach(f => { localMap[f.marker] = f; });
        const precedingSegment = parts[i - 1] || '';
        const ayahSpanRanges = [];
        const spanRe = /<span class="book-ayah[^"]*">[\s\S]*?<\/span>/g;
        let spanMatch;
        while ((spanMatch = spanRe.exec(precedingSegment))) {
            ayahSpanRanges.push([spanMatch.index, spanMatch.index + spanMatch[0].length]);
        }
        const isInsideAyahSpan = (pos) => ayahSpanRanges.some(([s, e]) => pos >= s && pos < e);

        let linkedSegment = '';
        let lastEnd = 0;
        const markerRe = /\(([\u0660-\u0669\d]+)\)/g;
        let markerMatch;
        while ((markerMatch = markerRe.exec(precedingSegment))) {
            const f = localMap[markerMatch[1]];
            linkedSegment += precedingSegment.slice(lastEnd, markerMatch.index);
            if (f && !isInsideAyahSpan(markerMatch.index)) {
                linkedSegment += `<sup class="qp-footnote-ref"><a href="#${f.anchorId}">(${markerMatch[1]})</a></sup>`;
            } else {
                linkedSegment += markerMatch[0];
            }
            lastEnd = markerRe.lastIndex;
        }
        linkedSegment += precedingSegment.slice(lastEnd);
        bodyOut = bodyOut.slice(0, bodyOut.length - precedingSegment.length) + linkedSegment;

        entries.forEach(f => {
            allFootnoteItemsHtml.push(
                `<div class="qp-footnote-item" id="${f.anchorId}"><span class="qp-footnote-marker">(${f.marker})</span> ${f.text}</div>`
            );
        });
    }

    if (!allFootnoteItemsHtml.length) return bodyOut;
    return bodyOut + `<div class="qp-footnotes-section"><div class="qp-footnotes-title">الحواشي</div>${allFootnoteItemsHtml.join('')}</div>`;
}

function qpRenderQiraatTab(entry, tabBody, divergence, surahAyahs) {
    if (!divergence || !divergence.length) {
        tabBody.appendChild(qpEl('div', 'qp-empty-note', 'لا اختلافات قراءات لهذه الآية'));
        return;
    }
    // Item #9: previously just a flat stack of variant lines with no visual
    // anchor back to the ayah word they belong to. Now shows the ayah text
    // once at the top with the divergent word highlighted per-group, so
    // switching between groups below makes clear which word each addresses.
    const ayahRow = (surahAyahs || []).find(a => a.ayah_number === entry.ayah);
    divergence.forEach((d, i) => {
        const row = qpEl('div', 'qp-divergence-row');
        const context = qpEl('div', 'qp-divergence-context');
        if (ayahRow) {
            const regex = qpBuildHighlightRegex(d.ayah_word);
            const span = qpEl('span', null, ayahRow.text);
            context.appendChild(span);
            if (regex) qpHighlightTextNode(context, regex);
        }
        row.appendChild(context);
        row.appendChild(qpEl('div', 'qp-divergence-word', `الموضع: ${d.ayah_word}`));
        d.variants.forEach(v => {
            const line = qpEl('div', 'qp-divergence-variant');
            let rawiLabel = `${v.rawi_name} (${v.qiraa_name}`;
            rawiLabel += v.qiraa_region ? ` — ${v.qiraa_region})` : ')';
            const rawi = qpEl('span', 'qp-divergence-rawi', rawiLabel);
            line.appendChild(rawi);
            line.appendChild(document.createTextNode(' — ' + v.qiraa_text));
            row.appendChild(line);
        });
        tabBody.appendChild(row);
    });
}

// ---------- root detail ----------

function qpRenderRootDetail(entry) {
    document.getElementById('qp-modal-title').textContent = `الجذر: ${entry.root}`;
    const body = document.getElementById('qp-detail-body');
    body.innerHTML = '';
    const list = qpEl('div', 'qp-root-results-inline');
    body.appendChild(list);
    qpRenderRootHits(list);
}

function qpRenderRootHits(container) {
    const s = qpState.searchState.root;
    container.innerHTML = '';
    if (!s.results.length) { container.appendChild(qpEl('div', 'qp-empty-note', 'لا نتائج')); }
    s.results.forEach(h => {
        const row = qpEl('div', 'qp-root-hit', `${qpArabicNum(h.surah_number)}:${qpArabicNum(h.ayah_number)} — ${h.word_text}`);
        row.onclick = () => qpPushAyahDetail(h.surah_number, h.ayah_number);
        container.appendChild(row);
    });
    if (s.hasMore) {
        const btn = qpEl('button', 'hk-load-more-btn', 'تحميل المزيد ↓');
        btn.onclick = () => qpLoadMoreSearchResults('root').then(() => qpRenderRootHits(container));
        container.appendChild(btn);
    }
}

// ---------- search (ayahs / books / root) — shared by results-pane mode AND root detail view ----------

async function qpRunSearch(mode, query) {
    const s = qpState.searchState[mode];
    s.query = query;
    s.results = [];
    s.offset = 0;
    s.hasMore = false;
    if (!query) { qpRenderSearchResults(mode); return; }
    await qpLoadMoreSearchResults(mode);
}

async function qpLoadMoreSearchResults(mode) {
    const s = qpState.searchState[mode];
    let url;
    if (mode === 'root') {
        url = `/api/qp/root/${encodeURIComponent(s.query)}?offset=${s.offset}&limit=${SEARCH_PAGE_SIZE}`;
    } else if (mode === 'ayahs') {
        url = `/api/qp/search/ayahs?q=${encodeURIComponent(s.query)}&offset=${s.offset}&limit=${SEARCH_PAGE_SIZE}`;
    } else {
        url = `/api/qp/search/books?q=${encodeURIComponent(s.query)}&offset=${s.offset}&limit=${SEARCH_PAGE_SIZE}`;
    }
    const data = await qpFetch(url);
    const results = (data && data.results) || [];
    s.results.push(...results);
    s.offset += results.length;
    s.hasMore = data ? !!data.has_more : false;
    s.summary = s.results.length ? `${s.results.length} نتيجة${s.hasMore ? '+' : ''}` : 'لا توجد نتائج مطابقة';

    if (qpState.mode === mode) qpRenderSearchResults(mode);
}

function qpRenderSearchResults(mode) {
    const s = qpState.searchState[mode];
    const summary = document.getElementById('qp-results-summary');
    const list = document.getElementById('qp-results-list');
    summary.textContent = s.query ? s.summary : 'اكتب للبحث';
    list.innerHTML = '';

    s.results.forEach(h => {
        const row = qpEl('div', 'search-result-item hk-result-card');
        if (mode === 'root') {
            row.textContent = `${qpArabicNum(h.surah_number)}:${qpArabicNum(h.ayah_number)} — ${h.word_text}`;
            row.onclick = () => qpPushAyahDetail(h.surah_number, h.ayah_number);
        } else if (mode === 'ayahs') {
            const surahNum = Number(h.surah_number), ayahNum = Number(h.ayah_number);
            row.appendChild(qpEl('div', 'result-title', `${h.surah_name} ${qpArabicNum(surahNum)}:${qpArabicNum(ayahNum)}`));
            const snippet = qpEl('div', 'result-meta hk-preview', h.text || '');
            const regex = qpBuildHighlightRegex(s.query);
            if (regex) qpHighlightTextNode(snippet, regex);
            row.appendChild(snippet);
            row.onclick = () => qpPushAyahDetail(surahNum, ayahNum, { pendingHighlight: s.query });
        } else {
            const surahNum = Number(h.surah_number), ayahNum = Number(h.ayah_number);
            row.appendChild(qpEl('div', 'result-title', `${h.book_name} — ${qpArabicNum(surahNum)}:${qpArabicNum(ayahNum)}`));
            const snippet = qpEl('div', 'result-meta hk-preview', h.snippet || '');
            qpApplyTashkeelState(snippet);  // tafsir prose snippet — respects the toggle, unlike ayah/root text above
            const regex = qpBuildHighlightRegex(s.query);
            if (regex) qpHighlightTextNode(snippet, regex);
            row.appendChild(snippet);
            row.onclick = () => qpPushAyahDetail(surahNum, ayahNum, {
                preferTab: 'tafsir', preferBookId: h.book_id, pendingHighlight: s.query,
            });
        }
        list.appendChild(row);
    });

    if (s.hasMore) {
        const btn = qpEl('button', 'hk-load-more-btn', 'تحميل المزيد ↓');
        btn.onclick = () => qpLoadMoreSearchResults(mode);
        list.appendChild(btn);
    }
}

document.addEventListener('DOMContentLoaded', qpInit);
