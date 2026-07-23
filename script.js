// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let normalisedData = [];   // Populated progressively as worker batches arrive
let filteredData    = [];
let currentPage      = 1;
let lastTotalPages    = 0;

const ITEMS_PER_PAGE = 5;
let wholeWordMode          = false;
let includeRationales      = false;
let includeDeepMetadata    = false;   // "hidden" fields not rendered anywhere on a card
let showStructuredMetadata = true;

let worker = null;

// ── List your chunk files here ───────────────────────────────────────────────
const DATA_FILES = [
    'data_1.json',
    'data_2.json',
    'data_3.json',
    'data_4.json',
    'data_6.json',
    'data_7.json'
];

// ─────────────────────────────────────────────────────────────────────────────
// Loading
//
// Strategy for large (~40k record) datasets:
//   1. Fetch all chunk files in parallel (as before), reporting fetch
//      progress as each one resolves.
//   2. Hand the raw records to a Web Worker, which normalises them and
//      builds their search blobs OFF the main thread, in batches.
//   3. As each batch comes back, append it to normalisedData immediately
//      and re-render — so the gallery becomes browsable and searchable
//      long before the full dataset finishes indexing, and the page never
//      freezes while that happens.
//   4. If Workers aren't supported, fall back to doing the same batching on
//      the main thread via setTimeout so the UI can still breathe between
//      chunks (worker.js is loaded as a plain <script> too, so its
//      functions are available here for this fallback).
// ─────────────────────────────────────────────────────────────────────────────

async function loadData() {
    const container = document.getElementById('gallery-container');
    setLoadingState(true, 'Fetching data files…', 0);

    try {
        let fetched = 0;
        const chunks = await Promise.all(DATA_FILES.map(f =>
            fetch(f)
                .then(r => {
                    if (!r.ok) throw new Error(`Failed to fetch ${r.url}`);
                    return r.json();
                })
                .then(json => {
                    fetched++;
                    setLoadingState(
                        true,
                        `Fetched ${fetched} / ${DATA_FILES.length} data files…`,
                        (fetched / DATA_FILES.length) * 30
                    );
                    return json;
                })
        ));

        const rawRecords = chunks.flatMap(extractRecordsFromChunk).reverse();
        startIndexing(rawRecords);
    } catch (e) {
        console.error('Failed to load data', e);
        setLoadingState(false);
        container.innerHTML = `
            <div class="error-box">
                <strong>Could not load data.</strong>
                <p>${escapeHtml(e.message)}</p>
                <p>Check that your JSON files exist and that DATA_FILES in script.js lists the correct filenames.</p>
            </div>
        `;
    }
}

function extractRecordsFromChunk(chunk) {
    if (Array.isArray(chunk))                  return chunk;
    if (chunk && Array.isArray(chunk.records))  return chunk.records;
    if (chunk && typeof chunk === 'object')     return [chunk];
    return [];
}

function startIndexing(rawRecords) {
    const total = rawRecords.length;

    if (!total) {
        setLoadingState(false);
        normalisedData = [];
        filteredData   = [];
        renderGallery();
        return;
    }

    if (window.Worker) {
        try {
            worker = new Worker('worker.js');
            worker.onmessage = handleWorkerMessage;
            worker.onerror = (err) => {
                console.error('Worker failed, falling back to main-thread indexing', err);
                if (worker) worker.terminate();
                worker = null;
                normalisedData = [];
                fallbackIndexOnMainThread(rawRecords);
            };
            worker.postMessage({ rawRecords, batchSize: 1500 });
            return;
        } catch (err) {
            console.error('Could not start Worker, falling back to main thread', err);
        }
    }

    fallbackIndexOnMainThread(rawRecords);
}

function handleWorkerMessage(e) {
    const msg = e.data;

    if (msg.type === 'batch') {
        normalisedData = normalisedData.concat(msg.records);
        if (!document.getElementById('searchInput').value.trim()) {
            filteredData = normalisedData;
        }
        const percent = 30 + (msg.done / msg.total) * 70;
        setLoadingState(
            true,
            `Indexed ${msg.done.toLocaleString()} / ${msg.total.toLocaleString()} records — you can search now…`,
            percent
        );
        renderGallery(document.getElementById('searchInput').value.trim());
    } else if (msg.type === 'complete') {
        setLoadingState(false);
        if (worker) worker.terminate();
        worker = null;
        runSearch();
    }
}

// Fallback path used only when Web Workers are unavailable. Relies on
// normaliseRecord() etc. from worker.js, which is also loaded as a plain
// script tag in index.html for exactly this purpose.
function fallbackIndexOnMainThread(rawRecords) {
    const total = rawRecords.length;
    let start = 0;
    const size = 1000;

    function processBatch() {
        const slice     = rawRecords.slice(start, start + size);
        const processed = slice.map(normaliseRecord);
        normalisedData  = normalisedData.concat(processed);
        start += size;

        if (!document.getElementById('searchInput').value.trim()) {
            filteredData = normalisedData;
        }

        const done    = Math.min(start, total);
        const percent = 30 + (done / total) * 70;
        setLoadingState(
            true,
            `Indexed ${done.toLocaleString()} / ${total.toLocaleString()} records — you can search now…`,
            percent
        );
        renderGallery(document.getElementById('searchInput').value.trim());

        if (start < total) {
            setTimeout(processBatch, 0);
        } else {
            setLoadingState(false);
            runSearch();
        }
    }

    processBatch();
}

