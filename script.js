// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let normalisedData = [];   // Pre-processed once at load time
let filteredData   = [];
let currentPage    = 1;

const ITEMS_PER_PAGE = 5;
let wholeWordMode        = false;
let includeRationales    = false;
let showStructuredMetadata = true;

// ── List your chunk files here ───────────────────────────────────────────────
const DATA_FILES = [
    'data_1.json',
    'data_2.json',
    'data_3.json',
    'data_4.json',
    'data_5.json'
];

// ─────────────────────────────────────────────────────────────────────────────
// Loading  —  normalise & index everything once, up-front
// ─────────────────────────────────────────────────────────────────────────────

async function loadData() {
    const container = document.getElementById('gallery-container');

    try {
        // Fetch all chunks in parallel
        const responses = await Promise.all(DATA_FILES.map(f => fetch(f)));
        const chunks    = await Promise.all(
            responses.map(r => {
                if (!r.ok) throw new Error(`Failed to fetch ${r.url}`);
                return r.json();
            })
        );

        const rawRecords = chunks.flatMap(extractRecordsFromChunk).reverse();

        // ── KEY OPTIMISATION: normalise every record once, including its
        //    search blob, then never touch it again during typing.
        normalisedData = rawRecords.map(item => normaliseRecord(item, false));

        filteredData = normalisedData;
        renderGallery();
    } catch (e) {
        console.error('Failed to load data', e);
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
    if (Array.isArray(chunk))               return chunk;
    if (chunk && Array.isArray(chunk.records)) return chunk.records;
    if (chunk && typeof chunk === 'object') return [chunk];
    return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema detection and normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object}  item
 * @param {boolean} withRationales  – pass true to build a blob that includes
 *                                    rationale fields (only used when the
 *                                    toggle is switched on after initial load)
 */
function normaliseRecord(item, withRationales = false) {
    const schemaType   = detectSchemaType(item);
    const transcription = getTranscription(item);
    const dateInfo     = getDateInfo(item);
    const maker        = getMaker(item);
    const imageLinks   = getImageLinks(item);

    const uid = getFirstValue([item.uid, item.object_uid, item.collection_uid]);

    const identifier = getFirstValue([
        item.identifier,
        item.id,
        getNested(item, 'editorial.accession_number'),
        getNested(item, 'section5_rights.editorial_metadata.accession_number')
    ]);

    const title = getFirstValue([
        item.title,
        getNested(item, 'title'),
        identifier ? `Daily Herald record ${identifier}` : '',
        uid        ? `Daily Herald object ${uid}`        : ''
    ]) || 'Untitled Archive Record';

    const description = getFirstValue([
        item.description,
        item.activity,
        getNested(item, 'section4_subject.depicted_activity.description'),
        getNested(item, 'editorial.story_or_series_title'),
        getNested(item, 'section5_rights.editorial_metadata.story_or_series_title')
    ]);

    const collectionUrl = getCollectionUrl(item, uid);
    const structured    = getStructuredMetadata(item);

    const searchBlob = buildSearchBlob(item, {
        transcription,
        title,
        description,
        maker,
        date: dateInfo.display,
        uid,
        identifier,
        structured
    }, withRationales);

    return {
        original: item,
        schemaType,
        uid,
        identifier,
        title,
        description,
        maker,
        date: dateInfo.display,
        dateDetails: dateInfo.details,
        transcription,
        imageLinks,
        collectionUrl,
        structured,
        searchBlob
    };
}

function detectSchemaType(item) {
    if (!item || typeof item !== 'object') return 'unknown';
    if (item.section0_transcription || item.section1_people || item.section5_rights)
        return 'full structured schema';
    if (Array.isArray(item.te) || item.editorial || item.date_info)
        return 'nested compact schema';
    if (item.Transcribed_Text || item.image_links)
        return 'flat GitHub schema';
    return 'unknown schema';
}

// ─────────────────────────────────────────────────────────────────────────────
// Field extraction
// ─────────────────────────────────────────────────────────────────────────────

function getTranscription(item) {
    if (item.Transcribed_Text) return item.Transcribed_Text;

    if (Array.isArray(item.te)) {
        return item.te.map(el => el?.text ?? '').filter(Boolean).join('\n');
    }

    const textElements = getNested(item, 'section0_transcription.text_elements');
    if (Array.isArray(textElements)) {
        return textElements.map(el => el?.transcription ?? '').filter(Boolean).join('\n');
    }

    if (item.text)          return item.text;
    if (item.transcription) return item.transcription;
    return '';
}

function getDateInfo(item) {
    const flatDate          = item.date;
    const compactPrimary    = getNested(item, 'date_info.date_standardised');
    const compactTranscribed = getNested(item, 'date_info.date_as_transcribed');
    const fullPrimary       = getNested(item, 'section3_dates.date_primary.date_standardised');
    const fullTranscribed   = getNested(item, 'section3_dates.date_primary.date_as_transcribed');
    const fullRelationship  = getNested(item, 'section3_dates.date_primary.relationship_label');

    let display = '';
    if (flatDate) {
        display = flatDate;
    } else if (Array.isArray(compactPrimary) && compactPrimary.length) {
        display = compactPrimary.join(' / ');
    } else if (compactTranscribed) {
        display = compactTranscribed;
    } else if (Array.isArray(fullPrimary) && fullPrimary.length) {
        display = fullPrimary.join(' / ');
    } else if (fullTranscribed) {
        display = fullTranscribed;
    }

    const details = [];
    if (compactTranscribed) details.push(`Transcribed: ${compactTranscribed}`);
    if (fullTranscribed)    details.push(`Transcribed: ${fullTranscribed}`);
    if (fullRelationship)   details.push(`Relationship: ${fullRelationship}`);

    return { display, details };
}

function getMaker(item) {
    if (item.maker) return item.maker;

    if (Array.isArray(item.photographers) && item.photographers.length) {
        return item.photographers
            .map(p => p.name || p.name_standardised || p.name_as_transcribed)
            .filter(Boolean).join('; ');
    }

    const fullPhotographers = getNested(item, 'section1_people.photographers');
    if (Array.isArray(fullPhotographers) && fullPhotographers.length) {
        return fullPhotographers
            .map(p => p.name_standardised || p.name_as_transcribed)
            .filter(Boolean).join('; ');
    }

    if (Array.isArray(item.rights) && item.rights.length) {
        return item.rights.map(r => r.holder).filter(Boolean).join('; ');
    }

    const fullRights = getNested(item, 'section5_rights.rights_and_ownership');
    if (Array.isArray(fullRights) && fullRights.length) {
        return fullRights.map(r => r.copyright_holder).filter(Boolean).join('; ');
    }

    return '';
}

function getImageLinks(item) {
    if (item.image_links) {
        return item.image_links.split(';').map(s => s.trim()).filter(Boolean);
    }
    if (item.img)       return [item.img];
    if (item.image_url) return [item.image_url];
    if (item.image)     return [item.image];
    return [];
}

function getCollectionUrl(item, uid) {
    if (item.url) return item.url;
    if (uid)      return `https://collection.sciencemuseumgroup.org.uk/objects/${uid}`;
    return '';
}

function getStructuredMetadata(item) {
    const groups = [];

    addGroup(groups, 'Photographers',    extractCompactPeople(item.photographers, 'name'));
    addGroup(groups, 'People depicted',  extractCompactPeople(item.depicted, 'name'));
    addGroup(groups, 'People mentioned', extractCompactPeople(item.mentioned, 'name'));
    addGroup(groups, 'Places depicted',  extractCompactPeople(item.places_dep, 'name'));
    addGroup(groups, 'Places mentioned', extractCompactPeople(item.places_men, 'name'));
    addGroup(groups, 'Rights',           extractCompactRights(item.rights));
    addGroup(groups, 'Editorial',        extractEditorial(item.editorial));

    addGroup(groups, 'Photographers',    extractFullPeople(getNested(item, 'section1_people.photographers')));
    addGroup(groups, 'People depicted',  extractFullPeople(getNested(item, 'section1_people.people_depicted')));
    addGroup(groups, 'People mentioned', extractFullPeople(getNested(item, 'section1_people.people_mentioned')));
    addGroup(groups, 'Places depicted',  extractFullPlaces(getNested(item, 'section2_places.places_depicted')));
    addGroup(groups, 'Places mentioned', extractFullPlaces(getNested(item, 'section2_places.places_mentioned')));
    addGroup(groups, 'Rights',           extractFullRights(getNested(item, 'section5_rights.rights_and_ownership')));
    addGroup(groups, 'Editorial',        extractEditorial(getNested(item, 'section5_rights.editorial_metadata')));

    return mergeDuplicateGroups(groups);
}

function extractCompactPeople(arr, key) {
    if (!Array.isArray(arr)) return [];
    return arr.map(obj => {
        if (!obj) return '';
        if (typeof obj === 'string') return obj;
        const name = obj[key] || obj.name_standardised || obj.name_as_transcribed || '';
        const rel  = obj.rel || obj.relationship_label || '';
        return rel ? `${name} — ${rel}` : name;
    }).filter(Boolean);
}

function extractCompactRights(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(r => {
        if (!r) return '';
        const holder = r.holder || r.copyright_holder || '';
        const type   = r.type  || r.rights_type       || '';
        return [holder, type].filter(Boolean).join(' — ');
    }).filter(Boolean);
}

function extractFullPeople(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(p => {
        if (!p) return '';
        const name = p.name_standardised || p.name_as_transcribed || '';
        const rel  = p.relationship_label || p.identification_certainty || '';
        return rel ? `${name} — ${rel}` : name;
    }).filter(Boolean);
}

function extractFullPlaces(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(p => {
        if (!p) return '';
        const name = p.name_standardised || p.name_as_transcribed || '';
        const rel  = p.relationship_label || p.place_type || '';
        return rel ? `${name} — ${rel}` : name;
    }).filter(Boolean);
}

function extractFullRights(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(r => {
        if (!r) return '';
        const holder = r.copyright_holder || '';
        const type   = r.rights_type      || '';
        return [holder, type].filter(Boolean).join(' — ');
    }).filter(Boolean);
}

function extractEditorial(editorial) {
    if (!editorial || typeof editorial !== 'object') return [];
    const rows   = [];
    const labels = {
        publication_name:      'Publication',
        story_or_series_title: 'Story / series',
        caption_reference_codes: 'Reference codes',
        image_sequence_number: 'Image sequence',
        accession_number:      'Accession number'
    };
    Object.entries(labels).forEach(([key, label]) => {
        const value = editorial[key];
        if (value) rows.push(`${label}: ${value}`);
    });
    return rows;
}

function addGroup(groups, label, values) {
    if (Array.isArray(values) && values.length) groups.push({ label, values });
}

function mergeDuplicateGroups(groups) {
    const merged = new Map();
    groups.forEach(({ label, values }) => {
        if (!merged.has(label)) merged.set(label, new Set());
        values.forEach(v => { if (v) merged.get(label).add(v); });
    });
    return Array.from(merged.entries())
        .map(([label, set]) => ({ label, values: Array.from(set) }))
        .filter(g => g.values.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Search  —  fast path: test pre-built blobs, never re-normalise
// ─────────────────────────────────────────────────────────────────────────────

function normaliseString(str) {
    return String(str || '').replace(/\s+/g, ' ').trim();
}

function buildRegex(term) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = wholeWordMode ? `\\b${escaped}\\b` : escaped;
    return new RegExp(pattern, 'i');
}

/**
 * Rebuild every record's searchBlob when the rationale toggle changes.
 * This is a one-off cost on toggle, not per-keystroke.
 */
function rebuildBlobs() {
    normalisedData = normalisedData.map(view => {
        const newBlob = buildSearchBlob(
            view.original,
            {
                transcription: view.transcription,
                title:         view.title,
                description:   view.description,
                maker:         view.maker,
                date:          view.date,
                uid:           view.uid,
                identifier:    view.identifier,
                structured:    view.structured
            },
            includeRationales
        );
        return { ...view, searchBlob: newBlob };
    });
}

function runSearch() {
    const raw = document.getElementById('searchInput').value.trim();

    if (!raw) {
        filteredData = normalisedData;
        currentPage  = 1;
        renderGallery('');
        return;
    }

    const regex = buildRegex(raw);
    // ── KEY OPTIMISATION: test the pre-built blob directly — no object
    //    creation, no field extraction, just a regex test on a string.
    filteredData = normalisedData.filter(view => regex.test(view.searchBlob));
    currentPage  = 1;
    renderGallery(raw);
}

function buildSearchBlob(item, view, withRationales = false) {
    const coreParts = [
        view.transcription,
        view.title,
        view.description,
        view.maker,
        view.date,
        view.uid,
        view.identifier
    ];

    view.structured.forEach(group => {
        coreParts.push(group.label);
        group.values.forEach(v => coreParts.push(v));
    });

    const deepParts = collectDeepText(item, { includeRationales: withRationales });

    return normaliseString([...coreParts, ...deepParts].join(' '));
}

function collectDeepText(value, options = {}, keyPath = '') {
    const parts = [];

    if (value === null || value === undefined) return parts;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        if (!options.includeRationales && keyPath.toLowerCase().includes('rationale')) return parts;
        parts.push(String(value));
        return parts;
    }

    if (Array.isArray(value)) {
        value.forEach((entry, i) =>
            parts.push(...collectDeepText(entry, options, `${keyPath}[${i}]`)));
        return parts;
    }

    if (typeof value === 'object') {
        Object.entries(value).forEach(([key, entry]) =>
            parts.push(...collectDeepText(entry, options, keyPath ? `${keyPath}.${key}` : key)));
    }

    return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderGallery(searchTerm = '') {
    const container = document.getElementById('gallery-container');
    container.innerHTML = '';

    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const end   = start + ITEMS_PER_PAGE;
    const items = filteredData.slice(start, end);

    const summary = document.createElement('div');
    summary.id = 'results-summary';
    if (searchTerm) {
        const modeLabel = wholeWordMode ? 'whole word' : 'partial match';
        summary.textContent =
            `Showing ${normalisedData.length} entries — ${filteredData.length} match "${searchTerm}" (${modeLabel})`;
    } else {
        summary.textContent = `Showing all ${normalisedData.length} entries`;
    }
    container.appendChild(summary);

    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-box';
        empty.innerHTML = `
            <strong>No matching records found.</strong>
            <p>Try a different spelling, turn off whole-word mode, or include rationales in search.</p>
        `;
        container.appendChild(empty);
    }

    items.forEach(view => container.appendChild(renderCard(view)));

    const totalPages = Math.ceil(filteredData.length / ITEMS_PER_PAGE);
    document.getElementById('pageIndicator').innerText =
        `Page ${currentPage} of ${totalPages || 1}`;
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage >= totalPages;

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderCard(view) {
    const card = document.createElement('div');
    card.className = 'card';

    const imageHtml     = renderImages(view.imageLinks);
    const structuredHtml = showStructuredMetadata ? renderStructuredMetadata(view.structured) : '';

    card.innerHTML = `
        <div class="photo-column">
            ${imageHtml}
        </div>
        <div class="content-column">
            <div class="meta">
                <span>📅 ${escapeHtml(view.date || 'Undated')}</span>
                <span class="meta-divider">|</span>
                <span>📷 ${escapeHtml(view.maker || 'Unknown')}</span>
            </div>
            <h3>${escapeHtml(view.title)}</h3>
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
            ${view.description ? `
                <div class="description-box">
                    ${escapeHtml(view.description)}
                </div>
            ` : ''}
            <div class="section-label">Transcription</div>
            <div class="transcription-box">
                ${escapeHtml(view.transcription || 'No transcription available.')}
            </div>
            ${structuredHtml}
        </div>
    `;

    return card;
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

function renderStructuredMetadata(groups) {
    if (!groups.length) return '';
    const sections = groups.map(group => `
        <details class="metadata-group">
            <summary>${escapeHtml(group.label)}</summary>
            <ul>${group.values.map(v => `<li>${escapeHtml(v)}</li>`).join('')}</ul>
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
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function getNested(obj, path) {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((acc, key) =>
        acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined, obj);
}

function getFirstValue(values) {
    return values.find(v =>
        Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
}

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Debounce helper
// ─────────────────────────────────────────────────────────────────────────────

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
    // Rebuild all blobs once (one-off cost), then re-run the current search.
    rebuildBlobs();
    runSearch();
});

document.getElementById('showStructuredToggle').addEventListener('change', event => {
    showStructuredMetadata = event.target.checked;
    renderGallery(document.getElementById('searchInput').value.trim());
});

// ── KEY OPTIMISATION: debounce the input so we only run the filter
//    250 ms after the user stops typing, not on every single keystroke.
const debouncedSearch = debounce(runSearch, 250);
document.getElementById('searchInput').addEventListener('input', debouncedSearch);

document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        renderGallery(document.getElementById('searchInput').value.trim());
    }
});

document.getElementById('nextBtn').addEventListener('click', () => {
    if ((currentPage * ITEMS_PER_PAGE) < filteredData.length) {
        currentPage++;
        renderGallery(document.getElementById('searchInput').value.trim());
    }
});

loadData();
