import time
import re
import json
import math
import html as html_module
import sqlite3
import configparser
import os
import sys
import threading
import subprocess
import collections
from datetime import datetime
from pathlib import Path
from flask import Flask, render_template, jsonify, request
from bs4 import BeautifulSoup, NavigableString
import requests

try:
    import sqlite_vec
    VEC_AVAILABLE = True
except ImportError:
    VEC_AVAILABLE = False
    print("[WARN] sqlite-vec not installed — semantic search will fall back to "
          "the slower brute-force cosine loop. Run: pip install sqlite-vec")

app = Flask(__name__)

# Hadith knowledge graph feature ("الحديث" button/modal) — self-contained
# blueprint over hadith-kg.db, replacing the old narrators.db-based
# "الرواة" panel. Kept in its own file (hadith_kg.py) rather than inline
# here, since it's a large, independent dataset/feature set. See
# hadith_kg.py's module docstring for why it imports helpers from this
# file at call time rather than at the top of that module.
from hadith_kg import hadith_kg_bp
app.register_blueprint(hadith_kg_bp)

# ═══════════════════════════════════════════════════════════════
# CONSOLE LOG CAPTURE (for the in-browser log panel — see /api/logs
# below and setupLogPanel() in app.js). Everything that would normally
# only be visible in the server's own console window (startup messages,
# [INFO]/[WARN] lines, Flask's request logs, tracebacks) gets mirrored
# into a small, size-capped in-memory buffer that the browser polls.
#
# Design notes:
# - Each captured line gets an increasing sequence number rather than
#   being addressed by buffer position, so /api/logs?since=N is safe
#   even though old lines fall off the deque's left side over a long
#   session — the client just asks "anything newer than N?" and never
#   needs to know how the buffer is actually storing things.
# - _LogTee still writes through to the real underlying stream, so if
#   the wrapper window is ever visible (it currently still is — see
#   start_server.bat, left untouched for now), console output continues
#   to look exactly as it always has. Nothing here changes what appears
#   on the actual terminal, only what's *additionally* captured.
# ═══════════════════════════════════════════════════════════════
_LOG_MAX_LINES = 2000  # fallback default; overridden after config is read (see LOG_MAX_LINES_CFG below)
_log_buffer = collections.deque(maxlen=_LOG_MAX_LINES)
_log_lock = threading.Lock()
_log_seq = 0

def _append_log_line(line):
    global _log_seq
    with _log_lock:
        _log_seq += 1
        _log_buffer.append((_log_seq, line))

class _LogTee:
    """A stdout/stderr replacement that passes writes through to the real
    stream untouched, while also splitting them into lines and feeding
    each line into the shared log buffer above."""
    def __init__(self, real_stream):
        self._real = real_stream

    def write(self, text):
        self._real.write(text)
        if text and text.strip('\n'):
            for line in text.splitlines():
                if line == '':
                    continue
                # Werkzeug logs one line per HTTP request it handles,
                # including the log panel's own polling requests to
                # /api/logs — without this filter, every poll would log
                # itself, get captured, and show up in the next poll,
                # which is itself a new request... an endless, useless
                # feedback loop. Every other request (and all real
                # [INFO]/[WARN]/print output) is unaffected.
                if '/api/logs' in line:
                    continue
                _append_log_line(line)

    def flush(self):
        self._real.flush()

    def isatty(self):
        return getattr(self._real, 'isatty', lambda: False)()

# ── Paths ──
BASE_DIR = Path(__file__).resolve().parent

# ── Config ──
config = configparser.ConfigParser()
config.read(BASE_DIR / 'config.ini', encoding='utf-8-sig')
BOOKS_DIR = (BASE_DIR / config.get('settings', 'books_dir', fallback='./books')).resolve()

GEMINI_KEY = config.get('settings', 'gemini_api_key', fallback='')
# 1. READ CHAT MODEL
GEMINI_MODEL = config.get('settings', 'gemini_model', fallback='gemini-2.5-flash')
GEMINI_FALLBACK_MODEL = config.get('settings', 'gemini_model_fallback', fallback='gemini-1.5-flash')

# 2. READ EMBEDDING MODEL
GEMINI_EMBED_MODEL = config.get('settings', 'gemini_embedding_model', fallback='gemini-embedding-2')

# 3. DEFINE SEPARATE URLS
GEMINI_GENERATE_URL_TEMPLATE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GEMINI_EMBED_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_EMBED_MODEL}:batchEmbedContents"

MISTRAL_API_KEY = config.get('settings', 'mistral_api_key', fallback='')
MISTRAL_MODEL = 'mistral-large-latest'

# ── Tunable parameters (all editable in config.ini) ──
ASK_PASSAGE_CHAR_CAP      = config.getint  ('settings', 'passage_char_cap',          fallback=2500)
NEIGHBOR_STITCHING        = config.getboolean('settings', 'neighbor_stitching',      fallback=True)
ASK_TOP_K_CFG             = config.getint  ('settings', 'ask_top_k',                 fallback=300)
EMBED_BATCH_SIZE_CFG      = config.getint  ('settings', 'embed_batch_size',           fallback=100)
EMBED_MAX_CHARS_CFG       = config.getint  ('settings', 'embed_max_chars',            fallback=4000)
EMBED_BATCH_SLEEP_CFG     = config.getint  ('settings', 'embed_batch_sleep',          fallback=60)
EMBED_MAX_RETRIES_CFG     = config.getint  ('settings', 'embed_max_retries',          fallback=1)
EMBED_BASE_DELAY_CFG      = config.getint  ('settings', 'embed_base_delay',           fallback=2)
GEMINI_MAX_OUTPUT_TOKENS  = config.getint  ('settings', 'gemini_max_output_tokens',   fallback=65536)
GENERATION_TEMPERATURE    = config.getfloat('settings', 'generation_temperature',     fallback=0.3)
MISTRAL_MAX_TOKENS        = config.getint  ('settings', 'mistral_max_tokens',         fallback=32000)
FETCH_TIMEOUT             = config.getint  ('settings', 'fetch_timeout',              fallback=30)
API_TIMEOUT               = config.getint  ('settings', 'api_timeout',               fallback=120)
SEARCH_RESULT_LIMIT       = config.getint  ('settings', 'search_result_limit',        fallback=60)
LOG_MAX_LINES_CFG         = config.getint  ('settings', 'log_max_lines',              fallback=2000)
_LOG_MAX_LINES = LOG_MAX_LINES_CFG  # now defined — update the buffer to use the real configured value
_log_buffer = collections.deque(_log_buffer, maxlen=_LOG_MAX_LINES)
MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions'

# 4. READ MULTIPLE EMBEDDING API KEYS (comma-separated in config.ini)
# Supports: gemini_api_keys = key1,key2,key3
# Falls back to the single gemini_api_key if the multi-key field is absent.
_raw_keys = config.get('settings', 'gemini_api_keys', fallback='').strip()
if _raw_keys:
    GEMINI_EMBED_KEYS = [k.strip() for k in _raw_keys.split(',') if k.strip()]
elif GEMINI_KEY:
    GEMINI_EMBED_KEYS = [GEMINI_KEY]
else:
    GEMINI_EMBED_KEYS = []

# Optional dedicated key for Ask's query-time embeddings only (embed_query).
# If unset, falls back to the original behavior (GEMINI_EMBED_KEYS[0]).
GEMINI_ASK_EMBED_KEY = config.get('settings', 'gemini_api_key_ask', fallback='').strip()


# Agent definitions for the AI panel's model dropdown.
AI_AGENTS = {
    'gemini': {
        'name': 'Google Gemini',
        'enabled': bool(GEMINI_KEY and GEMINI_KEY != 'YOUR_GEMINI_API_KEY_HERE'),
    },
    'mistral': {
        'name': 'Mistral AI',
        'enabled': bool(MISTRAL_API_KEY),
    },
}

DB_PATH = (BASE_DIR / 'library.db').resolve()

# Separate DB for the Ask panel's persisted history — kept apart from
# library.db so history survives independently of library rebuilds/imports.
# Stores only question/answer/citations (book+page refs), never snippet
# bodies — those are re-fetched on demand from library.db when the user
# clicks "نسخ المقتطفات" on a saved block.
ASK_HISTORY_DB_PATH = (BASE_DIR / 'ask_history.db').resolve()
HTML_SUFFIXES = ('.html', '.htm')


# ═══════════════════════════════════════════════════════════════
#  ARABIC NORMALIZATION (SEARCH ONLY)
# ═══════════════════════════════════════════════════════════════

def normalize_arabic(text):
    text = str(text)
    text = re.sub(r'[\u064B-\u065F\u0670\u0640]', '', text)
    text = re.sub(r'[\u0622\u0623\u0625]', '\u0627', text)
    text = text.replace('\u0649', '\u064A')
    text = re.sub(r'[\u200B-\u200F\u202A-\u202E\uFEFF]', '', text)
    text = re.sub(r'[:\.،؛؟!()\[\]«»]', '', text)
    return text.strip()


# ── Diacritic/letter-variant-tolerant highlighting (used by /api/search and
#    mirrored in app.js for on-page highlighting after navigation) ──
_TASHKEEL_CLASS = r'[\u064B-\u065F\u0670\u0640]*'
_ALEF_CLASS = '[اأإآ]'
_YAA_CLASS = '[يى]'


def _char_class(ch):
    if ch == 'ا':
        return _ALEF_CLASS
    if ch == 'ي':
        return _YAA_CLASS
    return re.escape(ch)


def build_word_regex_source(word):
    return _TASHKEEL_CLASS.join(_char_class(ch) for ch in word)


def build_highlight_regex(norm_words):
    patterns = [build_word_regex_source(w) for w in norm_words if w]
    if not patterns:
        return None
    try:
        return re.compile('(?:' + '|'.join(patterns) + ')')
    except re.error:
        return None


def build_phrase_highlight_regex(norm_words):
    """Like build_highlight_regex, but requires the words to occur in the
    given order, one after another (only whitespace between them) — used
    for exact "phrase in quotes" searches so the highlight mirrors what
    was actually matched, rather than marking any of the words wherever
    they happen to appear individually."""
    patterns = [build_word_regex_source(w) for w in norm_words if w]
    if not patterns:
        return None
    try:
        return re.compile(r'\s+'.join(patterns))
    except re.error:
        return None


def make_highlighted_snippet(text, regex, window=90, max_len=220):
    if not text:
        return ''
    if regex is None:
        snippet = text[:max_len]
        return html_module.escape(snippet) + ('…' if len(text) > max_len else '')

    m = regex.search(text)
    if not m:
        snippet = text[:max_len]
        return html_module.escape(snippet) + ('…' if len(text) > max_len else '')

    start = max(0, m.start() - window)
    end = min(len(text), m.end() + window)
    chunk = text[start:end]

    out, pos = [], 0
    for mm in regex.finditer(chunk):
        out.append(html_module.escape(chunk[pos:mm.start()]))
        out.append('<mark>' + html_module.escape(chunk[mm.start():mm.end()]) + '</mark>')
        pos = mm.end()
    out.append(html_module.escape(chunk[pos:]))

    prefix = '…' if start > 0 else ''
    suffix = '…' if end < len(text) else ''
    return prefix + ''.join(out) + suffix


# ═══════════════════════════════════════════════════════════════
#  DATABASE
# ═══════════════════════════════════════════════════════════════

def init_ask_history_db():
    """Creates ask_history.db if missing. One row per saved Q&A block.
    `citations` is a JSON array of {book_id, slide_number, title, label} —
    just enough to re-fetch a snippet later; never the snippet text itself."""
    conn = sqlite3.connect(ASK_HISTORY_DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS ask_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            answer TEXT NOT NULL,
            created_at TEXT NOT NULL,
            citations TEXT NOT NULL DEFAULT '[]'
        );
    """)
    conn.commit()
    conn.close()


def save_ask_history(question, answer, citations):
    conn = sqlite3.connect(ASK_HISTORY_DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT INTO ask_history (question, answer, created_at, citations) VALUES (?,?,?,?)",
        (question, answer, datetime.utcnow().isoformat(), json.dumps(citations, ensure_ascii=False))
    )
    conn.commit()
    new_id = c.lastrowid
    conn.close()
    return new_id


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS books (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            filename TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            slide_count INTEGER DEFAULT 0,
            mtime REAL,
            size INTEGER,
            shamela_id TEXT,
            folder TEXT,
            part_label TEXT,
            sort_num INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS slides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            slide_number INTEGER NOT NULL,
            html_content TEXT NOT NULL,
            plain_text TEXT
        );
        CREATE TABLE IF NOT EXISTS headings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book_id INTEGER NOT NULL,
            slide_id INTEGER NOT NULL,
            level INTEGER NOT NULL,
            text TEXT NOT NULL,
            anchor_id TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'inline'
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
            normalized_text,
            book_id UNINDEXED,
            slide_id UNINDEXED,
            heading_text UNINDEXED,
            source UNINDEXED
        );
        CREATE TABLE IF NOT EXISTS embeddings (
            slide_id INTEGER PRIMARY KEY,
            book_id INTEGER NOT NULL,
            vector TEXT NOT NULL,
            model TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_slides_book ON slides(book_id);
        CREATE INDEX IF NOT EXISTS idx_slides_book_num ON slides(book_id, slide_number);
        CREATE INDEX IF NOT EXISTS idx_headings_book ON headings(book_id);
        CREATE INDEX IF NOT EXISTS idx_embeddings_book ON embeddings(book_id);
    """)
    conn.commit()
    migrate_db(conn)
    conn.close()


def migrate_db(conn):
    """Bring an existing library.db (created by an older version of this
    file) up to the current schema without losing data."""
    c = conn.cursor()

    c.execute("PRAGMA table_info(books)")
    book_cols = {row[1] for row in c.fetchall()}
    if 'part_label' not in book_cols:
        c.execute("ALTER TABLE books ADD COLUMN part_label TEXT")
    if 'sort_num' not in book_cols:
        c.execute("ALTER TABLE books ADD COLUMN sort_num INTEGER DEFAULT 0")
    if 'author' not in book_cols:
        c.execute("ALTER TABLE books ADD COLUMN author TEXT")

    c.execute("PRAGMA table_info(search_index)")
    si_cols = {row[1] for row in c.fetchall()}
    if 'source' not in si_cols:
        # FTS5 virtual tables can't reliably gain a column via ALTER TABLE
        # across all SQLite builds, so rebuild it instead.
        c.execute("ALTER TABLE search_index RENAME TO search_index_old")
        c.execute("""
            CREATE VIRTUAL TABLE search_index USING fts5(
                normalized_text,
                book_id UNINDEXED,
                slide_id UNINDEXED,
                heading_text UNINDEXED,
                source UNINDEXED
            )
        """)
        c.execute("""
            INSERT INTO search_index (normalized_text, book_id, slide_id, heading_text, source)
            SELECT normalized_text, book_id, slide_id, heading_text,
                   CASE WHEN heading_text != '' THEN 'inline' ELSE 'body' END
            FROM search_index_old
        """)
        c.execute("DROP TABLE search_index_old")

    conn.commit()


