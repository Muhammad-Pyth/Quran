# ═══════════════════════════════════════════════════════════════
#  HADITH KNOWLEDGE GRAPH  (hadith-kg.db)
#
#  Self-contained Flask Blueprint for the "الحديث" feature — replaces the
#  old narrators.db-based "الرواة" panel entirely (that DB/routes/frontend
#  section have been removed from app.py; see app.py's history for the
#  removed NARRATOR SEARCH block).
#
#  Kept as its own file rather than folded into app.py: this is a large,
#  self-contained dataset (12 tables, 715K hadiths) with its own DB file,
#  and keeping it separate avoids growing an already-long app.py further.
#  Text-normalization / FTS-query-building helpers (normalize_arabic,
#  build_fts_match, escape_like) are still defined once in app.py and are
#  imported here at call time (inside each function, not at module import
#  time) specifically to avoid a circular import — app.py imports this
#  blueprint, so this module cannot import from app.py at the top level.
#
#  DB is opened read-only per request (short-lived sqlite3 connections,
#  same pattern as the rest of the app) — hadith-kg.db is a static,
#  pre-built dataset; this blueprint never writes to it.
# ═══════════════════════════════════════════════════════════════

import sqlite3
from pathlib import Path
from flask import Blueprint, jsonify, request

BASE_DIR = Path(__file__).resolve().parent
HADITH_KG_DB_PATH = (BASE_DIR / 'hadith-kg.db').resolve()

hadith_kg_bp = Blueprint('hadith_kg', __name__, url_prefix='/api/hk')

# Hukm (grading) code -> Arabic label, for matn_no filters coming from the
# frontend as plain integers (0=صحيح 1=حسن 2=ضعيف 3=شديد الضعف ...). The
# actual label text already lives in hadiths.matn/sanads.matn per-row, so
# this is only needed where a route accepts a numeric filter param.
HUKM_LABELS = {0: 'صحيح', 1: 'حسن', 2: 'ضعيف', 3: 'شديد الضعف'}

TYPE_LABELS = {0: 'قدسي', 1: 'مرفوع', 2: 'موقوف', 3: 'مقطوع'}


def _conn():
    # sqlite3's file: URI mode requires forward slashes and a file:///
    # prefix on Windows — a bare str(Path) on Windows renders with
    # backslashes (C:\Apps\...), which the URI parser silently fails to
    # open ("unable to open database file") even though the file exists.
    db_uri = HADITH_KG_DB_PATH.as_uri()  # -> file:///C:/Apps/Shamela/hadith-kg.db on Windows, file:///... on POSIX
    conn = sqlite3.connect(f'{db_uri}?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _clamp_int(value, default, max_value, min_value=0):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(min_value, min(n, max_value))


def _fts_helpers():
    # Deferred import — see module docstring for why this isn't at top level.
    from app import normalize_arabic, build_fts_match, escape_like
    return normalize_arabic, build_fts_match, escape_like


def _row_to_dict(row):
    return dict(row) if row is not None else None


# ═══════════════════════════════════════════════════════════════
#  SEARCH
# ═══════════════════════════════════════════════════════════════

@hadith_kg_bp.route('/meta/ranks')
def meta_ranks():
    """Distinct narrator reliability ranks present in the data, ordered by
    rank_no — used to populate the rank filter dropdown on the rawi search
    tab (previously hardcoded to a single non-functional 'الكل' option)."""
    conn = _conn()
    c = conn.cursor()
    c.execute("""
        SELECT DISTINCT rank_no, rank FROM rawis
        WHERE rank IS NOT NULL AND rank != ''
        ORDER BY rank_no
    """)
    ranks = [{'rankNo': r['rank_no'], 'rank': r['rank']} for r in c.fetchall()]
    conn.close()
    return jsonify({'ranks': ranks})


@hadith_kg_bp.route('/search/alems')
def search_alems():
    """Critic (alem) name search — by shuhra/name/laqab. Also used with an
    empty query to browse the full (small, ~1015-row) list."""
    q = (request.args.get('q') or '').strip()
    limit = _clamp_int(request.args.get('limit'), 30, 200)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)

    conn = _conn()
    c = conn.cursor()
    sql = "SELECT id, name, nickname, shuhra, laqab, tabaka, death_year, aqwal_qty FROM alems WHERE 1=1"
    params = []
    if q:
        sql += " AND (shuhra LIKE ? OR name LIKE ? OR laqab LIKE ?)"
        like = f"%{q}%"
        params += [like, like, like]
    sql += " ORDER BY aqwal_qty DESC LIMIT ? OFFSET ?"
    params += [limit + 1, offset]

    c.execute(sql, params)
    rows = c.fetchall()
    conn.close()

    has_more = len(rows) > limit
    rows = rows[:limit]
    hits = [{
        'alemId': r['id'], 'name': r['name'], 'nickname': r['nickname'], 'shuhra': r['shuhra'],
        'laqab': r['laqab'], 'tabaka': r['tabaka'], 'deathYear': r['death_year'], 'aqwalQty': r['aqwal_qty'],
    } for r in rows]
    return jsonify({'hits': hits, 'hasMore': has_more})


