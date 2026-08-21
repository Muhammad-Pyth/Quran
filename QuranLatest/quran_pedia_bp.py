import re
import sqlite3
from pathlib import Path
from flask import Blueprint, jsonify, request

BASE_DIR = Path(__file__).resolve().parent
QURAN_PEDIA_DB_PATH = (BASE_DIR / 'quran.db').resolve()

quran_pedia_bp = Blueprint('quran_pedia', __name__, url_prefix='/api/qp')

# Single-edition app: mushaf_id=1 (مصحف حفص، مجمع الملك فهد) is the ONLY mushaf
# offered. It's not an arbitrary default — it's the exact source text the
# Quranic Arabic Corpus (corpus.quran.com) morphology data was built against.
# Verified (2026-08-20): after stripping standalone waqf/pause marks (ۖۗۘۙۚۛ etc.)
# and merging raw words that correspond to a single multi-token Corpus entry
# (e.g. "يا أيها" = one morphology word), all 6236 ayahs of mushaf_id=1 align
# 1:1 with morphology_words with zero mismatches. Every other mushaf/riwayah
# in this DB has a genuinely different underlying text (different word joins,
# elisions, etc.) that morphology_words was never built against — so root
# lookups on those editions are unfixable at the app layer and were dropped.
DEFAULT_MUSHAF_ID = 1


def get_db():
    conn = sqlite3.connect(QURAN_PEDIA_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


# ---------- surahs ----------

@quran_pedia_bp.route('/surahs')
def list_surahs():
    conn = get_db()
    rows = conn.execute("""SELECT surah_number, name, coded_name, surah_type, words_count
                            FROM surahs ORDER BY surah_number""").fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@quran_pedia_bp.route('/surahs/<int:surah_number>')
def surah_detail(surah_number):
    conn = get_db()
    row = conn.execute("SELECT * FROM surahs WHERE surah_number=?", (surah_number,)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'not found'}), 404
    return jsonify(dict(row))


# ---------- mushafs / qira'at ----------