function setLoadingState(isLoading, label, percent) {
    const el = document.getElementById('loading-indicator');
    if (!el) return;

    if (!isLoading) {
        el.classList.add('hidden');
        return;
    }

    el.classList.remove('hidden');
    document.getElementById('progress-label').textContent = label || '';
    document.getElementById('progress-fill').style.width = `${Math.min(100, Math.max(0, percent || 0))}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
//
// By default only `visibleBlob` (the text actually rendered on a card) is
// searched, so a match always corresponds to something visible. "Hidden"
// JSON fields and rationale text are opt-in via their toggles — this is
// what was previously making results look like a fuzzy/broken search: it
// was matching on fields nowhere near the card.
// ─────────────────────────────────────────────────────────────────────────────

function buildRegex(term, global) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = wholeWordMode ? `\\b${escaped}\\b` : escaped;
    return new RegExp(pattern, global ? 'gi' : 'i');
}

function runSearch() {
    const raw = document.getElementById('searchInput').value.trim();

    if (!raw) {
        filteredData = normalisedData;
        currentPage  = 1;
        renderGallery('');
        return;
    }

    const regex = buildRegex(raw, false);
    filteredData = normalisedData.filter(view =>
        regex.test(view.visibleBlob) ||
        (includeDeepMetadata && regex.test(view.deepBlob)) ||
        (includeRationales   && regex.test(view.rationaleBlob))
    );
    currentPage = 1;
    renderGallery(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Highlighting
// ─────────────────────────────────────────────────────────────────────────────

function highlightHtml(rawText, searchTerm) {
    const escaped = escapeHtml(rawText);
    if (!searchTerm) return escaped;

    const regex = buildRegex(searchTerm, true);
    return escaped.replace(regex, match => `<mark class="hit">${match}</mark>`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderGallery(searchTerm = '') {
    const container = document.getElementById('gallery-container');
    container.innerHTML = '';

    if (!normalisedData.length) {
        // Still fetching/indexing the very first batch — the loading
        // indicator (outside this container) is showing progress.
        return;
    }

    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const end   = start + ITEMS_PER_PAGE;
    const items = filteredData.slice(start, end);

    const summary = document.createElement('div');
    summary.id = 'results-summary';
    if (searchTerm) {
        const modeLabel = wholeWordMode ? 'whole word' : 'partial match';
        summary.textContent =
            `Showing ${normalisedData.length.toLocaleString()} entries — ${filteredData.length.toLocaleString()} match "${searchTerm}" (${modeLabel})`;
    } else {
        summary.textContent = `Showing all ${normalisedData.length.toLocaleString()} entries`;
    }
    container.appendChild(summary);

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-box';
        empty.innerHTML = `
            <strong>No matching records found.</strong>
            <p>Try a different spelling, turn off whole-word mode, or include additional metadata / rationales in search.</p>
        `;
        container.appendChild(empty);
    }

    items.forEach(view => container.appendChild(renderCard(view, searchTerm)));

    updatePaginationControls();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderCard(view, searchTerm) {
    const card = document.createElement('div');
    card.className = 'card';

    const imageHtml      = renderImages(view.imageLinks);
    const structuredHtml = showStructuredMetadata ? renderStructuredMetadata(view.structured, searchTerm) : '';
    const makerHtml       = renderMakerNames(view.makerDetails, searchTerm);

    // If the term is only present because of hidden/rationale fields (i.e.
    // it isn't in anything the card actually displays), say so explicitly.
    let matchNote = '';
    if (searchTerm && (includeDeepMetadata || includeRationales)) {
        const visibleRegex = buildRegex(searchTerm, false);
        if (!visibleRegex.test(view.visibleBlob)) {
            matchNote = `
                <div class="match-note">
                    ⓘ This entry matched "${escapeHtml(searchTerm)}" only in additional metadata
                    not shown below (hidden fields and/or rationales).
                </div>
            `;
        }
    }

    card.innerHTML = `
        <div class="photo-column">
            ${imageHtml}
        </div>
        <div class="content-column">
            <div class="meta">
                <span>📅 ${highlightHtml(view.date || 'Undated', searchTerm)}</span>
                <span class="meta-divider">|</span>
                <span>📷 ${makerHtml}</span>
            </div>
            <h3>${highlightHtml(view.title, searchTerm)}</h3>
            <div class="record-submeta">
                ${view.identifier ? `<span>ID: ${escapeHtml(view.identifier)}</span>` : ''}
                ${view.uid        ? `<span>UID: ${escapeHtml(view.uid)}</span>`        : ''}
                <span>Schema: ${escapeHtml(view.schemaType)}</span>
            </div>
            ${view.collectionUrl ? `
                <div class="uid-link">
                    🔗 <a href="${escapeAttribute(view.collectionUrl)}" target="_blank" rel="noopener">
                        View collection object
                    </a>
                </div>
            ` : ''}
            ${matchNote}
            ${view.description ? `
                <div class="description-box">
                    ${highlightHtml(view.description, searchTerm)}
                </div>
            ` : ''}
            <div class="section-label">Transcription</div>
            <div class="transcription-box">
                ${highlightHtml(view.transcription || 'No transcription available.', searchTerm)}
            </div>
            ${structuredHtml}
        </div>
    `;

    return card;
}

/**
 * Renders every photographer/maker name found, each tagged with the exact
 * field it came from, instead of a single unattributed name.
 */
function renderMakerNames(makerDetails, searchTerm) {
    if (!makerDetails || !makerDetails.length) return 'Unknown';

    return makerDetails.map(m => {
        const nameHtml = highlightHtml(m.name, searchTerm);
        return `${nameHtml}<span class="source-tag">${escapeHtml(m.source)}</span>`;
    }).join('<span class="maker-sep">;</span> ');
}

function renderImages(imageLinks) {
    if (!imageLinks.length) {
        return `<div class="photo-placeholder"><span>No image URL available</span></div>`;
    }

    if (imageLinks.length === 1) {
        const url = imageLinks[0];
        return `
            <div class="photo-wrapper single-photo">
                <span>Image</span>
                <img
                    src="${escapeAttribute(url)}"
                    onclick="window.open('${escapeAttribute(url)}')"
                    loading="lazy"
                    alt="Daily Herald archive photograph"
                >
            </div>
        `;
    }

    return imageLinks.map((url, i) => `
        <div class="photo-wrapper">
            <span>${escapeHtml(i === 0 ? 'Image 1' : `Image ${i + 1}`)}</span>
            <img
                src="${escapeAttribute(url)}"
                onclick="window.open('${escapeAttribute(url)}')"
                loading="lazy"
                alt="Daily Herald archive photograph ${i + 1}"
            >
        </div>
    `).join('');
}

function renderStructuredMetadata(groups, searchTerm) {
    if (!groups.length) return '';
    const sections = groups.map(group => `
        <details class="metadata-group">
            <summary>${escapeHtml(group.label)}</summary>
            <ul>${group.values.map(v => `<li>${highlightHtml(v, searchTerm)}</li>`).join('')}</ul>
        </details>
    `).join('');
    return `
        <div class="structured-metadata">
            <div class="section-label">Structured metadata</div>
            ${sections}
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination (prev/next + jump-to-page dropdown)
// ─────────────────────────────────────────────────────────────────────────────

function updatePaginationControls() {
    const totalPages = Math.max(1, Math.ceil(filteredData.length / ITEMS_PER_PAGE));

    document.getElementById('pageIndicator').innerText = `Page ${currentPage} of ${totalPages}`;
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage >= totalPages;

    const select = document.getElementById('pageSelect');
    if (totalPages !== lastTotalPages) {
        const fragment = document.createDocumentFragment();
        for (let p = 1; p <= totalPages; p++) {
            const opt = document.createElement('option');
            opt.value = String(p);
            opt.textContent = `Page ${p}`;
            fragment.appendChild(opt);
        }
        select.innerHTML = '';
        select.appendChild(fragment);
        lastTotalPages = totalPages;
    }
    select.value = String(currentPage);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('wholeWordToggle').addEventListener('click', () => {
    wholeWordMode = !wholeWordMode;
    const btn = document.getElementById('wholeWordToggle');
    btn.classList.toggle('active', wholeWordMode);
    btn.title = wholeWordMode
        ? 'Whole word — click for partial match'
        : 'Partial match — click for whole word';
    runSearch();
});

document.getElementById('includeRationalesToggle').addEventListener('change', event => {
    includeRationales = event.target.checked;
    runSearch();
});

document.getElementById('includeDeepMetadataToggle').addEventListener('change', event => {
    includeDeepMetadata = event.target.checked;
    runSearch();
});

document.getElementById('showStructuredToggle').addEventListener('change', event => {
    showStructuredMetadata = event.target.checked;
    renderGallery(document.getElementById('searchInput').value.trim());
});

const debouncedSearch = debounce(runSearch, 250);
document.getElementById('searchInput').addEventListener('input', debouncedSearch);

document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        renderGallery(document.getElementById('searchInput').value.trim());
    }
});

document.getElementById('nextBtn').addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredData.length / ITEMS_PER_PAGE));
    if (currentPage < totalPages) {
        currentPage++;
        renderGallery(document.getElementById('searchInput').value.trim());
    }
});

document.getElementById('pageSelect').addEventListener('change', event => {
    currentPage = parseInt(event.target.value, 10) || 1;
    renderGallery(document.getElementById('searchInput').value.trim());
});

loadData();
