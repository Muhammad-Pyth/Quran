// ── State ──
var currentBookId = null;
var books = [];
var currentBookStructure = [];
var tashkeelVisible = true;
var currentSlidesData = [];   // [{number, html}] for the open book, cached for instant tashkeel toggling
var renderToken = 0;          // bumped whenever we (re)start rendering, so stale async work can bail out
var CHUNK_SIZE = 40;          // slides rendered per progressive batch (keeps huge books from freezing the tab)
var searchScope = 'all';
// 'nav' (default): search box matches book titles + heading text, library-
//   wide, with the current/all scope options hidden (a quick-jump index).
// 'content': matches page body text only, scoped by current/all — entered
//   by toggling the بحث button, which trades title/heading matching away
//   for scoped full-text search.
var searchMode = 'nav';
var aiScopeBookIds = [];   // selected book IDs for Ask retrieval scoping; empty = whole library

// Arabic diacritics (tashkeel) range — matches the same characters the
// server strips for search normalization, so toggling is predictable.
var TASHKEEL_REGEX = /[\u064B-\u065F\u0670]/g;

// ── DOM Elements ──
var bookTree = document.getElementById('book-tree');
var bookContent = document.getElementById('book-content');
var welcome = document.getElementById('welcome');
var reader = document.getElementById('reader');
var sidebar = document.getElementById('sidebar');
var layoutSplitter = document.getElementById('layout-splitter');
var sidebarSearchInput = document.getElementById('sidebar-search-input');
var sidebarSearchClear = document.getElementById('sidebar-search-clear');
var sidebarSearchResults = document.getElementById('sidebar-search-results');
var sidebarSearchScope = document.querySelector('.sidebar-search-scope');
var lblSearchAllVolumes = document.getElementById('lbl-search-all-volumes');
var chkSearchAllVolumes = document.getElementById('chk-search-all-volumes');
var tocSearchInput = document.getElementById('toc-search-input');
var tocSearchClear = document.getElementById('toc-search-clear');
var btnSearchToggle = document.getElementById('btn-search-toggle');
var aiPanel = document.getElementById('ai-panel');
var aiMessages = document.getElementById('ai-messages');
var aiInput = document.getElementById('ai-input');
var aiAgentSelect = document.getElementById('ai-agent');
var aiAnswerModeSelect = document.getElementById('ai-answer-mode');
var btnAiScope = document.getElementById('btn-ai-scope');
var aiScopeLabel = document.getElementById('ai-scope-label');
var aiScopePanel = document.getElementById('ai-scope-panel');
var aiScopeFilter = document.getElementById('ai-scope-filter');
var aiScopeSelectAll = document.getElementById('ai-scope-select-all');
var aiScopeClear = document.getElementById('ai-scope-clear');
var aiScopeBookList = document.getElementById('ai-scope-book-list');
var fontSelector = document.getElementById('font-selector');

// ── Init ──
document.addEventListener('DOMContentLoaded', function() {
    setupEventListeners();
    setupFontSwitcher();
    setupTashkeelToggle();
    setupSidebarSearch();
    setupHkSearch();
    setupTOCSearch();
    setupSplitter();
    setupSessionRestore();
    loadBooks().then(function() {
        restoreLastSession();
        restoreFocusMode();
    });
    resumeImportTocAllIfRunning();

    // Let the user dismiss a search-term highlight by clicking anywhere on
    // the page, rather than it persisting until the next navigation
    // overwrites it. Safe to attach once here: highlightInSlide() is only
    // ever invoked asynchronously (via setTimeout retries in
    // scrollToAnchorWhenReady/scrollToSlideWhenReady, after the triggering
    // click has already finished), so this listener never races with or
    // immediately undoes a highlight that a click just created.
    document.addEventListener('click', function() {
        clearHighlights();
    });
});

// ── Event Listeners ──
function setupEventListeners() {
    document.getElementById('btn-refresh').addEventListener('click', refreshLibrary);
    document.getElementById('btn-embed').addEventListener('click', runEmbedding);
    document.getElementById('btn-import-toc-all').addEventListener('click', startImportTocAll);
    document.getElementById('btn-import-toc-all-stop').addEventListener('click', stopImportTocAll);
    // بحث toggles between two search modes: by default the search box is a
    // quick title/heading index (no scope options, always library-wide);
    // toggling reveals the current-book/whole-library scope options and
    // switches to scoped full-text page-content search instead.
    document.getElementById('btn-search-toggle').addEventListener('click', toggleContentSearchMode);
    document.getElementById('btn-ai-toggle').addEventListener('click', function() { toggleAI(true); });
    document.getElementById('close-ai').addEventListener('click', function() { toggleAI(false); });
    document.getElementById('btn-send-ai').addEventListener('click', sendAIQuestion);
    document.getElementById('btn-ai-clear-all').addEventListener('click', clearAllAskHistory);
    btnAiScope.addEventListener('click', function(e) {
        e.stopPropagation();
        var willShow = aiScopePanel.classList.contains('hidden');
        aiScopePanel.classList.toggle('hidden', !willShow);
        if (willShow) renderAiScopeBookList();
    });
    aiScopeFilter.addEventListener('input', renderAiScopeBookList);
    aiScopeSelectAll.addEventListener('click', function(e) {
        e.stopPropagation();
        var filtered = getAiScopeFilteredBooks();
        filtered.forEach(function(b) {
            if (aiScopeBookIds.indexOf(b.id) === -1) aiScopeBookIds.push(b.id);
        });
        renderAiScopeBookList();
        updateAiScopeLabel();
    });
    aiScopeClear.addEventListener('click', function(e) {
        e.stopPropagation();
        aiScopeBookIds = [];
        renderAiScopeBookList();
        updateAiScopeLabel();
    });
    aiScopePanel.addEventListener('click', function(e) { e.stopPropagation(); });
    document.addEventListener('click', function() {
        aiScopePanel.classList.add('hidden');
    });
    document.getElementById('focus-breadcrumb-back').addEventListener('click', exitFocusMode);
    document.getElementById('btn-shutdown').addEventListener('click', function() {
        document.getElementById('shutdown-confirm-overlay').classList.add('show');
    });
    document.getElementById('btn-logs-toggle').addEventListener('click', toggleLogPanel);
    document.getElementById('close-logs').addEventListener('click', closeLogPanel);

    aiInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendAIQuestion();
        }
    });
}

// ── Font Switcher ──
function setupFontSwitcher() {
    fontSelector.addEventListener('change', function(e) {
        var font = e.target.value;
        document.documentElement.style.setProperty('--font-body', '"' + font + '", serif');
        document.documentElement.style.setProperty('--font-heading', '"' + font + '", serif');
    });
}

// ── Tashkeel Toggle ──
// Re-renders the already-fetched slide HTML through a single cheap regex
// pass instead of walking the DOM tree node-by-node. The reader's reading
// position is preserved by remembering exactly which slide sits at the top
// of the viewport (and how far scrolled into it) *before* toggling, then
// restoring that exact spot once the same slide exists again in the
// rebuilt DOM — not by guessing from a height ratio. A ratio measured
// against `reader.scrollHeight` is only correct once the *entire* book has
// re-rendered, but slides stream in progressively in the background; the
// previous implementation read that ratio almost immediately, while only
// the first ~40 slides existed, so the restored position drifted further
// the deeper the reader had scrolled into the book — exactly the "jumps to
// another location, sometimes considerably" symptom.
function setupTashkeelToggle() {
    var btn = document.getElementById('btn-tashkeel');
    if (!btn) return;

    btn.addEventListener('click', function() {
        tashkeelVisible = !tashkeelVisible;
        btn.classList.toggle('active-toggle', !tashkeelVisible);
        btn.textContent = tashkeelVisible ? '◌ التشكيل' : '◌ بدون تشكيل';

        if (!currentSlidesData.length) return;

        var anchor = getCurrentTopSlideInfo();

        renderToken++;
        var myToken = renderToken;
        // `silent: true` tells renderAllSlides to still synchronously include
        // the anchor slide in the first chunk (so its real post-toggle
        // position is known right away) without also kicking off its own
        // animated scrollIntoView — we restore the exact pixel offset
        // ourselves immediately below instead.
        renderAllSlides(myToken, anchor ? { type: 'slide', value: anchor.slideNumber, silent: true } : null);

        if (anchor) {
            restoreScrollOffset(anchor, myToken);
        }
    });
}

// Finds the slide currently sitting at (or just above) the top of the
// visible reader area, plus how many pixels the reader has already
// scrolled into it.
function getCurrentTopSlideInfo() {
    var slideEls = bookContent.querySelectorAll('.slide-page');
    if (!slideEls.length) return null;
    var readerTop = reader.getBoundingClientRect().top;
    var best = slideEls[0];
    var bestOffset = 0;
    for (var i = 0; i < slideEls.length; i++) {
        var rect = slideEls[i].getBoundingClientRect();
        if (rect.top - readerTop <= 1) {
            best = slideEls[i];
            bestOffset = readerTop - rect.top;
        } else {
            break;
        }
    }
    return { slideNumber: parseInt(best.dataset.slideNumber, 10), offset: Math.max(0, bestOffset) };
}

// Instantly (no animation) restores the reader's scroll position to the
// spot recorded by getCurrentTopSlideInfo(), once that slide exists in the
// freshly-rebuilt DOM.
function restoreScrollOffset(anchor, token, attemptsLeft) {
    attemptsLeft = attemptsLeft === undefined ? 40 : attemptsLeft;
    if (token !== renderToken) return; // superseded by a newer render
    var el = bookContent.querySelector('[data-slide-number="' + anchor.slideNumber + '"]');
    if (el) {
        // .slide-page's offsetParent is #reader itself (the nearest
        // positioned ancestor — #book-content in between is static), so
        // offsetTop is already in the same coordinate space as scrollTop.
        reader.scrollTop = el.offsetTop + (anchor.offset || 0);
        return;
    }
    if (attemptsLeft <= 0) return;
    setTimeout(function() { restoreScrollOffset(anchor, token, attemptsLeft - 1); }, 20);
}

// ── Session Restoration ──
// Remembers which book was open and exactly where the reader had scrolled
// to, so reloading or reopening the app resumes at the same spot instead
// of always landing back on the welcome screen. Reuses the same
// "topmost visible slide + pixel offset into it" anchor the tashkeel
// toggle uses, for the same reason: it's a real, stable position rather
// than a height-ratio that drifts as content streams in.
var SESSION_KEY = 'lastReadingSession';
var FOCUS_KEY = 'lastFocusedBook';

function saveSession() {
    if (!currentBookId || !currentSlidesData.length) return;
    var anchor = getCurrentTopSlideInfo();
    if (!anchor) return;
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
            bookId: currentBookId,
            slideNumber: anchor.slideNumber,
            offset: anchor.offset
        }));
    } catch (e) { /* localStorage unavailable — restoration just won't happen next time */ }
}

function setupSessionRestore() {
    reader.addEventListener('scroll', debounce(saveSession, 400));
}

// Called once, after the library has loaded and the tree is rendered.
function restoreLastSession() {
    var raw;
    try { raw = localStorage.getItem(SESSION_KEY); } catch (e) { return; }
    if (!raw) return;

    var session;
    try { session = JSON.parse(raw); } catch (e) { return; }
    if (!session || !session.bookId) return;

    // The book might have been removed/renamed since the last session.
    var stillExists = books.some(function(b) { return b.id === session.bookId; });
    if (!stillExists) return;

    document.querySelectorAll('.tree-node.active').forEach(function(n) { n.classList.remove('active'); });
    var node = bookTree.querySelector('.tree-node[data-book-id="' + session.bookId + '"]');
    if (node) {
        revealBookGroupIfCollapsed(node);
        node.classList.add('active');
        // No animation here — this runs once on page load, before the
        // user has seen anything, so an instant jump reads as "already
        // there" rather than a scroll happening in front of them (unlike
        // scrollToAnchorWhenReady's smooth scroll, which happens in
        // response to a visible click and should be seen moving).
        node.scrollIntoView({ block: 'center' });
        // Also expand this book's own TOC and highlight/reveal whichever
        // heading corresponds to the saved slide, so the tree shows
        // exactly where you left off, not just which book.
        revealTOCHeadingForSlide(session.bookId, session.slideNumber);
    }

    currentBookId = session.bookId;
    welcome.classList.add('hidden');
    bookContent.classList.remove('hidden');
    bookContent.innerHTML = '<div class="loading-msg">جارٍ استرجاع آخر موضع قراءة...</div>';

    renderToken++;
    var myToken = renderToken;

    fetch('/api/books/' + session.bookId + '/content')
        .then(function(res) { return res.json(); })
        .then(function(slides) {
            if (myToken !== renderToken) return;
            currentSlidesData = slides || [];
            // silent: true — land exactly on the saved pixel offset below,
            // without also triggering a separate animated scrollIntoView.
            renderAllSlides(myToken, { type: 'slide', value: session.slideNumber, silent: true });
            restoreScrollOffset({ slideNumber: session.slideNumber, offset: session.offset || 0 }, myToken);
        })
        .catch(function(err) {
            console.error('Failed to restore last reading session:', err);
        });
}

function stripTashkeel(html) {
    return html.replace(TASHKEEL_REGEX, '');
}

function buildSlideHtml(slide) {
    var html = tashkeelVisible ? slide.html : stripTashkeel(slide.html);
    return '<div class="slide-page" data-slide-number="' + slide.number + '">' + html + '</div>';
}

// ── Library Loading ──
function loadBooks() {
    return fetch('/api/books')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            books = data;
            renderBookTree();
        })
        .catch(function(err) {
            console.error('Failed to load books:', err);
            bookTree.innerHTML = '<div class="empty-msg">تعذر تحميل المكتبة. تأكد من تشغيل الخادم.</div>';
        });
}

function refreshLibrary() {
    var btn = document.getElementById('btn-refresh');
    var btnEmbed = document.getElementById('btn-embed');
    btn.disabled = true;
    btnEmbed.disabled = true;
    btn.classList.add('active-toggle');
    btn.innerHTML = '<span class="spinner"></span> جارٍ التحديث...';

    fetch('/api/refresh', { method: 'POST' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.status === 'error') {
                alert('حدث خطأ أثناء تحديث المكتبة:\n' + data.message);
                return;
            }
            if (data.missing_dir) {
                alert('لم يتم العثور على مجلد "books" بجانب البرنامج. أضف كتبك إليه ثم أعد التحديث.');
                return;
            }
            loadBooks();
            var msg = 'تم تحديث المكتبة (' + data.total + ' ملف).\n' +
                'جديد: ' + data.added + '   معدَّل: ' + data.updated +
                '   بلا تغيير: ' + data.unchanged + '   محذوف: ' + data.removed;
            if (data.errors > 0) msg += '\nتعذرت معالجة ' + data.errors + ' ملف(ات) — راجع نافذة التشغيل لتفاصيل الخطأ.';
            if (data.toc_files_removed > 0) {
                msg += '\nتم حذف ' + data.toc_files_removed + ' ملف(ات) فهرس محلي كانت بلا كتاب مرتبط بها.';
            }
            if (data.added > 0 || data.updated > 0) {
                msg += '\n\nتلميح: إن أردت بناء التمثيلات الدلالية للكتب المضافة أو المعدَّلة، اضغط زر "تمثيلات".';
            }
            alert(msg);
        })
        .catch(function(err) {
            console.error('Refresh error:', err);
            alert('تعذر الاتصال بالخادم. تأكد من تشغيله.');
        })
        .finally(function() {
            btn.disabled = false;
            btnEmbed.disabled = false;
            btn.classList.remove('active-toggle');
            btn.textContent = 'تحديث المكتبة';
        });
}