@hadith_kg_bp.route('/search/books')
def search_books():
    """Book name/author search — also used with an empty query to browse
    the full (small, 425-row) list."""
    q = (request.args.get('q') or '').strip()
    limit = _clamp_int(request.args.get('limit'), 30, 500)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)

    conn = _conn()
    c = conn.cursor()
    sql = "SELECT id, name, author_name, tasnif, hadith_qty FROM books WHERE 1=1"
    params = []
    if q:
        sql += " AND (name LIKE ? OR author_name LIKE ?)"
        like = f"%{q}%"
        params += [like, like]
    sql += " ORDER BY id LIMIT ? OFFSET ?"
    params += [limit + 1, offset]

    c.execute(sql, params)
    rows = c.fetchall()
    conn.close()

    has_more = len(rows) > limit
    rows = rows[:limit]
    hits = [{
        'bookId': r['id'], 'name': r['name'], 'authorName': r['author_name'],
        'tasnif': r['tasnif'], 'hadithQty': r['hadith_qty'],
    } for r in rows]
    return jsonify({'hits': hits, 'hasMore': has_more})


@hadith_kg_bp.route('/search/hadiths')
def search_hadiths():
    """FTS5 search over hadiths.nass, with optional hukm/type/book filters."""
    normalize_arabic, build_fts_match, _ = _fts_helpers()

    q = (request.args.get('q') or '').strip()
    limit = _clamp_int(request.args.get('limit'), 30, 100)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
    hukm = request.args.get('hukm')       # matn_no, optional
    htype = request.args.get('type')      # type_no, optional
    book_id = request.args.get('book_id')  # optional

    if not q:
        return jsonify({'hits': [], 'hasMore': False})

    match_expr = build_fts_match(normalize_arabic(q), prefix=True)
    if not match_expr:
        return jsonify({'hits': [], 'hasMore': False})

    conn = _conn()
    c = conn.cursor()

    sql = """
        SELECT h.id, h.book_id, b.name AS book_name, h.no_inbook, h.taraf_nass,
               h.matn_no, h.matn, h.type_no, h.type, h.group_id
        FROM hadiths_fts f
        JOIN hadiths h ON h.id = f.rowid
        JOIN books b ON b.id = h.book_id
        WHERE hadiths_fts MATCH ?
    """
    params = [match_expr]
    if hukm is not None and hukm != '':
        sql += " AND h.matn_no = ?"
        params.append(int(hukm))
    if htype is not None and htype != '':
        sql += " AND h.type_no = ?"
        params.append(int(htype))
    if book_id is not None and book_id != '':
        sql += " AND h.book_id = ?"
        params.append(int(book_id))
    sql += " ORDER BY rank LIMIT ? OFFSET ?"
    params.append(limit + 1)  # fetch one extra to detect "more available"
    params.append(offset)

    try:
        c.execute(sql, params)
        rows = c.fetchall()
    except sqlite3.OperationalError:
        conn.close()
        return jsonify({'hits': [], 'hasMore': False})

    has_more = len(rows) > limit
    rows = rows[:limit]
    hits = [{
        'hadithId': r['id'], 'bookId': r['book_id'], 'bookName': r['book_name'],
        'noInBook': r['no_inbook'], 'taraf': r['taraf_nass'],
        'hukm': r['matn'], 'hukmNo': r['matn_no'],
        'type': r['type'], 'typeNo': r['type_no'], 'groupId': r['group_id'],
    } for r in rows]
    conn.close()
    return jsonify({'hits': hits, 'hasMore': has_more})