def clear_library():
    conn = get_vec_conn() if VEC_AVAILABLE else sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM headings")
    c.execute("DELETE FROM slides")
    c.execute("DELETE FROM books")
    c.execute("DELETE FROM search_index")
    c.execute("DELETE FROM embeddings")
    if VEC_AVAILABLE:
        c.execute("DELETE FROM vec_embeddings")
    conn.commit()
    conn.close()


# ═══════════════════════════════════════════════════════════════
#  HTML PARSING  (unchanged from the original reading/rendering pipeline —
#  this controls what the reader displays, which we were asked not to alter)
# ═══════════════════════════════════════════════════════════════

_P_OPEN_RE = re.compile(r'<p\b[^>]*>', re.IGNORECASE)
_P_CLOSE_RE = re.compile(r'</p\s*>', re.IGNORECASE)


def fix_legacy_paragraph_breaks(raw_html):
    raw_html = _P_OPEN_RE.sub('', raw_html)
    raw_html = _P_CLOSE_RE.sub('<br>', raw_html)
    return raw_html


KNOWN_SLIDE_SELECTORS = [
    'div.PageText', 'div.pagetext',
    'div.slide', 'div.page', 'div.Page', 'div.bk', 'div.nass', 'div.mtn',
    '.slide', '.page', '.chapter', 'section', 'article',
]


def find_slide_containers(body):
    for selector in KNOWN_SLIDE_SELECTORS:
        containers = body.select(selector)
        if len(containers) > 1:
            total_text = sum(len(c.get_text(strip=True)) for c in containers)
            if total_text > 200:
                return containers

    body_text_len = len(body.get_text(strip=True)) or 1
    class_groups = {}
    for div in body.find_all('div'):
        classes = div.get('class')
        if not classes:
            continue
        key = ' '.join(classes)
        class_groups.setdefault(key, []).append(div)

    best_containers, best_coverage = None, 0
    for els in class_groups.values():
        if len(els) < 2:
            continue
        total_text = sum(len(e.get_text(strip=True)) for e in els)
        coverage = total_text / body_text_len
        if coverage > best_coverage:
            best_coverage = coverage
            best_containers = els

    if best_containers and best_coverage > 0.5:
        return best_containers
    return None


_HEADING_TAG_RE = re.compile(r'^h[1-6]$')


def extract_headings(container, slide_idx):
    results = []
    for hi, h in enumerate(container.find_all(_HEADING_TAG_RE)):
        if not h.get('id'):
            h['id'] = f"anchor-{slide_idx}-h{hi}"
        text = h.get_text(strip=True)
        if text:
            results.append((int(h.name[1]), text, h['id']))
    for mi, m in enumerate(container.find_all(attrs={'data-type': 'title'})):
        if not m.get('id'):
            m['id'] = f"anchor-{slide_idx}-t{mi}"
        text = m.get_text(strip=True)
        if text:
            results.append((2, text, m['id']))
    return results


def process_containers(containers):
    slides = []
    for idx, container in enumerate(containers, 1):
        headings = extract_headings(container, idx)
        html = str(container)
        text = container.get_text(separator=' ', strip=True)
        slides.append({'number': idx, 'html': html, 'text': text, 'headings': headings})
    return slides


def parse_book(filepath):
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        raw_html = f.read()

    raw_html = fix_legacy_paragraph_breaks(raw_html)
    soup = BeautifulSoup(raw_html, 'lxml')

    title = ''
    if soup.title:
        title = soup.title.get_text(strip=True)
    if not title:
        h1 = soup.find('h1')
        if h1:
            title = h1.get_text(strip=True)
    if not title:
        title = filepath.stem

    for tag in soup.find_all(['script', 'style']):
        tag.decompose()

    body = soup.find('body') or soup
    slides = []
    containers = find_slide_containers(body)
    if containers:
        slides = process_containers(containers)

    if not slides:
        direct_children = [c for c in body.children
                           if not isinstance(c, NavigableString)
                           and getattr(c, 'name', None) in ('div', 'section', 'article')
                           and len(c.get_text(strip=True)) > 100]
        if direct_children:
            slides = process_containers(direct_children)

    if not slides:
        headings = extract_headings(body, 1)
        slides = [{
            'number': 1,
            'html': str(body),
            'text': body.get_text(separator=' ', strip=True),
            'headings': headings,
        }]

    unique_slides = []
    seen_hashes = set()
    for slide in slides:
        text_key = slide['text'].replace(' ', '').replace('\n', '')[:300]
        if text_key not in seen_hashes and len(slide['text'].strip()) > 20:
            seen_hashes.add(text_key)
            unique_slides.append(slide)

    for i, slide in enumerate(unique_slides, 1):
        slide['number'] = i

    return {'title': title, 'slides': unique_slides}


# ═══════════════════════════════════════════════════════════════
#  PART NAME DETECTION  (ported verbatim from Mistral's implementation,
#  per explicit instruction — used by the TOC import pipeline below)
# ═══════════════════════════════════════════════════════════════

def normalize_part(part):
    """Normalize part name for comparison (remove Arabic prefixes, leading zeros)."""
    if not part:
        return None
    # Remove Arabic prefixes (e.g., "الجزء", "ج")
    part = re.sub(r'[\u0627\u0644\u062c\u0632\u0621\u062c]', '', str(part))
    # Remove leading zeros
    part = part.lstrip('0')
    return part or '0'  # Handle empty string


def detect_local_part_name(book_id):
    """Detect which part this local file represents.
    Returns part name string (e.g., '1', '2', '001', 'المقدمة', 'الكتاب') or None."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT filename, path FROM books WHERE id=?", (book_id,))
    row = c.fetchone()
    conn.close()
    if not row:
        return None

    filename, path = row

    # Try filename pattern: 001.htm -> part "1" or "001"
    m = re.match(r'^(\d+)\.(?:htm|html)$', filename, re.I)
    if m:
        part_num = m.group(1)
        # Normalize to string without leading zeros for matching
        return part_num

    # Try filename without extension for non-numeric parts (e.g., المقدمة.htm -> المقدمة)
    m = re.match(r'^([^.]+)\.(?:htm|html)$', filename, re.I)
    if m:
        part_name = m.group(1)
        # If it's a known part name (like المقدمة, الكتاب, etc.), use it as-is
        # Otherwise try to extract numeric part from it
        if part_name.isdigit():
            return part_name
        # Check if it contains a number
        num_match = re.search(r'(\d+)', part_name)
        if num_match:
            return num_match.group(1)
        # Return the filename without extension as the part identifier
        return part_name

    # Try PartName span in first slide
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT html_content FROM slides WHERE book_id=? ORDER BY slide_number LIMIT 3", (book_id,))
    for (html,) in c.fetchall():
        # Look for جـ N or الجزء N or ج 1 or جزء 1
        pm = re.search(r'ج[ـ]?\s*(\d+)', html)
        if pm:
            conn.close()
            return pm.group(1)
        pm = re.search(r'الجزء\s*(?:ال)?\s*(\d+)', html)
        if pm:
            conn.close()
            return pm.group(1)
    conn.close()

    return None


def compute_sort_num(label):
    """Used only for ordering books nicely in the tree (display concern) —
    not part of the TOC-matching pipeline."""
    if label and str(label).isdigit():
        return int(label)
    return 0


# ═══════════════════════════════════════════════════════════════
#  LIBRARY SCANNER
# ═══════════════════════════════════════════════════════════════

def scan_library():
    """Scan the books directory for new/changed/removed HTML files.
    Purely local — no API calls, no embedding generation whatsoever.
    Embeddings are handled separately by generate_embeddings_run()."""
    if not BOOKS_DIR.exists():
        return {'total': 0, 'added': 0, 'updated': 0, 'removed': 0,
                'unchanged': 0, 'errors': 0, 'missing_dir': True}

    conn = get_vec_conn() if VEC_AVAILABLE else sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    c = conn.cursor()

    # books.path is stored RELATIVE to BOOKS_DIR (see get_book_folder /
    # get_book_id_by_path below for the read-side counterpart) so that
    # renaming or moving the parent folder — or moving the whole app to
    # another machine — never invalidates the stored value. Only
    # books.path itself is relative; `filepath` below stays the real,
    # absolute path on disk for every filesystem operation (stat, open,
    # parse_book, etc.) — nothing else changes.
    c.execute("SELECT id, path, mtime, size, folder FROM books")
    existing = {row[1]: {'id': row[0], 'mtime': row[2], 'size': row[3], 'folder': row[4]} for row in c.fetchall()}

    html_files = [p for p in BOOKS_DIR.rglob('*')
                  if p.is_file() and p.suffix.lower() in HTML_SUFFIXES]

    seen_paths = set()
    stats = {'added': 0, 'updated': 0, 'removed': 0, 'unchanged': 0, 'errors': 0}

    for filepath in html_files:
        path_str = filepath.relative_to(BOOKS_DIR).as_posix()  # was: str(filepath)
        seen_paths.add(path_str)
        try:
            st = filepath.stat()
            mtime, size = st.st_mtime, st.st_size
            prev = existing.get(path_str)
            folder = str(filepath.parent.name)

            if prev and prev['mtime'] == mtime and prev['size'] == size:
                stats['unchanged'] += 1
                continue

            data = parse_book(filepath)

            if prev:
                book_id = prev['id']
                c.execute("DELETE FROM headings WHERE book_id=?", (book_id,))
                c.execute("DELETE FROM slides WHERE book_id=?", (book_id,))
                c.execute("DELETE FROM search_index WHERE book_id=?", (book_id,))
                # Slides are about to be re-inserted with new AUTOINCREMENT
                # ids, so any existing embeddings/vec_embeddings rows for
                # this book point at slide ids that are about to stop
                # existing — clean them up now rather than leaving them as
                # orphans. The embedding run will re-embed this book's
                # slides from scratch afterward.
                c.execute("DELETE FROM embeddings WHERE book_id=?", (book_id,))
                if VEC_AVAILABLE:
                    c.execute("DELETE FROM vec_embeddings WHERE book_id=?", (book_id,))
                c.execute(
                    "UPDATE books SET title=?, filename=?, slide_count=?, mtime=?, size=?, folder=? WHERE id=?",
                    (data['title'], filepath.name, len(data['slides']), mtime, size, folder, book_id)
                )
                stats['updated'] += 1
            else:
                c.execute(
                    "INSERT INTO books (title, filename, path, slide_count, mtime, size, folder) VALUES (?,?,?,?,?,?,?)",
                    (data['title'], filepath.name, path_str, len(data['slides']), mtime, size, folder)
                )
                book_id = c.lastrowid
                stats['added'] += 1

            heading_rows = []
            search_rows = []
            for slide in data['slides']:
                c.execute(
                    "INSERT INTO slides (book_id, slide_number, html_content, plain_text) VALUES (?,?,?,?)",
                    (book_id, slide['number'], slide['html'], slide['text'])
                )
                slide_id = c.lastrowid

                for level, htext, anchor in slide.get('headings', []):
                    heading_rows.append((book_id, slide_id, level, htext, anchor))
                    norm = normalize_arabic(htext)
                    if norm:
                        search_rows.append((norm, book_id, slide_id, htext, 'inline'))

                if slide['text']:
                    norm_body = normalize_arabic(slide['text'])
                    if norm_body:
                        search_rows.append((norm_body, book_id, slide_id, '', 'body'))

            if heading_rows:
                c.executemany(
                    "INSERT INTO headings (book_id, slide_id, level, text, anchor_id, source) VALUES (?,?,?,?,?,'inline')",
                    heading_rows
                )
            if search_rows:
                c.executemany(
                    "INSERT INTO search_index (normalized_text, book_id, slide_id, heading_text, source) VALUES (?,?,?,?,?)",
                    search_rows
                )

            m = re.match(r'^(\d+)\.(?:htm|html)$', filepath.name, re.I)
            part_label = m.group(1) if m else None
            sort_num = compute_sort_num(part_label)
            c.execute("UPDATE books SET part_label=?, sort_num=? WHERE id=?", (part_label, sort_num, book_id))

        except Exception as e:
            print(f"Error parsing {filepath}: {e}")
            stats['errors'] += 1

    removed_paths = set(existing.keys()) - seen_paths
    removed_folders = set()
    for path_str in removed_paths:
        book_id = existing[path_str]['id']
        removed_folders.add(existing[path_str].get('folder'))
        c.execute("DELETE FROM headings WHERE book_id=?", (book_id,))
        c.execute("DELETE FROM slides WHERE book_id=?", (book_id,))
        c.execute("DELETE FROM search_index WHERE book_id=?", (book_id,))
        c.execute("DELETE FROM embeddings WHERE book_id=?", (book_id,))
        if VEC_AVAILABLE:
            c.execute("DELETE FROM vec_embeddings WHERE book_id=?", (book_id,))
        c.execute("DELETE FROM books WHERE id=?", (book_id,))
        stats['removed'] += 1

    # toc/{folder}.html is shared by every part of a multi-part book (see
    # import_toc_for_book_local), so it's only safe to delete once NO book
    # row references that folder anymore — deleting a single part's HTML
    # file must not take out the TOC file the remaining parts still need.
    stats['toc_files_removed'] = 0
    for folder_name in removed_folders:
        if not folder_name:
            continue
        c.execute("SELECT COUNT(*) FROM books WHERE folder=?", (folder_name,))
        remaining = c.fetchone()[0]
        if remaining == 0:
            toc_path = find_local_toc_file(folder_name)
            if toc_path:
                try:
                    toc_path.unlink()
                    stats['toc_files_removed'] += 1
                    print(f"[INFO] Removed orphaned TOC file: {toc_path}")
                except OSError as e:
                    print(f"[WARN] Failed to remove orphaned TOC file {toc_path}: {e}")

    conn.commit()
    conn.close()

    stats['total'] = len(html_files)
    stats['missing_dir'] = False
    return stats


# ═══════════════════════════════════════════════════════════════
#  SHAMELA .DB DETECTION & VALIDATION  (ported verbatim from Mistral)
# ═══════════════════════════════════════════════════════════════

def validate_shamela_db(db_path):
    try:
        conn = sqlite3.connect(str(db_path))
        c = conn.cursor()
        c.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = {row[0].lower() for row in c.fetchall()}
        if not {'page', 'title'}.issubset(tables):
            return False, "Missing tables (page, title)"
        c.execute("PRAGMA table_info(page)")
        page_cols = {row[1].lower() for row in c.fetchall()}
        if not {'id', 'part', 'page'}.issubset(page_cols):
            return False, "Missing columns in page table"
        c.execute("PRAGMA table_info(title)")
        title_cols = {row[1].lower() for row in c.fetchall()}
        if not {'id', 'page', 'parent'}.issubset(title_cols):
            return False, "Missing columns in title table"
        conn.close()
        return True, None
    except Exception as e:
        return False, str(e)


def find_shamela_db(folder_path):
    """Find a valid Shamela .db file in the given folder.
    Tries common names like 2864.db, metadata.db, or any .db file."""
    if not folder_path or not folder_path.exists():
        return None

    # Try specific patterns first
    common_names = ['metadata.db', 'shamela.db', 'toc.db']
    for name in common_names:
        db_path = folder_path / name
        if db_path.exists():
            is_valid, _ = validate_shamela_db(db_path)
            if is_valid:
                return db_path

    # Try any .db file
    for db_path in folder_path.glob("*.db"):
        is_valid, _ = validate_shamela_db(db_path)
        if is_valid:
            return db_path
    return None


def get_book_folder(book_id):
    """Return the real, absolute folder Path on disk for this book.
    books.path is stored relative to BOOKS_DIR (see scan_library), so it
    is reconstructed here — this is the one place that matters, since
    every caller (find_shamela_db, mkdir, .save()) treats the result as
    a real filesystem path."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT path FROM books WHERE id=?", (book_id,))
    row = c.fetchone()
    conn.close()
    if row:
        return (BOOKS_DIR / row[0]).resolve().parent
    return None