function runEmbedding() {
    var btn = document.getElementById('btn-embed');
    var btnRefresh = document.getElementById('btn-refresh');
    btn.disabled = true;
    btnRefresh.disabled = true;
    btn.classList.add('active-toggle');
    btn.innerHTML = '<span class="spinner"></span> جارٍ البناء...';

    fetch('/api/embed', { method: 'POST' })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.status === 'error') {
                alert('حدث خطأ أثناء بناء التمثيلات الدلالية:\n' + data.message);
                return;
            }
            if (data.total_missing === 0) {
                alert(data.message || 'جميع الصفحات لديها تمثيلات دلالية بالفعل. لا شيء يحتاج معالجة.');
                return;
            }

            var msg = '';
            if (data.is_rebuild) {
                msg += '⚠️ تنبيه: معظم التمثيلات الدلالية كانت مفقودة — هذه إعادة بناء كاملة، وليست استئنافاً.\n\n';
            }

            if (data.status === 'partial') {
                msg += 'اكتمل جزئياً: تم بناء ' + data.embedded + ' من ' + data.total_missing + ' صفحة.';
                msg += '\nنفدت جميع مفاتيح API المتاحة (' + data.keys_exhausted + ' مفتاح). ';
                msg += 'يُرجَّح أنها بلغت الحدَّ اليومي — أعد التشغيل غداً لاستئناف البناء من حيث توقف.';
                msg += '\nالصفحات المتبقية (' + data.skipped + ') ستُعالَج في الجلسة القادمة.';
            } else {
                msg += 'اكتمل بنجاح: تم بناء ' + data.embedded + ' تمثيلاً دلالياً جديداً.';
                if (data.keys_exhausted > 0) {
                    msg += '\n(تم التبديل بين ' + data.keys_exhausted + ' مفتاح(مفاتيح) API أثناء العملية.)';
                }
            }
            alert(msg);
            loadBooks(); // Refresh to update embedding indicators in tree
        })
        .catch(function(err) {
            console.error('Embed error:', err);
            alert('تعذر الاتصال بالخادم. تأكد من تشغيله.');
        })
        .finally(function() {
            btn.disabled = false;
            btnRefresh.disabled = false;
            btn.classList.remove('active-toggle');
            btn.textContent = '⚡ تمثيلات';
        });
}


var tocAllPollInterval = null;

function startImportTocAll() {
    var btn = document.getElementById('btn-import-toc-all');
    var stopBtn = document.getElementById('btn-import-toc-all-stop');
    var forceCheckbox = document.getElementById('chk-import-toc-all-force');
    var force = !!(forceCheckbox && forceCheckbox.checked);

    fetch('/api/import_toc_all/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: force })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.status === 'error') {
                alert(data.message);
                return;
            }
            document.getElementById('btn-refresh').disabled = true;
            document.getElementById('btn-embed').disabled = true;
            btn.disabled = true;
            btn.classList.add('active-toggle');
            stopBtn.classList.remove('hidden');
            pollImportTocAllStatus();
        })
        .catch(function(err) {
            console.error('Import TOC all start error:', err);
            alert('تعذر الاتصال بالخادم. تأكد من تشغيله.');
        });
}

function pollImportTocAllStatus() {
    var btn = document.getElementById('btn-import-toc-all');
    var stopBtn = document.getElementById('btn-import-toc-all-stop');

    if (tocAllPollInterval) clearInterval(tocAllPollInterval);

    tocAllPollInterval = setInterval(function() {
        fetch('/api/import_toc_all/status')
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.running) {
                    var label = 'جارٍ الاستيراد... (' + data.processed + '/' + data.total_books + ')';
                    if (data.current_book_title) label += ' — ' + data.current_book_title;
                    btn.innerHTML = '<span class="spinner"></span> ' + label;
                    return;
                }

                clearInterval(tocAllPollInterval);
                tocAllPollInterval = null;

                document.getElementById('btn-refresh').disabled = false;
                document.getElementById('btn-embed').disabled = false;
                btn.disabled = false;
                btn.classList.remove('active-toggle');
                btn.textContent = '📑 استيراد الفهارس';
                stopBtn.classList.add('hidden');

                var msg = data.stopped_early ? '⏹ تم إيقاف العملية يدوياً.\n\n' : '';
                msg += 'تم الاستيراد: ' + data.imported.length +
                    '   تم التخطي (يملك فهرساً بالفعل): ' + data.skipped.length +
                    '   فشل: ' + data.failed.length;
                if (data.failed.length > 0) {
                    msg += '\n\nالكتب التي فشلت:\n' + data.failed.map(function(f) {
                        return '- ' + f.title + ': ' + f.message;
                    }).join('\n');
                }
                alert(msg);
                loadBooks(); // Refresh tree so any new headings/TOC indicators show up
            })
            .catch(function(err) {
                console.error('Import TOC all status error:', err);
            });
    }, 1000);
}

function stopImportTocAll() {
    var stopBtn = document.getElementById('btn-import-toc-all-stop');
    stopBtn.disabled = true;
    stopBtn.textContent = 'جارٍ الإيقاف...';
    fetch('/api/import_toc_all/stop', { method: 'POST' })
        .then(function(res) { return res.json(); })
        .catch(function(err) { console.error('Stop error:', err); })
        .finally(function() {
            stopBtn.disabled = false;
            stopBtn.textContent = '⏹ إيقاف';
        });
}

// If the page is reloaded/reopened while a universal TOC import job is
// still running server-side (e.g. the browser tab was closed but the
// server kept going), pick the running state back up instead of the
// button silently looking idle while a job is actually in progress.
function resumeImportTocAllIfRunning() {
    fetch('/api/import_toc_all/status')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.running) return;
            document.getElementById('btn-refresh').disabled = true;
            document.getElementById('btn-embed').disabled = true;
            var btn = document.getElementById('btn-import-toc-all');
            btn.disabled = true;
            btn.classList.add('active-toggle');
            document.getElementById('btn-import-toc-all-stop').classList.remove('hidden');
            pollImportTocAllStatus();
        })
        .catch(function(err) {
            console.error('Import TOC all resume-check error:', err);
        });
}



// ── Tree Rendering ──
// Clusters consecutive books sharing the same folder into "volume
// groups" (one collapsible parent per multi-part book). Each folder is
// dedicated to exactly one book — never shared between unrelated books —
// so any folder holding more than one book file is treated as a group,
// regardless of whether any member has a numeric part_label (e.g. a
// folder with only "الكتاب.html" + "المقدمة.html" groups too). A
// single-file folder stays standalone. /api/books already returns books
// pre-ordered by folder/sort_num/title, so one linear pass is enough —
// no separate sort needed here.
function groupBooksByVolume(bookList) {
    var groups = [];
    var i = 0;
    while (i < bookList.length) {
        var b = bookList[i];
        var run = [b];
        var j = i + 1;
        if (b.folder) {
            while (j < bookList.length && bookList[j].folder === b.folder) {
                run.push(bookList[j]);
                j++;
            }
        }
        // Any folder holding more than one book file is a multi-part set —
        // grouping no longer depends on a numeric part_label existing.
        // part_label (when present) still drives ordering/labeling within
        // the group; it just doesn't gate whether a group forms at all.
        // This covers folders like "الكتاب" + "المقدمة" with no numeric
        // filenames, which previously fell through as two standalone books.
        var isVolumeSet = run.length > 1;
        if (isVolumeSet) {
            groups.push({ isGroup: true, books: run });
        } else {
            run.forEach(function(single) { groups.push({ isGroup: false, books: [single] }); });
        }
        i = j;
    }
    return groups;
}

// If `node` (a .tree-node) sits inside a collapsed volume-group, expands
// that one specific group so the node is actually visible. Shared by
// every place that highlights/reveals a book in the sidebar tree, so a
// book being pointed to is never left hidden inside a collapsed group.
function revealBookGroupIfCollapsed(node) {
    var groupAncestor = node && node.closest('.volume-group');
    if (groupAncestor && groupAncestor._setExpanded) {
        groupAncestor._setExpanded(true);
    }
}

function createVolumeGroupNode(groupBooks) {
    var group = document.createElement('div');
    group.className = 'volume-group';

    var header = document.createElement('div');
    header.className = 'volume-group-header';

    var arrow = document.createElement('span');
    arrow.className = 'volume-group-arrow';
    arrow.textContent = '+';
    arrow.title = 'إظهار/إخفاء الأجزاء';

    var title = document.createElement('span');
    title.className = 'volume-group-title';
    title.textContent = groupBooks[0].folder || groupBooks[0].title;
    title.title = 'فتح الكتاب';

    header.appendChild(arrow);
    header.appendChild(title);
    group.appendChild(header);

    var childrenWrap = document.createElement('div');
    childrenWrap.className = 'volume-group-children'; // collapsed by default (no 'open' class)
    groupBooks.forEach(function(b) {
        childrenWrap.appendChild(createTreeNode(b, true));
    });
    group.appendChild(childrenWrap);

    var expanded = false;
    function setExpanded(val) {
        expanded = val;
        childrenWrap.classList.toggle('open', expanded);
        arrow.textContent = expanded ? '-' : '+';
        arrow.classList.toggle('expanded', expanded);
    }
    // Exposed so restoreLastSession/enterFocusMode/openBookById/TOC-filter
    // can force this specific group open when they need to reveal a book
    // inside it, without affecting any other group's collapsed state.
    group._setExpanded = setExpanded;

    arrow.addEventListener('click', function(e) {
        e.stopPropagation();
        setExpanded(!expanded);
    });

    // Clicking the group's title only navigates to the beginning of the
    // book (its first volume in the existing sort order) — it does NOT
    // expand the group or that volume's TOC. Expanding the group is the
    // `+` arrow's job; expanding a volume's TOC is that volume's own
    // click job (see createTreeNode).
    title.addEventListener('click', function() {
        var firstBook = groupBooks[0];
        loadBookContent(firstBook.id);
        var firstNode = childrenWrap.querySelector('.tree-node[data-book-id="' + firstBook.id + '"]');
        if (firstNode) {
            document.querySelectorAll('.tree-node.active').forEach(function(n) { n.classList.remove('active'); });
            firstNode.classList.add('active');
        }
    });

    return group;
}

function renderBookTree() {
    bookTree.innerHTML = '';
    if (books.length === 0) {
        bookTree.innerHTML = '<div class="empty-msg">لا توجد كتب في المجلد. أضف ملفات HTML إلى مجلد books ثم اضغط "تحديث المكتبة".</div>';
        return;
    }

    groupBooksByVolume(books).forEach(function(g) {
        bookTree.appendChild(g.isGroup ? createVolumeGroupNode(g.books) : createTreeNode(g.books[0]));
    });
}

// ── Focus mode ──
// Dedicates the whole sidebar pane to a single book: its title and TOC
// only, every other book hidden from view. Triggered explicitly via the
// ↳ icon next to a book (never by the existing click-to-expand
// interaction, which continues to work exactly as before, unchanged).
// While active, the toc-search-box (تصفية) filters within this book's
// TOC only, since every other node is already hidden — no code change
// needed there, filtering an already-narrowed tree is its normal behavior.
var focusBreadcrumb = document.getElementById('focus-breadcrumb');
var focusBreadcrumbBack = document.getElementById('focus-breadcrumb-back');
var focusBreadcrumbTitle = document.getElementById('focus-breadcrumb-title');
var focusedBookId = null;

function enterFocusMode(bookId, bookTitle) {
    focusedBookId = bookId;

    // Top-level children of #book-tree are now either plain .tree-node
    // (ungrouped books) or .volume-group wrappers (multi-volume sets) —
    // hide every top-level item that doesn't contain the focused book.
    document.querySelectorAll('#book-tree > .tree-node, #book-tree > .volume-group').forEach(function(topNode) {
        var isMatch = topNode.classList.contains('tree-node')
            ? String(topNode.dataset.bookId) === String(bookId)
            : !!topNode.querySelector('.tree-node[data-book-id="' + bookId + '"]');
        topNode.classList.toggle('focus-hidden', !isMatch);
    });

    // If the focused book lives inside a volume-group, expand that one
    // group and hide its other volumes too — focus mode means "just this
    // one book", so sibling volumes shouldn't remain visible either.
    var focusedNode = bookTree.querySelector('.tree-node[data-book-id="' + bookId + '"]');
    var groupAncestor = focusedNode && focusedNode.closest('.volume-group');
    if (groupAncestor) {
        if (groupAncestor._setExpanded) groupAncestor._setExpanded(true);
        groupAncestor.querySelectorAll('.tree-node').forEach(function(n) {
            n.classList.toggle('focus-hidden', String(n.dataset.bookId) !== String(bookId));
        });
    }

    focusBreadcrumbTitle.textContent = bookTitle;
    focusBreadcrumb.classList.remove('hidden');

    try { localStorage.setItem(FOCUS_KEY, String(bookId)); } catch (e) { /* ignore */ }

    // Auto-expand this book's TOC and open its content, exactly as a
    // normal click on its toggle would, so focus mode is immediately
    // useful rather than requiring a second click to see anything.
    // If restoreLastSession() already called revealTOCHeadingForSlide()
    // for this same book just before this runs, skip re-clicking here —
    // that earlier call is already loading (or has loaded) the TOC at
    // its exact remembered slide/offset and highlighting the matching
    // heading. `open` alone isn't a reliable signal for this: on a
    // first-ever load it's only added once that earlier call's own fetch
    // resolves, i.e. asynchronously, so checking just `open` here (this
    // runs synchronously, same tick, right after restoreLastSession) can
    // still see it unset and wrongly fire a second, colliding
    // loadBookStructure call that rebuilds the heading list and wipes out
    // the highlight a moment after it appeared. tocRevealPending is set
    // synchronously the instant revealTOCHeadingForSlide is called, so it
    // reliably catches this even before that fetch resolves.
    var node = bookTree.querySelector('.tree-node[data-book-id="' + bookId + '"]');
    if (node) {
        var toggle = node.querySelector('.tree-toggle');
        var children = node.querySelector('.tree-children');
        var alreadyHandled = children && (children.classList.contains('open') || node.dataset.tocRevealPending === '1');
        if (toggle && children && !alreadyHandled) {
            toggle.click();
        }
    }
}

function exitFocusMode() {
    var previouslyFocusedBookId = focusedBookId;
    focusedBookId = null;
    document.querySelectorAll('#book-tree > .tree-node, #book-tree > .volume-group').forEach(function(node) {
        node.classList.remove('focus-hidden');
    });
    document.querySelectorAll('#book-tree .volume-group .tree-node').forEach(function(node) {
        node.classList.remove('focus-hidden');
    });
    focusBreadcrumb.classList.add('hidden');
    focusBreadcrumbTitle.textContent = '';
    try { localStorage.removeItem(FOCUS_KEY); } catch (e) { /* ignore */ }

    // Scroll the tree pane back to wherever focus mode was showing, rather
    // than leaving the person at whatever scroll position the pane
    // happened to be at (typically the top) — same idea as
    // revealBookGroupIfCollapsed/scrollIntoView elsewhere in this file.
    // Prefer the highlighted heading if one is currently set (the person
    // was looking at a specific chapter), falling back to the book node
    // itself when there's no heading highlighted.
    if (previouslyFocusedBookId) {
        var headingEl = currentActiveHeadingId
            ? bookTree.querySelector('.tree-heading[data-heading-id="' + currentActiveHeadingId + '"]')
            : null;
        // Guard against a stale currentActiveHeadingId pointing at a
        // heading that belongs to some other book (e.g. the person
        // clicked around before ever entering focus mode) — only trust
        // it here if it's actually nested under the book being exited.
        var headingBelongsToBook = headingEl && headingEl.closest('.tree-node[data-book-id="' + previouslyFocusedBookId + '"]');
        if (headingBelongsToBook) {
            headingEl.scrollIntoView({ block: 'center' });
        } else {
            var bookNode = bookTree.querySelector('.tree-node[data-book-id="' + previouslyFocusedBookId + '"]');
            if (bookNode) {
                revealBookGroupIfCollapsed(bookNode);
                bookNode.scrollIntoView({ block: 'center' });
            }
        }
    }
}

function restoreFocusMode() {
    var savedId;
    try { savedId = localStorage.getItem(FOCUS_KEY); } catch (e) { return; }
    if (!savedId) return;
    var book = books.find(function(b) { return String(b.id) === String(savedId); });
    if (!book) return; // book may have been removed since — just skip silently
    enterFocusMode(book.id, book.title);
}