@hadith_kg_bp.route('/search/groups')
def search_groups():
    """FTS5 search over meaning_groups.nass (canonical meaning text)."""
    normalize_arabic, build_fts_match, _ = _fts_helpers()

    q = (request.args.get('q') or '').strip()
    limit = _clamp_int(request.args.get('limit'), 30, 100)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
    if not q:
        return jsonify({'hits': [], 'hasMore': False})

    match_expr = build_fts_match(normalize_arabic(q), prefix=True)
    if not match_expr:
        return jsonify({'hits': [], 'hasMore': False})

    conn = _conn()
    c = conn.cursor()
    try:
        c.execute("""
            SELECT g.id, g.nass, g.matn_no, g.is_qudsi, g.sahaba_qty, g.repeat_qty
            FROM meaning_groups_fts f
            JOIN meaning_groups g ON g.id = f.rowid
            WHERE meaning_groups_fts MATCH ?
            ORDER BY rank LIMIT ? OFFSET ?
        """, (match_expr, limit + 1, offset))
        rows = c.fetchall()
    except sqlite3.OperationalError:
        conn.close()
        return jsonify({'hits': [], 'hasMore': False})

    has_more = len(rows) > limit
    rows = rows[:limit]
    hits = []
    for r in rows:
        c.execute("SELECT COUNT(DISTINCT book_id) n FROM hadiths WHERE group_id = ?", (r['id'],))
        book_count = c.fetchone()['n']
        hits.append({
            'groupId': r['id'], 'nass': r['nass'], 'hukmNo': r['matn_no'],
            'isQudsi': bool(r['is_qudsi']), 'sahabaQty': r['sahaba_qty'],
            'repeatQty': r['repeat_qty'], 'bookCount': book_count,
        })
    conn.close()
    return jsonify({'hits': hits, 'hasMore': has_more})


@hadith_kg_bp.route('/search/rawis')
def search_rawis():
    """Narrator name search (indexed columns) with reliability/era/book filters."""
    q = (request.args.get('q') or '').strip()
    limit = _clamp_int(request.args.get('limit'), 30, 100)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
    rank_no = request.args.get('rank_no')
    tabaka = request.args.get('tabaka')
    is_bukhari = request.args.get('is_bukhari')
    is_muslim = request.args.get('is_muslim')

    conn = _conn()
    c = conn.cursor()

    sql = "SELECT id, name, nickname, rank_no, rank, tabaka, is_bukhari, is_muslim, " \
          "has_ikhtilat, has_tadlis, riwaya_qty, death_year, death_year_raw " \
          "FROM rawis WHERE 1=1"
    params = []
    if q:
        sql += " AND (name LIKE ? OR nickname LIKE ?)"
        like = f"%{q}%"
        params += [like, like]
    if rank_no:
        sql += " AND rank_no = ?"
        params.append(int(rank_no))
    if tabaka:
        sql += " AND tabaka = ?"
        params.append(int(tabaka))
    if is_bukhari == '1':
        sql += " AND is_bukhari = 1"
    if is_muslim == '1':
        sql += " AND is_muslim = 1"
    sql += " ORDER BY riwaya_qty DESC LIMIT ? OFFSET ?"
    params.append(limit + 1)
    params.append(offset)

    if not q and not any([rank_no, tabaka, is_bukhari, is_muslim]):
        conn.close()
        return jsonify({'hits': [], 'hasMore': False})

    c.execute(sql, params)
    rows = c.fetchall()
    conn.close()

    has_more = len(rows) > limit
    rows = rows[:limit]
    hits = [{
        'rawiId': r['id'], 'name': r['name'], 'nickname': r['nickname'],
        'rank': r['rank'], 'rankNo': r['rank_no'], 'tabaka': r['tabaka'],
        'isBukhari': bool(r['is_bukhari']), 'isMuslim': bool(r['is_muslim']),
        'hasIkhtilat': bool(r['has_ikhtilat']), 'hasTadlis': bool(r['has_tadlis']),
        'riwayaQty': r['riwaya_qty'],
        'deathYear': r['death_year'] if r['death_year'] is not None else r['death_year_raw'],
    } for r in rows]
    return jsonify({'hits': hits, 'hasMore': has_more})


@hadith_kg_bp.route('/search/topics')
def search_topics():
    normalize_arabic, build_fts_match, _ = _fts_helpers()
    q = (request.args.get('q') or '').strip()
    limit = _clamp_int(request.args.get('limit'), 30, 100)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
    if not q:
        return jsonify({'hits': [], 'hasMore': False})

    match_expr = build_fts_match(normalize_arabic(q), prefix=True)
    if not match_expr:
        return jsonify({'hits': [], 'hasMore': False})

    conn = _conn()
    c = conn.cursor()
    try:
        c.execute("""
            SELECT t.id, t.name, t.level, t.parent_id, t.group_id
            FROM topics_fts f JOIN topics t ON t.id = f.rowid
            WHERE topics_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?
        """, (match_expr, limit + 1, offset))
        rows = c.fetchall()
    except sqlite3.OperationalError:
        conn.close()
        return jsonify({'hits': [], 'hasMore': False})
    conn.close()

    has_more = len(rows) > limit
    rows = rows[:limit]
    hits = [{
        'topicId': r['id'], 'name': r['name'], 'level': r['level'],
        'parentId': r['parent_id'], 'groupId': r['group_id'],
    } for r in rows]
    return jsonify({'hits': hits, 'hasMore': has_more})