def get_book_id_by_path(filepath):
    """Look up a book by its real, absolute filesystem path — converts
    to the same BOOKS_DIR-relative form used in the path column before
    querying."""
    try:
        rel = Path(filepath).resolve().relative_to(BOOKS_DIR).as_posix()
    except ValueError:
        return None  # filepath isn't under BOOKS_DIR at all
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id FROM books WHERE path=?", (rel,))
    row = c.fetchone()
    conn.close()
    return row[0] if row else None


def is_single_volume_book(book_id):
    """Determine if a book is single-volume by consulting its Shamela .db
    directly, rather than where the local file happens to sit on disk.

    Rule: count the DISTINCT non-null/non-empty values in the .db's
    page.part column. More than one distinct value -> multi-part (the
    publisher's own db distinguishes parts, and the user's local files are
    split to mirror those same part boundaries 1:1). Zero or one distinct
    value -> single-volume.

    This replaces the old folder-location heuristic (subfolder = multi-part,
    flat in books/ = single-volume), which broke for books whose .db
    legitimately has only one part value but happens to live in a
    subfolder for organizational reasons, or vice versa. The .db is the
    authoritative source for this because it was generated by Shamela's own
    export tool, which already knows the book's true structure.

    Falls back to single-volume (True) if no .db can be found/read at all,
    matching the previous function's safe-default behavior.
    """
    book_folder = get_book_folder(book_id)
    if not book_folder:
        return True  # Default to single-volume if we can't determine

    db_path = find_shamela_db(book_folder)
    if not db_path:
        return True  # No .db to consult — safest default, as before

    return is_single_volume_db(db_path)


def is_single_volume_db(db_path):
    """Check if .db file represents a single-volume book (all parts are NULL)."""
    try:
        conn = sqlite3.connect(str(db_path))
        c = conn.cursor()
        c.execute("SELECT DISTINCT part FROM page WHERE part IS NOT NULL AND part != ''")
        parts = [row[0] for row in c.fetchall()]
        conn.close()

        # If no non-NULL/empty parts found, it's single-volume
        if not parts:
            return True
        return False
    except Exception:
        return False


# ═══════════════════════════════════════════════════════════════
#  SHAMELA.WS FETCHING  (ported verbatim from Mistral)
# ═══════════════════════════════════════════════════════════════

PAGE_TOLERANCE = 2

SHAMELA_TOC_SELECTOR = "div.s-nav-head + ul > li"
SHAMELA_BOOK_ID_RE = re.compile(r'(?:shamela\.ws/book/)?(\d+)(?:/(\d+))?')
SHAMELA_PAGE_HREF_RE = re.compile(r'/book/\d+/(\d+)')

# Matches both single and double quotes for class attribute
LOCAL_PAGENUMBER_SPAN_RE = re.compile(r"<span\s+class\s*=\s*['\"]PageNumber['\"]>\s*\(\s*ص\s*:\s*(\d+)\s*\)\s*</span>", re.IGNORECASE)


def extract_shamela_book_id(raw):
    raw = (raw or '').strip()
    match = SHAMELA_BOOK_ID_RE.search(raw)
    if match:
        return (match.group(1), match.group(2))
    return (None, None)


def fetch_shamela_toc(shamela_id):
    book_id, part_id = extract_shamela_book_id(shamela_id)
    if not book_id:
        return []

    url = f"https://shamela.ws/book/{book_id}"
    try:
        resp = requests.get(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept-Language': 'ar,en;q=0.8',
        }, timeout=FETCH_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"[ERROR] Failed to fetch {url}: {e}")
        return []

    soup = BeautifulSoup(resp.text, 'lxml')
    top_items = soup.select(SHAMELA_TOC_SELECTOR)
    entries = []

    def walk(items, level):
        for li in items:
            link = li.find('a', href=True)
            if not link:
                continue
            href = link.get('href', '')
            page_match = SHAMELA_PAGE_HREF_RE.search(href)
            if not page_match:
                continue
            text = link.get_text(strip=True)
            if text:
                entries.append({
                    'level': level,
                    'text': text,
                    'abs_page': int(page_match.group(1))
                })
            sub_ul = li.find('ul', recursive=False)
            if sub_ul:
                walk(sub_ul.find_all('li', recursive=False), level + 1)

    if top_items:
        walk(top_items, 1)
    else:
        for link in soup.find_all('a', href=True):
            href = link['href']
            if f'/book/{book_id}/' not in href:
                continue
            page_match = SHAMELA_PAGE_HREF_RE.search(href)
            text = link.get_text(strip=True)
            if page_match and text:
                entries.append({
                    'level': 1,
                    'text': text,
                    'abs_page': int(page_match.group(1))
                })

    return entries


# ═══════════════════════════════════════════════════════════════
#  SYNTHETIC ANCHOR INJECTION  (ported verbatim from Mistral)
# ═══════════════════════════════════════════════════════════════