function createTreeNode(book, isGroupChild) {
    var node = document.createElement('div');
    node.className = 'tree-node';
    node.dataset.bookId = book.id;

    var toggle = document.createElement('div');
    toggle.className = 'tree-toggle';

    var arrow = document.createElement('span');
    arrow.className = isGroupChild ? 'tree-arrow tree-arrow-child' : 'tree-arrow';
    arrow.textContent = isGroupChild ? '◂' : '-';

    var label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = book.title;

    var dbIndicator = document.createElement('span');
    dbIndicator.className = 'db-indicator';
    if (book.has_db) {
        dbIndicator.textContent = '\ud83d\udcda';
        dbIndicator.title = 'قاعدة بيانات مرتبطة';
    } else {
        dbIndicator.textContent = '\u274c';
        dbIndicator.title = 'لا توجد قاعدة بيانات';
        dbIndicator.style.opacity = '0.5';
    }

    var embedIndicator = document.createElement('span');
    embedIndicator.className = 'embed-indicator';
    if (book.has_embeddings) {
        embedIndicator.textContent = '●';
        embedIndicator.title = 'التمثيلات الدلالية مكتملة (' + book.embedded_slides + '/' + book.total_slides + ' صفحة)';
    } else if (book.embedded_slides > 0) {
        embedIndicator.textContent = '◑';
        embedIndicator.style.opacity = '0.4';
        embedIndicator.title = 'تمثيلات دلالية جزئية (' + book.embedded_slides + '/' + book.total_slides + ' صفحة) — اضغط "تمثيلات" لاستكمالها';
    } else {
        embedIndicator.textContent = '○';
        embedIndicator.style.opacity = '0.4';
        embedIndicator.title = 'لا توجد تمثيلات دلالية — اضغط "تمثيلات" لبنائها';
    }

    var focusIcon = document.createElement('span');
    focusIcon.className = 'focus-trigger';
    focusIcon.textContent = '↳';
    focusIcon.title = 'التركيز على هذا الكتاب فقط';
    focusIcon.addEventListener('click', function(e) {
        e.stopPropagation();
        enterFocusMode(book.id, book.title);
    });

    toggle.appendChild(arrow);
    toggle.appendChild(label);
    toggle.appendChild(dbIndicator);
    toggle.appendChild(embedIndicator);
    toggle.appendChild(focusIcon);
    node.appendChild(toggle);

    var children = document.createElement('div');
    children.className = 'tree-children';
    node.appendChild(children);

    var loaded = false;
    var expanded = false;

    toggle.addEventListener('click', function() {
        if (!loaded) {
            loadBookStructure(book.id, children).then(function() {
                loaded = true;
                expanded = true;
                children.classList.add('open');
                arrow.classList.add('expanded');
            });
        } else {
            expanded = !expanded;
            children.classList.toggle('open', expanded);
            arrow.classList.toggle('expanded', expanded);
        }

        if (!node.classList.contains('active')) {
            document.querySelectorAll('.tree-node.active').forEach(function(n) { n.classList.remove('active'); });
            node.classList.add('active');
            loadBookContent(book.id);
        }
    });

    return node;
}

function loadBookStructure(bookId, container) {
    return fetch('/api/books/' + bookId + '/structure')
        .then(function(res) { return res.json(); })
        .then(function(headings) {
            currentBookStructure = headings;
            renderStructureContainer(bookId, container, headings);
        })
        .catch(function(err) {
            renderStructureContainer(bookId, container, []);
        });
}

function renderStructureContainer(bookId, container, headings) {
    container.innerHTML = '';

    var actionRow = document.createElement('div');
    actionRow.className = 'tree-actions';

    // ── Row 1: Import buttons ──
    var importLine = document.createElement('div');
    importLine.className = 'tree-action-line';

    var importRow = document.createElement('div');
    importRow.className = 'tree-import-toc';
    importRow.dataset.action = 'import-shamela';
    importRow.textContent = '⤓ استيراد الفهرس من الشاملة';
    importRow.title = 'يجلب فهرس الفصول/الأبواب الكامل من shamela.ws ويربطه بصفحات هذا الكتاب';
    importRow.addEventListener('click', function(e) {
        e.stopPropagation();
        runShamelaImport(bookId, container);
    });
    importLine.appendChild(importRow);

    var importLocalRow = document.createElement('div');
    importLocalRow.className = 'tree-import-toc';
    importLocalRow.dataset.action = 'import-local';
    importLocalRow.textContent = '⤓ استيراد الفهرس محليًّا';
    importLocalRow.title = 'يقرأ فهرس الكتاب من ملف HTML محفوظ محلياً في مجلد toc بجانب app.py';
    importLocalRow.addEventListener('click', function(e) {
        e.stopPropagation();
        runLocalImport(bookId, container);
    });
    importLine.appendChild(importLocalRow);
    actionRow.appendChild(importLine);

    // ── Row 2: Upload buttons ──
    var uploadLine = document.createElement('div');
    uploadLine.className = 'tree-action-line';

    var linkDbRow = document.createElement('div');
    linkDbRow.className = 'tree-import-toc';
    linkDbRow.dataset.action = 'link-db';
    linkDbRow.textContent = '📎 ربط قاعدة البيانات';
    linkDbRow.title = 'رفع ملف .db يدوياً لربطه بهذا الكتاب';
    linkDbRow.addEventListener('click', function(e) {
        e.stopPropagation();
        uploadDbFile(bookId, container);
    });
    uploadLine.appendChild(linkDbRow);

    var linkTocRow = document.createElement('div');
    linkTocRow.className = 'tree-import-toc';
    linkTocRow.dataset.action = 'link-toc';
    linkTocRow.textContent = '📎 ربط ملف الفهرس';
    linkTocRow.title = 'رفع ملف HTML للفهرس يدوياً واستيراد الفهرس منه مباشرةً';
    linkTocRow.addEventListener('click', function(e) {
        e.stopPropagation();
        uploadTocFile(bookId, container);
    });
    uploadLine.appendChild(linkTocRow);
    actionRow.appendChild(uploadLine);

    container.appendChild(actionRow);

    if (!headings || headings.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-msg';
        empty.style.padding = '8px';
        empty.style.fontSize = '0.85rem';
        empty.textContent = 'لا يوجد فهرس لهذا الكتاب';
        container.appendChild(empty);
        return;
    }

    headings.forEach(function(h) {
        var div = document.createElement('div');
        div.className = 'tree-heading level-' + h.level;
        div.dataset.headingId = h.id;
        div.textContent = h.text;
        div.addEventListener('click', function(e) {
            e.stopPropagation();
            navigateToHeading(bookId, h);
            setActiveHeading(h.id);
        });
        container.appendChild(div);
    });
}

// Keeps the most recently clicked TOC heading visually distinguished from
// the rest while its page is being read, by toggling a dedicated
// .active-heading class (separate from the .active class used for the
// currently-open book in the tree).
var currentActiveHeadingId = null;

function setActiveHeading(headingId) {
    if (currentActiveHeadingId) {
        var prevHeading = bookTree.querySelector('.tree-heading[data-heading-id="' + currentActiveHeadingId + '"]');
        if (prevHeading) {
            prevHeading.classList.remove('active-heading');
        }
    }
    currentActiveHeadingId = headingId;
    var heading = bookTree.querySelector('.tree-heading[data-heading-id="' + headingId + '"]');
    if (heading) {
        heading.classList.add('active-heading');
    }
}

// ── Session-restore TOC reveal ──
// On a normal page reload (restoreLastSession) or a restored focus mode
// (restoreFocusMode/enterFocusMode), the book itself was already being
// reopened at a remembered slide/scroll position, but the *chapter
// heading* in the right-pane tree that corresponds to that position was
// never expanded to, highlighted, or scrolled into view — landing back
// on a book gave no clue where within its TOC you actually were. This
// closes that gap by reusing the exact same building blocks a manual
// click already uses (loadBookStructure to populate + open the TOC,
// setActiveHeading to highlight), just driven programmatically from a
// remembered slide number instead of a click event, plus a scrollIntoView
// on the heading itself, which no click-driven path needed before since
// the person had just clicked something already on screen.
//
// "Nearest heading" is computed fresh from the book's structure every
// time (rather than saved alongside the session) so it's always accurate
// even if the TOC was imported/changed after the session was saved, and
// so saveSession() itself stays untouched — it already runs on every
// scroll tick, and fetching /structure that often would be wasteful.
function revealTOCHeadingForSlide(bookId, slideNumber) {
    var node = bookTree.querySelector('.tree-node[data-book-id="' + bookId + '"]');
    if (!node) return;
    var arrow = node.querySelector('.tree-arrow');
    var children = node.querySelector('.tree-children');
    if (!children) return;

    // Marked synchronously, the instant this function is called — unlike
    // the 'open' class, which (on a first-ever load) only gets added once
    // loadBookStructure's fetch resolves, i.e. asynchronously. Without a
    // synchronous marker, enterFocusMode (which runs right after this,
    // same tick, from the DOMContentLoaded handler's restoreLastSession()
    // + restoreFocusMode() sequence) would see 'open' as still absent,
    // conclude the TOC wasn't opened yet, and fire its own toggle.click()
    // — triggering a second, colliding loadBookStructure call that
    // rebuilds the whole heading list from scratch and wipes out the
    // highlight this function just set, a fraction of a second after it
    // appeared (the exact flash-then-disappear this comment is guarding
    // against).
    node.dataset.tocRevealPending = '1';

    function highlightAndScroll(headings) {
        if (!headings || !headings.length) return;
        // Headings arrive sorted by slide_number (see /api/books/<id>/structure) —
        // the nearest one at-or-before the saved slide is simply the last
        // entry whose slide_number doesn't exceed it.
        var match = null;
        for (var i = 0; i < headings.length; i++) {
            if (headings[i].slide_number <= slideNumber) {
                match = headings[i];
            } else {
                break;
            }
        }
        if (!match) return;
        setActiveHeading(match.id);
        var headingEl = bookTree.querySelector('.tree-heading[data-heading-id="' + match.id + '"]');
        if (headingEl) {
            headingEl.scrollIntoView({ block: 'center' });
        }
    }

    if (children.classList.contains('open') || children.children.length) {
        // TOC already loaded (open or not) for this node — reuse
        // currentBookStructure if it's for this same book, otherwise
        // fall back to a fresh fetch below. Either way, make sure it
        // ends up visibly open here regardless of whatever collapsed/
        // expanded state it happened to be in before this ran.
        children.classList.add('open');
        if (arrow) arrow.classList.add('expanded');
        if (currentBookStructure && currentBookStructure.length && node.classList.contains('active')) {
            highlightAndScroll(currentBookStructure);
        } else {
            loadBookStructure(bookId, children).then(function() {
                children.classList.add('open');
                if (arrow) arrow.classList.add('expanded');
                highlightAndScroll(currentBookStructure);
            });
        }
        return;
    }

    loadBookStructure(bookId, children).then(function() {
        children.classList.add('open');
        if (arrow) arrow.classList.add('expanded');
        highlightAndScroll(currentBookStructure);
    });
}

// Real <h1-6>/data-type="title" headings carry an anchor inside the page
// itself; headings imported from shamela.ws don't (we only know which
// page they start on), so they fall back to scrolling to that whole page.
function navigateToHeading(bookId, h) {
    var target = h.anchor ? { type: 'anchor', value: h.anchor } : { type: 'slide', value: h.slide_number };
    jumpWithinOrLoad(bookId, target);
}

// If the requested book is already open, just jump to the target within
// it (instant — no network round-trip); otherwise load it fresh.
function jumpWithinOrLoad(bookId, jumpTarget) {
    if (currentBookId === bookId && currentSlidesData.length) {
        if (!jumpTarget) {
            clearHighlights();
            reader.scrollTop = 0;
            setTimeout(saveSession, 150);
        } else if (jumpTarget.type === 'anchor') {
            scrollToAnchorWhenReady(jumpTarget.value, undefined, jumpTarget.words);
        } else if (jumpTarget.type === 'slide') {
            scrollToSlideWhenReady(jumpTarget.value, undefined, jumpTarget.words);
        }
    } else {
        loadBookContent(bookId, jumpTarget);
    }
}

// Activates a book's tree node (highlighting it, even while hidden behind
// the search-results panel) and jumps to it. Shared by search-result
// clicks and anything else that needs to open a book from outside the tree.
function openBookById(bookId, jumpTarget) {
    document.querySelectorAll('.tree-node.active').forEach(function(n) { n.classList.remove('active'); });
    var node = bookTree.querySelector('.tree-node[data-book-id="' + bookId + '"]');
    if (node) {
        node.classList.add('active');
        revealBookGroupIfCollapsed(node);
    }
    jumpWithinOrLoad(bookId, jumpTarget);
}

// ── Manual DB Upload ──
function uploadDbFile(bookId, container) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.db';
    input.onchange = function(e) {
        var file = e.target.files[0];
        if (!file) return;

        var form = new FormData();
        form.append('db_file', file);

        var linkRow = container.querySelector('[data-action="link-db"]');
        if (linkRow) {
            linkRow.textContent = 'جارٍ الرفع...';
            linkRow.classList.add('loading');
        }

        fetch('/api/books/' + bookId + '/link_db', {
            method: 'POST',
            body: form
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.status === 'ok') {
                alert('تم ربط قاعدة البيانات بنجاح');
                loadBooks(); // Refresh to update indicators
            } else {
                alert('خطأ: ' + (data.message || 'فشل في ربط القاعدة'));
            }
        })
        .catch(function(err) {
            alert('تعذر الاتصال بالخادم');
        })
        .finally(function() {
            if (linkRow) {
                linkRow.textContent = '📎 ربط قاعدة البيانات';
                linkRow.classList.remove('loading');
            }
        });
    };
    input.click();
}

function uploadTocFile(bookId, container) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,.htm';
    input.onchange = function(e) {
        var file = e.target.files[0];
        if (!file) return;

        var linkTocRow = container.querySelector('[data-action="link-toc"]');
        if (linkTocRow) {
            linkTocRow.textContent = 'جارٍ الرفع والاستيراد...';
            linkTocRow.classList.add('loading');
        }

        var form = new FormData();
        form.append('toc_file', file);

        fetch('/api/books/' + bookId + '/link_toc', {
            method: 'POST',
            body: form
        })
        .then(function(res) {
            return res.json().then(function(data) { return { ok: res.ok, data: data }; });
        })
        .then(function(result) {
            if (!result.ok || result.data.status === 'error') {
                alert('تعذر استيراد الفهرس:\n' + (result.data.message || 'خطأ غير معروف'));
            } else {
                var d = result.data;
                var msg = 'تم استيراد ' + d.matched + ' من ' + d.total + ' عنصراً من ملف الفهرس المرفوع' +
                    (d.part ? (' (الجزء: ' + d.part + ')') : '') + '.';
                if (d.unmatched > 0) msg += '\n' + d.unmatched + ' عنصراً لم يُطابَق.';
                alert(msg);
                loadBookStructure(bookId, container);
            }
        })
        .catch(function() {
            alert('تعذر الاتصال بالخادم.');
        })
        .finally(function() {
            if (linkTocRow) {
                linkTocRow.textContent = '📎 ربط ملف الفهرس';
                linkTocRow.classList.remove('loading');
            }
        });
    };
    input.click();
}

