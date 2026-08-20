/**
 * hk-tree.js — Isnad tree (شجرة الإسناد) view: tree diagram + table, with
 * a companion (صحابي) filter shared by both.
 *
 * renderHkTree(container, data, opts)
 *   data: the JSON from GET /api/hk/group/<id>/tree ({nodes, edges, madar,
 *         sahabis, chains, totalChains})
 *   opts.onNodeClick(rawiId): fired when the user explicitly asks to open
 *         a narrator's dossier (the ↗ symbol in tree view, or a name in
 *         table view).
 *   opts.onSahabiFilterChange(sahabiIdOrNull): fired when the companion
 *         filter dropdown changes. This module does not fetch — the
 *         caller re-fetches /group/<id>/tree?sahabi=<id> and calls
 *         renderHkTree again with the new data.
 *   opts.allSahabis: the FULL, unfiltered companion list (for populating
 *         the filter dropdown even while a filter is currently applied,
 *         since a filtered response's own `sahabis` field only contains
 *         whichever single companion is active).
 *   opts.state: a plain object the caller persists across re-renders
 *         (e.g. on the detail-stack entry) — { view: 'tree'|'table',
 *         sortCol, sortDir, activePathId, sahabiFilter }. Mutated in
 *         place, so returning to a previously-viewed tree and passing
 *         the same object back restores the exact view.
 *
 * v4 changes:
 *   - Table view alternative (sortable: name / role / chain-count /
 *     layer), toggled alongside the tree — for trees too large to trace
 *     visually, a sortable list communicates the same information more
 *     usably.
 *   - Companion (صحابي) filter dropdown — narrows the tree/table to only
 *     the chains passing through one chosen companion, turning one
 *     unreadable many-companion tree into several small readable ones.
 *   - Horizontal scroll is now structurally prevented: the container is
 *     expected to keep a permanently-reserved vertical-scrollbar gutter
 *     (see tree_test.html's #tree-container: overflow-y: scroll, not
 *     auto), so width measurement is consistent whether or not content
 *     is currently tall enough to need scrolling — previously the first
 *     measurement happened before any content existed, so the vertical
 *     scrollbar hadn't appeared yet and the tree was sized slightly too
 *     wide once it did.
 *   - The ↗ "open dossier" affordance now has a larger invisible hit
 *     rect behind the small glyph, since the bare glyph was an easy-to-
 *     miss target.
 *
 * v3 changes (retained): blue path-highlight distinct from the madar's
 * permanent gold border; unrelated-edge dimming; full (wrapped, not
 * truncated) names; right-margin tabaqa brackets (no text labels);
 * chain-membership-based path tracing (chainPath) rather than a naive
 * graph walk, which previously could leak into an unrelated chain
 * through a narrator shared by two otherwise-unconnected routes.
 */

function renderHkTree(container, data, opts) {
    opts = opts || {};
    var onNodeClick = opts.onNodeClick || function() {};
    var onSahabiFilterChange = opts.onSahabiFilterChange || function() {};
    var allSahabis = opts.allSahabis || data.sahabis || [];
    var state = opts.state || {};
    if (!state.view) state.view = 'tree';
    if (!state.sortCol) state.sortCol = 'depth';
    if (!state.sortDir) state.sortDir = 'asc';

    // Prevent horizontal overflow structurally, regardless of any sizing
    // edge case below — belt and suspenders alongside the gutter fix.
    container.style.overflowX = 'hidden';

    container.innerHTML = '';

    var toolbar = document.createElement('div');
    toolbar.className = 'hk-tree-toolbar';

    var viewToggle = document.createElement('div');
    viewToggle.className = 'hk-tree-view-toggle';
    var treeBtn = document.createElement('button');
    treeBtn.type = 'button'; treeBtn.textContent = 'شجرة';
    var tableBtn = document.createElement('button');
    tableBtn.type = 'button'; tableBtn.textContent = 'جدول';
    viewToggle.appendChild(treeBtn);
    viewToggle.appendChild(tableBtn);
    toolbar.appendChild(viewToggle);

    if (allSahabis.length > 1) {
        var filterSelect = document.createElement('select');
        filterSelect.className = 'hk-tree-sahabi-filter';
        var allOpt = document.createElement('option');
        allOpt.value = ''; allOpt.textContent = 'كل الصحابة (' + allSahabis.length + ')';
        filterSelect.appendChild(allOpt);
        allSahabis.forEach(function(s) {
            var opt = document.createElement('option');
            opt.value = s.rawiId;
            opt.textContent = s.name + ' (' + s.count + ')';
            if (state.sahabiFilter && String(state.sahabiFilter) === String(s.rawiId)) opt.selected = true;
            filterSelect.appendChild(opt);
        });
        filterSelect.addEventListener('change', function() {
            state.sahabiFilter = filterSelect.value || null;
            onSahabiFilterChange(state.sahabiFilter);
        });
        toolbar.appendChild(filterSelect);
    }

    var body = document.createElement('div');
    body.className = 'hk-tree-body';

    container.appendChild(toolbar);
    container.appendChild(body);

    function setView(v) {
        state.view = v;
        treeBtn.classList.toggle('active', v === 'tree');
        tableBtn.classList.toggle('active', v === 'table');
        body.innerHTML = '';
        if (v === 'tree') renderTreeInto(body, data, opts, state);
        else renderTableInto(body, data, opts, state);
    }
    treeBtn.addEventListener('click', function() { setView('tree'); });
    tableBtn.addEventListener('click', function() { setView('table'); });

    setView(state.view);
}