def inject_synthetic_anchor(html_content, heading_text, anchor_id):
    if not html_content or not heading_text:
        return html_content
    try:
        soup = BeautifulSoup(f'<div id="temp-wrapper">{html_content}</div>', 'lxml')
        wrapper = soup.find('div', id='temp-wrapper')
        norm_heading = normalize_arabic(heading_text)
        if not norm_heading:
            return html_content

        injected = False

        # First, try to find exact or partial match in text nodes
        for text_node in wrapper.find_all(string=True):
            if text_node.parent.name in ('script', 'style'):
                continue
            node_text = str(text_node).strip()
            if not node_text:
                continue
            norm_node = normalize_arabic(node_text)
            # Check if heading is contained in this node (exact or as substring)
            if norm_heading in norm_node or norm_node in norm_heading:
                span = soup.new_tag('span', id=anchor_id, style='display:none')
                text_node.parent.insert_before(span)
                injected = True
                break

        if not injected:
            # Try in element text content
            for elem in wrapper.find_all(['p', 'span', 'div', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
                if elem.name in ('script', 'style'):
                    continue
                elem_text = elem.get_text(strip=True)
                if not elem_text:
                    continue
                norm_elem = normalize_arabic(elem_text)
                if norm_heading in norm_elem or norm_elem in norm_heading:
                    span = soup.new_tag('span', id=anchor_id, style='display:none')
                    elem.insert_before(span)
                    injected = True
                    break

        if not injected:
            # Try partial matching with word boundaries
            heading_words = norm_heading.split()
            if len(heading_words) > 0:
                for text_node in wrapper.find_all(string=True):
                    if text_node.parent.name in ('script', 'style'):
                        continue
                    node_text = str(text_node).strip()
                    if not node_text:
                        continue
                    norm_node = normalize_arabic(node_text)
                    node_words = norm_node.split()
                    # Check if first few words match
                    for i in range(min(3, len(heading_words))):
                        if heading_words[i] in node_words:
                            span = soup.new_tag('span', id=anchor_id, style='display:none')
                            text_node.parent.insert_before(span)
                            injected = True
                            break
                    if injected:
                        break

        if not injected:
            # Fallback: insert at the beginning of PageText or after PageHead
            page_text = wrapper.find('div', class_='PageText')
            if page_text:
                page_head = page_text.find('div', class_='PageHead')
                if page_head:
                    span = soup.new_tag('span', id=anchor_id, style='display:none')
                    page_head.insert_after(span)
                else:
                    span = soup.new_tag('span', id=anchor_id, style='display:none')
                    page_text.insert(0, span)
            else:
                span = soup.new_tag('span', id=anchor_id, style='display:none')
                wrapper.insert(0, span)

        return ''.join(str(child) for child in wrapper.children)
    except Exception as e:
        print(f"[WARN] Failed to inject anchor for '{heading_text[:40]}...': {e}")
        return html_content


# ═══════════════════════════════════════════════════════════════
#  LOCAL TOC IMPORT  (new, additive — reads a Shamela book-page HTML file
#  saved to disk instead of live-fetching shamela.ws. Produces the exact
#  same entry shape as fetch_shamela_toc() — {'level','text','abs_page'} —
#  so it can be fed into the same downstream matching logic without any
#  duplication or divergence from the already-verified Shamela-import path.)
# ═══════════════════════════════════════════════════════════════

TOC_DIR = (BASE_DIR / 'toc').resolve()

# The TOC tree on a saved Shamela book page lives under a "betaka-index"
# block as nested <ul><li> elements. Each heading <li> carries a
# data-id="<title.id>" attribute on its expand-button <a>, and a sibling
# <a href="https://shamela.ws/book/<book_id>/<abs_page>">heading text</a>
# whose trailing path segment is the heading's absolute page id — the same
# value found in title.page / page.id in the .db. Nesting depth in the
# HTML mirrors title.parent, but we don't even need to rely on that: the
# data-id is title.id itself, an exact, unambiguous join key.
LOCAL_TOC_PAGE_HREF_RE = re.compile(r'/book/\d+/(\d+)')


def find_local_toc_file(book_title):
    """Look up toc/{book_title}.html (or .htm) for the given book title."""
    if not book_title:
        return None
    for suffix in ('.html', '.htm'):
        candidate = TOC_DIR / f"{book_title}{suffix}"
        if candidate.exists():
            return candidate
    return None


def parse_local_toc_html(filepath):
    """Parse a locally saved Shamela book-page HTML file into the same
    entry list shape fetch_shamela_toc() returns: [{'level','text',
    'abs_page'}, ...], in document order (top-to-bottom, depth-first —
    matching the book's natural reading order, exactly like the live
    fetch's recursive walk)."""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            raw_html = f.read()
    except Exception as e:
        print(f"[ERROR] Failed to read local TOC file {filepath}: {e}")
        return []

    soup = BeautifulSoup(raw_html, 'lxml')
    index_block = soup.find('div', class_='betaka-index')
    if not index_block:
        return []

    top_ul = index_block.find('ul', recursive=False)
    if not top_ul:
        return []

    entries = []

    def walk(ul, level):
        for li in ul.find_all('li', recursive=False):
            # A heading <li> has its own direct <a href="...{abs_page}">
            # text link (there may also be a [+] expand-button <a>
            # alongside it — that one has no usable page href, so the
            # regex match below naturally skips it).
            heading_link = None
            for a in li.find_all('a', href=True, recursive=False):
                if LOCAL_TOC_PAGE_HREF_RE.search(a['href']):
                    heading_link = a
                    break
            if heading_link:
                page_match = LOCAL_TOC_PAGE_HREF_RE.search(heading_link['href'])
                text = heading_link.get_text(strip=True)
                if text and page_match:
                    entries.append({
                        'level': level,
                        'text': text,
                        'abs_page': int(page_match.group(1)),
                    })
            sub_ul = li.find('ul', recursive=False)
            if sub_ul:
                walk(sub_ul, level + 1)

    walk(top_ul, 1)
    return entries


def parse_local_toc_author(filepath):
    """Extract the author name from the book-info card in a locally saved
    Shamela book-page HTML file. The card lives in the <div> immediately
    following the <h3>بطاقة الكتاب وفهرس الموضوعات</h3> heading, as a set
    of "label: value" lines separated by <br> tags (not a labelled
    span/PageText structure — confirmed against an actual saved file).

    Example of the relevant lines inside that div:
        الكتاب: الكلم الطيب
        المؤلف: تقي الدين أبو العباس ... ابن تيمية الحراني الحنبلي الدمشقي (ت ٧٢٨هـ)
        تحقيق: ...

    Returns None if the file, the info div, or the المؤلف line itself can't
    be found, so callers can leave author untouched rather than overwrite
    existing data with a false negative."""
    if not filepath:
        return None
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            raw_html = f.read()
    except Exception as e:
        print(f"[WARN] Failed to read TOC file for author extraction {filepath}: {e}")
        return None

    soup = BeautifulSoup(raw_html, 'lxml')
    h3 = soup.find('h3', string=re.compile('بطاقة الكتاب'))
    info_div = h3.find_next('div') if h3 else None
    if not info_div:
        return None

    for line in info_div.get_text('\n').split('\n'):
        line = line.strip()
        if line.startswith('المؤلف:') or line.startswith('المؤلف :'):
            author = line.split(':', 1)[1].strip()
            # Drop a trailing death-date parenthetical, e.g. "(ت ٧٢٨هـ)".
            author = re.sub(r'\(ت[^)]*\)\s*$', '', author).strip()
            return author or None

    return None


# ═══════════════════════════════════════════════════════════════
#  TOC IMPORT (PER-PART, DB-BASED)  (ported verbatim from Mistral —
#  the only addition is mirroring inserted headings into search_index,
#  tagged source='imported', so they stay searchable; this never changes
#  *which* slide a heading is matched/placed on)
# ═══════════════════════════════════════════════════════════════

def import_toc_for_book(book_id, shamela_id):
    """Import TOC for a single part or single-volume book using local .db as page map.

    Flow:
    1. Determine if single-volume or multi-part book
    2. Find .db in parent folder
    3. Fetch Shamela TOC (whole book)
    4. Build mapping from absolute page numbers to (part, sequential_page) from .db
    5. For single-volume: import ALL TOC entries
       For multi-part: filter TOC entries to only those belonging to THIS part
    6. Map sequential page numbers to local slide page numbers
    7. Match each entry to local slides by printed page number
    8. Insert headings for this part only
    """
    # ── Step 1: Determine book type and local part ──
    book_folder = get_book_folder(book_id)
    if not book_folder:
        return {'status': 'error', 'message': 'تعذر تحديد مجلد الكتاب'}

    # Check if this is a single-volume book (standalone in books/ folder)
    is_single_volume = is_single_volume_book(book_id)

    if is_single_volume:
        # For single-volume books, we don't need a part number
        local_part = None
        print(f"[INFO] Book {book_id} detected as single-volume")
    else:
        # For multi-part books, detect the part from filename or content
        local_part = detect_local_part_name(book_id)
        if not local_part:
            return {'status': 'error', 'message': 'تعذر تحديد رقم الجزء من اسم الملف'}
        print(f"[INFO] Local file detected as part: '{local_part}'")

    # ── Step 2: Find .db ──
    db_path = find_shamela_db(book_folder)
    if not db_path:
        return {
            'status': 'error',
            'message': 'لم يتم العثور على قاعدة بيانات Shamela في مجلد الكتاب. '
                      'يرجى وضع ملف .db في نفس المجلد أو الضغط على "ربط قاعدة بيانات".'
        }

    is_valid, error = validate_shamela_db(db_path)
    if not is_valid:
        return {'status': 'error', 'message': f'قاعدة البيانات غير صالحة: {error}'}

    # ── Step 3: Build comprehensive mapping from .db ──
    s_conn = sqlite3.connect(str(db_path))
    s_c = s_conn.cursor()

    # Get all page entries: id, part, page (sequential), number
    s_c.execute("SELECT id, part, page, number FROM page WHERE page IS NOT NULL ORDER BY id")
    page_rows = s_c.fetchall()

    # Get all title entries: id, page (ref to page.id), parent
    s_c.execute("SELECT id, page, parent FROM title ORDER BY id")
    title_rows = s_c.fetchall()

    s_conn.close()

    # Build mapping: absolute_page_id -> (part, sequential_page)
    abs_page_map = {}
    for page_id, part, seq_page, number in page_rows:
        abs_page_map[page_id] = (str(part) if part else None, seq_page)

    # Build title info: title_id -> (page_id, parent_id)
    title_info = {}
    for title_id, page_id, parent_id in title_rows:
        title_info[title_id] = (page_id, parent_id)

    print(f"[INFO] .db has {len(abs_page_map)} pages and {len(title_info)} titles")

    # ── Step 4: Fetch Shamela TOC ──
    book_id_input, _ = extract_shamela_book_id(shamela_id)
    if not book_id_input:
        return {'status': 'error', 'message': 'معرف الشاملة غير صالح'}

    toc_entries = fetch_shamela_toc(book_id_input)
    if not toc_entries:
        return {'status': 'error', 'message': 'لم يتم العثور على فهرس في الشاملة'}

    print(f"[INFO] Shamela TOC has {len(toc_entries)} entries")

    # ── Step 5: Filter TOC entries ──
    # For single-volume: import ALL entries
    # For multi-part: filter to THIS part only
    part_entries = []
    unmatched_pages = []

    for entry in toc_entries:
        abs_page_id = entry['abs_page']

        if abs_page_id not in abs_page_map:
            unmatched_pages.append(entry)
            continue

        db_part, seq_page = abs_page_map[abs_page_id]

        if is_single_volume:
            # Single-volume: import ALL entries (no part filtering)
            part_entries.append({
                'level': entry['level'],
                'text': entry['text'],
                'abs_page_id': abs_page_id,
                'seq_page': seq_page,
            })
        else:
            # Multi-part: filter to THIS part only
            # Use normalize_part for consistent comparison
            db_part_norm = normalize_part(db_part)
            local_part_norm = normalize_part(local_part)

            if db_part_norm == local_part_norm:
                part_entries.append({
                    'level': entry['level'],
                    'text': entry['text'],
                    'abs_page_id': abs_page_id,
                    'seq_page': seq_page,
                })

    if is_single_volume:
        print(f"[INFO] Single-volume: importing all {len(part_entries)} TOC entries")
    else:
        print(f"[INFO] Filtered to {len(part_entries)} entries for part '{local_part}'")

    if not part_entries:
        if is_single_volume:
            return {
                'status': 'error',
                'message': 'لا توجد عناوين في الفهرس. قد يكون ترقيم الصفحات مختلفاً.'
            }
        else:
            return {
                'status': 'error',
                'message': f'لا توجد عناوين للجزء {local_part} في الفهرس. '
                          f'تأكد من رقم الجزء في اسم الملف أو محتوى الكتاب.'
            }

    # ── Step 6: Get local slides with page numbers ──
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, slide_number, html_content FROM slides WHERE book_id=? ORDER BY slide_number", (book_id,))
    slides = []
    for sid, snum, html in c.fetchall():
        m = LOCAL_PAGENUMBER_SPAN_RE.search(html[:800])
        page_num = int(m.group(1)) if m else None
        slides.append({'id': sid, 'num': snum, 'page': page_num, 'html': html})
    conn.close()

    slides_with_page = [s for s in slides if s['page'] is not None]
    page_lookup = {s['page']: s for s in slides_with_page}

    print(f"[INFO] Local file has {len(slides)} slides, {len(slides_with_page)} with page numbers")
    if slides_with_page:
        print(f"[INFO] Local page range: {slides_with_page[0]['page']} - {slides_with_page[-1]['page']}")

    # ── Step 7: Match and insert ──
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    # Clear old imported headings for THIS part only
    c.execute("DELETE FROM headings WHERE book_id=? AND source='imported'", (book_id,))
    c.execute("DELETE FROM search_index WHERE book_id=? AND source='imported'", (book_id,))

    stats = {'inserted': 0, 'exact': 0, 'synthetic': 0, 'unmatched': 0}

    def _index_for_search(slide_id, text):
        norm = normalize_arabic(text)
        if norm:
            c.execute(
                "INSERT INTO search_index (normalized_text, book_id, slide_id, heading_text, source) VALUES (?,?,?,?,'imported')",
                (norm, book_id, slide_id, text)
            )

    for entry in part_entries:
        # The seq_page from .db is the sequential page number within the part
        # This should match the page numbers in the local HTM file
        target_seq_page = entry['seq_page']

        if target_seq_page is None:
            stats['unmatched'] += 1
            continue

        matched = False

        # Try exact match first
        if target_seq_page in page_lookup:
            c.execute(
                "INSERT INTO headings (book_id, slide_id, level, text, anchor_id, source) VALUES (?,?,?,?,?,'imported')",
                (book_id, page_lookup[target_seq_page]['id'], entry['level'], entry['text'], '')
            )
            _index_for_search(page_lookup[target_seq_page]['id'], entry['text'])
            stats['inserted'] += 1
            stats['exact'] += 1
            matched = True
        else:
            # Try with tolerance
            for delta in range(-PAGE_TOLERANCE, PAGE_TOLERANCE + 1):
                pg = target_seq_page + delta
                if pg in page_lookup:
                    c.execute(
                        "INSERT INTO headings (book_id, slide_id, level, text, anchor_id, source) VALUES (?,?,?,?,?,'imported')",
                        (book_id, page_lookup[pg]['id'], entry['level'], entry['text'], '')
                    )
                    _index_for_search(page_lookup[pg]['id'], entry['text'])
                    stats['inserted'] += 1
                    stats['exact'] += 1
                    matched = True
                    break

        if not matched:
            # Nearest slide fallback
            best = None
            best_diff = float('inf')
            for s in slides_with_page:
                diff = abs(s['page'] - target_seq_page) if s['page'] else 999
                if diff < best_diff:
                    best_diff = diff
                    best = s

            if best and best_diff <= 5:
                aid = f"synth-{best['id']}-{stats['synthetic']}"
                new_html = inject_synthetic_anchor(best['html'], entry['text'], aid)
                if new_html != best['html']:
                    c.execute("UPDATE slides SET html_content=? WHERE id=?", (new_html, best['id']))
                c.execute(
                    "INSERT INTO headings (book_id, slide_id, level, text, anchor_id, source) VALUES (?,?,?,?,?,'imported')",
                    (book_id, best['id'], entry['level'], entry['text'], aid)
                )
                _index_for_search(best['id'], entry['text'])
                stats['inserted'] += 1
                stats['synthetic'] += 1
            else:
                stats['unmatched'] += 1

    c.execute("UPDATE books SET shamela_id=? WHERE id=?", (str(book_id_input), book_id))
    conn.commit()
    conn.close()

    return {
        'status': 'ok',
        'source': 'db',
        'matched': stats['inserted'],
        'exact': stats['exact'],
        'synthetic': stats['synthetic'],
        'unmatched': stats['unmatched'] + len(unmatched_pages),
        'total': len(toc_entries),
        'part': local_part,
        'part_entries': len(part_entries),
    }


# ═══════════════════════════════════════════════════════════════
#  TOC IMPORT — LOCAL HTML SOURCE (new, additive)
#
#  Identical in every respect to import_toc_for_book() above — same book-
#  type detection, same .db page-map, same part filtering, same page-
#  matching/tolerance/synthetic-anchor logic, same headings/search_index
#  writes — except step 4 reads toc/{book_title}.html from disk via
#  parse_local_toc_html() instead of live-fetching shamela.ws via
#  fetch_shamela_toc(). Kept as a fully separate function (rather than
#  refactored to share code with import_toc_for_book) specifically so the
#  existing, already-verified Shamela-import path is never touched.
# ═══════════════════════════════════════════════════════════════

def import_toc_for_book_local(book_id):
    """Import TOC for a single part or single-volume book from a locally
    saved Shamela book-page HTML file (toc/{book_title}.html), using the
    local .db as the page map — same algorithm as import_toc_for_book(),
    different TOC source."""
    # ── Step 1: Determine book type and local part ──
    book_folder = get_book_folder(book_id)
    if not book_folder:
        return {'status': 'error', 'message': 'تعذر تحديد مجلد الكتاب'}

    is_single_volume = is_single_volume_book(book_id)

    if is_single_volume:
        local_part = None
        print(f"[INFO] Book {book_id} detected as single-volume (local TOC)")
    else:
        local_part = detect_local_part_name(book_id)
        if not local_part:
            return {'status': 'error', 'message': 'تعذر تحديد رقم الجزء من اسم الملف'}
        print(f"[INFO] Local file detected as part: '{local_part}' (local TOC)")

    # ── Step 2: Find .db ──
    db_path = find_shamela_db(book_folder)
    if not db_path:
        return {
            'status': 'error',
            'message': 'لم يتم العثور على قاعدة بيانات Shamela في مجلد الكتاب. '
                      'يرجى وضع ملف .db في نفس المجلد أو الضغط على "ربط قاعدة بيانات".'
        }

    is_valid, error = validate_shamela_db(db_path)
    if not is_valid:
        return {'status': 'error', 'message': f'قاعدة البيانات غير صالحة: {error}'}

    # ── Step 3: Build comprehensive mapping from .db ──
    s_conn = sqlite3.connect(str(db_path))
    s_c = s_conn.cursor()
    s_c.execute("SELECT id, part, page, number FROM page WHERE page IS NOT NULL ORDER BY id")
    page_rows = s_c.fetchall()
    s_conn.close()

    abs_page_map = {}
    for page_id, part, seq_page, number in page_rows:
        abs_page_map[page_id] = (str(part) if part else None, seq_page)

    print(f"[INFO] .db has {len(abs_page_map)} pages (local TOC)")

    # ── Step 4: Read the locally saved TOC HTML ──
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    # Use books.folder (the subfolder/book name) rather than books.title
    # (the part filename stem like "الكتاب") as the TOC file lookup key.
    # books.folder is shared across all parts of the same multi-part book,
    # so one single toc/{folder}.html file serves every part — no need to
    # maintain one copy per part.
    c.execute("SELECT folder FROM books WHERE id=?", (book_id,))
    row = c.fetchone()
    conn.close()
    if not row:
        return {'status': 'error', 'message': 'تعذر تحديد مجلد الكتاب'}
    book_folder_name = row[0]

    toc_path = find_local_toc_file(book_folder_name)
    if not toc_path:
        return {
            'status': 'error',
            'message': f'لم يتم العثور على ملف الفهرس المحلي. ضع الملف في مجلد '
                      f'"toc" بجانب app.py باسم "{book_folder_name}.html".'
        }

    # ── Author extraction (best-effort, independent of TOC-tree parsing
    # below) — same file, different section of the page. Applied to every
    # part sharing this folder, since one toc/{folder}.html file covers the
    # whole multi-part book, same as the TOC entries themselves. ──
    author = parse_local_toc_author(toc_path)
    if author:
        conn = sqlite3.connect(DB_PATH)
        conn.execute("UPDATE books SET author=? WHERE folder=?", (author, book_folder_name))
        conn.commit()
        conn.close()

    toc_entries = parse_local_toc_html(toc_path)
    if not toc_entries:
        return {'status': 'error', 'message': 'لم يتم العثور على فهرس صالح داخل ملف الـHTML المحلي.'}

    print(f"[INFO] Local TOC file has {len(toc_entries)} entries")

    # ── Step 5: Filter TOC entries ──
    part_entries = []
    unmatched_pages = []

    for entry in toc_entries:
        abs_page_id = entry['abs_page']

        if abs_page_id not in abs_page_map:
            unmatched_pages.append(entry)
            continue

        db_part, seq_page = abs_page_map[abs_page_id]

        if is_single_volume:
            part_entries.append({
                'level': entry['level'],
                'text': entry['text'],
                'abs_page_id': abs_page_id,
                'seq_page': seq_page,
            })
        else:
            db_part_norm = normalize_part(db_part)
            local_part_norm = normalize_part(local_part)
            if db_part_norm == local_part_norm:
                part_entries.append({
                    'level': entry['level'],
                    'text': entry['text'],
                    'abs_page_id': abs_page_id,
                    'seq_page': seq_page,
                })

    if is_single_volume:
        print(f"[INFO] Single-volume: importing all {len(part_entries)} TOC entries (local)")
    else:
        print(f"[INFO] Filtered to {len(part_entries)} entries for part '{local_part}' (local)")

    if not part_entries:
        if is_single_volume:
            return {
                'status': 'error',
                'message': 'لا توجد عناوين في الفهرس المحلي. قد يكون ترقيم الصفحات مختلفاً.'
            }
        else:
            return {
                'status': 'error',
                'message': f'لا توجد عناوين للجزء {local_part} في الفهرس المحلي. '
                          f'تأكد من رقم الجزء في اسم الملف أو محتوى الكتاب.'
            }

    # ── Step 6: Get local slides with page numbers ──
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, slide_number, html_content FROM slides WHERE book_id=? ORDER BY slide_number", (book_id,))
    slides = []
    for sid, snum, html in c.fetchall():
        m = LOCAL_PAGENUMBER_SPAN_RE.search(html[:800])
        page_num = int(m.group(1)) if m else None
        slides.append({'id': sid, 'num': snum, 'page': page_num, 'html': html})
    conn.close()

    slides_with_page = [s for s in slides if s['page'] is not None]
    page_lookup = {s['page']: s for s in slides_with_page}

    print(f"[INFO] Local file has {len(slides)} slides, {len(slides_with_page)} with page numbers")
    if slides_with_page:
        print(f"[INFO] Local page range: {slides_with_page[0]['page']} - {slides_with_page[-1]['page']}")

    # ── Step 7: Match and insert ──
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("DELETE FROM headings WHERE book_id=? AND source='imported'", (book_id,))
    c.execute("DELETE FROM search_index WHERE book_id=? AND source='imported'", (book_id,))

    stats = {'inserted': 0, 'exact': 0, 'synthetic': 0, 'unmatched': 0}

    def _index_for_search(slide_id, text):
        norm = normalize_arabic(text)
        if norm:
            c.execute(
                "INSERT INTO search_index (normalized_text, book_id, slide_id, heading_text, source) VALUES (?,?,?,?,'imported')",
                (norm, book_id, slide_id, text)
            )

    for entry in part_entries:
        target_seq_page = entry['seq_page']

        if target_seq_page is None:
            stats['unmatched'] += 1
            continue

        matched = False

        if target_seq_page in page_lookup:
            c.execute(
                "INSERT INTO headings (book_id, slide_id, level, text, anchor_id, source) VALUES (?,?,?,?,?,'imported')",
                (book_id, page_lookup[target_seq_page]['id'], entry['level'], entry['text'], '')
            )
            _index_for_search(page_lookup[target_seq_page]['id'], entry['text'])
            stats['inserted'] += 1
            stats['exact'] += 1
            matched = True
        else:
            for delta in range(-PAGE_TOLERANCE, PAGE_TOLERANCE + 1):
                pg = target_seq_page + delta
                if pg in page_lookup:
                    c.execute(
                        "INSERT INTO headings (book_id, slide_id, level, text, anchor_id, source) VALUES (?,?,?,?,?,'imported')",
                        (book_id, page_lookup[pg]['id'], entry['level'], entry['text'], '')
                    )
                    _index_for_search(page_lookup[pg]['id'], entry['text'])
                    stats['inserted'] += 1
                    stats['exact'] += 1
                    matched = True
                    break

        if not matched:
            best = None
            best_diff = float('inf')
            for s in slides_with_page:
                diff = abs(s['page'] - target_seq_page) if s['page'] else 999
                if diff < best_diff:
                    best_diff = diff
                    best = s

            if best and best_diff <= 5:
                aid = f"synth-{best['id']}-{stats['synthetic']}"
                new_html = inject_synthetic_anchor(best['html'], entry['text'], aid)
                if new_html != best['html']:
                    c.execute("UPDATE slides SET html_content=? WHERE id=?", (new_html, best['id']))
                c.execute(
                    "INSERT INTO headings (book_id, slide_id, level, text, anchor_id, source) VALUES (?,?,?,?,?,'imported')",
                    (book_id, best['id'], entry['level'], entry['text'], aid)
                )
                _index_for_search(best['id'], entry['text'])
                stats['inserted'] += 1
                stats['synthetic'] += 1
            else:
                stats['unmatched'] += 1

    conn.commit()
    conn.close()

    return {
        'status': 'ok',
        'source': 'local',
        'matched': stats['inserted'],
        'exact': stats['exact'],
        'synthetic': stats['synthetic'],
        'unmatched': stats['unmatched'] + len(unmatched_pages),
        'total': len(toc_entries),
        'part': local_part,
        'part_entries': len(part_entries),
    }


# ═══════════════════════════════════════════════════════════════
#  UNIVERSAL LOCAL TOC IMPORT (library-wide sweep, background job)
# ═══════════════════════════════════════════════════════════════
# Runs import_toc_for_book_local() across every book, in a background
# thread so the request that starts it returns immediately — the
# frontend polls _toc_import_job's state instead of blocking on one
# long request. Each book's import is already one all-or-nothing DB
# transaction (see import_toc_for_book_local above), so the loop only
# ever checks the stop flag *between* books: stopping mid-run can never
# leave a single book half-imported, only leave later books untouched.
#
# Default behavior skips any book that already has headings with
# source='imported' — treating "already has an imported TOC" as done.
# Passing force=True instead redoes every book regardless (the same
# per-book override the individual button already gives you, just
# applied library-wide).

_toc_import_lock = threading.Lock()
_toc_import_job = {
    'running': False,
    'stop_requested': False,
    'stopped_early': False,
    'total_books': 0,
    'processed': 0,
    'current_book_title': None,
    'imported': [],
    'skipped': [],
    'failed': [],
}


def _run_toc_import_all(force):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, title FROM books ORDER BY sort_num, id")
    all_books = c.fetchall()
    conn.close()

    with _toc_import_lock:
        _toc_import_job['running'] = True
        _toc_import_job['stop_requested'] = False
        _toc_import_job['stopped_early'] = False
        _toc_import_job['total_books'] = len(all_books)
        _toc_import_job['processed'] = 0
        _toc_import_job['current_book_title'] = None
        _toc_import_job['imported'] = []
        _toc_import_job['skipped'] = []
        _toc_import_job['failed'] = []

    for book_id, title in all_books:
        with _toc_import_lock:
            if _toc_import_job['stop_requested']:
                _toc_import_job['stopped_early'] = True
                break
            _toc_import_job['current_book_title'] = title

        if not force:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            c.execute(
                "SELECT 1 FROM headings WHERE book_id=? AND source='imported' LIMIT 1",
                (book_id,)
            )
            already_imported = c.fetchone() is not None
            conn.close()
            if already_imported:
                with _toc_import_lock:
                    _toc_import_job['skipped'].append({'id': book_id, 'title': title})
                    _toc_import_job['processed'] += 1
                continue

        try:
            result = import_toc_for_book_local(book_id)
        except Exception as e:
            result = {'status': 'error', 'message': f'خطأ غير متوقع: {e}'}

        with _toc_import_lock:
            if result.get('status') == 'ok':
                _toc_import_job['imported'].append({
                    'id': book_id, 'title': title,
                    'matched': result.get('matched', 0), 'total': result.get('total', 0),
                })
            else:
                _toc_import_job['failed'].append({
                    'id': book_id, 'title': title,
                    'message': result.get('message', 'خطأ غير معروف'),
                })
            _toc_import_job['processed'] += 1

    with _toc_import_lock:
        _toc_import_job['running'] = False
        _toc_import_job['current_book_title'] = None


# ═══════════════════════════════════════════════════════════════
#  EMBEDDINGS  (semantic retrieval for /api/ask)
# ═══════════════════════════════════════════════════════════════
# A single embedding provider is chosen once, at startup, and used both to
# index the library's content AND to embed incoming questions — mixing
# providers would make cosine similarity meaningless, since each model's
# vectors live in a different space. Gemini is preferred when available
# (it's normally the user's primary configured agent); Mistral is used if
# only its key is set. If neither is configured, /api/ask transparently
# falls back to the existing keyword (FTS) retrieval — nothing breaks.

EMBEDDING_PROVIDER = 'gemini' if (AI_AGENTS['gemini']['enabled'] or GEMINI_EMBED_KEYS) else ('mistral' if AI_AGENTS['mistral']['enabled'] else None)

MISTRAL_EMBED_MODEL = 'mistral-embed'
MISTRAL_EMBED_URL = 'https://api.mistral.ai/v1/embeddings'

EMBED_BATCH_SIZE = EMBED_BATCH_SIZE_CFG
EMBED_MAX_CHARS  = EMBED_MAX_CHARS_CFG

# ── Ask retrieval tuning ──
# All values below come from config.ini — edit there, no code change needed.
ASK_TOP_K = ASK_TOP_K_CFG


def embed_texts_gemini(texts, api_key):
    """
    Sends a batch embedding request to Gemini. 
    Handles 429 (Too Many Requests) with exponential backoff retries.
    Returns None if retries are exhausted to trip the circuit breaker.
    """
    requests_payload = [
        {"model": f"models/{GEMINI_EMBED_MODEL}", "content": {"parts": [{"text": t}]}}
        for t in texts
    ]
    
    max_retries = EMBED_MAX_RETRIES_CFG
    base_delay = EMBED_BASE_DELAY_CFG

    for attempt in range(max_retries):
        try:
            resp = requests.post(
                f"{GEMINI_EMBED_URL}?key={api_key}",
                json={"requests": requests_payload},
                headers={"Content-Type": "application/json"},
                timeout=API_TIMEOUT  # Don't let a single hang freeze the server
            )

            # If rate-limited, wait and retry up to max_retries
            if resp.status_code == 429:
                delay = base_delay * (2 ** attempt)
                print(f"[WARN] Gemini embedding rate-limited (429). Attempt {attempt + 1}/{max_retries}. Retrying in {delay}s...")
                time.sleep(delay)
                continue

            resp.raise_for_status()
            data = resp.json()
            return [e['values'] for e in data.get('embeddings', [])]

        except Exception as e:
            print(f"[WARN] Exception during Gemini embedding attempt {attempt + 1}: {e}")
            # If it's the last attempt, don't retry, let it fall through to return None
            if attempt < max_retries - 1:
                time.sleep(base_delay * (2 ** attempt))
                
    # If we got here, all attempts failed. 
    # Returning None safely activates your existing circuit breaker downstream.
    return None


def embed_texts_mistral(texts, api_key):
    resp = requests.post(
        MISTRAL_EMBED_URL,
        json={"model": MISTRAL_EMBED_MODEL, "input": texts},
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        timeout=API_TIMEOUT
    )
    resp.raise_for_status()
    data = resp.json()
    # Mistral returns an "index" per item — sort defensively to guarantee
    # the result lines up with the input order even if the API ever
    # reorders them.
    items = sorted(data.get('data', []), key=lambda d: d.get('index', 0))
    return [item['embedding'] for item in items]


def embed_texts(texts, api_key):
    """Embed a batch of texts using the configured provider and a specific
    api_key. Returns a list of vectors or None on failure."""
    if not texts:
        return []
    if EMBEDDING_PROVIDER == 'gemini':
        return embed_texts_gemini(texts, api_key)
    elif EMBEDDING_PROVIDER == 'mistral':
        return embed_texts_mistral(texts, MISTRAL_API_KEY)
    return None


def embed_query(text):
    """Embed a single query for semantic retrieval at ask-time.
    Uses the dedicated Ask key (gemini_api_key_ask) if configured, otherwise
    falls back to the primary (first) configured key — key rotation is only
    for the bulk embedding run, not individual question embeddings."""
    key = GEMINI_ASK_EMBED_KEY or (GEMINI_EMBED_KEYS[0] if GEMINI_EMBED_KEYS else GEMINI_KEY)
    result = embed_texts([text], key)
    return result[0] if result else None


# ── Per-key consecutive-failure threshold ──
# If a key fails this many batches in a row, it's considered daily-exhausted
# and the rotation moves to the next key. Set to 1 deliberately: on the
# Gemini free tier, a 429 here reliably means the day's quota for that key
# is used up (not a transient hiccup), so there's no benefit to retrying
# the same key again — better to rotate immediately to the next one.
KEY_EXHAUST_THRESHOLD = 1


def get_vec_conn():
    """A sqlite3 connection with the sqlite-vec extension loaded — needed
    anywhere vec_embeddings is read from or written to. A plain
    sqlite3.connect(DB_PATH) can still be used everywhere else in the app
    that never touches vec_embeddings (search, TOC, books, etc.)."""
    conn = sqlite3.connect(DB_PATH)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def generate_embeddings_run():
    """Standalone embedding generation run — called by the dedicated /api/embed
    route, completely separate from scan_library.

    Finds every slide in the library that has no embedding yet, then processes
    them in batches using the configured embedding provider. Supports multiple
    API keys (GEMINI_EMBED_KEYS): exhausts each key fully before rotating to
    the next. A key is considered exhausted when it fails KEY_EXHAUST_THRESHOLD
    consecutive batches — distinguishing a genuine daily quota limit from a
    transient error. All keys exhausted → stops and reports how far it got.

    Returns a stats dict for the frontend to display.
    """
    if EMBEDDING_PROVIDER is None:
        return {
            'status': 'error',
            'message': 'لا يوجد مزود تمثيلات دلالية مضبوط. أضف مفتاح API في config.ini.',
        }

    keys = list(GEMINI_EMBED_KEYS) if EMBEDDING_PROVIDER == 'gemini' else [MISTRAL_API_KEY]
    if not keys:
        return {'status': 'error', 'message': 'لا توجد مفاتيح API مضبوطة للتمثيلات الدلالية.'}

    conn = get_vec_conn()
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    c = conn.cursor()

    # ── Coverage snapshot before run (for transparent reporting) ──
    c.execute("SELECT COUNT(*) FROM slides")
    total_slides = c.fetchone()[0]
    c.execute("SELECT COUNT(*) FROM embeddings")
    before_count = c.fetchone()[0]

    is_rebuild = (total_slides > 0 and before_count < total_slides * 0.5)
    if is_rebuild:
        print(f"[WARN] Embedding coverage is {before_count}/{total_slides} — "
              f"this run will rebuild most embeddings from scratch.")

    # ── Collect all slides missing embeddings ──
    c.execute("""
        SELECT s.id, s.book_id, s.plain_text FROM slides s
        LEFT JOIN embeddings e ON e.slide_id = s.id
        WHERE e.slide_id IS NULL AND s.plain_text IS NOT NULL AND s.plain_text != ''
        ORDER BY s.book_id, s.id
    """)
    missing = c.fetchall()

    if not missing:
        conn.close()
        return {
            'status': 'ok',
            'embedded': 0,
            'skipped': 0,
            'total_missing': 0,
            'keys_exhausted': 0,
            'is_rebuild': is_rebuild,
            'before_count': before_count,
            'message': 'جميع الصفحات لديها تمثيلات دلالية بالفعل. لا شيء يحتاج معالجة.',
        }

    print(f"[INFO] Embedding run: {len(missing)} slides missing embeddings across library.")

    # ── Key rotation state ──
    key_index = 0
    consecutive_failures = 0
    keys_exhausted = 0
    stored = 0
    skipped = 0
    all_keys_dead = False

    texts = [row[2][:EMBED_MAX_CHARS] for row in missing]
    ids = [row[0] for row in missing]
    book_ids = [row[1] for row in missing]

    # ── Key rotation state ──
    key_index = 0
    consecutive_failures = 0
    keys_exhausted = 0
    stored = 0
    skipped = 0
    i = 0  # batch index — only advances on success, stays on failure for retry
    vec_synced = 0
    vec_sync_error = None

    while i < len(texts):
        if all_keys_dead:
            skipped += len(texts) - i
            break

        batch_texts = texts[i:i + EMBED_BATCH_SIZE]
        batch_ids = ids[i:i + EMBED_BATCH_SIZE]
        batch_book_ids = book_ids[i:i + EMBED_BATCH_SIZE]

        current_key = keys[key_index]
        vectors = embed_texts(batch_texts, current_key)

        if not vectors or len(vectors) != len(batch_texts):
            consecutive_failures += 1
            print(f"[WARN] Batch {i // EMBED_BATCH_SIZE + 1} failed with key #{key_index + 1} "
                  f"(consecutive failures: {consecutive_failures}/{KEY_EXHAUST_THRESHOLD})")

            if consecutive_failures >= KEY_EXHAUST_THRESHOLD:
                keys_exhausted += 1
                print(f"[WARN] Key #{key_index + 1} considered daily-exhausted after "
                      f"{KEY_EXHAUST_THRESHOLD} consecutive failures.")
                key_index += 1
                consecutive_failures = 0

                if key_index >= len(keys):
                    print("[WARN] All embedding keys exhausted — stopping run.")
                    all_keys_dead = True
                    skipped += len(texts) - i
                    break
                else:
                    print(f"[INFO] Rotating to key #{key_index + 1}.")
            # Do NOT advance i — retry this same batch with the current or new key
            continue

        consecutive_failures = 0  # successful batch resets the failure counter
        rows = [(sid, bid, json.dumps(vec), EMBEDDING_PROVIDER)
                for sid, bid, vec in zip(batch_ids, batch_book_ids, vectors)]
        c.executemany(
            "INSERT OR REPLACE INTO embeddings (slide_id, book_id, vector, model) VALUES (?,?,?,?)",
            rows
        )
        # Keep vec_embeddings (the fast, binary lookup table used by
        # retrieve_via_embeddings) in sync as embeddings are written,
        # rather than needing a separate rebuild step afterwards. Silently
        # skipped if the table doesn't exist yet (e.g. the one-time
        # migration script hasn't been run) — embeddings itself is always
        # the source of truth, so nothing is lost, and running the
        # migration script later will pick these rows up too.
        if VEC_AVAILABLE:
            try:
                c.executemany(
                    "INSERT OR REPLACE INTO vec_embeddings(rowid, embedding, book_id) VALUES (?, ?, ?)",
                    [(sid, sqlite_vec.serialize_float32(vec), bid)
                     for sid, bid, vec in zip(batch_ids, batch_book_ids, vectors)]
                )
                vec_synced += len(rows)
            except sqlite3.OperationalError as e:
                vec_sync_error = str(e)  # reported once in the final summary below
        conn.commit()
        stored += len(rows)
        i += EMBED_BATCH_SIZE  # only advance on success
        time.sleep(EMBED_BATCH_SLEEP_CFG)  # Pacing between batches to respect free-tier TPM limits

    conn.commit()
    conn.close()

    if not VEC_AVAILABLE:
        print("[WARN] sqlite-vec not installed — new embeddings were NOT synced to "
              "vec_embeddings. Semantic search will use the slower brute-force fallback "
              "until this is installed and migrate_embeddings_to_vec.py is (re-)run.")
    elif vec_sync_error:
        print(f"[WARN] vec_embeddings sync failed partway through this run: {vec_sync_error} "
              f"— {vec_synced}/{stored} new embeddings made it in. Run migrate_embeddings_to_vec.py "
              f"to sync the rest (it also picks up anything already in the `embeddings` table).")
    elif stored > 0:
        print(f"[INFO] vec_embeddings sync: {vec_synced}/{stored} new embeddings synced successfully.")

    return {
        'status': 'ok' if not all_keys_dead else 'partial',
        'embedded': stored,
        'skipped': skipped,
        'total_missing': len(missing),
        'keys_exhausted': keys_exhausted,
        'is_rebuild': is_rebuild,
        'before_count': before_count,
    }


def cosine_similarity(a, b):
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# ═══════════════════════════════════════════════════════════════
#  SQLITE-VEC SEMANTIC SEARCH
#
#  Replaces the brute-force Python cosine-similarity loop (which was
#  scanning all ~200K+ vectors on every single AI question, loaded fresh
#  from SQLite/JSON each time) with sqlite-vec — a SQLite extension that
#  stores vectors as compact binary and does the similarity search inside
#  SQLite itself, in C. Unlike the earlier FAISS-based approach, there is
#  no separate "load the whole index into RAM" step at all: SQLite reads
#  only the pages a given query actually touches, the same way it already
#  does for every other table in this app (slides, headings, etc.), so
#  memory use no longer scales with total library size, and there's no
#  multi-second index-load cost on first use each session.
# ═══════════════════════════════════════════════════════════════

def retrieve_via_embeddings(question, top_k=ASK_TOP_K, book_ids=None):
    """Semantic retrieval: embed the question, then search via the
    vec_embeddings virtual table (sqlite-vec) for the top_k most similar
    slides. Falls back to the original brute-force cosine loop if
    sqlite-vec isn't installed or vec_embeddings hasn't been created yet
    (e.g. before migrate_embeddings_to_vec.py has been run). Returns None
    (not []) if embeddings aren't usable at all, so the caller knows to
    fall back to keyword search instead of concluding 'no relevant
    passages exist'.

    book_ids: optional list/set of book IDs to scope retrieval to (from the
    Ask panel's multi-book picker). None/empty means library-wide, unchanged
    from the original behavior. When scoped, filtering happens inside the
    vec MATCH query itself via vec_embeddings' book_id partition key column
    (added by migrate_embeddings_to_vec.py) — this is an exact pre-filter,
    not an approximation: only the selected books' vectors are ever ranked,
    so scoped results can never be starved by unrelated library-wide
    matches, no matter how narrow the scope or how large the library."""
    if EMBEDDING_PROVIDER is None:
        return None

    q_vec = embed_query(question)
    if not q_vec:
        return None

    if VEC_AVAILABLE:
        try:
            conn = get_vec_conn()
            c = conn.cursor()
            if book_ids:
                book_placeholders = ','.join('?' * len(book_ids))
                c.execute(f"""
                    SELECT rowid, distance FROM vec_embeddings
                    WHERE embedding MATCH ? AND k = ? AND book_id IN ({book_placeholders})
                    ORDER BY distance
                """, [sqlite_vec.serialize_float32(q_vec), top_k] + list(book_ids))
            else:
                c.execute("""
                    SELECT rowid, distance FROM vec_embeddings
                    WHERE embedding MATCH ? AND k = ?
                    ORDER BY distance
                """, (sqlite_vec.serialize_float32(q_vec), top_k))
            matched = c.fetchall()  # [(slide_id, distance), ...] ranked nearest-first
        except sqlite3.OperationalError as e:
            print(f"[WARN] vec_embeddings query failed, falling back: {e}")
            matched = None  # vec_embeddings doesn't exist yet, or lacks book_id — see migrate_embeddings_to_vec.py
            conn.close()
        else:
            matched_slide_ids = [row[0] for row in matched]
            if not matched_slide_ids:
                conn.close()
                return [], []

            # Defensive cap: the query above already asks for k=top_k nearest
            # neighbors, but some sqlite-vec versions/configurations can
            # still return more rows than that. Without this, the IN (...)
            # clause below gets one placeholder per row and can blow past
            # SQLite's SQL variable limit ("too many SQL variables") on a
            # large library. Trimming here — before the placeholders are
            # built — keeps this query safe no matter what MATCH returns.
            matched_slide_ids = matched_slide_ids[:top_k]

            # distance is sqlite-vec's L2 distance (lower = more similar), not
            # a 0-1 score. Converted to a rough 0-1 similarity for display
            # purposes only — not used for ranking, since `matched` above is
            # already correctly distance-ordered.
            distance_by_id = {row[0]: row[1] for row in matched}

            placeholders = ','.join('?' * len(matched_slide_ids))
            c.execute(f"""
                SELECT sl.id, sl.book_id, b.title, b.part_label, sl.slide_number, sl.plain_text,
                       (SELECT text FROM headings h WHERE h.slide_id = sl.id ORDER BY h.id LIMIT 1) AS heading
                FROM slides sl
                JOIN books b ON sl.book_id = b.id
                WHERE sl.id IN ({placeholders})
            """, matched_slide_ids)
            info_by_id = {row[0]: row[1:] for row in c.fetchall()}

            # ── Batch-fetch neighbor slides (prev/next by slide_number within same book) ──
            # Build a lookup: (book_id, slide_number) → plain_text for all
            # neighbors needed, in a single query.
            neighbor_keys = set()
            for sid in matched_slide_ids:
                if sid not in info_by_id:
                    continue
                book_id, _title, _pl, slide_number, _pt, _h = info_by_id[sid]
                neighbor_keys.add((book_id, slide_number - 1))
                neighbor_keys.add((book_id, slide_number + 1))

            neighbor_text = {}  # (book_id, slide_number) → plain_text
            if neighbor_keys:
                # SQLite doesn't support tuple-IN, so use OR-expanded WHERE.
                or_clauses = ' OR '.join(
                    '(book_id = ? AND slide_number = ?)' for _ in neighbor_keys
                )
                nb_params = [v for pair in neighbor_keys for v in pair]
                c.execute(
                    f"SELECT book_id, slide_number, plain_text FROM slides WHERE {or_clauses}",
                    nb_params
                )
                for nb_book_id, nb_slide_num, nb_text in c.fetchall():
                    neighbor_text[(nb_book_id, nb_slide_num)] = nb_text or ''

            conn.close()

            # Preserve vec_embeddings' distance-ranked order (info_by_id
            # lookup doesn't guarantee order, so rebuild in ranked sequence).
            passages = []
            refs = []
            for sid in matched_slide_ids:
                if sid not in info_by_id:
                    continue
                if len(passages) >= top_k:
                    break
                book_id, title, part_label, slide_number, plain_text, heading = info_by_id[sid]
                label = heading if heading else f"صفحة {slide_number}"
                if part_label:
                    title = f"{title} - ج{part_label}"
                similarity = 1.0 / (1.0 + max(distance_by_id.get(sid, 0.0), 0.0))

                # ── Neighbor stitching ──
                # Matched page gets priority up to the full cap; whatever
                # budget remains is split evenly between prev and next.
                cap = ASK_PASSAGE_CHAR_CAP
                matched_text = (plain_text or '')[:cap]
                parts = [f"[المصدر: {title} - {label} (تشابه: {similarity:.2f})]"]
                if NEIGHBOR_STITCHING:
                    leftover = cap - len(matched_text)
                    neighbor_budget = leftover // 2
                    prev_text = neighbor_text.get((book_id, slide_number - 1), '')
                    next_text = neighbor_text.get((book_id, slide_number + 1), '')
                    if prev_text and neighbor_budget > 0:
                        parts.append(f"--- (سياق من الصفحة السابقة) ---\n{prev_text[-neighbor_budget:]}")
                parts.append(matched_text)
                if NEIGHBOR_STITCHING:
                    if next_text and neighbor_budget > 0:
                        parts.append(f"--- (تتمة من الصفحة التالية) ---\n{next_text[:neighbor_budget]}")

                passages.append('\n'.join(parts))
                refs.append({'book_id': book_id, 'slide_number': slide_number, 'title': title, 'label': label})
            return passages, refs

    # ── Fallback: brute-force cosine loop (sqlite-vec unavailable/not migrated yet) ──
    print("[INFO] vec_embeddings unavailable — using brute-force cosine fallback "
          "(slower). Run migrate_embeddings_to_vec.py to build it.")
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    book_filter = ""
    params = []
    if book_ids:
        book_placeholders = ','.join('?' * len(book_ids))
        book_filter = f" WHERE e.book_id IN ({book_placeholders})"
        params = list(book_ids)
    c.execute(f"""
        SELECT e.slide_id, e.book_id, e.vector, b.title, b.part_label, sl.slide_number, sl.plain_text,
               (SELECT text FROM headings h WHERE h.slide_id = e.slide_id ORDER BY h.id LIMIT 1) AS heading
        FROM embeddings e
        JOIN books b ON e.book_id = b.id
        JOIN slides sl ON e.slide_id = sl.id
        {book_filter}
    """, params)
    rows = c.fetchall()

    if not rows:
        conn.close()
        return None

    scored = []
    for slide_id, book_id, vector_json, title, part_label, slide_number, plain_text, heading in rows:
        try:
            vec = json.loads(vector_json)
        except (TypeError, ValueError):
            continue
        scored.append((cosine_similarity(q_vec, vec), book_id, title, part_label, slide_number, plain_text, heading))

    scored.sort(key=lambda x: x[0], reverse=True)

    # ── Batch-fetch neighbor slides for top_k results ──
    neighbor_keys = set()
    for score, book_id, title, part_label, slide_number, plain_text, heading in scored[:top_k]:
        neighbor_keys.add((book_id, slide_number - 1))
        neighbor_keys.add((book_id, slide_number + 1))

    neighbor_text = {}
    if neighbor_keys:
        or_clauses = ' OR '.join(
            '(book_id = ? AND slide_number = ?)' for _ in neighbor_keys
        )
        nb_params = [v for pair in neighbor_keys for v in pair]
        c.execute(
            f"SELECT book_id, slide_number, plain_text FROM slides WHERE {or_clauses}",
            nb_params
        )
        for nb_book_id, nb_slide_num, nb_text in c.fetchall():
            neighbor_text[(nb_book_id, nb_slide_num)] = nb_text or ''

    conn.close()

    passages = []
    refs = []
    for score, book_id, title, part_label, slide_number, plain_text, heading in scored[:top_k]:
        label = heading if heading else f"صفحة {slide_number}"
        if part_label:
            title = f"{title} - ج{part_label}"
        # score here is cosine similarity itself (already 0-1-ish), unlike
        # the vec_embeddings branch above which has to derive one from an
        # L2 distance — shown as-is.

        # ── Neighbor stitching ──
        cap = ASK_PASSAGE_CHAR_CAP
        matched_text = (plain_text or '')[:cap]
        parts = [f"[المصدر: {title} - {label} (تشابه: {score:.2f})]"]
        if NEIGHBOR_STITCHING:
            leftover = cap - len(matched_text)
            neighbor_budget = leftover // 2
            prev_text = neighbor_text.get((book_id, slide_number - 1), '')
            next_text = neighbor_text.get((book_id, slide_number + 1), '')
            if prev_text and neighbor_budget > 0:
                parts.append(f"--- (سياق من الصفحة السابقة) ---\n{prev_text[-neighbor_budget:]}")
        parts.append(matched_text)
        if NEIGHBOR_STITCHING:
            if next_text and neighbor_budget > 0:
                parts.append(f"--- (تتمة من الصفحة التالية) ---\n{next_text[:neighbor_budget]}")

        passages.append('\n'.join(parts))
        refs.append({'book_id': book_id, 'slide_number': slide_number, 'title': title, 'label': label})
    return passages, refs


def retrieve_via_fts(question, top_k=ASK_TOP_K, book_ids=None):
    """Keyword-search fallback for context retrieval, used when no
    embedding provider is configured or the embedding call itself fails.

    book_ids: optional list/set of book IDs to scope the search to (mirrors
    /api/search's existing scope filter, just applied here for Ask)."""
    norm_q = normalize_arabic(question)
    match_expr = build_fts_match(norm_q, prefix=False)
    if not match_expr:
        return [], []

    book_filter = ""
    book_params = []
    if book_ids:
        book_placeholders = ','.join('?' * len(book_ids))
        book_filter = f" AND s.book_id IN ({book_placeholders})"
        book_params = list(book_ids)

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    rows = []
    try:
        c.execute(f"""
            SELECT sl.book_id, b.title, b.part_label, sl.slide_number, s.heading_text, s.normalized_text
            FROM search_index s
            JOIN books b ON s.book_id = b.id
            JOIN slides sl ON s.slide_id = sl.id
            WHERE s.normalized_text MATCH ? {book_filter}
            ORDER BY rank LIMIT ?
        """, [match_expr] + book_params + [top_k])
        rows = c.fetchall()
    except sqlite3.OperationalError:
        like_q = '%' + escape_like(norm_q) + '%'
        c.execute(f"""
            SELECT sl.book_id, b.title, b.part_label, sl.slide_number, s.heading_text, s.normalized_text
            FROM search_index s
            JOIN books b ON s.book_id = b.id
            JOIN slides sl ON s.slide_id = sl.id
            WHERE s.normalized_text LIKE ? ESCAPE '\\' {book_filter}
            LIMIT ?
        """, [like_q] + book_params + [top_k])
        rows = c.fetchall()

    # ── Batch-fetch neighbor slides ──
    neighbor_keys = set()
    for book_id, title, part_label, slide_number, heading_text, text in rows:
        neighbor_keys.add((book_id, slide_number - 1))
        neighbor_keys.add((book_id, slide_number + 1))

    neighbor_text = {}
    if neighbor_keys:
        or_clauses = ' OR '.join(
            '(book_id = ? AND slide_number = ?)' for _ in neighbor_keys
        )
        nb_params = [v for pair in neighbor_keys for v in pair]
        c.execute(
            f"SELECT book_id, slide_number, plain_text FROM slides WHERE {or_clauses}",
            nb_params
        )
        for nb_book_id, nb_slide_num, nb_text in c.fetchall():
            neighbor_text[(nb_book_id, nb_slide_num)] = nb_text or ''

    conn.close()

    # No similarity score here — FTS5 keyword matching isn't a 0-1-scored
    # ranking the way embeddings are, so only the part title is added,
    # matching what the embeddings paths above now include.
    passages = []
    refs = []
    for book_id, title, part_label, slide_number, heading_text, text in rows:
        label = heading_text if heading_text else f"صفحة {slide_number}"
        if part_label:
            title = f"{title} - ج{part_label}"

        # ── Neighbor stitching ──
        cap = ASK_PASSAGE_CHAR_CAP
        matched_text = (text or '')[:cap]
        parts = [f"[المصدر: {title} - {label}]"]
        if NEIGHBOR_STITCHING:
            leftover = cap - len(matched_text)
            neighbor_budget = leftover // 2
            prev_text = neighbor_text.get((book_id, slide_number - 1), '')
            next_text = neighbor_text.get((book_id, slide_number + 1), '')
            if prev_text and neighbor_budget > 0:
                parts.append(f"--- (سياق من الصفحة السابقة) ---\n{prev_text[-neighbor_budget:]}")
        parts.append(matched_text)
        if NEIGHBOR_STITCHING:
            if next_text and neighbor_budget > 0:
                parts.append(f"--- (تتمة من الصفحة التالية) ---\n{next_text[:neighbor_budget]}")

        passages.append('\n'.join(parts))
        refs.append({'book_id': book_id, 'slide_number': slide_number, 'title': title, 'label': label})
    return passages, refs


def retrieve_context_passages(question, top_k=ASK_TOP_K, book_ids=None):
    result = retrieve_via_embeddings(question, top_k, book_ids=book_ids)
    if result is not None:
        return result
    return retrieve_via_fts(question, top_k, book_ids=book_ids)


def build_ai_prompt(question, context, mode='strict'):
    """Build the prompt with RAG context.

    mode='strict' (default, original behavior): answer only from the
    provided excerpts; say so explicitly if they don't cover the question.

    mode='extended': treat the excerpts as a foundation and permit the
    model to supplement with its own general knowledge, while keeping the
    library excerpts as the primary grounding so the answer stays
    distinguishable between what comes from the user's library and what's
    drawn from the model's own knowledge.
    """
    if mode == 'extended':
        system_prompt = (
            "أنت مساعد بحثي متخصص في النصوص الإسلامية. "
            "استخدم المقتطفات المقدمة أدناه كأساس رئيسي لإجابتك، واستشهد باسم الكتاب والقسم لكل ادعاء مأخوذ منها. "
            "يمكنك إكمال الإجابة وتوسيعها بمعرفتك العامة عند الحاجة لتقديم إجابة أوفى وأكثر فائدة، "
            "لكن وضّح بشكل واضح متى تكون تستند إلى معرفتك العامة بدلاً من المقتطفات المقدمة."
        )
    else:
        system_prompt = (
            "أنت مساعد بحثي متخصص في النصوص الإسلامية. "
            "أجب بناءً فقط على المقتطفات المقدمة أدناه، ولا تستعن بأي معلومة خارجها. "
            "استشهد باسم الكتاب والقسم لكل ادعاء. "
            "اجتهد في استخلاص كل ما تحمله المقتطفات من معلومات ذات صلة بالسؤال، "
            "واعرض إجابتك بشكل مفصّل ووافٍ ما دام النص يسعف بذلك. "
            "إذا لم تحتوِ المقتطفات على إجابة، قل بوضوح أن المعلومة غير موجودة في المكتبة."
        )
    return f"{system_prompt}\n\nالمقتطفات من المكتبة:\n{context}\n\nالسؤال: {question}\n\nالإجابة:"


def call_gemini(prompt, api_key):
    """Call Google Gemini, trying the primary model first and falling back
    to the secondary one if the primary fails for any reason (unavailable,
    quota, transient error, etc.)."""
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": GENERATION_TEMPERATURE, "maxOutputTokens": GEMINI_MAX_OUTPUT_TOKENS}
    }
    last_error = None
    for model in (GEMINI_MODEL, GEMINI_FALLBACK_MODEL):
        try:
            url = GEMINI_GENERATE_URL_TEMPLATE.format(model=model)
            resp = requests.post(
                f"{url}?key={api_key}", json=payload,
                headers={"Content-Type": "application/json"}, timeout=API_TIMEOUT
            )
            resp.raise_for_status()
            return resp.json()['candidates'][0]['content']['parts'][0]['text']
        except Exception as e:
            last_error = e
            continue
    return f"خطأ في الاتصال بـGemini (تمت تجربة {GEMINI_MODEL} و{GEMINI_FALLBACK_MODEL}): {last_error}"


def call_mistral(prompt, api_key):
    """Call Mistral AI."""
    try:
        payload = {
            "model": MISTRAL_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": GENERATION_TEMPERATURE,
            "max_tokens": MISTRAL_MAX_TOKENS
        }
        resp = requests.post(
            MISTRAL_CHAT_URL,
            json=payload,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=API_TIMEOUT
        )
        resp.raise_for_status()
        return resp.json()['choices'][0]['message']['content']
    except Exception as e:
        return f"خطأ في الاتصال بMistral: {str(e)}"


# ═══════════════════════════════════════════════════════════════
#  FTS5 HELPERS
# ═══════════════════════════════════════════════════════════════

def build_fts_match(normalized_query, prefix=True, exact_phrase=False):
    words = re.findall(r'\S+', normalized_query)
    if not words:
        return None
    if exact_phrase:
        # A single quoted FTS5 phrase requires the terms to appear
        # adjacent and in this exact order — this is what actually
        # gives "loose AND-of-terms" search its exact-match counterpart,
        # rather than just re-wrapping each word individually (which
        # FTS5 would still treat as an implicit AND, not a phrase).
        phrase = ' '.join(words).replace('"', '""')
        return f'"{phrase}"'
    parts = []
    for i, w in enumerate(words):
        w_escaped = w.replace('"', '""')
        if prefix and i == len(words) - 1:
            parts.append(f'"{w_escaped}"*')
        else:
            parts.append(f'"{w_escaped}"')
    return ' '.join(parts)


def escape_like(s):
    return s.replace('\\', '\\\\').replace('%', r'\%').replace('_', r'\_')


# ═══════════════════════════════════════════════════════════════
#  API ROUTES
# ═══════════════════════════════════════════════════════════════

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/refresh', methods=['POST'])
def refresh():
    try:
        stats = scan_library()
        return jsonify({'status': 'ok', **stats})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/embed', methods=['POST'])
def embed():
    """Dedicated embedding generation endpoint — runs independently of
    scan_library. Finds all slides missing embeddings and processes them
    with key rotation. Long-running; reports progress on completion."""
    try:
        result = generate_embeddings_run()
        return jsonify({'status': result.get('status', 'ok'), **result})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/rebuild_index', methods=['POST'])
def rebuild_index():
    """Sync vec_embeddings with the embeddings table — a safety net for
    rows that exist in embeddings but are missing from vec_embeddings
    (e.g. added before migrate_embeddings_to_vec.py was ever run, or if
    that table was dropped/corrupted). Normal embedding runs already keep
    the two in sync automatically; this exists for catching up after the
    fact, without needing to touch the command line."""
    if not VEC_AVAILABLE:
        return jsonify({
            'status': 'error',
            'message': 'مكتبة sqlite-vec غير مثبتة. شغّل: pip install sqlite-vec'
        }), 400

    conn = get_vec_conn()
    c = conn.cursor()
    try:
        c.execute("SELECT COUNT(*) FROM vec_embeddings")
    except sqlite3.OperationalError:
        conn.close()
        return jsonify({
            'status': 'error',
            'message': 'جدول vec_embeddings غير موجود بعد — شغّل migrate_embeddings_to_vec.py أولاً.'
        }), 400

    c.execute("""
        SELECT e.slide_id, e.book_id, e.vector FROM embeddings e
        WHERE e.slide_id NOT IN (SELECT rowid FROM vec_embeddings)
    """)
    missing = c.fetchall()
    synced = 0
    for slide_id, book_id, vector_json in missing:
        try:
            vec = json.loads(vector_json)
        except (TypeError, ValueError):
            continue
        c.execute(
            "INSERT OR REPLACE INTO vec_embeddings(rowid, embedding, book_id) VALUES (?, ?, ?)",
            (slide_id, sqlite_vec.serialize_float32(vec), book_id)
        )
        synced += 1
    conn.commit()

    c.execute("SELECT COUNT(*) FROM vec_embeddings")
    total = c.fetchone()[0]
    conn.close()
    return jsonify({'status': 'ok', 'synced': synced, 'vector_count': total})


@app.route('/api/logs')
def get_logs():
    """Polling endpoint for the in-browser console panel. Returns every
    buffered log line newer than `since`, plus `latest` (the newest
    sequence number currently buffered) so the client knows what to pass
    on its next poll. Omitting `since` (or passing 0) returns the whole
    current buffer — used the first time the panel is opened in a
    session, so the user isn't staring at an empty panel and can see
    everything printed since the server started."""
    try:
        since = int(request.args.get('since', 0))
    except (TypeError, ValueError):
        since = 0
    with _log_lock:
        lines = [{'seq': seq, 'text': text} for seq, text in _log_buffer if seq > since]
        latest = _log_seq
    return jsonify({'lines': lines, 'latest': latest})


@app.route('/api/shutdown', methods=['POST'])
def shutdown():
    """Gracefully terminate the server from the UI's 'إيقاف الخادم' button.

    On Windows, start_server.bat launches python.exe inside a *hidden*
    cmd.exe wrapper via PowerShell's Start-Process (cmd.exe is the parent,
    python.exe is its child) — the server has no visible window at all;
    logs/errors are read via the in-browser log panel (📋 السجل) instead.
    taskkill's /T flag only kills *descendants* of the PID you give it, so
    targeting our own PID (python.exe) can never reach upward to close its
    parent cmd.exe process — that hidden process would keep running as an
    orphan after Python exits.

    The fix: start_server.bat saves that wrapping cmd.exe process's own
    PID (returned directly by Start-Process -PassThru, since it's the
    process PowerShell itself launched) to server_pid.txt right after
    starting it. Reading that file and taskkill-ing *that* PID kills the
    wrapper, which takes its python.exe child down as a side effect.

    Falls back to a plain os._exit(0) on this process if the PID file is
    missing/unreadable (e.g. run directly with `python app.py`, bypassing
    start_server.bat entirely) or on non-Windows platforms, where the
    "separate wrapping cmd process" concept doesn't apply in the first
    place.

    Responds first, then exits shortly after on a background timer so the
    response actually reaches the browser before the process disappears
    (mirrors the Hub proxy's _die()/threading.Timer pattern)."""
    def _die():
        killed_wrapper = False
        if os.name == 'nt':
            pid_file = BASE_DIR / 'server_pid.txt'
            try:
                if pid_file.exists():
                    wrapper_pid = pid_file.read_text().strip()
                    if wrapper_pid.isdigit():
                        subprocess.run(
                            ['taskkill', '/F', '/T', '/PID', wrapper_pid],
                            capture_output=True
                        )
                        killed_wrapper = True
            except Exception:
                pass

        if not killed_wrapper:
            # No PID file (not launched via start_server.bat), or the
            # taskkill attempt above failed for some reason — fall back to
            # ending at least this process directly. On Windows this may
            # still leave a wrapping cmd window open with a bare prompt,
            # but the server itself stops either way.
            os._exit(0)

    threading.Timer(0.5, _die).start()
    return jsonify({'status': 'shutting down'})


@app.route('/api/books')
def get_books():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""SELECT id, title, filename, slide_count, shamela_id, path, folder, part_label, author
                 FROM books ORDER BY folder, sort_num, title""")
    rows = c.fetchall()

    # Single query for embedding coverage per book (more efficient than
    # one query per book in the loop below).
    c.execute("""
        SELECT b.id,
               COUNT(s.id) AS total_slides,
               COUNT(e.slide_id) AS embedded_slides
        FROM books b
        LEFT JOIN slides s ON s.book_id = b.id
        LEFT JOIN embeddings e ON e.slide_id = s.id
        GROUP BY b.id
    """)
    embed_coverage = {row[0]: (row[1], row[2]) for row in c.fetchall()}
    conn.close()

    result = []
    for r in rows:
        folder = (BOOKS_DIR / r[5]).resolve().parent if r[5] else None
        has_db = bool(folder and find_shamela_db(folder))
        total, embedded = embed_coverage.get(r[0], (0, 0))
        has_embeddings = (embedded > 0 and total > 0 and embedded >= total * 0.9)
        result.append({
            'id': r[0], 'title': r[1], 'filename': r[2],
            'slide_count': r[3], 'shamela_id': r[4],
            'folder': r[6], 'has_db': has_db, 'part_label': r[7],
            'has_embeddings': has_embeddings,
            'embedded_slides': embedded, 'total_slides': total,
            'author': r[8],
        })
    return jsonify(result)


@app.route('/api/books/<int:book_id>/import_toc', methods=['POST'])
def import_toc(book_id):
    data = request.get_json() or {}
    raw_input = data.get('shamela_id') or ''
    if not raw_input.strip():
        return jsonify({
            'status': 'error',
            'message': 'يرجى إدخال رقم الكتاب على الشاملة أو رابط الكتاب (مثال: 2864 أو https://shamela.ws/book/2864).'
        }), 400
    result = import_toc_for_book(book_id, raw_input)
    if result.get('status') == 'error':
        return jsonify(result), 400
    return jsonify(result)


@app.route('/api/books/<int:book_id>/import_toc_local', methods=['POST'])
def import_toc_local(book_id):
    result = import_toc_for_book_local(book_id)
    if result.get('status') == 'error':
        return jsonify(result), 400
    return jsonify(result)


@app.route('/api/import_toc_all/start', methods=['POST'])
def import_toc_all_start():
    data = request.get_json(silent=True) or {}
    force = bool(data.get('force'))
    with _toc_import_lock:
        if _toc_import_job['running']:
            return jsonify({'status': 'error', 'message': 'عملية استيراد الفهارس تعمل بالفعل.'}), 400
    thread = threading.Thread(target=_run_toc_import_all, args=(force,), daemon=True)
    thread.start()
    return jsonify({'status': 'ok'})


@app.route('/api/import_toc_all/status')
def import_toc_all_status():
    with _toc_import_lock:
        # Shallow copy so the JSON encoder isn't reading the live dict
        # while the background thread might still be mutating it.
        snapshot = dict(_toc_import_job)
        snapshot['imported'] = list(_toc_import_job['imported'])
        snapshot['skipped'] = list(_toc_import_job['skipped'])
        snapshot['failed'] = list(_toc_import_job['failed'])
    return jsonify(snapshot)


@app.route('/api/import_toc_all/stop', methods=['POST'])
def import_toc_all_stop():
    with _toc_import_lock:
        if not _toc_import_job['running']:
            return jsonify({'status': 'error', 'message': 'لا توجد عملية جارية لإيقافها.'}), 400
        _toc_import_job['stop_requested'] = True
    return jsonify({'status': 'ok'})


@app.route('/api/books/<int:book_id>/link_db', methods=['POST'])
def link_db(book_id):
    if 'db_file' not in request.files:
        return jsonify({'status': 'error', 'message': 'لم يتم رفع أي ملف'}), 400

    file = request.files['db_file']
    book_folder = get_book_folder(book_id)
    if not book_folder:
        return jsonify({'status': 'error', 'message': 'تعذر تحديد مجلد الكتاب'}), 400

    # Ensure the folder exists (handles Arabic folder names on Windows
    # where the path may not yet be created on the filesystem).
    book_folder.mkdir(parents=True, exist_ok=True)
    target = book_folder / "metadata.db"
    file.save(target)

    is_valid, error = validate_shamela_db(target)
    if not is_valid:
        target.unlink()
        return jsonify({'status': 'error', 'message': error}), 400

    return jsonify({'status': 'ok', 'path': str(target)})


@app.route('/api/books/<int:book_id>/link_toc', methods=['POST'])
def link_toc(book_id):
    """Accept a manually uploaded Shamela book-page HTML file and save it
    to toc/{folder}.html, then immediately run the local-TOC import on it.
    Bypasses the automatic name-matching requirement entirely — the user
    just picks the file from disk and the route handles naming."""
    if 'toc_file' not in request.files:
        return jsonify({'status': 'error', 'message': 'لم يتم رفع أي ملف'}), 400

    file = request.files['toc_file']

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT folder FROM books WHERE id=?", (book_id,))
    row = c.fetchone()
    conn.close()
    if not row or not row[0]:
        return jsonify({'status': 'error', 'message': 'تعذر تحديد مجلد الكتاب'}), 400

    book_folder_name = row[0]
    TOC_DIR.mkdir(parents=True, exist_ok=True)
    target = TOC_DIR / f"{book_folder_name}.html"
    file.save(str(target))

    # Now run the import using the file we just saved.
    result = import_toc_for_book_local(book_id)
    if result.get('status') == 'error':
        return jsonify(result), 400
    return jsonify(result)



@app.route('/api/books/<int:book_id>/structure')
def get_structure(book_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""SELECT h.id, h.slide_id, h.level, h.text, h.anchor_id, sl.slide_number
                 FROM headings h JOIN slides sl ON h.slide_id = sl.id
                 WHERE h.book_id = ? ORDER BY sl.slide_number, h.id""", (book_id,))
    rows = c.fetchall()
    conn.close()
    return jsonify([{'id': r[0], 'slide_id': r[1], 'level': r[2], 'text': r[3],
                      'anchor': r[4], 'slide_number': r[5]} for r in rows])