function runShamelaImport(bookId, container) {
    var input = prompt('أدخل رقم الكتاب على موقع الشاملة (shamela.ws) أو رابط الكتاب كاملاً:\nمثال: 2864 أو https://shamela.ws/book/2864');
    if (!input || !input.trim()) return;

    var importRow = container.querySelector('[data-action="import-shamela"]');
    if (importRow) {
        importRow.textContent = 'جارٍ الاستيراد...';
        importRow.classList.add('loading');
    }

    fetch('/api/books/' + bookId + '/import_toc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shamela_id: input.trim() })
    })
    .then(function(res) {
        return res.json().then(function(data) { return { ok: res.ok, data: data }; });
    })
    .then(function(result) {
        if (!result.ok || result.data.status === 'error') {
            alert('تعذر الاستيراد:\n' + (result.data.message || 'خطأ غير معروف'));
            if (importRow) { importRow.textContent = '⤓ استيراد الفهرس من الشاملة'; importRow.classList.remove('loading'); }
            return;
        }

        var d = result.data;
        var msg = 'تم استيراد ' + d.matched + ' من ' + d.total + ' عنصراً من فهرس الشاملة' +
            (d.part ? (' (الجزء: ' + d.part + ')') : '') + '.';

        if (d.exact !== undefined && d.synthetic !== undefined) {
            msg += '\n(' + d.exact + ' مطابقة مباشرة بترقيم الصفحة، ' + d.synthetic + ' عبر تموضع تقديري داخل الصفحة)';
        }
        if (d.unmatched > 0) {
            msg += '\n' + d.unmatched + ' عنصراً لم يُطابَق - قد يكون ترقيم الصفحات مختلفاً.';
        }

        alert(msg);
        loadBookStructure(bookId, container);
    })
    .catch(function(err) {
        alert('تعذر الاتصال بالخادم أو بموقع الشاملة.');
        if (importRow) { importRow.textContent = '⤓ استيراد الفهرس من الشاملة'; importRow.classList.remove('loading'); }
    });
}

function runLocalImport(bookId, container) {
    var importLocalRow = container.querySelector('[data-action="import-local"]');
    if (importLocalRow) {
        importLocalRow.textContent = 'جارٍ الاستيراد...';
        importLocalRow.classList.add('loading');
    }

    fetch('/api/books/' + bookId + '/import_toc_local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    .then(function(res) {
        return res.json().then(function(data) { return { ok: res.ok, data: data }; });
    })
    .then(function(result) {
        if (!result.ok || result.data.status === 'error') {
            alert('تعذر الاستيراد:\n' + (result.data.message || 'خطأ غير معروف'));
            if (importLocalRow) { importLocalRow.textContent = '⤓ استيراد الفهرس محليًّا'; importLocalRow.classList.remove('loading'); }
            return;
        }

        var d = result.data;
        var msg = 'تم استيراد ' + d.matched + ' من ' + d.total + ' عنصراً من الفهرس المحلي' +
            (d.part ? (' (الجزء: ' + d.part + ')') : '') + '.';

        if (d.exact !== undefined && d.synthetic !== undefined) {
            msg += '\n(' + d.exact + ' مطابقة مباشرة بترقيم الصفحة، ' + d.synthetic + ' عبر تموضع تقديري داخل الصفحة)';
        }
        if (d.unmatched > 0) {
            msg += '\n' + d.unmatched + ' عنصراً لم يُطابَق - قد يكون ترقيم الصفحات مختلفاً.';
        }

        alert(msg);
        loadBookStructure(bookId, container);
    })
    .catch(function(err) {
        alert('تعذر الاتصال بالخادم.');
        if (importLocalRow) { importLocalRow.textContent = '⤓ استيراد الفهرس محليًّا'; importLocalRow.classList.remove('loading'); }
    });
}

// ── Book Content Loading ──
// jumpTarget (optional): { type: 'anchor'|'slide', value, words?, silent? }
function loadBookContent(bookId, jumpTarget) {
    currentBookId = bookId;
    welcome.classList.add('hidden');
    bookContent.classList.remove('hidden');
    bookContent.innerHTML = '<div class="loading-msg">جارٍ تحميل الكتاب...</div>';

    if (currentActiveHeadingId) {
        var prevHeading = bookTree.querySelector('.tree-heading[data-heading-id="' + currentActiveHeadingId + '"]');
        if (prevHeading) {
            prevHeading.classList.remove('active-heading');
        }
        currentActiveHeadingId = null;
    }

    renderToken++;
    var myToken = renderToken;

    fetch('/api/books/' + bookId + '/content')
        .then(function(res) { return res.json(); })
        .then(function(slides) {
            if (myToken !== renderToken) return; // a newer load started meanwhile
            currentSlidesData = slides || [];
            renderAllSlides(myToken, jumpTarget);
            setTimeout(saveSession, 150);
        })
        .catch(function(err) {
            console.error('Error loading book:', err);
            bookContent.innerHTML = '<div class="error-msg">تعذر تحميل الكتاب</div>';
        });
}

// Renders the first batch of slides immediately (instant first paint even
// for very large books), then appends the rest in small batches via
// setTimeout so the browser stays responsive instead of freezing on one
// giant DOM insertion.
function renderAllSlides(token, jumpTarget) {
    var slides = currentSlidesData;
    if (!slides.length) {
        bookContent.innerHTML = '<div class="empty-msg">لا يوجد محتوى في هذا الكتاب</div>';
        return;
    }

    var firstChunkSize = CHUNK_SIZE;
    if (jumpTarget && jumpTarget.type === 'slide') {
        firstChunkSize = Math.max(firstChunkSize, jumpTarget.value + 3);
    }

    var firstChunk = slides.slice(0, firstChunkSize);
    bookContent.innerHTML = firstChunk.map(buildSlideHtml).join('');

    if (jumpTarget && !jumpTarget.silent) {
        if (jumpTarget.type === 'anchor') {
            scrollToAnchorWhenReady(jumpTarget.value, undefined, jumpTarget.words);
        } else if (jumpTarget.type === 'slide') {
            scrollToSlideWhenReady(jumpTarget.value, undefined, jumpTarget.words);
        }
    }

    if (slides.length > firstChunkSize) {
        appendRemainingChunks(slides, firstChunkSize, token);
    }
}

function appendRemainingChunks(slides, startIndex, token) {
    if (token !== renderToken) return; // cancelled — user switched books or toggled tashkeel again
    var end = Math.min(startIndex + CHUNK_SIZE, slides.length);
    var html = slides.slice(startIndex, end).map(buildSlideHtml).join('');
    bookContent.insertAdjacentHTML('beforeend', html);
    if (end < slides.length) {
        setTimeout(function() { appendRemainingChunks(slides, end, token); }, 0);
    }
}

function scrollToAnchorWhenReady(anchorId, attemptsLeft, words) {
    attemptsLeft = attemptsLeft === undefined ? 40 : attemptsLeft;
    var el = document.getElementById(anchorId);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        var slideEl = el.closest ? el.closest('.slide-page') : null;
        if (words && words.length && slideEl) {
            highlightInSlide(slideEl, words);
        } else {
            clearHighlights();
        }
        setTimeout(saveSession, 300);
        return;
    }
    if (attemptsLeft <= 0) return;
    setTimeout(function() { scrollToAnchorWhenReady(anchorId, attemptsLeft - 1, words); }, 50);
}

function scrollToSlideWhenReady(slideNumber, attemptsLeft, words) {
    attemptsLeft = attemptsLeft === undefined ? 40 : attemptsLeft;
    var el = bookContent.querySelector('[data-slide-number="' + slideNumber + '"]');
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (words && words.length) {
            highlightInSlide(el, words);
        } else {
            clearHighlights();
        }
        setTimeout(saveSession, 300);
        return;
    }
    if (attemptsLeft <= 0) return;
    setTimeout(function() { scrollToSlideWhenReady(slideNumber, attemptsLeft - 1, words); }, 50);
}

// ── Search-term highlighting ──
// Mirrors the diacritic/letter-variant-tolerant matching used server-side
// for snippet generation (see build_highlight_regex in app.py), so a word
// highlighted in a result snippet is found and highlighted the same way on
// the actual page after navigating to it.
var ALEF_CLASS = '[اأإآ]';
var YAA_CLASS = '[يى]';
var TASHKEEL_CLASS_SRC = '[\\u064B-\\u065F\\u0670\\u0640]*';

function escapeRegexChar(ch) {
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function charClassForHighlight(ch) {
    if (ch === 'ا') return ALEF_CLASS;
    if (ch === 'ي') return YAA_CLASS;
    return escapeRegexChar(ch);
}

function buildHighlightRegex(words) {
    if (!words || !words.length) return null;
    var patterns = [];
    for (var i = 0; i < words.length; i++) {
        var w = words[i];
        if (!w) continue;
        var chars = [];
        for (var j = 0; j < w.length; j++) chars.push(charClassForHighlight(w[j]));
        if (chars.length) patterns.push(chars.join(TASHKEEL_CLASS_SRC));
    }
    if (!patterns.length) return null;
    try {
        return new RegExp('(?:' + patterns.join('|') + ')', 'g');
    } catch (e) {
        return null;
    }
}

function clearHighlights() {
    var marks = bookContent.querySelectorAll('mark.search-hit');
    marks.forEach(function(m) {
        var parent = m.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
    });
}

function highlightInSlide(slideEl, words) {
    clearHighlights();
    var regex = buildHighlightRegex(words);
    if (!regex) return;

    var walker = document.createTreeWalker(slideEl, NodeFilter.SHOW_TEXT, null, false);
    var textNodes = [];
    var node;
    while ((node = walker.nextNode())) {
        regex.lastIndex = 0;
        if (node.nodeValue && regex.test(node.nodeValue)) textNodes.push(node);
    }

    var firstMark = null;
    textNodes.forEach(function(textNode) {
        var text = textNode.nodeValue;
        regex.lastIndex = 0;
        var lastIndex = 0;
        var frag = document.createDocumentFragment();
        var m, found = false;
        while ((m = regex.exec(text))) {
            found = true;
            if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
            var markEl = document.createElement('mark');
            markEl.className = 'search-hit';
            markEl.textContent = m[0];
            frag.appendChild(markEl);
            if (!firstMark) firstMark = markEl;
            lastIndex = m.index + m[0].length;
            if (m[0].length === 0) regex.lastIndex++;
        }
        if (!found) return;
        if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        textNode.parentNode.replaceChild(frag, textNode);
    });

    if (firstMark) {
        setTimeout(function() {
            firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 60);
    }
}

// ── Draggable sidebar splitter ──
function setupSplitter() {
    if (!layoutSplitter || !sidebar) return;

    try {
        var saved = localStorage.getItem('sidebarWidth');
        if (saved) sidebar.style.width = saved;
    } catch (e) { /* localStorage unavailable — fine, just use the default width */ }

    var dragging = false, startX = 0, startWidth = 0;

    layoutSplitter.addEventListener('pointerdown', function(e) {
        dragging = true;
        startX = e.clientX;
        startWidth = sidebar.getBoundingClientRect().width;
        layoutSplitter.classList.add('dragging');
        document.body.style.userSelect = 'none';
        if (layoutSplitter.setPointerCapture) {
            try { layoutSplitter.setPointerCapture(e.pointerId); } catch (e2) {}
        }
    });

    layoutSplitter.addEventListener('pointermove', function(e) {
        if (!dragging) return;
        // The sidebar is docked at the right edge of the layout; moving the
        // pointer toward the reader (left) should widen it.
        var delta = startX - e.clientX;
        var newWidth = Math.max(260, Math.min(600, startWidth + delta));
        sidebar.style.width = newWidth + 'px';
    });

    function endDrag() {
        if (!dragging) return;
        dragging = false;
        layoutSplitter.classList.remove('dragging');
        document.body.style.userSelect = '';
        try { localStorage.setItem('sidebarWidth', sidebar.style.width); } catch (e) {}
    }
    layoutSplitter.addEventListener('pointerup', endDrag);
    layoutSplitter.addEventListener('pointercancel', endDrag);
}

// ── Sidebar Search ──
// Lives permanently in the sidebar (replacing the old popup): searches book
// titles, imported/inline TOC headings, and page body text, with yellow-
// highlighted snippets. Clicking a result navigates to it but deliberately
// leaves the results panel exactly as it was, so it can be revisited
// afterwards to try other results without re-searching.
function setupSidebarSearch() {
    document.querySelectorAll('.scope-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.scope-btn').forEach(function(b) { b.classList.remove('active'); });
            btn.classList.add('active');
            searchScope = btn.dataset.scope;
            lblSearchAllVolumes.classList.toggle('hidden', searchScope !== 'current');
            var q = sidebarSearchInput.value.trim();
            if (q.length >= 2) performSidebarSearch(q);
        });
    });

    chkSearchAllVolumes.addEventListener('change', function() {
        var q = sidebarSearchInput.value.trim();
        if (q.length >= 2) performSidebarSearch(q);
    });

    sidebarSearchInput.addEventListener('input', debounce(function() {
        var q = sidebarSearchInput.value.trim();
        sidebarSearchClear.classList.toggle('hidden', q.length === 0);
        if (q.length < 2) {
            hideSearchResultsPanel();
            return;
        }
        performSidebarSearch(q);
    }, 350));

    sidebarSearchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            sidebarSearchInput.value = '';
            sidebarSearchClear.classList.add('hidden');
            hideSearchResultsPanel();
        }
    });

    sidebarSearchClear.addEventListener('click', function() {
        sidebarSearchInput.value = '';
        sidebarSearchClear.classList.add('hidden');
        hideSearchResultsPanel();
        sidebarSearchInput.focus();
    });
}

// Toggles between the two search modes (see the `searchMode` state comment
// at the top of this file). One click on بحث reveals the scope options and
// switches to scoped page-content search; another click hides them again
// and reverts to the title/heading quick-jump index.
function toggleContentSearchMode() {
    searchMode = (searchMode === 'nav') ? 'content' : 'nav';

    var contentModeOn = (searchMode === 'content');
    sidebarSearchScope.classList.toggle('hidden', !contentModeOn);
    btnSearchToggle.classList.toggle('active-toggle', contentModeOn);
    sidebarSearchInput.placeholder = contentModeOn
        ? 'بحث في نصوص الصفحات...'
        : 'بحث في عناوين الكتب والفهارس...';

    sidebarSearchInput.focus();

    var q = sidebarSearchInput.value.trim();
    if (q.length >= 2) {
        performSidebarSearch(q);
    } else {
        hideSearchResultsPanel();
    }
}

function showSearchResultsPanel() {
    sidebarSearchResults.classList.remove('hidden');
    bookTree.classList.add('hidden');
}

function hideSearchResultsPanel() {
    sidebarSearchResults.classList.add('hidden');
    bookTree.classList.remove('hidden');
}

function performSidebarSearch(query) {
    sidebarSearchResults.innerHTML = '<div class="loading-msg" style="padding:16px">جارٍ البحث...</div>';
    showSearchResultsPanel();

    var requestBody = { query: query, book_id: currentBookId, scope: searchScope, mode: searchMode };

    // كل الأجزاء: expand the single current book into every book_id that
    // shares its folder — computed client-side from the already-loaded
    // `books` array, no extra endpoint needed.
    if (searchScope === 'current' && chkSearchAllVolumes.checked && currentBookId) {
        var volumeGroup = groupBooksByVolume(books).find(function(g) {
            return g.isGroup && g.books.some(function(b) { return b.id === currentBookId; });
        });
        if (volumeGroup) {
            requestBody.book_ids = volumeGroup.books.map(function(b) { return b.id; });
        }
    }

    fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    })
    .then(function(res) {
        if (!res.ok) throw new Error('Search failed: ' + res.status);
        return res.json();
    })
    .then(function(data) {
        // Bail out if the input has since changed (a newer debounced
        // search will render its own results) to avoid flicker.
        if (sidebarSearchInput.value.trim() !== query) return;
        renderSidebarSearchResults(data, query);
    })
    .catch(function(err) {
        console.error('Search error:', err);
        sidebarSearchResults.innerHTML = '<div class="error-msg" style="padding:12px">خطأ في البحث: ' + escapeHtml(err.message) + '</div>';
    });
}