@hadith_kg_bp.route('/search/aqwal')
def search_aqwal():
    """Critic (jarh wa ta'dil) statement search."""
    normalize_arabic, build_fts_match, _ = _fts_helpers()
    q = (request.args.get('q') or '').strip()
    limit = _clamp_int(request.args.get('limit'), 30, 100)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
    if not q:
        return jsonify({'hits': [], 'hasMore': False})

    match_expr = build_fts_match(normalize_arabic(q), prefix=True)
    if not match_expr:
        return jsonify({'hits': [], 'hasMore': False})

    conn = _conn()
    c = conn.cursor()
    try:
        c.execute("""
            SELECT q.id, q.qawl, q.rawi_id, r.nickname AS rawi_name,
                   q.alem_id, a.shuhra AS alem_name
            FROM aqwal_fts f
            JOIN aqwal q ON q.id = f.rowid
            JOIN rawis r ON r.id = q.rawi_id
            JOIN alems a ON a.id = q.alem_id
            WHERE aqwal_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?
        """, (match_expr, limit + 1, offset))
        rows = c.fetchall()
    except sqlite3.OperationalError:
        conn.close()
        return jsonify({'hits': [], 'hasMore': False})
    conn.close()

    has_more = len(rows) > limit
    rows = rows[:limit]
    hits = [{
        'aqwalId': r['id'], 'qawl': r['qawl'],
        'rawiId': r['rawi_id'], 'rawiName': r['rawi_name'],
        'alemId': r['alem_id'], 'alemName': r['alem_name'],
    } for r in rows]
    return jsonify({'hits': hits, 'hasMore': has_more})


# ═══════════════════════════════════════════════════════════════
#  DETAIL PAGES
# ═══════════════════════════════════════════════════════════════

@hadith_kg_bp.route('/hadith/<int:hadith_id>')
def hadith_detail(hadith_id):
    conn = _conn()
    c = conn.cursor()
    c.execute("""
        SELECT h.*, b.name AS book_name, b.author_name
        FROM hadiths h JOIN books b ON b.id = h.book_id
        WHERE h.id = ?
    """, (hadith_id,))
    row = c.fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'not found'}), 404

    c.execute("SELECT id, matn_no, matn, hukum, max_rank, length FROM sanads WHERE hadith_id = ?", (hadith_id,))
    sanad_rows = c.fetchall()

    sanads = []
    for s in sanad_rows:
        c.execute("""
            SELECT sr.pos, sr.rawi_id, r.nickname, r.rank, r.tabaka, r.is_bukhari, r.is_muslim
            FROM sanad_rawis sr LEFT JOIN rawis r ON r.id = sr.rawi_id
            WHERE sr.sanad_id = ? ORDER BY sr.pos DESC
        """, (s['id'],))
        chain = [{
            'pos': cr['pos'], 'rawiId': cr['rawi_id'],
            'name': cr['nickname'], 'rank': cr['rank'], 'tabaka': cr['tabaka'],
            'isBukhari': bool(cr['is_bukhari']) if cr['rawi_id'] else False,
            'isMuslim': bool(cr['is_muslim']) if cr['rawi_id'] else False,
        } for cr in c.fetchall()]
        sanads.append({
            'sanadId': s['id'], 'hukmNo': s['matn_no'], 'hukm': s['matn'],
            'hukmSentence': s['hukum'], 'maxRank': s['max_rank'],
            'length': s['length'], 'chain': chain,
        })

    conn.close()
    return jsonify({
        'hadithId': row['id'], 'bookId': row['book_id'], 'bookName': row['book_name'],
        'authorName': row['author_name'], 'noInBook': row['no_inbook'],
        'pageNo': row['page_no'], 'typeNo': row['type_no'], 'type': row['type'],
        'hukmNo': row['matn_no'], 'hukm': row['matn'], 'groupId': row['group_id'],
        'taraf': row['taraf_nass'], 'nass': row['nass'], 'sanads': sanads,
    })