@app.route('/api/books/<int:book_id>/content')
def get_content(book_id):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT slide_number, html_content FROM slides WHERE book_id = ? ORDER BY slide_number", (book_id,))
    rows = c.fetchall()
    conn.close()
    return jsonify([{'number': r[0], 'html': r[1]} for r in rows])


@app.route('/api/search', methods=['POST'])
def search():
    data = request.get_json() or {}
    query = (data.get('query') or '').strip()
    book_id = data.get('book_id')
    scope = data.get('scope', 'all')
    # 'nav'     -> book titles + heading text (titles/imported-TOC/inline),
    #              always library-wide (this is the default, quick-jump mode)
    # 'content' -> page body text only, scoped by 'current'/'all' — entered
    #              by toggling the بحث button, which trades away title/
    #              heading matching for scoped full-text search
    mode = data.get('mode', 'nav')

    if len(query) < 2:
        return jsonify({'results': [], 'match_words': []})

    # ── Exact-phrase mode: query wrapped in "double quotes" ──
    # Straight ASCII quotes (") since Arabic-style «» are already
    # stripped by normalize_arabic and shouldn't collide with book
    # titles/snippets that legitimately contain them.
    exact_match = False
    if len(query) >= 2 and query[0] == '"' and query[-1] == '"':
        exact_match = True
        query = query[1:-1].strip()
        if len(query) < 1:
            return jsonify({'results': [], 'match_words': []})

    norm_query = normalize_arabic(query)
    words = re.findall(r'\S+', norm_query)
    match_expr = build_fts_match(norm_query, exact_phrase=exact_match)
    if not match_expr:
        return jsonify({'results': [], 'match_words': []})

    highlight_re = (build_phrase_highlight_regex(words) if exact_match
                     else build_highlight_regex(words))
    results = []

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    if mode == 'nav':
        # ── Book-title matches (always library-wide in nav mode) ──
        c.execute("SELECT id, title FROM books")
        for bid, title in c.fetchall():
            if norm_query in normalize_arabic(title):
                results.append({'type': 'book', 'book_id': bid, 'book_title': title})
        source_filter = "AND s.source IN ('inline','imported')"
        scope_filter = ""
        scope_params = []
    else:
        source_filter = "AND s.source = 'body'"
        book_ids = data.get('book_ids')
        if scope == 'current' and book_ids:
            placeholders = ','.join('?' * len(book_ids))
            scope_filter = f"AND s.book_id IN ({placeholders})"
            scope_params = list(book_ids)
        elif scope == 'current' and book_id:
            scope_filter = "AND s.book_id = ?"
            scope_params = [book_id]
        else:
            scope_filter = ""
            scope_params = []

    # ── Heading matches (nav mode) / page-content matches (content mode) ──
    rows = []
    try:
        sql = f"""
            SELECT s.book_id, b.title, s.slide_id, sl.slide_number, s.heading_text,
                   sl.plain_text, s.source
            FROM search_index s
            JOIN books b ON s.book_id = b.id
            JOIN slides sl ON s.slide_id = sl.id
            WHERE s.normalized_text MATCH ? {source_filter} {scope_filter}
            ORDER BY rank LIMIT {SEARCH_RESULT_LIMIT}
        """
        params = [match_expr] + scope_params
        c.execute(sql, params)
        rows = c.fetchall()
    except sqlite3.OperationalError:
        like_query = '%' + escape_like(norm_query) + '%'
        sql = f"""
            SELECT s.book_id, b.title, s.slide_id, sl.slide_number, s.heading_text,
                   sl.plain_text, s.source
            FROM search_index s
            JOIN books b ON s.book_id = b.id
            JOIN slides sl ON s.slide_id = sl.id
            WHERE s.normalized_text LIKE ? ESCAPE '\\' {source_filter} {scope_filter}
            LIMIT {SEARCH_RESULT_LIMIT}
        """
        params = [like_query] + scope_params
        c.execute(sql, params)
        rows = c.fetchall()

    conn.close()

    seen = set()
    for r in rows:
        book_id_r, book_title, slide_id, slide_number, heading_text, plain_text, source = r
        key = (book_id_r, slide_id)
        if key in seen:
            continue
        seen.add(key)
        # If the match was against a heading, highlight inside the heading
        # text itself (that's what actually matched); otherwise highlight
        # inside the page's own body text.
        snippet_source = heading_text if heading_text else (plain_text or '')
        snippet = make_highlighted_snippet(snippet_source, highlight_re)
        results.append({
            'type': 'slide',
            'book_id': book_id_r, 'book_title': book_title,
            'slide_id': slide_id, 'slide_number': slide_number,
            'heading': heading_text or None,
            'is_heading_match': bool(heading_text),
            'snippet_html': snippet,
        })

    return jsonify({'results': results, 'match_words': words, 'exact': exact_match})