function renderSidebarSearchResults(data, query) {
    var results = (data && data.results) || [];
    var words = (data && data.match_words) || [];

    var html = '<div class="search-results-summary"><span>' +
        (results.length ? (results.length + ' نتيجة لـ «' + escapeHtml(query) + '»') : ('لا توجد نتائج لـ «' + escapeHtml(query) + '»')) +
        '</span><button class="search-back-btn" id="search-back-to-tree" type="button">← فهرس الكتب</button></div>';

    results.forEach(function(r, idx) {
        if (r.type === 'book') {
            html += '<div class="search-result-item book-result" data-idx="' + idx + '" data-result-type="book" data-book-id="' + r.book_id + '">' +
                '<div class="result-title">📖 ' + escapeHtml(r.book_title) + '</div>' +
                '<div class="result-meta">فتح الكتاب</div></div>';
        } else {
            var metaLine = r.is_heading_match
                ? ('📑 ' + (r.heading ? escapeHtml(r.heading) : 'عنوان'))
                : ('صفحة ' + r.slide_number);
            html += '<div class="search-result-item" data-idx="' + idx + '" data-result-type="slide" data-book-id="' + r.book_id +
                '" data-slide-number="' + r.slide_number + '">' +
                '<div class="result-title">' + escapeHtml(r.book_title) + '</div>' +
                '<div class="result-meta">' + metaLine + '</div>' +
                '<div class="result-snippet">' + r.snippet_html + '</div></div>';
        }
    });

    sidebarSearchResults.innerHTML = html;

    var backBtn = document.getElementById('search-back-to-tree');
    if (backBtn) {
        backBtn.addEventListener('click', function() {
            sidebarSearchInput.value = '';
            sidebarSearchClear.classList.add('hidden');
            hideSearchResultsPanel();
        });
    }

    sidebarSearchResults.querySelectorAll('.search-result-item').forEach(function(item) {
        item.addEventListener('click', function() {
            var bookId = parseInt(item.dataset.bookId, 10);
            if (item.dataset.resultType === 'book') {
                openBookById(bookId, null);
            } else {
                var slideNumber = parseInt(item.dataset.slideNumber, 10);
                openBookById(bookId, { type: 'slide', value: slideNumber, words: words });
            }
            // The results panel is deliberately left exactly as-is here —
            // not cleared or hidden — so the user can come back and open a
            // different result afterwards without searching again.
        });
    });
}

// ── Instant TOC Filter ──
// A lightweight, purely client-side complement to the server-side search
// above: it filters whichever .tree-node/.tree-heading elements are
// *already rendered in the DOM* right now via simple show/hide, with no
// network call at all. Because headings are only rendered once a book is
// expanded, this can only filter within books you've already opened —
// that's the deliberate, simpler scope asked for here (as opposed to the
// server-side search box, which finds matches anywhere in the library
// regardless of what's currently expanded).
function setupTOCSearch() {
    if (!tocSearchInput || !tocSearchClear) return;

    var tocSearchTimeout;

    tocSearchInput.addEventListener('input', function() {
        clearTimeout(tocSearchTimeout);
        tocSearchTimeout = setTimeout(filterTOCBySearch, 300);
        tocSearchClear.classList.toggle('hidden', tocSearchInput.value === '');
    });

    tocSearchClear.addEventListener('click', function() {
        tocSearchInput.value = '';
        filterTOCBySearch();
        tocSearchClear.classList.add('hidden');
        tocSearchInput.focus();
    });

    tocSearchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            tocSearchInput.value = '';
            filterTOCBySearch();
            tocSearchClear.classList.add('hidden');
        }
    });
}

function filterTOCBySearch() {
    var query = tocSearchInput.value.trim().toLowerCase();
    if (!query) {
        var allNodes = bookTree.querySelectorAll('.tree-node, .tree-heading');
        allNodes.forEach(function(node) {
            node.style.display = '';
        });
        bookTree.querySelectorAll('.volume-group').forEach(function(g) {
            g.style.display = '';
        });
        return;
    }

    var hasMatches = false;
    var allNodes = bookTree.querySelectorAll('.tree-node, .tree-heading');
    // Tracks, per volume-group element, whether any of its own book nodes
    // matched — a group's header/title text is never itself checked, only
    // whether it contains at least one matching child.
    var groupHasMatch = new Map();

    allNodes.forEach(function(node) {
        var text = node.textContent.toLowerCase();
        var matches = text.includes(query);

        if (!matches) {
            // Author isn't shown in the tree line itself, so fall back to
            // looking it up via the nearest ancestor book node's bookId
            // (headings don't carry their own bookId, only their parent
            // book node does — same lookup .closest('.tree-node') already
            // does below for expanding parents).
            var bookNode = node.classList.contains('tree-node') ? node : node.closest('.tree-node');
            var bookId = bookNode ? parseInt(bookNode.dataset.bookId, 10) : NaN;
            if (!isNaN(bookId)) {
                var book = books.find(function(b) { return b.id === bookId; });
                if (book && book.author && book.author.toLowerCase().includes(query)) {
                    matches = true;
                }
            }
        }

        if (matches) {
            node.style.display = '';
            var parentNode = node.closest('.tree-node');
            if (parentNode) {
                parentNode.style.display = '';
                var children = parentNode.querySelector('.tree-children');
                if (children) {
                    children.classList.add('open');
                    var toggle = parentNode.querySelector('.tree-arrow');
                    if (toggle) toggle.classList.add('expanded');
                }
                var groupAncestor = parentNode.closest('.volume-group');
                if (groupAncestor) {
                    groupHasMatch.set(groupAncestor, true);
                    revealBookGroupIfCollapsed(parentNode);
                }
            }
            hasMatches = true;
        } else {
            node.style.display = 'none';
        }
    });

    // A group with no matching child anywhere inside it stays hidden
    // entirely, exactly like any other non-matching standalone book —
    // otherwise its header/folder name would linger over an empty list.
    bookTree.querySelectorAll('.volume-group').forEach(function(g) {
        g.style.display = groupHasMatch.get(g) ? '' : 'none';
    });

    if (!hasMatches) {
        allNodes.forEach(function(node) {
            node.style.display = '';
        });
        bookTree.querySelectorAll('.volume-group').forEach(function(g) {
            g.style.display = '';
        });
    }
}

// ── AI Chat ──
function toggleAI(show) {
    var wasHidden = aiPanel.classList.contains('hidden');
    aiPanel.classList.toggle('hidden', !show);
    // Load saved history only on the actual open transition (hidden ->
    // visible) — not on every click of the AI button, and never on page
    // load, per spec.
    if (show && wasHidden) {
        loadAskHistory();
    }
}

// Renders the book checkbox list inside the Ask scope picker, reusing the
// already-loaded `books` array (no extra fetch) and filtering by title
// against whatever's typed in the ai-scope-filter input.
// Shared by renderAiScopeBookList and the "select all" button, so both
// always agree on exactly which books count as "currently filtered".
function getAiScopeFilteredBooks() {
    var filterText = aiScopeFilter.value.trim().toLowerCase();
    return books.filter(function(b) {
        if (!filterText) return true;
        var titleMatch = (b.title || '').toLowerCase().includes(filterText);
        var authorMatch = (b.author || '').toLowerCase().includes(filterText);
        return titleMatch || authorMatch;
    });
}

function renderAiScopeBookList() {
    aiScopeBookList.innerHTML = '';

    var filtered = getAiScopeFilteredBooks();

    if (filtered.length === 0) {
        aiScopeBookList.innerHTML = '<div class="ai-scope-empty">لا توجد نتائج</div>';
        return;
    }

    groupBooksByVolume(filtered).forEach(function(g) {
        if (g.isGroup) {
            renderAiScopeBookGroup(g.books);
        } else {
            renderAiScopeBookRow(g.books[0], false, aiScopeBookList);
        }
    });
}

// One checkbox row — shared by plain (ungrouped) books and each volume
// inside a group (indented when `indented` is true).
function renderAiScopeBookRow(b, indented, container) {
    var row = document.createElement('label');
    row.className = 'ai-scope-book-row' + (indented ? ' ai-scope-book-row-indented' : '');

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = b.id;
    checkbox.checked = aiScopeBookIds.indexOf(b.id) !== -1;
    checkbox.addEventListener('change', function() {
        if (checkbox.checked) {
            if (aiScopeBookIds.indexOf(b.id) === -1) aiScopeBookIds.push(b.id);
        } else {
            aiScopeBookIds = aiScopeBookIds.filter(function(id) { return id !== b.id; });
        }
        if (checkbox._syncGroupState) checkbox._syncGroupState();
        updateAiScopeLabel();
    });

    var span = document.createElement('span');
    span.textContent = b.title;

    row.appendChild(checkbox);
    row.appendChild(span);
    container.appendChild(row);
    return checkbox;
}

// A multi-volume book's group header: one checkbox that selects/
// deselects every volume in the group at once, plus each volume's own
// checkbox underneath (still individually toggleable, unchanged).
function renderAiScopeBookGroup(groupBooks) {
    var wrapper = document.createElement('div');
    wrapper.className = 'ai-scope-group';

    var header = document.createElement('label');
    header.className = 'ai-scope-group-header';

    var groupCheckbox = document.createElement('input');
    groupCheckbox.type = 'checkbox';
    var groupIds = groupBooks.map(function(b) { return b.id; });
    groupCheckbox.checked = groupIds.every(function(id) { return aiScopeBookIds.indexOf(id) !== -1; });

    var groupTitle = document.createElement('span');
    groupTitle.className = 'ai-scope-group-title';
    groupTitle.textContent = groupBooks[0].folder || groupBooks[0].title;

    header.appendChild(groupCheckbox);
    header.appendChild(groupTitle);
    wrapper.appendChild(header);

    var childCheckboxes = groupBooks.map(function(b) {
        return renderAiScopeBookRow(b, true, wrapper);
    });

    function syncGroupState() {
        groupCheckbox.checked = groupIds.every(function(id) { return aiScopeBookIds.indexOf(id) !== -1; });
    }
    childCheckboxes.forEach(function(cb) { cb._syncGroupState = syncGroupState; });

    groupCheckbox.addEventListener('click', function(e) {
        e.stopPropagation();
    });
    groupCheckbox.addEventListener('change', function() {
        groupBooks.forEach(function(b) {
            if (groupCheckbox.checked) {
                if (aiScopeBookIds.indexOf(b.id) === -1) aiScopeBookIds.push(b.id);
            } else {
                aiScopeBookIds = aiScopeBookIds.filter(function(id) { return id !== b.id; });
            }
        });
        childCheckboxes.forEach(function(cb) { cb.checked = groupCheckbox.checked; });
        updateAiScopeLabel();
    });

    aiScopeBookList.appendChild(wrapper);
}

// Keeps the picker button's label reflecting the current selection, so the
// user can see at a glance whether Ask is scoped or library-wide.
function updateAiScopeLabel() {
    if (aiScopeBookIds.length === 0) {
        aiScopeLabel.textContent = '📚 نطاق البحث: كل المكتبة';
    } else if (aiScopeBookIds.length === 1) {
        var b = books.find(function(x) { return x.id === aiScopeBookIds[0]; });
        aiScopeLabel.textContent = '📚 نطاق البحث: ' + (b ? b.title : '1 كتاب');
    } else {
        aiScopeLabel.textContent = '📚 نطاق البحث: ' + aiScopeBookIds.length + ' كتب محددة';
    }
}

function sendAIQuestion() {
    var question = aiInput.value.trim();
    if (!question) return;

    // Instant echo of the question while waiting — placeholder only,
    // replaced below once the real block (with buttons) is ready.
    var placeholder = document.createElement('div');
    placeholder.className = 'ai-message user';
    placeholder.textContent = question;
    aiMessages.appendChild(placeholder);
    aiMessages.scrollTop = aiMessages.scrollHeight;
    aiInput.value = '';

    var btn = document.getElementById('btn-send-ai');
    btn.textContent = 'جارٍ التفكير...';
    btn.disabled = true;

    var topKInput = document.getElementById('ai-top-k');
    var topKValue = topKInput && topKInput.value.trim() !== '' ? topKInput.value.trim() : undefined;

    fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            question: question,
            agent: aiAgentSelect ? aiAgentSelect.value : 'gemini',
            answer_mode: aiAnswerModeSelect ? aiAnswerModeSelect.value : 'strict',
            top_k: topKValue,
            book_ids: aiScopeBookIds.length ? aiScopeBookIds : undefined
        })
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        placeholder.remove();
        // Render straight from what /api/ask already gave us — this still
        // has the just-computed similarity scores baked into data.sources,
        // since it's the exact same text that was fed to the AI. This is
        // a true first-time surfacing: no DB re-fetch happens here. Once
        // the panel is closed and reopened, this in-memory copy is gone
        // and نسخ المقتطفات on this same block will fall back to the
        // DB re-fetch path (no similarity) like any other saved block.
        renderSavedBlock({
            id: data.history_id || null,
            question: question,
            answer: data.answer,
            citations: data.source_refs || []
        }, data.sources || null, true);
        aiMessages.scrollTop = aiMessages.scrollHeight;
    })
    .catch(function(err) {
        placeholder.remove();
        addAIMessage('حدث خطأ في الاتصال بالمساعد الذكي.', 'bot');
    })
    .finally(function() {
        btn.textContent = 'إرسال';
        btn.disabled = false;
    });
}

// ── Ask history (persisted saved blocks) ──

function loadAskHistory() {
    fetch('/api/ask_history')
        .then(function(res) { return res.json(); })
        .then(function(data) {
            aiMessages.innerHTML = '';
            var blocks = (data.blocks || []).slice().reverse(); // oldest first, chat-style
            blocks.forEach(function(block) { renderSavedBlock(block); });
            aiMessages.scrollTop = aiMessages.scrollHeight;
        })
        .catch(function() {
            // Silently leave whatever's on screen; history is a nice-to-
            // have, not required for the panel to keep working.
        });
}

function clearAllAskHistory() {
    if (!confirm('هل تريد حذف كل الأسئلة والأجوبة المحفوظة؟')) return;
    fetch('/api/ask_history', { method: 'DELETE' })
        .then(function() {
            aiMessages.innerHTML = '';
        });
}

function buildCitationsElements(citations) {
    var toggle = document.createElement('div');
    var sourcesBox = document.createElement('div');
    sourcesBox.className = 'ai-sources-box hidden';
    if (!citations || citations.length === 0) {
        return { toggle: null, box: null };
    }
    toggle.className = 'ai-sources-toggle';
    toggle.textContent = '▸ المصادر (' + citations.length + ')';
    citations.forEach(function(cit, idx) {
        var citation = document.createElement('div');
        citation.className = 'source-citation';
        citation.textContent = (idx + 1) + '. ' + (cit.title || '') + ' - ' + (cit.label || '');
        sourcesBox.appendChild(citation);
    });
    var expanded = false;
    toggle.addEventListener('click', function() {
        expanded = !expanded;
        sourcesBox.classList.toggle('hidden', !expanded);
        toggle.textContent = (expanded ? '▾' : '▸') + ' المصادر (' + citations.length + ')';
    });
    return { toggle: toggle, box: sourcesBox };
}

