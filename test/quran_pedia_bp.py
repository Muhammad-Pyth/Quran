import sqlite3
from pathlib import Path
from flask import Blueprint, jsonify, request

BASE_DIR = Path(__file__).resolve().parent
QURAN_PEDIA_DB_PATH = (BASE_DIR / 'quran.db').resolve()

quran_pedia_bp = Blueprint('quran_pedia', __name__, url_prefix='/api/qp')

# Only these 4 qira'at / 8 riwayat have full standalone mushaf text in this DB
# (the other 12 riwayat exist only as word-level divergence entries).
FULL_TEXT_RIWAYAT_NOTE = "Only mushafs with actual ayah text are offered as reading selections."


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
    """Only mushafs that actually have ayah rows (i.e. full running text available)."""
    conn = get_db()
    rows = conn.execute("""
        SELECT m.mushaf_id, m.name, m.description, m.bismillah, r.name AS rawi_name,
               r.full_name AS rawi_full_name, q.qiraa_id, q.short_name AS qiraa_name
        FROM mushafs m
        JOIN riwayat r ON r.rawi_id = m.rawi_id
        JOIN qiraat q ON q.qiraa_id = r.qiraa_id
        WHERE EXISTS (SELECT 1 FROM ayahs a WHERE a.mushaf_id = m.mushaf_id)
        ORDER BY m.mushaf_id
    """).fetchall()
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
               r.full_name AS rawi_full_name, q.qiraa_id, q.short_name AS qiraa_name
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
        SELECT a.service_type, b.book_id, b.name, b.short_name, b.author_name, b.publish_year,
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
            'author_name': r['author_name'], 'publish_year': r['publish_year'],
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

@quran_pedia_bp.route('/ayah/<int:surah_number>/<int:ayah_number>/morphology')
def ayah_morphology(surah_number, ayah_number):
    """Word-by-word breakdown for an ayah — powers click-a-word-to-see-root."""
    conn = get_db()
    words = conn.execute("""
        SELECT id, word_number, word_text, translation, phonetic
        FROM morphology_words WHERE surah_number=? AND ayah_number=? ORDER BY word_number
    """, (surah_number, ayah_number)).fetchall()

    result = []
    for w in words:
        segs = conn.execute("""
            SELECT form, role, pos, inflection, root, lemma, pattern
            FROM morphology_segments WHERE word_id=?
        """, (w['id'],)).fetchall()
        result.append({
            'word_number': w['word_number'], 'word_text': w['word_text'],
            'translation': w['translation'], 'phonetic': w['phonetic'],
            'segments': [dict(s) for s in segs],
        })
    conn.close()
    return jsonify(result)


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
    mushaf_id = request.args.get('mushaf_id', type=int)
    offset = request.args.get('offset', 0, type=int)
    limit = request.args.get('limit', 20, type=int)
    if not q:
        return jsonify({'results': [], 'has_more': False})
    conn = get_db()
    q_norm = normalize_arabic(q)

    # snippet() can't be combined with GROUP BY (breaks FTS5's per-match row context),
    # so when no mushaf is specified we search within a single default mushaf (the
    # lowest mushaf_id that actually has ayah text) instead of grouping across all of them.
    if not mushaf_id:
        default_row = conn.execute("SELECT MIN(mushaf_id) AS m FROM ayahs").fetchone()
        mushaf_id = default_row['m'] if default_row else None

    if not mushaf_id:
        conn.close()
        return jsonify({'results': [], 'has_more': False})

    rows = conn.execute("""
        SELECT a.surah_number, a.ayah_number, a.text, s.name AS surah_name,
               snippet(ayahs_fts, 0, '<mark>', '</mark>', '…', 20) AS snippet
        FROM ayahs_fts f JOIN ayahs a ON a.id = f.rowid
        JOIN surahs s ON s.surah_number = a.surah_number
        WHERE f.text_normalized MATCH ? AND a.mushaf_id = ?
        ORDER BY a.surah_number, a.ayah_number LIMIT ? OFFSET ?
    """, (q_norm, mushaf_id, limit + 1, offset)).fetchall()
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
               snippet(book_content_fts, 0, '<mark>', '</mark>', '…', 20) AS snippet
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
    results = [dict(r) for r in rows[:limit]]
    return jsonify({'results': results, 'has_more': has_more})


# ---------- normalize_arabic (kept local to this blueprint, per project convention) ----------

import re
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