@app.route('/api/ask', methods=['POST'])
def ask():
    data = request.get_json() or {}
    question = (data.get('question') or '').strip()
    agent = data.get('agent', 'gemini')
    answer_mode = data.get('answer_mode', 'strict')
    if answer_mode not in ('strict', 'extended'):
        answer_mode = 'strict'

    if not question:
        return jsonify({'answer': 'يرجى إدخال سؤال.', 'sources': []})

    if agent not in AI_AGENTS:
        return jsonify({'answer': f'وكيل غير صالح: {agent}', 'sources': []}), 400

    agent_info = AI_AGENTS[agent]
    if not agent_info['enabled']:
        return jsonify({'answer': f"مفتاح API لـ{agent_info['name']} غير مضبوط في config.ini.", 'sources': []}), 400

    # Optional book scoping from the Ask panel's multi-book picker. Empty/
    # missing means library-wide, unchanged from the original behavior.
    book_ids = data.get('book_ids') or None
    if book_ids:
        try:
            book_ids = [int(b) for b in book_ids]
        except (TypeError, ValueError):
            book_ids = None

    # Per-request top_k override from the Ask panel's UI field. Blank/
    # missing/invalid falls back to config.ini's ask_top_k, unchanged.
    top_k = ASK_TOP_K
    raw_top_k = data.get('top_k')
    if raw_top_k not in (None, ''):
        try:
            parsed_top_k = int(raw_top_k)
            if parsed_top_k > 0:
                top_k = parsed_top_k
        except (TypeError, ValueError):
            pass

    # Semantic (embeddings) retrieval first; transparently falls back to
    # keyword (FTS) search if no embedding provider is configured, or the
    # embedding call itself fails for any reason.
    #
    # This is wrapped separately from the AI call below: an unexpected
    # retrieval-side error (bad query, sqlite-vec quirk, etc.) must not
    # produce a bare 500. A bare 500 has no JSON body at all, so the
    # frontend's fetch().catch() only ever sees a generic connection-error
    # message — with no `sources`, even though retrieval may have actually
    # found passages before failing partway through. Catching it here keeps
    # the response shape consistent (`answer` + `sources`, always JSON)
    # no matter which stage fails.
    try:
        passages, refs = retrieve_context_passages(question, top_k=top_k, book_ids=book_ids)
    except Exception as e:
        print(f"[ERROR] retrieve_context_passages failed: {e}")
        return jsonify({
            'answer': f"حدث خطأ أثناء البحث في المكتبة: {str(e)}",
            'sources': [],
            'source_refs': []
        }), 200

    context = "\n\n".join(passages) if passages else "لم يتم العثور على نصوص ذات صلة في المكتبة."
    prompt = build_ai_prompt(question, context, mode=answer_mode)

    try:
        if agent == 'gemini':
            answer = call_gemini(prompt, GEMINI_KEY)
        else:
            answer = call_mistral(prompt, MISTRAL_API_KEY)
    except Exception as e:
        answer = f"خطأ غير متوقع: {str(e)}"

    # Auto-save every Q&A block to ask_history.db — question, answer, and
    # only the lightweight citation refs (book_id/slide_number/title/label),
    # never the snippet bodies. Saving must never break the live response,
    # so a failure here is logged and swallowed rather than surfaced.
    history_id = None
    try:
        history_id = save_ask_history(question, answer, refs)
    except Exception as e:
        print(f"[WARN] save_ask_history failed: {e}")

    return jsonify({'answer': answer, 'sources': passages, 'source_refs': refs, 'history_id': history_id})