// Builds the نسخ / نسخ المقتطفات / ❌ مسح action row. مسح always deletes
// the whole block from ask_history.db — never partial/text-level — and
// that single action removes `listWrapper` from the main panel AND calls
// `onCleared` (used to also close the modal, if this row is rendered
// inside one) so the effect is identical no matter where مسح was clicked.
function buildActionsRow(block, citations, preloadedSnippets, listWrapper, onCleared) {
    var actions = document.createElement('div');
    actions.className = 'ai-history-actions';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'ai-copy-btn';
    copyBtn.type = 'button';
    copyBtn.title = 'نسخ السؤال والإجابة مع المصادر';
    copyBtn.textContent = '📋 نسخ';
    copyBtn.addEventListener('click', function() {
        var full = 'السؤال: ' + block.question + '\n\n' + block.answer;
        if (citations.length > 0) {
            full += '\n\nالمصادر:\n' + citations.map(function(c, i) {
                return (i + 1) + '. ' + (c.title || '') + ' - ' + (c.label || '');
            }).join('\n');
        }
        flashCopyButton(copyBtn, '📋 نسخ', navigator.clipboard.writeText(full));
    });
    actions.appendChild(copyBtn);

    if (citations.length > 0) {
        var copySnippetsBtn = document.createElement('button');
        copySnippetsBtn.className = 'ai-copy-btn';
        copySnippetsBtn.type = 'button';
        copySnippetsBtn.title = preloadedSnippets
            ? 'نسخ المقتطفات الكاملة لهذا السؤال'
            : 'استرجاع ونسخ المقتطفات الكاملة لهذا السؤال';
        copySnippetsBtn.textContent = '📄 نسخ المقتطفات';
        copySnippetsBtn.addEventListener('click', function() {
            if (preloadedSnippets) {
                var text = preloadedSnippets.join('\n\n---\n\n');
                flashCopyButton(copySnippetsBtn, '📄 نسخ المقتطفات', navigator.clipboard.writeText(text));
                return;
            }
            copySnippetsBtn.textContent = '... جارٍ الاسترجاع';
            copySnippetsBtn.disabled = true;
            fetch('/api/passages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ citations: citations })
            })
            .then(function(res) { return res.json(); })
            .then(function(data) {
                var text = (data.passages || []).join('\n\n---\n\n');
                copySnippetsBtn.disabled = false;
                flashCopyButton(copySnippetsBtn, '📄 نسخ المقتطفات', navigator.clipboard.writeText(text));
            })
            .catch(function() {
                copySnippetsBtn.disabled = false;
                copySnippetsBtn.textContent = '⚠ فشل الاسترجاع';
                setTimeout(function() { copySnippetsBtn.textContent = '📄 نسخ المقتطفات'; }, 1500);
            });
        });
        actions.appendChild(copySnippetsBtn);
    }

    var clearBtn = document.createElement('button');
    clearBtn.className = 'ai-copy-btn ai-clear-block-btn';
    clearBtn.type = 'button';
    clearBtn.title = 'مسح هذا السؤال والإجابة';
    clearBtn.textContent = '❌ مسح';
    if (!block.id) {
        clearBtn.disabled = true;
        clearBtn.title = 'لم يُحفظ هذا السؤال، لا يمكن مسحه';
    } else {
        clearBtn.addEventListener('click', function() {
            fetch('/api/ask_history/' + block.id, { method: 'DELETE' })
                .then(function() {
                    if (listWrapper) listWrapper.remove();
                    if (onCleared) onCleared();
                });
        });
    }
    actions.appendChild(clearBtn);

    return actions;
}

// Modal reading view for one block — same content and same live buttons
// (نسخ / نسخ المقتطفات / ❌ مسح) as the collapsed list item, just with
// room to read comfortably. مسح here deletes the same block from the
// list behind it and closes the modal, exactly as if مسح had been
// clicked in the list itself.
function openBlockModal(block, citations, preloadedSnippets, listWrapper) {
    var overlay = document.createElement('div');
    overlay.className = 'ai-block-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'ai-block-modal';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'ai-block-modal-close';
    closeBtn.type = 'button';
    closeBtn.title = 'إغلاق';
    closeBtn.textContent = '×';

    function close() {
        document.removeEventListener('keydown', onKeydown);
        overlay.remove();
    }
    function onKeydown(e) {
        if (e.key === 'Escape') close();
    }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKeydown);

    var qEl = document.createElement('div');
    qEl.className = 'ai-message user';
    qEl.textContent = block.question;

    var aEl = document.createElement('div');
    aEl.className = 'ai-message bot';
    aEl.innerHTML = escapeHtml(block.answer).replace(/\n/g, '<br>');

    modal.appendChild(closeBtn);
    modal.appendChild(qEl);
    modal.appendChild(aEl);

    var cit = buildCitationsElements(citations);
    if (cit.toggle) {
        modal.appendChild(cit.toggle);
        modal.appendChild(cit.box);
    }

    modal.appendChild(buildActionsRow(block, citations, preloadedSnippets, listWrapper, close));

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

function renderSavedBlock(block, preloadedSnippets, startExpanded) {
    var wrapper = document.createElement('div');
    wrapper.className = 'ai-history-block';

    var citations = block.citations || [];

    // Collapsed by default (question only) — click the question row to
    // expand the answer/citations/actions inline. A freshly-answered
    // question (startExpanded=true) opens already expanded, since it was
    // just asked; anything loaded from ask_history.db on panel reopen
    // starts collapsed.
    var headerRow = document.createElement('div');
    headerRow.className = 'ai-history-question-row';

    var arrow = document.createElement('span');
    arrow.className = 'ai-history-arrow';
    arrow.textContent = startExpanded ? '▾' : '▸';

    var qText = document.createElement('div');
    qText.className = 'ai-history-question';
    qText.textContent = block.question;

    var openBtn = document.createElement('button');
    openBtn.className = 'ai-history-open-btn';
    openBtn.type = 'button';
    openBtn.title = 'فتح في نافذة للقراءة';
    openBtn.textContent = '🔍';
    openBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        openBlockModal(block, citations, preloadedSnippets, wrapper);
    });

    headerRow.appendChild(arrow);
    headerRow.appendChild(qText);
    headerRow.appendChild(openBtn);
    wrapper.appendChild(headerRow);

    var body = document.createElement('div');
    body.className = 'ai-history-body' + (startExpanded ? '' : ' hidden');

    var aMsg = document.createElement('div');
    aMsg.className = 'ai-message bot';
    aMsg.innerHTML = escapeHtml(block.answer).replace(/\n/g, '<br>');
    body.appendChild(aMsg);

    var cit = buildCitationsElements(citations);
    if (cit.toggle) {
        body.appendChild(cit.toggle);
        body.appendChild(cit.box);
    }

    body.appendChild(buildActionsRow(block, citations, preloadedSnippets, wrapper, null));
    wrapper.appendChild(body);

    var expanded = !!startExpanded;
    headerRow.addEventListener('click', function() {
        expanded = !expanded;
        body.classList.toggle('hidden', !expanded);
        arrow.textContent = expanded ? '▾' : '▸';
    });

    aiMessages.appendChild(wrapper);
}

// Shared little "✓ تم النسخ" / "⚠ فشل النسخ" flash helper for copy buttons.
function flashCopyButton(btn, originalLabel, clipboardPromise) {
    clipboardPromise.then(function() {
        btn.textContent = '✓ تم النسخ';
        setTimeout(function() { btn.textContent = originalLabel; }, 1500);
    }).catch(function() {
        btn.textContent = '⚠ فشل النسخ';
        setTimeout(function() { btn.textContent = originalLabel; }, 1500);
    });
}

function addAIMessage(text, type) {
    var msg = document.createElement('div');
    msg.className = 'ai-message ' + type;
    msg.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');

    if (type === 'bot') {
        var copyBtn = document.createElement('button');
        copyBtn.className = 'ai-copy-btn';
        copyBtn.type = 'button';
        copyBtn.title = 'نسخ';
        copyBtn.textContent = '📋 نسخ';
        copyBtn.addEventListener('click', function() {
            flashCopyButton(copyBtn, '📋 نسخ', navigator.clipboard.writeText(text));
        });
        msg.appendChild(copyBtn);
    }

    aiMessages.appendChild(msg);
    aiMessages.scrollTop = aiMessages.scrollHeight;
}

// ── Utilities ──
function debounce(fn, delay) {
    var timer;
    return function() {
        var args = arguments;
        clearTimeout(timer);
        timer = setTimeout(function() { fn.apply(null, args); }, delay);
    };
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── Console log panel ──
// Polls /api/logs while the panel is open and appends new lines to the
// panel, mirroring app.py's stdout/stderr (startup messages, [INFO]/
// [WARN] lines, tracebacks, Flask's own request logs). Polling only runs
// while the panel is actually visible — no point hitting the server
// every second or two for a panel nobody's looking at — but the
// sequence cursor (logsSeq) persists across opens/closes, so reopening
// the panel later only fetches what's new since it was last open, not
// the whole buffer again. The very first open of a session passes
// since=0, which the server treats as "give me everything currently
// buffered" — so even messages printed before the panel was ever opened
// (e.g. the initial "Starting server..." line) still show up once.
var logPanelOpen = false;
var logsSeq = 0;
var logsPollTimer = null;
var LOG_POLL_INTERVAL_MS = 1500;
var LOG_MAX_DOM_LINES = 500; // trim old lines so a long session doesn't bloat the DOM

function toggleLogPanel() {
    logPanelOpen = !logPanelOpen;
    document.getElementById('log-panel').classList.toggle('show', logPanelOpen);
    if (logPanelOpen) {
        pollLogs();
        logsPollTimer = setInterval(pollLogs, LOG_POLL_INTERVAL_MS);
    } else {
        stopLogPolling();
    }
}

function closeLogPanel() {
    logPanelOpen = false;
    document.getElementById('log-panel').classList.remove('show');
    stopLogPolling();
}

function stopLogPolling() {
    if (logsPollTimer) {
        clearInterval(logsPollTimer);
        logsPollTimer = null;
    }
}

function pollLogs() {
    fetch('/api/logs?since=' + logsSeq)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.lines || !data.lines.length) return;
            var content = document.getElementById('log-content');
            var atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 10;
            data.lines.forEach(function(line) {
                var div = document.createElement('div');
                div.className = 'log-line';
                div.textContent = line.text;
                content.appendChild(div);
                logsSeq = line.seq;
            });
            while (content.children.length > LOG_MAX_DOM_LINES) {
                content.removeChild(content.firstChild);
            }
            if (atBottom) content.scrollTop = content.scrollHeight;
        })
        .catch(function() {
            // Server unreachable (e.g. mid-shutdown) — the shutdown flow
            // already surfaces that; nothing extra to do here.
        });
}

// ── Shutdown flow ──
// Ported from the Hub proxy's landing.html confirm/shutdown pattern,
// adapted for a single standalone Flask process rather than the Hub's
// several tracked backend processes: same confirm-overlay UX, same
// "network error on the shutdown response is expected and fine" handling
// (the process exits mid-response, so the fetch's own response is never
// actually received), same swap to a full-page dead message afterward.
(function setupShutdown() {
    var overlay = document.getElementById('shutdown-confirm-overlay');
    var deadMsg = document.getElementById('shutdown-dead-msg');

    document.getElementById('shutdown-confirm-no').addEventListener('click', function() {
        overlay.classList.remove('show');
    });

    document.getElementById('shutdown-confirm-yes').addEventListener('click', function() {
        overlay.classList.remove('show');
        fetch('/api/shutdown', { method: 'POST' })
            .catch(function() {
                // The server exits mid-response — a network error here is
                // expected and does not indicate anything went wrong.
            })
            .finally(function() {
                document.getElementById('top-bar').style.display = 'none';
                document.getElementById('sidebar').style.display = 'none';
                document.getElementById('reader').style.display = 'none';
                var aiPanel = document.getElementById('ai-panel');
                if (aiPanel) aiPanel.style.display = 'none';
                deadMsg.classList.add('show');
            });
    });
})();


// ═══════════════════════════════════════════════════════════════
//  Hadith Knowledge Graph search (الحديث)
//
//  Replaces the old narrators-only overlay. Two independent layers live
//  inside one overlay:
//    - hkSearchState: one persistent entry per search mode (hadith / group
//      / rawi / topic / aqwal), holding that mode's last query + results +
//      scroll position. Never destroyed by drilling into detail views —
//      switching back to "نتائج البحث" restores it exactly as left.
//    - hkDetailStack: an unlimited-depth stack of detail views pushed to
//      as internal links are clicked (narrator -> critic -> narrator -> ...).
//      A back button pops one level; the results button (present in both
//      layers) always jumps straight back to the results layer in one
//      click, regardless of stack depth.
//  Both layers persist across modal close/reopen (only reset on an
//  explicit new top-level search), so reopening the modal restores the
//  last view rather than starting over.
// ═══════════════════════════════════════════════════════════════

var HK_MODES = ['hadith', 'group', 'rawi', 'topic', 'aqwal', 'alem', 'book'];
var hkMode = 'hadith';
var hkActiveLayer = 'results';   // 'results' | 'detail'
var hkSearchState = {};          // mode -> { query, hits, offset, hasMore, summary, scrollTop }
HK_MODES.forEach(function(m) { hkSearchState[m] = { query: '', hits: null, offset: 0, hasMore: false, summary: 'اكتب للبحث', scrollTop: 0 }; });
// Detail stack is now per-mode: switching modes shows that mode's OWN
// drill-down history, isolated from the others — "السابق" only ever
// unwinds clicks made while in the current mode, never crosses into a
// different mode's trail. The persistent-results behavior is unchanged:
// each mode's last search/scroll position is still preserved regardless.
var hkDetailStacks = {};         // mode -> [{ type, id, data }]
HK_MODES.forEach(function(m) { hkDetailStacks[m] = []; });
var hkModeLayer = {};            // mode -> 'results' | 'detail' (which layer that mode was left on)
HK_MODES.forEach(function(m) { hkModeLayer[m] = 'results'; });

var hkOverlay = document.getElementById('hk-overlay');
var hkModalTitle = document.getElementById('hk-modal-title');
var hkResultsPane = document.getElementById('hk-results-pane');
var hkDetailPane = document.getElementById('hk-detail-pane');
var hkSearchInput = document.getElementById('hk-search-input');
var hkSearchClear = document.getElementById('hk-search-clear');
var hkResultsSummary = document.getElementById('hk-results-summary');
var hkResultsList = document.getElementById('hk-results-list');
var hkDetailBody = document.getElementById('hk-detail-body');
var hkRawiFilters = document.getElementById('hk-rawi-filters');
var hkFilterBukhari = document.getElementById('hk-filter-bukhari');
var hkFilterMuslim = document.getElementById('hk-filter-muslim');

var HK_MODE_TITLES = {
    hadith: 'بحث نص الحديث', group: 'بحث المتون المجمعة', rawi: 'بحث الرواة',
    topic: 'بحث الموضوعات', aqwal: 'بحث أقوال النقّاد',
    alem: 'الأئمة والنقّاد', book: 'الكتب'
};
var HK_HUKM_CLASS = { 0: 'hk-badge-sahih', 1: 'hk-badge-hasan', 2: 'hk-badge-daif', 3: 'hk-badge-daif' };

function setupHkSearch() {
    document.getElementById('btn-hk-toggle').addEventListener('click', openHkOverlay);
    document.getElementById('close-hk').addEventListener('click', closeHkOverlay);
    document.getElementById('hk-detail-back').addEventListener('click', hkPopDetail);
    document.getElementById('hk-detail-results').addEventListener('click', hkShowResultsLayer);

    fetch('/api/hk/meta/ranks').then(function(r) { return r.json(); }).then(function(data) {
        var sel = document.getElementById('hk-filter-rank');
        (data.ranks || []).forEach(function(r) {
            var opt = document.createElement('option');
            opt.value = r.rankNo;
            opt.textContent = r.rank;
            sel.appendChild(opt);
        });
    }).catch(function(err) { console.error('failed to load rank list', err); });
    document.getElementById('hk-filter-rank').addEventListener('change', function() {
        if (hkMode === 'rawi') performHkSearch('rawi', hkSearchState.rawi.query);
    });

    document.querySelectorAll('.hk-mode-tab').forEach(function(tab) {
        tab.addEventListener('click', function() { hkSwitchMode(tab.getAttribute('data-mode')); });
    });

    hkSearchInput.addEventListener('input', debounce(function() {
        var q = hkSearchInput.value.trim();
        hkSearchClear.classList.toggle('hidden', q.length === 0);
        hkSearchState[hkMode].query = q;
        var browsable = ['alem', 'book', 'topic'].indexOf(hkMode) !== -1;
        if (q.length < 2 && !(browsable && q.length === 0)) {
            hkSearchState[hkMode].hits = null;
            hkSearchState[hkMode].summary = 'اكتب للبحث';
            renderHkResultsFromState();
            return;
        }
        performHkSearch(hkMode, q);
    }, 250));

    hkSearchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') hkClearSearchBox();
    });
    hkSearchClear.addEventListener('click', hkClearSearchBox);

    hkFilterBukhari.addEventListener('change', function() { if (hkMode === 'rawi') performHkSearch('rawi', hkSearchState.rawi.query); });
    hkFilterMuslim.addEventListener('change', function() { if (hkMode === 'rawi') performHkSearch('rawi', hkSearchState.rawi.query); });

    hkOverlay.addEventListener('click', function(e) { if (e.target === hkOverlay) closeHkOverlay(); });
}