@hadith_kg_bp.route('/group/<int:group_id>')
def group_detail(group_id):
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM meaning_groups WHERE id = ?", (group_id,))
    g = c.fetchone()
    if not g:
        conn.close()
        return jsonify({'error': 'not found'}), 404

    limit = _clamp_int(request.args.get('limit'), 30, 200)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)

    taraf = None
    if g['taraf_id']:
        c.execute("SELECT nass FROM tarafs WHERE id = ?", (g['taraf_id'],))
        tr = c.fetchone()
        if tr:
            taraf = tr['nass']

    c.execute("""
        SELECT h.id, h.book_id, b.name AS book_name, h.no_inbook, h.taraf_nass,
               h.matn_no, h.matn, h.type_no, h.type
        FROM hadiths h JOIN books b ON b.id = h.book_id
        WHERE h.group_id = ?
        ORDER BY h.book_id, h.no_inbook LIMIT ? OFFSET ?
    """, (group_id, limit, offset))
    narrations = [{
        'hadithId': r['id'], 'bookId': r['book_id'], 'bookName': r['book_name'],
        'noInBook': r['no_inbook'], 'taraf': r['taraf_nass'],
        'hukm': r['matn'], 'hukmNo': r['matn_no'], 'type': r['type'], 'typeNo': r['type_no'],
    } for r in c.fetchall()]

    conn.close()
    return jsonify({
        'groupId': g['id'], 'nass': g['nass'], 'taraf': taraf, 'hukmNo': g['matn_no'],
        'isQudsi': bool(g['is_qudsi']), 'sahabaQty': g['sahaba_qty'],
        'repeatQty': g['repeat_qty'], 'narrations': narrations,
        'hasMore': len(narrations) == limit,
    })


@hadith_kg_bp.route('/group/<int:group_id>/tree')
def group_tree(group_id):
    """Isnad tree: every sanad of this meaning group merged into one
    weighted DAG (nodes = narrators incl. a virtual Prophet root, edges =
    transmission links with a count of how many chains share that link),
    plus automatic مدار الحديث (madar) detection — the narrator through
    whom the most independent chains converge as a middle link.

    Algorithm ported directly from the reference implementation studied
    during planning (emadjumaah/hadith, js/server/server.mjs): one query
    pulls every (sanad_id, pos, rawi_id) row for the group; rows are
    regrouped into per-sanad chains; each chain is walked in transmission
    order (Prophet -> sahabi -> ... -> book author) building a shared
    node/edge map with per-node position tallies (sahabi/author/middle
    counts); the madar is whichever non-Prophet, non-sahabi, non-break
    node has the highest middle-position count (>1, i.e. a genuine
    convergence point, not a one-off).

    ?sahabi=<rawiId> optionally restricts the merge to only chains that
    pass through that specific companion.
    """
    conn = _conn()
    c = conn.cursor()
    c.execute("""
        SELECT s.id AS sanad_id, s.matn AS grade, sr.pos, sr.rawi_id,
               r.nickname, r.rank, r.tabaka
        FROM sanads s
        JOIN sanad_rawis sr ON sr.sanad_id = s.id
        JOIN rawis r ON r.id = sr.rawi_id
        WHERE s.group_id = ?
        ORDER BY s.id, sr.pos
    """, (group_id,))
    rows = c.fetchall()
    conn.close()

    if not rows:
        return jsonify({'error': 'not found'}), 404

    sahabi_filter = request.args.get('sahabi')
    sahabi_filter = int(sahabi_filter) if sahabi_filter else None

    chains = {}
    for r in rows:
        chains.setdefault(r['sanad_id'], {'grade': r['grade'], 'rawis': []})['rawis'].append(r)

    PROPHET = 0
    nodes = {PROPHET: {'rawiId': PROPHET, 'name': 'النبي ﷺ', 'role': 'prophet',
                        'count': 0, 'depthSum': 0, 'sahabiCount': 0, 'authorCount': 0, 'middleCount': 0,
                        'sanadIds': set()}}
    edges = {}
    used = 0

    for sanad_id, chain in chains.items():
        rw = chain['rawis']  # ascending pos: 0 = author ... last = sahabi
        last = rw[-1]
        if sahabi_filter and last['rawi_id'] != sahabi_filter:
            continue
        used += 1

        # transmission order: Prophet -> sahabi (last) -> ... -> author (pos 0)
        seq = [{'rawi_id': PROPHET, 'nickname': None, 'rank': None, 'tabaka': None}] + list(reversed(rw))

        for i, r in enumerate(seq):
            rid = r['rawi_id']
            n = nodes.get(rid)
            if n is None:
                n = {'rawiId': rid, 'name': r['nickname'], 'rank': r['rank'],
                     'tabaka': r['tabaka'], 'role': 'rawi',
                     'count': 0, 'depthSum': 0, 'sahabiCount': 0, 'authorCount': 0, 'middleCount': 0,
                     'sanadIds': set()}
                nodes[rid] = n
            n['count'] += 1
            n['depthSum'] += i
            n['sanadIds'].add(sanad_id)
            if i == 1:
                n['sahabiCount'] += 1
            elif i == len(seq) - 1:
                n['authorCount'] += 1
            elif i > 1:
                n['middleCount'] += 1

            if i > 0:
                prev_id = seq[i - 1]['rawi_id']
                key = (prev_id, rid)
                e = edges.get(key)
                if e is None:
                    e = {'from': prev_id, 'to': rid, 'count': 0, 'sanadIds': set()}
                    edges[key] = e
                e['count'] += 1
                e['sanadIds'].add(sanad_id)

    import re as _re
    BREAK_RE = _re.compile(r'موضع (انقطاع|ارسال|إرسال|تعليق|إعضال)|مبهم|غير معرف')

    def _is_break(name):
        return bool(name) and bool(BREAK_RE.search(name))

    node_list = []
    for n in nodes.values():
        if n['role'] == 'prophet':
            role = 'prophet'
        elif _is_break(n.get('name')):
            role = 'break'
        elif n['sahabiCount'] > 0:
            role = 'sahabi'
        elif n['middleCount'] > 0:
            role = 'rawi'
        else:
            role = 'author'
        node_list.append({
            'rawiId': n['rawiId'], 'name': n['name'], 'rank': n.get('rank'),
            'tabaka': n.get('tabaka'), 'role': role, 'count': n['count'],
            'depth': (n['depthSum'] / n['count']) if n['count'] else 0,
            'sahabiCount': n['sahabiCount'], 'authorCount': n['authorCount'],
            'middleCount': n['middleCount'],
            # Which specific chains this narrator belongs to — needed by the
            # frontend to trace only the clicked narrator's own route(s),
            # rather than walking the whole merged graph. Without this, a
            # narrator who happens to appear in two otherwise-unrelated
            # chains becomes a "bridge" that a naive graph walk leaks
            # through, highlighting nodes from a completely different chain.
            'sanadIds': sorted(n['sanadIds']),
        })

    candidates = [n for n in node_list
                  if n['role'] not in ('prophet', 'break', 'sahabi') and n['middleCount'] > 1]
    madar = max(candidates, key=lambda n: n['middleCount']) if candidates else None

    sahabis = sorted(
        [n for n in node_list if n['role'] == 'sahabi'],
        key=lambda n: -n['count']
    )

    return jsonify({
        'groupId': group_id, 'chains': used, 'totalChains': len(chains),
        'nodes': node_list,
        'edges': [{'from': f, 'to': t, 'count': e['count'], 'sanadIds': sorted(e['sanadIds'])}
                  for (f, t), e in edges.items()],
        'madar': ({'rawiId': madar['rawiId'], 'name': madar['name'], 'count': madar['middleCount']}
                   if madar else None),
        'sahabis': [{'rawiId': s['rawiId'], 'name': s['name'], 'count': s['count']} for s in sahabis],
    })