@app.route('/api/ask_history', methods=['GET'])
def get_ask_history():
    """Returns all saved Ask blocks, newest first. Loaded by the frontend
    only when the Ask panel is opened — never on page load."""
    conn = sqlite3.connect(ASK_HISTORY_DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, question, answer, created_at, citations FROM ask_history ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    blocks = []
    for row_id, question, answer, created_at, citations in rows:
        try:
            parsed_citations = json.loads(citations)
        except (TypeError, ValueError):
            parsed_citations = []
        blocks.append({
            'id': row_id,
            'question': question,
            'answer': answer,
            'created_at': created_at,
            'citations': parsed_citations
        })
    return jsonify({'blocks': blocks})


@app.route('/api/ask_history/<int:block_id>', methods=['DELETE'])
def delete_ask_history_block(block_id):
    """Per-block Clear button: removes exactly one saved Q&A block."""
    conn = sqlite3.connect(ASK_HISTORY_DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM ask_history WHERE id = ?", (block_id,))
    conn.commit()
    deleted = c.rowcount > 0
    conn.close()
    return jsonify({'deleted': deleted})


@app.route('/api/ask_history', methods=['DELETE'])
def clear_ask_history():
    """Clear All button: wipes every saved Q&A block."""
    conn = sqlite3.connect(ASK_HISTORY_DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM ask_history")
    conn.commit()
    conn.close()
    return jsonify({'cleared': True})


@app.route('/api/passages', methods=['POST'])
def get_passages():
    """Re-fetches snippet bodies for a saved block's citations, on demand
    (only ever called when the user clicks 'نسخ المقتطفات' on a saved
    block). Rebuilds the same capped/stitched text that was originally
    sent to the AI, straight from library.db — nothing is stored twice.
    No similarity score is included (that value belonged to the original
    query's embedding and isn't meaningfully reconstructible later)."""
    data = request.get_json() or {}
    citations = data.get('citations') or []
    if not citations:
        return jsonify({'passages': []})

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    passages = []
    for cit in citations:
        book_id = cit.get('book_id')
        slide_number = cit.get('slide_number')
        title = cit.get('title') or ''
        label = cit.get('label') or ''
        if book_id is None or slide_number is None:
            continue

        c.execute(
            "SELECT plain_text FROM slides WHERE book_id = ? AND slide_number = ?",
            (book_id, slide_number)
        )
        row = c.fetchone()
        matched_text = (row[0] or '')[:ASK_PASSAGE_CHAR_CAP] if row else ''

        parts = [f"[المصدر: {title} - {label}]"]
        if NEIGHBOR_STITCHING:
            cap = ASK_PASSAGE_CHAR_CAP
            leftover = cap - len(matched_text)
            neighbor_budget = leftover // 2
            if neighbor_budget > 0:
                c.execute(
                    "SELECT plain_text FROM slides WHERE book_id = ? AND slide_number = ?",
                    (book_id, slide_number - 1)
                )
                prev_row = c.fetchone()
                prev_text = (prev_row[0] or '') if prev_row else ''
                c.execute(
                    "SELECT plain_text FROM slides WHERE book_id = ? AND slide_number = ?",
                    (book_id, slide_number + 1)
                )
                next_row = c.fetchone()
                next_text = (next_row[0] or '') if next_row else ''
                if prev_text:
                    parts.append(f"--- (سياق من الصفحة السابقة) ---\n{prev_text[-neighbor_budget:]}")
        parts.append(matched_text)
        if NEIGHBOR_STITCHING and neighbor_budget > 0 and next_text:
            parts.append(f"--- (تتمة من الصفحة التالية) ---\n{next_text[:neighbor_budget]}")

        passages.append('\n'.join(parts))

    conn.close()
    return jsonify({'passages': passages})


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

if __name__ == '__main__':
    # Installed first, before init_db() or anything else prints, so the
    # browser log panel can show the *entire* session from the very first
    # line — not just whatever happened to print after this point.
    sys.stdout = _LogTee(sys.stdout)
    sys.stderr = _LogTee(sys.stderr)

    init_db()
    init_ask_history_db()
    TOC_DIR.mkdir(parents=True, exist_ok=True)

    # Semantic search (used only by /api/ask) is backed by vec_embeddings
    # (sqlite-vec), which — unlike the earlier FAISS approach — has no
    # separate "load index into RAM" step at all: SQLite reads only the
    # pages a given query touches, same as every other table here. So
    # there's nothing to warm up or lazily load at startup; the first
    # /api/ask call is already as fast as any later one. Regular library
    # search runs entirely on SQLite FTS5 and never touches embeddings.

    print("Starting server at http://localhost:3000")
    app.run(host='0.0.0.0', port=3000, debug=False, threaded=True)