function hkClearSearchBox() {
    hkSearchInput.value = '';
    hkSearchClear.classList.add('hidden');
    hkSearchState[hkMode].query = '';
    var browsable = ['alem', 'book', 'topic'].indexOf(hkMode) !== -1;
    if (browsable) {
        performHkSearch(hkMode, '');
    } else {
        hkSearchState[hkMode].hits = null;
        hkSearchState[hkMode].summary = 'اكتب للبحث';
        renderHkResultsFromState();
    }
    hkSearchInput.focus();
}

function openHkOverlay() {
    hkOverlay.classList.add('show');
    // Restore exactly where THIS mode was left off (each mode remembers
    // its own layer + detail stack independently).
    if (hkModeLayer[hkMode] === 'detail' && hkDetailStacks[hkMode].length) {
        hkShowDetailLayer();
    } else {
        hkShowResultsLayer();
    }
}

function closeHkOverlay() {
    hkOverlay.classList.remove('show');
    // State intentionally left untouched — reopening restores this view.
}

function hkSwitchMode(mode) {
    if (HK_MODES.indexOf(mode) === -1) return;
    hkMode = mode;
    document.querySelectorAll('.hk-mode-tab').forEach(function(t) {
        t.classList.toggle('active', t.getAttribute('data-mode') === mode);
    });
    hkRawiFilters.classList.toggle('hidden', mode !== 'rawi');
    hkSearchInput.value = hkSearchState[mode].query;
    hkSearchClear.classList.toggle('hidden', !hkSearchState[mode].query);
    hkModalTitle.textContent = HK_MODE_TITLES[mode] || 'بحث الحديث';
    // Restore whichever layer this mode was left on, with its own
    // isolated detail stack — never the other modes' drill-down trail.
    if (hkModeLayer[mode] === 'detail' && hkDetailStacks[mode].length) {
        hkShowDetailLayer();
    } else {
        hkShowResultsLayer();
    }

    // alem/book/topic are browsable even without typing a query (small,
    // navigable sets) — auto-load the first page the first time this mode
    // is opened in this session, same as clicking "بحث" with an empty box.
    if (['alem', 'book', 'topic'].indexOf(mode) !== -1 && hkSearchState[mode].hits === null) {
        performHkSearch(mode, '');
    }
}

function hkShowResultsLayer() {
    hkActiveLayer = 'results';
    hkModeLayer[hkMode] = 'results';
    hkDetailPane.classList.add('hidden');
    hkResultsPane.classList.remove('hidden');
    hkModalTitle.textContent = HK_MODE_TITLES[hkMode] || 'بحث الحديث';
    document.querySelector('.hk-modal').classList.remove('hk-modal-tree-mode');
    renderHkResultsFromState();
    hkResultsList.scrollTop = hkSearchState[hkMode].scrollTop || 0;
}

function hkShowDetailLayer() {
    hkActiveLayer = 'detail';
    hkModeLayer[hkMode] = 'detail';
    hkResultsPane.classList.add('hidden');
    hkDetailPane.classList.remove('hidden');
    var stack = hkDetailStacks[hkMode];
    var top = stack[stack.length - 1];
    if (top) renderHkDetailEntry(top);
}

var HK_SEARCH_ENDPOINTS = {
    hadith: 'hadiths', group: 'groups', rawi: 'rawis',
    topic: 'topics', aqwal: 'aqwal', alem: 'alems', book: 'books'
};
var HK_PAGE_SIZE = 30;

function performHkSearch(mode, query, append) {
    var state = hkSearchState[mode];
    var offset = append ? state.hits.length : 0;
    if (!append) {
        state.summary = 'جارٍ البحث...';
        if (hkMode === mode) hkResultsSummary.textContent = state.summary;
    }

    // topic mode with an empty query browses the root of the topic tree
    // (a plain listing, not FTS) — everything else uses /search/<endpoint>,
    // which for alem/book also doubles as "browse all" when q is empty.
    var url, resultsKey;
    if (mode === 'topic' && !query) {
        url = '/api/hk/topics?limit=' + HK_PAGE_SIZE + '&offset=' + offset;
        resultsKey = 'topics';
    } else {
        var params = new URLSearchParams({ q: query, limit: String(HK_PAGE_SIZE), offset: String(offset) });
        if (mode === 'rawi') {
            if (hkFilterBukhari.checked) params.set('is_bukhari', '1');
            if (hkFilterMuslim.checked) params.set('is_muslim', '1');
            var rankVal = document.getElementById('hk-filter-rank').value;
            if (rankVal) params.set('rank_no', rankVal);
        }
        url = '/api/hk/search/' + HK_SEARCH_ENDPOINTS[mode] + '?' + params.toString();
        resultsKey = 'hits';
    }

    fetch(url)
        .then(function(res) { if (!res.ok) throw new Error('HK search failed: ' + res.status); return res.json(); })
        .then(function(data) {
            var newHits = data[resultsKey] || data.hits || [];
            state.hits = append ? state.hits.concat(newHits) : newHits;
            state.hasMore = !!data.hasMore;
            state.summary = state.hits.length ? (state.hits.length + ' نتيجة' + (state.hasMore ? '+' : '')) : 'لا توجد نتائج مطابقة';
            if (hkMode === mode) renderHkResultsFromState();
        })
        .catch(function(err) {
            console.error(err);
            state.summary = 'حدث خطأ أثناء البحث';
            if (hkMode === mode) renderHkResultsFromState();
        });
}

function renderHkResultsFromState() {
    var state = hkSearchState[hkMode];
    hkResultsSummary.textContent = state.summary;
    hkResultsList.innerHTML = '';
    if (!state.hits) return;
    state.hits.forEach(function(hit) { hkResultsList.appendChild(hkBuildResultCard(hkMode, hit)); });
    if (state.hasMore) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hk-load-more-btn';
        btn.textContent = 'تحميل المزيد';
        btn.addEventListener('click', function() {
            btn.textContent = 'جارٍ التحميل...';
            btn.disabled = true;
            performHkSearch(hkMode, state.query, true);
        });
        hkResultsList.appendChild(btn);
    }
}

function hkBuildResultCard(mode, hit) {
    var row = document.createElement('div');
    row.className = 'search-result-item hk-result-card';

    if (mode === 'hadith') {
        row.innerHTML =
            '<div class="result-title">' + escapeHtml(hit.bookName) + ' &middot; #' + hit.noInBook + '</div>' +
            '<div class="hk-badges">' + hkHukmBadge(hit.hukmNo, hit.hukm) + hkTypeBadge(hit.type) + '</div>' +
            '<div class="result-meta hk-preview">' + escapeHtml(hkTruncate(hit.taraf, 160)) + '</div>';
        row.addEventListener('click', function() { hkPushDetail('hadith', hit.hadithId); });
    } else if (mode === 'group') {
        row.innerHTML =
            '<div class="result-meta hk-preview">' + escapeHtml(hkTruncate(hit.nass, 180)) + '</div>' +
            '<div class="hk-badges">' + hkHukmBadge(hit.hukmNo) +
            '<span class="hk-badge hk-badge-muted">' + hit.bookCount + ' كتب</span>' +
            '<span class="hk-badge hk-badge-muted">' + hit.repeatQty + ' رواية</span></div>';
        row.addEventListener('click', function() { hkPushDetail('group', hit.groupId); });
    } else if (mode === 'rawi') {
        row.innerHTML =
            '<div class="result-title">' + escapeHtml(hit.nickname || hit.name) + '</div>' +
            '<div class="result-meta hk-subline">' + escapeHtml(hit.rank || '') + '</div>' +
            '<div class="hk-badges">' +
                (hit.isBukhari ? '<span class="hk-badge hk-badge-muted">روى له البخاري</span>' : '') +
                (hit.isMuslim ? '<span class="hk-badge hk-badge-muted">روى له مسلم</span>' : '') +
            '</div>';
        row.addEventListener('click', function() { hkPushDetail('rawi', hit.rawiId); });
    } else if (mode === 'topic') {
        row.innerHTML = '<div class="result-title">' + escapeHtml(hit.name) + '</div>';
        row.addEventListener('click', function() { hkPushDetail('topic', hit.topicId); });
    } else if (mode === 'aqwal') {
        row.innerHTML =
            '<div class="result-meta hk-preview">' + escapeHtml(hkTruncate(hit.qawl, 160)) + '</div>' +
            '<div class="result-meta hk-subline">' + escapeHtml(hit.alemName) + ' عن ' + escapeHtml(hit.rawiName) + '</div>';
        row.addEventListener('click', function() { hkPushDetail('rawi', hit.rawiId); });
    } else if (mode === 'alem') {
        row.innerHTML =
            '<div class="result-title">' + escapeHtml(hit.shuhra || hit.name) + '</div>' +
            '<div class="result-meta hk-subline">' +
                (hit.tabaka ? 'الطبقة ' + hit.tabaka : '') +
                (hit.deathYear ? ' &middot; ت ' + hit.deathYear : '') + '</div>' +
            '<div class="hk-badges"><span class="hk-badge hk-badge-muted">' + hit.aqwalQty + ' قولاً</span></div>';
        row.addEventListener('click', function() { hkPushDetail('alem', hit.alemId); });
    } else if (mode === 'book') {
        row.innerHTML =
            '<div class="result-title">' + escapeHtml(hit.name) + '</div>' +
            '<div class="result-meta hk-subline">' + escapeHtml(hit.authorName || '') + '</div>' +
            '<div class="hk-badges">' +
                (hit.tasnif ? '<span class="hk-badge hk-badge-muted">' + escapeHtml(hit.tasnif) + '</span>' : '') +
                '<span class="hk-badge hk-badge-muted">' + hit.hadithQty + ' حديث</span></div>';
        row.addEventListener('click', function() { hkPushDetail('book', hit.bookId); });
    }
    return row;
}

function hkHukmBadge(hukmNo, label) {
    var cls = HK_HUKM_CLASS[hukmNo] || 'hk-badge-muted';
    return '<span class="hk-badge ' + cls + '">' + escapeHtml(label || '') + '</span>';
}
function hkTypeBadge(label) {
    return label ? '<span class="hk-badge hk-badge-muted">' + escapeHtml(label) + '</span>' : '';
}
function hkTruncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── Detail stack (isolated per mode — see hkDetailStacks) ──

function hkPushDetail(type, id) {
    // Remember the results-layer scroll position before leaving it.
    hkSearchState[hkMode].scrollTop = hkResultsList.scrollTop;
    var stack = hkDetailStacks[hkMode];
    stack.push({ type: type, id: id, data: null });
    hkShowDetailLayer();
    hkLoadDetail(stack[stack.length - 1]);
}

function hkPopDetail() {
    var stack = hkDetailStacks[hkMode];
    if (stack.length) stack.pop();
    if (stack.length === 0) {
        hkShowResultsLayer();
    } else {
        renderHkDetailEntry(stack[stack.length - 1]);
    }
}

function hkLoadDetail(entry) {
    hkDetailBody.innerHTML = '<div class="loading-msg" style="padding:16px">جارٍ التحميل...</div>';
    var endpoint = {
        hadith: '/api/hk/hadith/', group: '/api/hk/group/', rawi: '/api/hk/rawi/',
        alem: '/api/hk/alem/', book: '/api/hk/book/', topic: '/api/hk/topic/',
        tree: '/api/hk/group/'
    }[entry.type];
    if (!endpoint) return;

    var stack = hkDetailStacks[hkMode];

    if (entry.type === 'tree') {
        // treeState lives on the entry itself (not entry.data, which gets
        // replaced wholesale on every companion-filter refetch) — this is
        // what lets returning to this exact tree, even after navigating
        // away to a narrator and back, restore the same view/sort/traced
        // path/filter instead of starting over.
        if (!entry.treeState) entry.treeState = {};
        fetch(endpoint + entry.id + '/tree')
            .then(function(res) { if (!res.ok) throw new Error('tree fetch failed'); return res.json(); })
            .then(function(data) {
                entry.data = data;
                entry.allSahabis = data.sahabis || []; // full list, cached — see hk-tree.js docstring
                if (stack[stack.length - 1] === entry) renderHkDetailEntry(entry);
            })
            .catch(function(err) {
                console.error(err);
                if (stack[stack.length - 1] === entry) {
                    hkDetailBody.innerHTML = '<div class="loading-msg" style="padding:16px">حدث خطأ في تحميل الشجرة</div>';
                }
            });
        return;
    }

    fetch(endpoint + entry.id)
        .then(function(res) { if (!res.ok) throw new Error('detail fetch failed'); return res.json(); })
        .then(function(data) {
            entry.data = data;
            if (stack[stack.length - 1] === entry) renderHkDetailEntry(entry);
            // Narrator dossiers show a "من مروياته" section, but that list
            // lives at a separate endpoint (not bundled into /rawi/<id>,
            // to keep that response light) — fetch it right after and
            // re-render once it arrives.
            if (entry.type === 'rawi') {
                fetch('/api/hk/rawi/' + entry.id + '/hadiths?limit=20&offset=0')
                    .then(function(res) { return res.json(); })
                    .then(function(hData) {
                        entry.data.hadithsData = { items: hData.hadiths || [], hasMore: !!hData.hasMore };
                        if (stack[stack.length - 1] === entry) renderHkDetailEntry(entry);
                    })
                    .catch(function(err) { console.error('rawi hadiths fetch failed', err); });
            }
        })
        .catch(function(err) {
            console.error(err);
            if (stack[stack.length - 1] === entry) {
                hkDetailBody.innerHTML = '<div class="loading-msg" style="padding:16px">حدث خطأ في التحميل</div>';
            }
        });
}

function renderHkDetailEntry(entry) {
    if (!entry.data) { hkDetailBody.innerHTML = '<div class="loading-msg" style="padding:16px">جارٍ التحميل...</div>'; return; }
    var d = entry.data;
    // The tree view needs meaningfully more room than every other page in
    // this modal (wide layered diagram, or a wide sortable table) — widen
    // (and, more modestly, heighten) the modal only while a tree entry is
    // the one actually showing, reverting for every other detail type.
    document.querySelector('.hk-modal').classList.toggle('hk-modal-tree-mode', entry.type === 'tree');
    if (entry.type === 'hadith') { hkModalTitle.textContent = d.bookName + ' #' + d.noInBook; hkDetailBody.innerHTML = hkRenderHadith(d); }
    else if (entry.type === 'group') { hkModalTitle.textContent = 'متن مجمَّع'; hkDetailBody.innerHTML = hkRenderGroup(d); }
    else if (entry.type === 'rawi') { hkModalTitle.textContent = d.nickname || d.name; hkDetailBody.innerHTML = hkRenderRawi(d); }
    else if (entry.type === 'alem') { hkModalTitle.textContent = d.shuhra || d.name; hkDetailBody.innerHTML = hkRenderAlem(d); }
    else if (entry.type === 'book') { hkModalTitle.textContent = d.name; hkDetailBody.innerHTML = hkRenderBook(d); }
    else if (entry.type === 'topic') { hkModalTitle.textContent = d.name; hkDetailBody.innerHTML = hkRenderTopic(d); }
    else if (entry.type === 'tree') {
        hkModalTitle.textContent = 'شجرة الإسناد';
        hkDetailBody.innerHTML = '<div class="hk-tree-widget-container"></div>';
        hkMountTree(entry);
    }
    hkBindDetailLinks();
    hkBindLoadMore(entry);
    hkBindTreeTrigger(entry);
}

// Mounts the actual interactive tree/table widget (hk-tree.js) into the
// container just inserted above. Kept separate from renderHkDetailEntry's
// generic innerHTML-per-type pattern because renderHkTree builds its own
// DOM and event listeners directly, rather than returning an HTML string.
function hkMountTree(entry) {
    var container = hkDetailBody.querySelector('.hk-tree-widget-container');
    if (!container || typeof renderHkTree !== 'function') return;

    function mount() {
        renderHkTree(container, entry.data, {
            onNodeClick: function(rawiId) { hkPushDetail('rawi', rawiId); },
            onSahabiFilterChange: function(sahabiId) {
                var url = '/api/hk/group/' + entry.id + '/tree' + (sahabiId ? ('?sahabi=' + sahabiId) : '');
                fetch(url)
                    .then(function(res) { return res.json(); })
                    .then(function(newData) {
                        entry.data = newData;
                        mount();
                    })
                    .catch(function(err) { console.error('sahabi filter fetch failed', err); });
            },
            allSahabis: entry.allSahabis || [],
            state: entry.treeState
        });
    }
    mount();
}