@hadith_kg_bp.route('/rawi/<int:rawi_id>')
def rawi_detail(rawi_id):
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM rawis WHERE id = ?", (rawi_id,))
    r = c.fetchone()
    if not r:
        conn.close()
        return jsonify({'error': 'not found'}), 404

    c.execute("""
        SELECT COUNT(DISTINCT sanad_id) n FROM sanad_rawis WHERE rawi_id = ?
    """, (rawi_id,))
    chain_count = c.fetchone()['n']

    c.execute("""
        SELECT COUNT(DISTINCT s.hadith_id) n
        FROM sanad_rawis sr JOIN sanads s ON s.id = sr.sanad_id
        WHERE sr.rawi_id = ?
    """, (rawi_id,))
    hadith_count = c.fetchone()['n']

    # Teachers: the narrator one position closer to the Prophet (pos + 1).
    # Students: the narrator one position closer to the book author (pos - 1).
    # pos=0 is the book author, ascending toward the companion (per schema).
    c.execute("""
        SELECT b.rawi_id AS id, r2.nickname AS name, r2.rank, r2.tabaka, COUNT(*) AS n
        FROM sanad_rawis a JOIN sanad_rawis b ON b.sanad_id = a.sanad_id AND b.pos = a.pos + 1
        JOIN rawis r2 ON r2.id = b.rawi_id
        WHERE a.rawi_id = ? AND a.pos > 0
        GROUP BY b.rawi_id ORDER BY n DESC LIMIT 15
    """, (rawi_id,))
    teachers = [{'rawiId': t['id'], 'name': t['name'], 'rank': t['rank'], 'tabaka': t['tabaka'], 'count': t['n']}
                for t in c.fetchall()]

    c.execute("""
        SELECT b.rawi_id AS id, r2.nickname AS name, r2.rank, r2.tabaka, COUNT(*) AS n
        FROM sanad_rawis a JOIN sanad_rawis b ON b.sanad_id = a.sanad_id AND b.pos = a.pos - 1
        JOIN rawis r2 ON r2.id = b.rawi_id
        WHERE a.rawi_id = ? AND b.pos > 0
        GROUP BY b.rawi_id ORDER BY n DESC LIMIT 15
    """, (rawi_id,))
    students = [{'rawiId': s['id'], 'name': s['name'], 'rank': s['rank'], 'tabaka': s['tabaka'], 'count': s['n']}
                for s in c.fetchall()]

    c.execute("""
        SELECT q.id, q.qawl, q.alem_id, a.shuhra AS alem_name
        FROM aqwal q JOIN alems a ON a.id = q.alem_id
        WHERE q.rawi_id = ? ORDER BY q.id
    """, (rawi_id,))
    aqwal = [{'aqwalId': a['id'], 'qawl': a['qawl'], 'alemId': a['alem_id'], 'alemName': a['alem_name']}
             for a in c.fetchall()]

    conn.close()
    return jsonify({
        'rawiId': r['id'], 'name': r['name'], 'nickname': r['nickname'],
        'rank': r['rank'], 'rankNo': r['rank_no'], 'tabaka': r['tabaka'],
        'isBukhari': bool(r['is_bukhari']), 'isMuslim': bool(r['is_muslim']),
        'hasIkhtilat': bool(r['has_ikhtilat']), 'hasTadlis': bool(r['has_tadlis']),
        'isStub': bool(r['is_stub']), 'riwayaQty': r['riwaya_qty'],
        'birthYear': r['birth_year'] if r['birth_year'] is not None else r['birth_year_raw'],
        'deathYear': r['death_year'] if r['death_year'] is not None else r['death_year_raw'],
        'deathPlace': r['death_place'], 'profession': r['profession'],
        'nasab': r['nasab'], 'iqama': r['iqama'],
        'chainCount': chain_count, 'hadithCount': hadith_count,
        'teachers': teachers, 'students': students, 'aqwal': aqwal,
    })