var HK_ROLE_LABELS = { prophet: 'النبي ﷺ', sahabi: 'صحابي', rawi: 'راوٍ', author: 'مؤلف', break: 'منقطع' };

function renderTableInto(body, data, opts, state) {
    var onNodeClick = opts.onNodeClick || function() {};
    var madarId = data.madar ? data.madar.rawiId : null;
    var nodes = (data.nodes || []).filter(function(n) { return n.role !== 'prophet'; }).slice();

    var cols = [
        { key: 'name', label: 'الراوي' },
        { key: 'role', label: 'الدور' },
        { key: 'count', label: 'عدد السلاسل' },
        { key: 'depth', label: 'الطبقة' }
    ];

    function sortRows() {
        var col = state.sortCol, dir = state.sortDir === 'asc' ? 1 : -1;
        nodes.sort(function(a, b) {
            var av = a[col], bv = b[col];
            if (col === 'role') { av = HK_ROLE_LABELS[av] || av; bv = HK_ROLE_LABELS[bv] || bv; }
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
    }

    var table = document.createElement('table');
    table.className = 'hk-tree-table';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    cols.forEach(function(c) {
        var th = document.createElement('th');
        th.textContent = c.label + (state.sortCol === c.key ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '');
        th.addEventListener('click', function() {
            if (state.sortCol === c.key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            else { state.sortCol = c.key; state.sortDir = 'asc'; }
            renderTableInto(body, data, opts, state);
        });
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    sortRows();
    var tbody = document.createElement('tbody');
    nodes.forEach(function(n) {
        var tr = document.createElement('tr');
        var nameTd = document.createElement('td');
        var link = document.createElement('a');
        link.href = '#'; link.className = 'hk-link';
        link.textContent = n.name || '';
        link.addEventListener('click', function(e) { e.preventDefault(); onNodeClick(n.rawiId); });
        nameTd.appendChild(link);
        if (n.rawiId === madarId) {
            var badge = document.createElement('span');
            badge.className = 'hk-badge hk-badge-hasan';
            badge.style.marginRight = '6px';
            badge.textContent = 'مدار';
            nameTd.appendChild(badge);
        }
        tr.appendChild(nameTd);

        var roleTd = document.createElement('td');
        roleTd.textContent = HK_ROLE_LABELS[n.role] || n.role;
        tr.appendChild(roleTd);

        var countTd = document.createElement('td');
        countTd.textContent = n.count;
        tr.appendChild(countTd);

        var depthTd = document.createElement('td');
        depthTd.textContent = Math.round(n.depth);
        tr.appendChild(depthTd);

        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.innerHTML = '';
    body.appendChild(table);
}

function renderTreeInto(body, data, opts, state) {
    var onNodeClick = opts.onNodeClick || function() {};

    var nodesIn = data.nodes || [];
    var edgesIn = data.edges || [];
    var madarId = data.madar ? data.madar.rawiId : null;

    if (!nodesIn.length) {
        body.innerHTML = '<div class="hk-tree-empty">لا توجد بيانات كافية لرسم الشجرة</div>';
        return;
    }

    var maxDepth = Math.max.apply(null, nodesIn.map(function(n) { return Math.round(n.depth || 0); }));
    var layers = [];
    for (var i = 0; i <= maxDepth; i++) layers.push([]);
    var nodeById = {};
    nodesIn.forEach(function(n) {
        var layer = n.role === 'prophet' ? 0 : Math.max(0, Math.min(maxDepth, Math.round(n.depth || 0)));
        if (n.role === 'author') layer = maxDepth;
        layers[layer].push(n);
        nodeById[n.rawiId] = n;
    });

    var adjacency = {};
    nodesIn.forEach(function(n) { adjacency[n.rawiId] = { up: [], down: [] }; });
    edgesIn.forEach(function(e) {
        if (adjacency[e.from] && adjacency[e.to]) {
            adjacency[e.from].down.push(e.to);
            adjacency[e.to].up.push(e.from);
        }
    });

    function layerIndexMap(layer) {
        var m = {};
        layer.forEach(function(n, i) { m[n.rawiId] = i; });
        return m;
    }
    function sweep(fromAbove) {
        for (var li = fromAbove ? 1 : layers.length - 2; fromAbove ? li < layers.length : li >= 0; li += fromAbove ? 1 : -1) {
            var refLayer = layers[li + (fromAbove ? -1 : 1)];
            if (!refLayer) continue;
            var refIndex = layerIndexMap(refLayer);
            layers[li].forEach(function(n) {
                var neighbors = fromAbove ? adjacency[n.rawiId].up : adjacency[n.rawiId].down;
                var positions = neighbors.map(function(id) { return refIndex[id]; }).filter(function(p) { return p !== undefined; });
                n.__bary = positions.length ? positions.reduce(function(a, b) { return a + b; }, 0) / positions.length : (layers[li].indexOf(n));
            });
            layers[li].sort(function(a, b) { return a.__bary - b.__bary; });
        }
    }
    for (var pass = 0; pass < 3; pass++) { sweep(true); sweep(false); }

    var NODE_W = 150, NODE_H = 56, LAYER_GAP = 60, ROW_GAP = 16, NODE_GAP = 16;
    var BRACKET_MARGIN = 40;
    // container.clientWidth is reliable here because the container keeps
    // a permanently-reserved vertical-scrollbar gutter (overflow-y:
    // scroll, not auto) — see module docstring.
    var contentWidth = opts.maxWidth || (body.clientWidth > 0 ? body.clientWidth - BRACKET_MARGIN : 700);
    contentWidth = Math.max(NODE_W + NODE_GAP * 2, contentWidth);
    var nodesPerRow = Math.max(1, Math.floor((contentWidth + NODE_GAP) / (NODE_W + NODE_GAP)));

    var LAYER_COLORS = ['#6b7280', '#059669', '#7c3aed', '#0891b2', '#b45309', '#dc2626', '#4338ca', '#be185d'];

    var cursorY = LAYER_GAP;
    var layerRanges = [];
    layers.forEach(function(layer, li) {
        var layerTop = cursorY;
        var rowCount = Math.ceil(layer.length / nodesPerRow) || 1;
        for (var r = 0; r < rowCount; r++) {
            var rowNodes = layer.slice(r * nodesPerRow, (r + 1) * nodesPerRow);
            var totalW = rowNodes.length * (NODE_W + NODE_GAP) - NODE_GAP;
            var startX = (contentWidth - totalW) / 2;
            rowNodes.forEach(function(n, i) {
                n.__x = startX + i * (NODE_W + NODE_GAP) + NODE_W / 2;
                n.__y = cursorY + NODE_H / 2;
            });
            cursorY += NODE_H + ROW_GAP;
        }
        var layerBottom = cursorY - ROW_GAP;
        cursorY += LAYER_GAP - ROW_GAP;
        layerRanges.push({ top: layerTop, bottom: layerBottom, color: LAYER_COLORS[li % LAYER_COLORS.length] });
    });
    var svgHeight = cursorY;
    var svgWidth = contentWidth + BRACKET_MARGIN;

    function wrapName(name) {
        name = name || '';
        if (name.length <= 16) return [name];
        var words = name.split(' ');
        var line1 = '', line2 = '';
        for (var w = 0; w < words.length; w++) {
            var candidate = line1 ? line1 + ' ' + words[w] : words[w];
            if (candidate.length <= 16) { line1 = candidate; }
            else { line2 = words.slice(w).join(' '); break; }
        }
        if (line2.length > 18) line2 = line2.slice(0, 17) + '…';
        return line2 ? [line1, line2] : [line1];
    }

    var maxEdgeCount = Math.max.apply(null, edgesIn.map(function(e) { return e.count; }).concat([1]));

    var svgParts = [];
    svgParts.push('<svg viewBox="0 0 ' + svgWidth + ' ' + svgHeight + '" xmlns="http://www.w3.org/2000/svg" ' +
        'width="' + svgWidth + '" height="' + svgHeight + '" class="hk-tree-svg">');

    edgesIn.forEach(function(e) {
        var from = nodeById[e.from], to = nodeById[e.to];
        if (!from || !to) return;
        var midY = (from.__y + to.__y) / 2;
        var opacity = 0.25 + 0.55 * (e.count / maxEdgeCount);
        var width = 1 + 3.5 * (Math.log2(e.count + 1) / Math.log2(maxEdgeCount + 1));
        var path = 'M ' + from.__x + ' ' + (from.__y + NODE_H / 2) +
            ' C ' + from.__x + ' ' + midY + ', ' + to.__x + ' ' + midY + ', ' + to.__x + ' ' + (to.__y - NODE_H / 2);
        svgParts.push('<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-opacity="' + opacity.toFixed(2) +
            '" stroke-width="' + width.toFixed(1) + '" data-hk-edge data-from="' + e.from + '" data-to="' + e.to + '"></path>');
    });

    nodesIn.forEach(function(n) {
        var x = n.__x, y = n.__y;
        var isMadar = n.rawiId === madarId;
        var cls = 'hk-tree-node hk-tree-node-' + n.role + (isMadar ? ' hk-tree-node-madar' : '');
        var lines = wrapName(n.name);

        svgParts.push('<g class="' + cls + '" data-hk-node="' + n.rawiId + '" tabindex="0" transform="translate(' + (x - NODE_W / 2) + ',' + (y - NODE_H / 2) + ')">');
        svgParts.push('<rect width="' + NODE_W + '" height="' + NODE_H + '" rx="9"></rect>');
        if (lines.length === 1) {
            svgParts.push('<text x="' + (NODE_W / 2) + '" y="' + (NODE_H / 2 + 2) + '" text-anchor="middle">' + escapeHtmlForSvg(lines[0]) + '</text>');
        } else {
            svgParts.push('<text x="' + (NODE_W / 2) + '" y="' + (NODE_H / 2 - 7) + '" text-anchor="middle">' + escapeHtmlForSvg(lines[0]) + '</text>');
            svgParts.push('<text x="' + (NODE_W / 2) + '" y="' + (NODE_H / 2 + 11) + '" text-anchor="middle">' + escapeHtmlForSvg(lines[1]) + '</text>');
        }
        if (n.rawiId !== 0) {
            // Larger invisible hit rect behind the small glyph — the bare
            // glyph alone was an easy-to-miss click target.
            svgParts.push('<rect data-hk-open="' + n.rawiId + '" x="' + (NODE_W - 26) + '" y="' + (NODE_H - 22) +
                '" width="22" height="22" fill="transparent"></rect>');
            svgParts.push('<text class="hk-tree-open-link" data-hk-open="' + n.rawiId + '" x="' + (NODE_W - 14) + '" y="' + (NODE_H - 6) + '" text-anchor="middle"><title>فتح ملف الراوي</title>↗</text>');
        }
        if (isMadar) {
            svgParts.push('<text x="' + (NODE_W / 2) + '" y="-8" text-anchor="middle" class="hk-tree-madar-label">◈ مدار الحديث</text>');
        }
        svgParts.push('</g>');
    });

    layerRanges.forEach(function(lr) {
        var x0 = contentWidth + 8, tipX = contentWidth + 22;
        var mid = (lr.top + lr.bottom) / 2;
        var d = 'M ' + x0 + ' ' + lr.top +
            ' C ' + tipX + ' ' + lr.top + ', ' + tipX + ' ' + mid + ', ' + (tipX + 8) + ' ' + mid +
            ' C ' + tipX + ' ' + mid + ', ' + tipX + ' ' + lr.bottom + ', ' + x0 + ' ' + lr.bottom;
        svgParts.push('<path d="' + d + '" fill="none" stroke="' + lr.color + '" stroke-width="2"></path>');
    });

    svgParts.push('</svg>');
    body.innerHTML = svgParts.join('');

    var svgEl = body.querySelector('.hk-tree-svg');
    var activePathId = state.activePathId || null;

    function touchingEdges(id) {
        return Array.prototype.slice.call(svgEl.querySelectorAll('[data-hk-edge]')).filter(function(edge) {
            return parseInt(edge.getAttribute('data-from'), 10) === id || parseInt(edge.getAttribute('data-to'), 10) === id;
        });
    }
    function clearHover() {
        svgEl.querySelectorAll('[data-hk-edge]').forEach(function(edge) { edge.classList.remove('hk-tree-edge-hover'); });
    }
    function clearPath() {
        svgEl.querySelectorAll('[data-hk-edge]').forEach(function(edge) { edge.classList.remove('hk-tree-edge-active', 'hk-tree-edge-dim'); });
        svgEl.querySelectorAll('[data-hk-node]').forEach(function(g) { g.classList.remove('hk-tree-node-dim', 'hk-tree-node-onpath'); });
    }

    function chainPath(startId) {
        var node = nodeById[startId];
        var startSanadIds = (node && node.sanadIds) || [];
        var nodeSet = {}, edgeKeys = [];
        nodeSet[startId] = true;
        edgesIn.forEach(function(e) {
            var shared = (e.sanadIds || []).some(function(sid) { return startSanadIds.indexOf(sid) !== -1; });
            if (shared) {
                edgeKeys.push(e.from + '->' + e.to);
                nodeSet[e.from] = true;
                nodeSet[e.to] = true;
            }
        });
        return { nodes: nodeSet, edges: edgeKeys };
    }

    function applyPath(id) {
        clearPath();
        activePathId = id;
        state.activePathId = id;
        var path = chainPath(id);
        svgEl.querySelectorAll('[data-hk-node]').forEach(function(og) {
            var oid = parseInt(og.getAttribute('data-hk-node'), 10);
            if (path.nodes[oid]) og.classList.add('hk-tree-node-onpath');
            else og.classList.add('hk-tree-node-dim');
        });
        svgEl.querySelectorAll('[data-hk-edge]').forEach(function(edge) {
            var key = edge.getAttribute('data-from') + '->' + edge.getAttribute('data-to');
            if (path.edges.indexOf(key) !== -1) edge.classList.add('hk-tree-edge-active');
            else edge.classList.add('hk-tree-edge-dim');
        });
    }

    // Restore a previously-active path (returning to this tree view as-is).
    if (activePathId !== null && nodeById[activePathId]) applyPath(activePathId);

    svgEl.querySelectorAll('[data-hk-node]').forEach(function(g) {
        var id = parseInt(g.getAttribute('data-hk-node'), 10);

        g.addEventListener('mouseenter', function() { if (activePathId === null) touchingEdges(id).forEach(function(e) { e.classList.add('hk-tree-edge-hover'); }); });
        g.addEventListener('mouseleave', clearHover);
        g.addEventListener('focus', function() { if (activePathId === null) touchingEdges(id).forEach(function(e) { e.classList.add('hk-tree-edge-hover'); }); });
        g.addEventListener('blur', clearHover);

        g.addEventListener('click', function(evt) {
            if (evt.target && evt.target.getAttribute && evt.target.getAttribute('data-hk-open')) return;
            if (id === 0) return;
            if (activePathId === id) { clearPath(); activePathId = null; state.activePathId = null; return; }
            applyPath(id);
        });
        g.style.cursor = 'pointer';
    });

    svgEl.querySelectorAll('[data-hk-open]').forEach(function(el) {
        el.addEventListener('click', function(evt) {
            evt.stopPropagation();
            onNodeClick(parseInt(el.getAttribute('data-hk-open'), 10));
        });
    });

    if (opts.restoreScrollTop) body.parentNode.scrollTop = opts.restoreScrollTop;
}

function escapeHtmlForSvg(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