// Delegate every [data-hk-link] element inside the current detail body to
// push a new stack entry — this is what makes narrator names, critic
// names, book names, etc. clickable throughout every detail view.
function hkBindDetailLinks() {
    hkDetailBody.querySelectorAll('[data-hk-link]').forEach(function(el) {
        el.addEventListener('click', function() {
            hkPushDetail(el.getAttribute('data-hk-type'), parseInt(el.getAttribute('data-hk-id'), 10));
        });
    });
}

// Wires the "عرض شجرة الإسناد" button on a group detail view.
function hkBindTreeTrigger() {
    hkDetailBody.querySelectorAll('[data-hk-open-tree]').forEach(function(el) {
        el.addEventListener('click', function() {
            hkPushDetail('tree', parseInt(el.getAttribute('data-hk-open-tree'), 10));
        });
    });
}

// Wires the "تحميل المزيد" button that can appear inside a detail view
// (group narrations / book hadiths / a narrator's own hadith list) — each
// re-fetches its own endpoint at the next offset, merges into entry.data,
// and re-renders the whole detail view in place.
function hkBindLoadMore(entry) {
    var btn = hkDetailBody.querySelector('[data-hk-loadmore]');
    if (!btn) return;
    var kind = btn.getAttribute('data-hk-loadmore');
    btn.addEventListener('click', function() {
        btn.textContent = 'جارٍ التحميل...';
        btn.disabled = true;
        var d = entry.data;

        if (kind === 'group') {
            fetch('/api/hk/group/' + entry.id + '?offset=' + d.narrations.length)
                .then(function(res) { return res.json(); })
                .then(function(more) {
                    d.narrations = d.narrations.concat(more.narrations || []);
                    d.hasMore = !!more.hasMore;
                    renderHkDetailEntry(entry);
                });
        } else if (kind === 'book') {
            fetch('/api/hk/book/' + entry.id + '?offset=' + d.hadiths.length)
                .then(function(res) { return res.json(); })
                .then(function(more) {
                    d.hadiths = d.hadiths.concat(more.hadiths || []);
                    d.hasMore = !!more.hasMore;
                    renderHkDetailEntry(entry);
                });
        } else if (kind === 'rawi') {
            fetch('/api/hk/rawi/' + entry.id + '/hadiths?limit=20&offset=' + d.hadithsData.items.length)
                .then(function(res) { return res.json(); })
                .then(function(more) {
                    d.hadithsData.items = d.hadithsData.items.concat(more.hadiths || []);
                    d.hadithsData.hasMore = !!more.hasMore;
                    renderHkDetailEntry(entry);
                });
        } else if (kind === 'alem') {
            fetch('/api/hk/alem/' + entry.id + '?offset=' + d.aqwal.length)
                .then(function(res) { return res.json(); })
                .then(function(more) {
                    d.aqwal = d.aqwal.concat(more.aqwal || []);
                    d.hasMore = !!more.hasMore;
                    renderHkDetailEntry(entry);
                });
        } else if (kind === 'topic') {
            fetch('/api/hk/topic/' + entry.id + '?offset=' + d.narrations.length)
                .then(function(res) { return res.json(); })
                .then(function(more) {
                    d.narrations = d.narrations.concat(more.narrations || []);
                    d.hasMore = !!more.hasMore;
                    renderHkDetailEntry(entry);
                });
        }
    });
}

function hkLink(type, id, label, extraClass) {
    if (id === null || id === undefined || id === 0) return escapeHtml(label || '');
    return '<a href="#" class="hk-link ' + (extraClass || '') + '" data-hk-link data-hk-type="' + type + '" data-hk-id="' + id + '">' + escapeHtml(label || '') + '</a>';
}

function hkRenderHadith(d) {
    var sanadsHtml = (d.sanads || []).map(function(s) {
        var chainHtml = s.chain.map(function(n) {
            if (!n.rawiId) return '<span class="hk-chain-break">⌁</span>';
            var flags = (n.isBukhari ? ' <span class="hk-chain-flag" title="روى له البخاري">خ</span>' : '') +
                        (n.isMuslim ? ' <span class="hk-chain-flag" title="روى له مسلم">م</span>' : '');
            // Plain middle-dot character, not the &middot; HTML entity — the
            // sub-line text passes through escapeHtml(), which escapes the
            // "&" in any entity into literal "&amp;middot;" text instead of
            // rendering "·". A real Unicode character has no such issue.
            var sub = [n.tabaka ? 'ط' + n.tabaka : '', n.rank || ''].filter(Boolean).join(' · ');
            return '<span class="hk-chain-node-wrap">' +
                '<span class="hk-chain-node-top">' + hkLink('rawi', n.rawiId, n.name, 'hk-chain-node') + flags + '</span>' +
                (sub ? '<span class="hk-chain-node-sub">' + escapeHtml(sub) + '</span>' : '') + '</span>';
        }).join('<span class="hk-chain-arrow"> ← </span>');
        return '<div class="hk-sanad-row">' + hkHukmBadge(s.hukmNo, s.hukm) +
            (s.hukmSentence ? '<div class="hk-hukm-sentence">' + escapeHtml(s.hukmSentence) + '</div>' : '') +
            '<div class="hk-chain">' + chainHtml + '</div></div>';
    }).join('');

    return (
        '<div class="hk-detail-header">' + hkLink('book', d.bookId, d.bookName) +
        ' <span class="hk-detail-muted">#' + d.noInBook + '</span></div>' +
        '<div class="hk-badges">' + hkHukmBadge(d.hukmNo, d.hukm) + hkTypeBadge(d.type) + '</div>' +
        '<div class="hk-nass">' + escapeHtml(d.nass) + '</div>' +
        (d.groupId ? '<div class="hk-section-link">' + hkLink('group', d.groupId, 'عرض كل روايات هذا المعنى ←') + '</div>' : '') +
        '<div class="hk-section-heading">الأسانيد (' + (d.sanads ? d.sanads.length : 0) + ')</div>' +
        '<div class="hk-sanads">' + sanadsHtml + '</div>'
    );
}

function hkRenderGroup(d) {
    var narrationsHtml = (d.narrations || []).map(function(n) {
        return '<div class="hk-result-card search-result-item">' +
            '<div class="result-title">' + hkLink('book', n.bookId, n.bookName) + ' <span class="hk-detail-muted">#' + n.noInBook + '</span></div>' +
            '<div class="hk-badges">' + hkHukmBadge(n.hukmNo, n.hukm) + hkTypeBadge(n.type) + '</div>' +
            '<a href="#" class="hk-link-block" data-hk-link data-hk-type="hadith" data-hk-id="' + n.hadithId + '">' +
            escapeHtml(hkTruncate(n.taraf, 140)) + '</a></div>';
    }).join('');

    return (
        '<button type="button" class="hk-tree-trigger-btn" data-hk-open-tree="' + d.groupId + '">عرض شجرة الإسناد</button>' +
        (d.taraf ? '<div class="hk-section-heading">الطرف (اللفظ الجامع)</div><div class="hk-nass hk-taraf">' + escapeHtml(d.taraf) + '</div>' : '') +
        '<div class="hk-section-heading">نص المتن</div>' +
        '<div class="hk-nass">' + escapeHtml(d.nass) + '</div>' +
        '<div class="hk-badges">' + hkHukmBadge(d.hukmNo) +
            '<span class="hk-badge hk-badge-muted">' + d.sahabaQty + ' صحابة</span>' +
            '<span class="hk-badge hk-badge-muted">' + d.repeatQty + ' رواية</span></div>' +
        '<div class="hk-section-heading">الروايات</div>' +
        '<div class="hk-narrations-list">' + narrationsHtml + '</div>' +
        (d.hasMore ? '<button type="button" class="hk-load-more-btn" data-hk-loadmore="group">تحميل المزيد</button>' : '')
    );
}

function hkRenderRawi(d) {
    var flags = [];
    if (d.isBukhari) flags.push('روى له البخاري');
    if (d.isMuslim) flags.push('روى له مسلم');
    if (d.hasTadlis) flags.push('موصوف بالتدليس');
    if (d.hasIkhtilat) flags.push('وقع له اختلاط');
    if (d.isStub) flags.push('ترجمة ناقصة');

    var bars = function(list) {
        if (!list.length) return '<div class="hk-detail-muted">لا بيانات</div>';
        var max = Math.max.apply(null, list.map(function(x) { return x.count; }));
        return list.map(function(x) {
            var pct = Math.max(8, Math.round((x.count / max) * 100));
            return '<div class="hk-bar-row">' +
                '<div class="hk-bar-label">' + hkLink('rawi', x.rawiId, x.name) + '<span class="hk-detail-muted">' + x.count + '</span></div>' +
                '<div class="hk-bar-track"><div class="hk-bar-fill" style="width:' + pct + '%"></div></div></div>';
        }).join('');
    };

    var aqwalHtml = (d.aqwal || []).map(function(a) {
        return '<div class="hk-aqwal-quote"><div>' + escapeHtml(a.qawl) + '</div>' +
            '<div class="hk-detail-muted">— ' + hkLink('alem', a.alemId, a.alemName) + '</div></div>';
    }).join('') || '<div class="hk-detail-muted">لا توجد أقوال مسجلة</div>';

    var hd = d.hadithsData;
    var hadithsHtml, loadMoreHtml = '';
    if (!hd) {
        hadithsHtml = '<div class="hk-detail-muted">جارٍ التحميل...</div>';
    } else {
        hadithsHtml = (hd.items || []).map(function(h) {
            return '<div class="hk-result-card search-result-item">' +
                '<div class="result-title">' + hkLink('book', h.bookId, h.bookName) + ' <span class="hk-detail-muted">#' + h.noInBook + '</span></div>' +
                '<div class="hk-badges">' + hkHukmBadge(h.hukmNo, h.hukm) + '</div>' +
                '<a href="#" class="hk-link-block" data-hk-link data-hk-type="hadith" data-hk-id="' + h.hadithId + '">' +
                escapeHtml(hkTruncate(h.taraf, 140)) + '</a></div>';
        }).join('') || '<div class="hk-detail-muted">لا توجد روايات</div>';
        if (hd.hasMore) loadMoreHtml = '<button type="button" class="hk-load-more-btn" data-hk-loadmore="rawi">تحميل المزيد</button>';
    }

    return (
        '<div class="hk-detail-header">' + escapeHtml(d.nickname || '') +
            '<span class="hk-detail-muted"> ' + escapeHtml(d.name || '') + '</span></div>' +
        '<div class="hk-badges">' + (d.rank ? hkHukmBadge(0, d.rank) : '') +
            flags.map(function(f) { return '<span class="hk-badge hk-badge-muted">' + escapeHtml(f) + '</span>'; }).join('') + '</div>' +
        '<div class="hk-bio-row">' +
            '<span class="hk-detail-muted">الطبقة:</span> ' + (d.tabaka || '—') +
            ' &middot; <span class="hk-detail-muted">الوفاة:</span> ' + escapeHtml(String(d.deathYear || '—')) +
            (d.deathPlace ? ' &middot; <span class="hk-detail-muted">مكان الوفاة:</span> ' + escapeHtml(d.deathPlace) : '') +
        '</div>' +
        '<div class="hk-stats-row">' + d.chainCount + ' إسناد &middot; ' + d.hadithCount + ' حديث</div>' +
        '<div class="hk-network-grid">' +
            '<div><div class="hk-section-heading">شيوخه</div>' + bars(d.teachers) + '</div>' +
            '<div><div class="hk-section-heading">تلاميذه</div>' + bars(d.students) + '</div>' +
        '</div>' +
        '<div class="hk-section-heading">أقوال النقّاد فيه</div>' +
        '<div class="hk-aqwal-list">' + aqwalHtml + '</div>' +
        '<div class="hk-section-heading">من مروياته</div>' +
        '<div class="hk-narrations-list">' + hadithsHtml + '</div>' +
        loadMoreHtml
    );
}

function hkRenderAlem(d) {
    var aqwalHtml = (d.aqwal || []).map(function(a) {
        return '<div class="hk-aqwal-quote"><div>' + escapeHtml(a.qawl) + '</div>' +
            '<div class="hk-detail-muted">عن ' + hkLink('rawi', a.rawiId, a.rawiName) + '</div></div>';
    }).join('') || '<div class="hk-detail-muted">لا توجد أقوال مسجلة</div>';

    return (
        '<div class="hk-detail-header">' + escapeHtml(d.shuhra || d.name) + '</div>' +
        '<div class="hk-bio-row"><span class="hk-detail-muted">الطبقة:</span> ' + (d.tabaka || '—') +
            ' &middot; <span class="hk-detail-muted">الوفاة:</span> ' + (d.deathYear || '—') +
            (d.rank ? ' &middot; <span class="hk-detail-muted">الرتبة:</span> ' + escapeHtml(d.rank) : '') + '</div>' +
        '<div class="hk-section-heading">أقواله (' + d.aqwalQty + ')</div>' +
        '<div class="hk-aqwal-list">' + aqwalHtml + '</div>' +
        (d.hasMore ? '<button type="button" class="hk-load-more-btn" data-hk-loadmore="alem">تحميل المزيد</button>' : '')
    );
}

function hkRenderBook(d) {
    var hadithsHtml = (d.hadiths || []).map(function(h) {
        return '<div class="hk-result-card search-result-item">' +
            '<div class="hk-badges">' + hkHukmBadge(h.hukmNo, h.hukm) + '<span class="hk-badge hk-badge-muted">#' + h.noInBook + '</span></div>' +
            '<a href="#" class="hk-link-block" data-hk-link data-hk-type="hadith" data-hk-id="' + h.hadithId + '">' +
            escapeHtml(hkTruncate(h.taraf, 140)) + '</a></div>';
    }).join('');

    return (
        '<div class="hk-detail-header">' + escapeHtml(d.name) + '</div>' +
        '<div class="hk-detail-muted">' + escapeHtml(d.authorName || '') + (d.authorDeathYear ? ' (ت ' + d.authorDeathYear + ')' : '') + '</div>' +
        '<div class="hk-bio-row">' + escapeHtml(d.tasnif || '') + ' &middot; ' + d.hadithQty + ' حديث</div>' +
        '<div class="hk-section-heading">الأحاديث</div>' +
        '<div class="hk-narrations-list">' + hadithsHtml + '</div>' +
        (d.hasMore ? '<button type="button" class="hk-load-more-btn" data-hk-loadmore="book">تحميل المزيد</button>' : '')
    );
}

function hkRenderTopic(d) {
    var childrenHtml = (d.children || []).map(function(t) {
        return '<div class="hk-result-card search-result-item">' + hkLink('topic', t.topicId, t.name, 'hk-link-block') + '</div>';
    }).join('');
    var narrationsHtml = (d.narrations || []).map(function(n) {
        return '<div class="hk-result-card search-result-item">' +
            '<div class="result-title">' + hkLink('book', n.bookId, n.bookName) + '</div>' +
            hkHukmBadge(0, n.hukm) +
            '<a href="#" class="hk-link-block" data-hk-link data-hk-type="hadith" data-hk-id="' + n.hadithId + '">' +
            escapeHtml(hkTruncate(n.taraf, 140)) + '</a></div>';
    }).join('');

    return (
        '<div class="hk-detail-header">' + escapeHtml(d.name) + '</div>' +
        (childrenHtml ? '<div class="hk-section-heading">مواضيع فرعية</div><div class="hk-narrations-list">' + childrenHtml + '</div>' : '') +
        (d.group ? '<div class="hk-section-heading">الأحاديث</div><div class="hk-narrations-list">' + narrationsHtml + '</div>' +
            (d.hasMore ? '<button type="button" class="hk-load-more-btn" data-hk-loadmore="topic">تحميل المزيد</button>' : '') : '')
    );
}