@hadith_kg_bp.route('/rawi/<int:rawi_id>/hadiths')
def rawi_hadiths(rawi_id):
    limit = _clamp_int(request.args.get('limit'), 20, 100)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)

    conn = _conn()
    c = conn.cursor()
    c.execute("""
        SELECT DISTINCT h.id, h.book_id, b.name AS book_name, h.no_inbook,
               h.taraf_nass, h.matn_no, h.matn, h.type
        FROM sanad_rawis sr
        JOIN sanads s ON s.id = sr.sanad_id
        JOIN hadiths h ON h.id = s.hadith_id
        JOIN books b ON b.id = h.book_id
        WHERE sr.rawi_id = ? AND sr.pos > 0
        ORDER BY h.id LIMIT ? OFFSET ?
    """, (rawi_id, limit + 1, offset))
    rows = c.fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    hadiths = [{
        'hadithId': r['id'], 'bookId': r['book_id'], 'bookName': r['book_name'],
        'noInBook': r['no_inbook'], 'taraf': r['taraf_nass'],
        'hukm': r['matn'], 'hukmNo': r['matn_no'], 'type': r['type'],
    } for r in rows]
    conn.close()
    return jsonify({'hadiths': hadiths, 'hasMore': has_more})


@hadith_kg_bp.route('/alem/<int:alem_id>')
def alem_detail(alem_id):
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM alems WHERE id = ?", (alem_id,))
    a = c.fetchone()
    if not a:
        conn.close()
        return jsonify({'error': 'not found'}), 404

    limit = _clamp_int(request.args.get('limit'), 50, 500)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
    c.execute("""
        SELECT q.id, q.rawi_id, r.nickname AS rawi_name, q.qawl
        FROM aqwal q JOIN rawis r ON r.id = q.rawi_id
        WHERE q.alem_id = ? ORDER BY q.id LIMIT ? OFFSET ?
    """, (alem_id, limit + 1, offset))
    rows = c.fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    aqwal = [{'aqwalId': r['id'], 'rawiId': r['rawi_id'], 'rawiName': r['rawi_name'], 'qawl': r['qawl']}
              for r in rows]
    conn.close()

    return jsonify({
        'alemId': a['id'], 'name': a['name'], 'nickname': a['nickname'],
        'shuhra': a['shuhra'], 'laqab': a['laqab'], 'tabaka': a['tabaka'],
        'deathYear': a['death_year'], 'rank': a['rank'], 'rankNo': a['rank_no'],
        'aqwalQty': a['aqwal_qty'], 'notes': a['notes'], 'aqwal': aqwal, 'hasMore': has_more,
    })