@quran_pedia_bp.route('/mushafs')
def list_mushafs():
    """Reader-display list — ONE mushaf per riwayah (rawi_id), so the
    dropdown offers each genuine reading (Hafs, Warsh, Qalun, ...) exactly
    once. Verified against the real production database (2026-08-21): four
    mushafs share rawi_id=10 (Hafs) — mushaf_id 1/2/3/11, differing only in
    typeface/script (plain Uthmani print, plain text, Nastaleeq, colored
    tajweed) — and two share rawi_id=1 (Qalun) — mushaf_id 7/12 (standard
    print vs. the Libyan Awqaf edition). An earlier version of this query
    hardcoded "NOT IN (2, 3)" to exclude only 2 of these 6 duplicates, which
    missed mushaf_id 11 and 12 entirely. Fixed to a real GROUP BY rawi_id
    (picking the lowest mushaf_id per riwayah as the representative) so
    this stays correct regardless of how many typeface variants exist per
    riwayah, rather than needing to hardcode every new one found. This is
    UNRELATED to root/morphology lookups: those stay pinned to
    DEFAULT_MUSHAF_ID everywhere else (see the note above
    ayah_morphology()) since morphology_words only aligns with that one
    edition's text."""
    conn = get_db()
    rows = conn.execute("""
        SELECT m.mushaf_id, m.name, m.description, m.bismillah, r.name AS rawi_name,
               r.full_name AS rawi_full_name, q.qiraa_id, q.short_name AS qiraa_name
        FROM mushafs m
        JOIN riwayat r ON r.rawi_id = m.rawi_id
        JOIN qiraat q ON q.qiraa_id = r.qiraa_id
        WHERE EXISTS (SELECT 1 FROM ayahs a WHERE a.mushaf_id = m.mushaf_id)
          AND m.mushaf_id = (
              -- lowest mushaf_id among all mushafs sharing this riwayah —
              -- for Hafs (rawi_id=10) that's mushaf_id=1, DEFAULT_MUSHAF_ID
              -- itself, so the default reading edition and the dropdown's
              -- representative for Hafs are guaranteed to be the same row
              SELECT MIN(m2.mushaf_id) FROM mushafs m2
              WHERE m2.rawi_id = m.rawi_id
                AND EXISTS (SELECT 1 FROM ayahs a2 WHERE a2.mushaf_id = m2.mushaf_id)
          )
        ORDER BY (m.mushaf_id != ?), m.mushaf_id
    """, (DEFAULT_MUSHAF_ID,)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ---------- ayahs (reading view) ----------

@quran_pedia_bp.route('/ayahs/<int:mushaf_id>/<int:surah_number>')
def surah_ayahs(mushaf_id, surah_number):
    conn = get_db()
    rows = conn.execute("""
        SELECT ayah_number, text, page_number, juz, hizb, ruku, manzil
        FROM ayahs WHERE mushaf_id=? AND surah_number=? ORDER BY ayah_number
    """, (mushaf_id, surah_number)).fetchall()
    conn.close()
    if not rows:
        return jsonify({'error': 'not found for this mushaf/surah'}), 404
    return jsonify([dict(r) for r in rows])


# ---------- qira'at divergence (per ayah) ----------

@quran_pedia_bp.route('/surah/<int:surah_number>/qiraat')
def surah_qiraat_words(surah_number):
    """Bulk divergence-word list per ayah for the whole surah, used only to drive
    inline highlighting while reading (not the full variant detail — that's fetched
    per-ayah on demand when the modal opens)."""
    conn = get_db()
    rows = conn.execute("""SELECT DISTINCT ayah_number, ayah_word FROM qiraat_divergence
                            WHERE surah_number=?""", (surah_number,)).fetchall()
    conn.close()
    grouped = {}
    for r in rows:
        grouped.setdefault(r['ayah_number'], []).append(r['ayah_word'])
    return jsonify(grouped)


@quran_pedia_bp.route('/ayah/<int:surah_number>/<int:ayah_number>/qiraat')
def ayah_qiraat_divergence(surah_number, ayah_number):
    conn = get_db()
    rows = conn.execute("""
        SELECT d.ayah_word, d.qiraa_text, r.rawi_id, r.name AS rawi_name,
               r.full_name AS rawi_full_name, q.qiraa_id, q.short_name AS qiraa_name,
               q.region_name AS qiraa_region
        FROM qiraat_divergence d
        JOIN riwayat r ON r.rawi_id = d.rawi_id
        JOIN qiraat q ON q.qiraa_id = r.qiraa_id
        WHERE d.surah_number=? AND d.ayah_number=?
        ORDER BY d.id
    """, (surah_number, ayah_number)).fetchall()
    conn.close()

    # group by divergence word for cleaner frontend rendering
    grouped = {}
    for r in rows:
        word = r['ayah_word']
        grouped.setdefault(word, []).append({
            'qiraa_text': r['qiraa_text'], 'rawi_id': r['rawi_id'], 'rawi_name': r['rawi_name'],
            'rawi_full_name': r['rawi_full_name'], 'qiraa_id': r['qiraa_id'], 'qiraa_name': r['qiraa_name'],
            'qiraa_region': r['qiraa_region'],
        })
    return jsonify([{'ayah_word': w, 'variants': v} for w, v in grouped.items()])


# ---------- books / tafsir / asbab / e3rab / nasekh (shared pattern) ----------

@quran_pedia_bp.route('/ayah/<int:surah_number>/<int:ayah_number>/books')
def ayah_available_books(surah_number, ayah_number):
    """Returns availability grouped by service_type — drives the tab + dropdown UI.
    DISTINCT + GROUP BY guards against duplicate availability rows; priority CASE
    puts the six most-requested tafsir books on top of that tab's dropdown."""
    conn = get_db()
    rows = conn.execute("""
        SELECT a.service_type, b.book_id, b.name, b.short_name, b.author_name, b.publish_year, b.parts,
               CASE
                   WHEN b.name LIKE '%الطبري%' OR b.name LIKE '%جامع البيان%' THEN 0
                   WHEN b.name LIKE '%ابن كثير%' OR b.name LIKE '%القرآن العظيم%' THEN 1
                   WHEN b.name LIKE '%البغوي%' OR b.name LIKE '%معالم التنزيل%' THEN 2
                   WHEN b.name LIKE '%القرطبي%' OR b.name LIKE '%الجامع لأحكام%' THEN 3
                   WHEN b.name LIKE '%السعدي%' OR b.name LIKE '%الكريم الرحمن%' THEN 4
                   WHEN b.name LIKE '%أضواء البيان%' THEN 5
                   ELSE 99
               END AS priority
        FROM book_ayah_availability a
        JOIN books b ON b.book_id = a.book_id
        WHERE a.surah_number=? AND a.ayah_number=?
          AND EXISTS (SELECT 1 FROM book_content bc
                       WHERE bc.book_id = b.book_id AND bc.surah_number = a.surah_number
                             AND bc.ayah_number = a.ayah_number)
        GROUP BY a.service_type, b.book_id
        ORDER BY a.service_type, priority, b.name
    """, (surah_number, ayah_number)).fetchall()
    conn.close()

    grouped = {}
    seen = {}  # service_type -> set of (name, author_name) already added
    for r in rows:
        st = r['service_type']
        dedup_key = (r['name'], r['author_name'])
        seen.setdefault(st, set())
        if dedup_key in seen[st]:
            continue  # exact same title+author under a different book_id — real catalog duplicate
        seen[st].add(dedup_key)
        grouped.setdefault(st, []).append({
            'book_id': r['book_id'], 'name': r['name'], 'short_name': r['short_name'],
            'author_name': r['author_name'], 'publish_year': r['publish_year'], 'parts': r['parts'],
        })
    return jsonify(grouped)  # {'tafsir': [...], 'asbab': [...], 'e3rab': [...], 'nasekh': [...]}


@quran_pedia_bp.route('/book_content/<int:book_id>/<int:surah_number>/<int:ayah_number>')
def book_content(book_id, surah_number, ayah_number):
    conn = get_db()
    row = conn.execute("""
        SELECT bc.content_html, b.name AS book_name, b.author_name, b.book_type
        FROM book_content bc JOIN books b ON b.book_id = bc.book_id
        WHERE bc.book_id=? AND bc.surah_number=? AND bc.ayah_number=?
    """, (book_id, surah_number, ayah_number)).fetchone()
    conn.close()
    if not row:
        return jsonify({'error': 'no content for this book/ayah'}), 404
    return jsonify(dict(row))


# ---------- morphology / roots ----------

# Standalone Quranic annotation/pause marks (waqf signs, small high marks, etc.)
# that appear in ayahs.text as their own whitespace-delimited "word" but carry
# no morphology entry — must be excluded before positionally aligning raw
# mushaf words against morphology_words. Range covers e.g. ۖ ۗ ۘ ۙ ۚ ۛ ۜ.
_PAUSE_MARK_RE = re.compile(r'^[\u06D6-\u06ED\ufeff]+$')


def _align_words_to_morphology(raw_text, morph_words):
    """Maps each displayed (non-pause-mark) word in raw_text to the morphology
    word it belongs to. Handles the one real complication found in this data:
    a small number of Corpus entries are themselves two space-joined raw words
    (e.g. "يا أيها" as a single morphology word) — so alignment must consume
    raw words in groups matching each morphology word's own token count,
    not 1:1 by position. Verified: 0 misalignments across all 6236 ayahs of
    mushaf_id=1 with this approach (see DEFAULT_MUSHAF_ID note above).

    Returns a list of dicts, one per RAW displayed token (so the frontend can
    render every token it already shows), each either:
      {'display': text, 'clickable': False}                    — a pause mark
      {'display': text, 'clickable': True, 'word_number': N}   — real word,
        where N is the morphology_words.word_number it belongs to (several
        consecutive raw tokens may share the same N for multi-token entries).
    """
    raw_tokens = raw_text.split()
    out = []
    morph_idx = 0
    raw_idx = 0
    while raw_idx < len(raw_tokens):
        tok = raw_tokens[raw_idx]
        if _PAUSE_MARK_RE.match(tok.strip('\ufeff')):
            out.append({'display': tok, 'clickable': False})
            raw_idx += 1
            continue
        if morph_idx >= len(morph_words):
            # shouldn't happen given verification above, but fail safe rather
            # than crash or silently mis-map to the wrong word
            out.append({'display': tok, 'clickable': False})
            raw_idx += 1
            continue
        n_tokens = len(morph_words[morph_idx]['text'].split())
        word_number = morph_words[morph_idx]['word_number']
        for _ in range(n_tokens):
            if raw_idx >= len(raw_tokens):
                break
            out.append({'display': raw_tokens[raw_idx], 'clickable': True, 'word_number': word_number})
            raw_idx += 1
        morph_idx += 1
    return out


@quran_pedia_bp.route('/ayah/<int:surah_number>/<int:ayah_number>/morphology')
def ayah_morphology(surah_number, ayah_number):
    """Word-by-word breakdown for an ayah — powers click-a-word-to-see-root.
    Also returns `alignment`: the raw mushaf text's tokens mapped to the
    correct word_number (or flagged non-clickable for pause marks), so the
    frontend never has to re-derive this itself. See _align_words_to_morphology."""
    conn = get_db()
    ayah_row = conn.execute(
        "SELECT text FROM ayahs WHERE mushaf_id=? AND surah_number=? AND ayah_number=?",
        (DEFAULT_MUSHAF_ID, surah_number, ayah_number)
    ).fetchone()

    words = conn.execute("""
        SELECT id, word_number, word_text, translation, phonetic
        FROM morphology_words WHERE surah_number=? AND ayah_number=? ORDER BY word_number
    """, (surah_number, ayah_number)).fetchall()

    # Item #12: previously issued one morphology_segments query PER WORD in
    # a loop (N+1 pattern — an ayah with 10 words meant 11 round-trips).
    # Batched into a single IN(...) query, then grouped in Python instead.
    word_ids = [w['id'] for w in words]
    segs_by_word = {}
    if word_ids:
        placeholders = ','.join('?' * len(word_ids))
        seg_rows = conn.execute(f"""
            SELECT word_id, form, role, pos, inflection, root, lemma, pattern
            FROM morphology_segments WHERE word_id IN ({placeholders})
        """, word_ids).fetchall()
        for s in seg_rows:
            segs_by_word.setdefault(s['word_id'], []).append(dict(s))

    result = []
    for w in words:
        result.append({
            'word_number': w['word_number'], 'word_text': w['word_text'],
            'translation': w['translation'], 'phonetic': w['phonetic'],
            'segments': segs_by_word.get(w['id'], []),
        })
    conn.close()

    alignment = []
    if ayah_row and result:
        morph_for_align = [{'text': r['word_text'], 'word_number': r['word_number']} for r in result]
        alignment = _align_words_to_morphology(ayah_row['text'], morph_for_align)

    return jsonify({'words': result, 'alignment': alignment})


@quran_pedia_bp.route('/root/<root>')
def root_occurrences(root):
    """All occurrences of a given root across the Quran, paginated."""
    offset = request.args.get('offset', 0, type=int)
    limit = request.args.get('limit', 20, type=int)
    conn = get_db()
    rows = conn.execute("""
        SELECT DISTINCT w.surah_number, w.ayah_number, w.word_number, w.word_text
        FROM morphology_segments s
        JOIN morphology_words w ON w.id = s.word_id
        WHERE s.root = ?
        ORDER BY w.surah_number, w.ayah_number, w.word_number
        LIMIT ? OFFSET ?
    """, (root, limit + 1, offset)).fetchall()
    conn.close()
    has_more = len(rows) > limit
    results = [dict(r) for r in rows[:limit]]
    return jsonify({'results': results, 'has_more': has_more})


@quran_pedia_bp.route('/roots')
def list_roots():
    """All distinct roots, for populating a root-search autocomplete/browse list."""
    conn = get_db()
    rows = conn.execute("""
        SELECT root, COUNT(*) AS occurrences FROM morphology_segments
        WHERE root IS NOT NULL AND root != '' GROUP BY root ORDER BY root
    """).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ---------- search ----------

@quran_pedia_bp.route('/search/ayahs')
def search_ayahs():
    q = request.args.get('q', '').strip()
    offset = request.args.get('offset', 0, type=int)
    limit = request.args.get('limit', 20, type=int)
    if not q:
        return jsonify({'results': [], 'has_more': False})
    conn = get_db()
    q_norm = normalize_arabic(q)

    # Item #5 fix: snippet() can only return text from the FTS-INDEXED
    # column, which is text_normalized (undiacritized) — there is no
    # diacritized column in ayahs_fts to pull from, so snippet() was
    # always going to show normalized text no matter what. Fixed by
    # dropping snippet() for ayahs entirely: a.text (the real diacritized
    # text) is already selected below, and a full ayah is short enough to
    # show whole — the frontend highlights the match client-side using the
    # same qpHighlightTextNode() logic used on destination views (item #8),
    # so there's no need for FTS to produce a marked-up excerpt here.
    rows = conn.execute("""
        SELECT a.surah_number, a.ayah_number, a.text, s.name AS surah_name
        FROM ayahs_fts f JOIN ayahs a ON a.id = f.rowid
        JOIN surahs s ON s.surah_number = a.surah_number
        WHERE f.text_normalized MATCH ? AND a.mushaf_id = ?
        ORDER BY a.surah_number, a.ayah_number LIMIT ? OFFSET ?
    """, (q_norm, DEFAULT_MUSHAF_ID, limit + 1, offset)).fetchall()
    conn.close()
    has_more = len(rows) > limit
    results = [dict(r) for r in rows[:limit]]
    return jsonify({'results': results, 'has_more': has_more})


@quran_pedia_bp.route('/search/books')
def search_books():
    q = request.args.get('q', '').strip()
    service_type = request.args.get('service_type')  # optional filter
    offset = request.args.get('offset', 0, type=int)
    limit = request.args.get('limit', 20, type=int)
    if not q:
        return jsonify({'results': [], 'has_more': False})
    conn = get_db()
    q_norm = normalize_arabic(q)
    sql = """
        SELECT bc.surah_number, bc.ayah_number, bc.book_id, b.name AS book_name, b.book_type,
               bc.content_html, f.content_text_normalized
        FROM book_content_fts f
        JOIN book_content bc ON bc.id = f.rowid
        JOIN books b ON b.book_id = bc.book_id
        WHERE f.content_text_normalized MATCH ?
    """
    params = [q_norm]
    if service_type:
        sql += " AND b.book_type = ?"
        params.append(service_type)
    sql += " ORDER BY bc.surah_number, bc.ayah_number LIMIT ? OFFSET ?"
    params += [limit + 1, offset]
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    has_more = len(rows) > limit

    # Item #5 fix: snippet() only had the normalized column to pull from
    # (book_content_fts indexes content_text_normalized, not real
    # diacritized text — same root cause as search_ayahs above), so results
    # always showed undiacritized text. Build the preview from content_html
    # itself instead: strip tags, find roughly where the match falls in the
    # normalized text, map that position proportionally into the real text
    # (both strings track each other closely since normalization only
    # removes diacritics/tatweel — it doesn't reorder or add characters),
    # then take a window of real text around that point.
    results = []
    for r in rows[:limit]:
        plain = re.sub(r'<[^>]+>', ' ', r['content_html'] or '')
        plain = re.sub(r'\s+', ' ', plain).strip()
        norm_full = r['content_text_normalized'] or ''
        match_pos = normalize_arabic(q).strip()
        idx = norm_full.find(match_pos) if match_pos else -1
        if idx >= 0 and len(norm_full) > 0:
            ratio = idx / len(norm_full)
            center = int(ratio * len(plain))
        else:
            center = 0
        window = 90
        start = max(0, center - window)
        end = min(len(plain), center + window)
        snippet = ('…' if start > 0 else '') + plain[start:end] + ('…' if end < len(plain) else '')
        results.append({
            'surah_number': r['surah_number'], 'ayah_number': r['ayah_number'],
            'book_id': r['book_id'], 'book_name': r['book_name'], 'book_type': r['book_type'],
            'snippet': snippet,
        })
    return jsonify({'results': results, 'has_more': has_more})


# ---------- normalize_arabic (kept local to this blueprint, per project convention) ----------

_TASHKEEL_RE = re.compile(r'[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u08D4-\u08E1\u08E3-\u08FF]')
_TATWEEL_RE = re.compile(r'\u0640')

def normalize_arabic(text: str) -> str:
    if not text:
        return text
    text = _TASHKEEL_RE.sub('', text)
    text = _TATWEEL_RE.sub('', text)
    text = text.replace('\u0622', '\u0627').replace('\u0623', '\u0627').replace('\u0625', '\u0627')
    text = text.replace('\u0629', '\u0647').replace('\u0649', '\u064A')
    return text.strip()