@hadith_kg_bp.route('/book/<int:book_id>')
def book_detail(book_id):
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM books WHERE id = ?", (book_id,))
    b = c.fetchone()
    if not b:
        conn.close()
        return jsonify({'error': 'not found'}), 404

    limit = _clamp_int(request.args.get('limit'), 30, 200)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
    c.execute("""
        SELECT id, no_inbook, taraf_nass, matn_no, matn, type
        FROM hadiths WHERE book_id = ? ORDER BY no_inbook LIMIT ? OFFSET ?
    """, (book_id, limit + 1, offset))
    rows = c.fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    hadiths = [{
        'hadithId': r['id'], 'noInBook': r['no_inbook'], 'taraf': r['taraf_nass'],
        'hukm': r['matn'], 'hukmNo': r['matn_no'], 'type': r['type'],
    } for r in rows]
    conn.close()

    return jsonify({
        'bookId': b['id'], 'name': b['name'], 'authorName': b['author_name'],
        'authorDeathYear': b['author_death_year'], 'city': b['city'], 'dar': b['dar'],
        'tabaa': b['tabaa'], 'tasnif': b['tasnif'], 'hadithQty': b['hadith_qty'],
        'hadiths': hadiths, 'hasMore': has_more,
    })


@hadith_kg_bp.route('/topics')
def topics_list():
    """Root topics (level 0) by default, or children of ?parent=<id>."""
    conn = _conn()
    c = conn.cursor()
    limit = _clamp_int(request.args.get('limit'), 200, 1000)
    offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
    parent = request.args.get('parent')
    if parent:
        c.execute("SELECT id, name, level, parent_id, group_id FROM topics WHERE parent_id = ? ORDER BY lft LIMIT ? OFFSET ?", (int(parent), limit + 1, offset))
    else:
        c.execute("SELECT id, name, level, parent_id, group_id FROM topics WHERE level = 0 ORDER BY lft LIMIT ? OFFSET ?", (limit + 1, offset))
    rows = c.fetchall()
    conn.close()
    has_more = len(rows) > limit
    rows = rows[:limit]
    topics = [{
        'topicId': r['id'], 'name': r['name'], 'level': r['level'],
        'parentId': r['parent_id'], 'groupId': r['group_id'],
    } for r in rows]
    return jsonify({'topics': topics, 'hasMore': has_more})


@hadith_kg_bp.route('/topic/<int:topic_id>')
def topic_detail(topic_id):
    conn = _conn()
    c = conn.cursor()
    c.execute("SELECT * FROM topics WHERE id = ?", (topic_id,))
    t = c.fetchone()
    if not t:
        conn.close()
        return jsonify({'error': 'not found'}), 404

    c.execute("SELECT id, name, level, parent_id, group_id FROM topics WHERE parent_id = ? ORDER BY lft", (topic_id,))
    children = [{
        'topicId': r['id'], 'name': r['name'], 'level': r['level'],
        'parentId': r['parent_id'], 'groupId': r['group_id'],
    } for r in c.fetchall()]

    group = None
    narrations = []
    if t['group_id'] is not None:
        c.execute("SELECT * FROM meaning_groups WHERE id = ?", (t['group_id'],))
        g = c.fetchone()
        if g:
            group = {'groupId': g['id'], 'nass': g['nass'], 'hukmNo': g['matn_no']}
            limit = _clamp_int(request.args.get('limit'), 30, 200)
            offset = _clamp_int(request.args.get('offset'), 0, 10_000_000)
            c.execute("""
                SELECT h.id, h.book_id, b.name AS book_name, h.no_inbook, h.taraf_nass, h.matn
                FROM hadiths h JOIN books b ON b.id = h.book_id
                WHERE h.group_id = ? ORDER BY h.book_id, h.no_inbook LIMIT ? OFFSET ?
            """, (t['group_id'], limit + 1, offset))
            rows = c.fetchall()
            narrations_has_more = len(rows) > limit
            rows = rows[:limit]
            narrations = [{
                'hadithId': r['id'], 'bookId': r['book_id'], 'bookName': r['book_name'],
                'noInBook': r['no_inbook'], 'taraf': r['taraf_nass'], 'hukm': r['matn'],
            } for r in rows]
        else:
            narrations_has_more = False
    else:
        narrations_has_more = False

    conn.close()
    return jsonify({
        'topicId': t['id'], 'name': t['name'], 'level': t['level'], 'parentId': t['parent_id'],
        'children': children, 'group': group, 'narrations': narrations, 'hasMore': narrations_has_more,
    })
