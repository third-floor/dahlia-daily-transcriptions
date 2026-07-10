let allData = [];
let filteredData = [];
let currentPage = 1;

const itemsPerPage = 5;
let wholeWordMode = false;
let includeRationales = false;
let showStructuredMetadata = true;

// ── List your chunk files here ───────────────────────────────────────────────
// These files may contain:
// 1. An array of old flat records.
// 2. An object with a "records" array.
// 3. A single rich-schema record.
// 4. A mixture of old and new schema records.
const DATA_FILES = [
    'data_1.json',
    'data_2.json',
    'data_3.json',
    'data_4.json',
    'data_5.json'
];

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadData() {
    const container = document.getElementById('gallery-container');

    try {
        const responses = await Promise.all(
            DATA_FILES.map(f => fetch(f))
        );

        const chunks = await Promise.all(
            responses.map(r => {
                if (!r.ok) throw new Error(`Failed to fetch ${r.url}`);
                return r.json();
            })
        );

        allData = chunks.flatMap(extractRecordsFromChunk);

        // Preserve the previous behaviour: newest / latest chunk entries first.
        allData.reverse();

        filteredData = [...allData];
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
    if (Array.isArray(chunk)) {
        return chunk;
    }

    if (chunk && Array.isArray(chunk.records)) {
        return chunk.records;
    }

    if (chunk && typeof chunk === 'object') {
        return [chunk];
    }

    return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema detection and normalisation
// ─────────────────────────────────────────────────────────────────────────────

function normaliseRecord(item) {
    const schemaType = detectSchemaType(item);

    const transcription = getTranscription(item);
    const dateInfo = getDateInfo(item);
    const maker = getMaker(item);
    const imageLinks = getImageLinks(item);

    const uid = getFirstValue([
        item.uid,
        item.object_uid,
        item.collection_uid
    ]);

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
        uid ? `Daily Herald object ${uid}` : ''
    ]) || 'Untitled Archive Record';

    const description = getFirstValue([
        item.description,
        item.activity,
        getNested(item, 'section4_subject.depicted_activity.description'),
        getNested(item, 'editorial.story_or_series_title'),
        getNested(item, 'section5_rights.editorial_metadata.story_or_series_title')
    ]);

    const collectionUrl = getCollectionUrl(item, uid);

    const structured = getStructuredMetadata(item);
    const searchBlob = buildSearchBlob(item, {
        transcription,
        title,
        description,
        maker,
        date: dateInfo.display,
        uid,
        identifier,
        structured
    });

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

    if (item.section0_transcription || item.section1_people || item.section5_rights) {
        return 'full structured schema';
    }

    if (Array.isArray(item.te) || item.editorial || item.date_info) {
        return 'nested compact schema';
    }

    if (item.Transcribed_Text || item.image_links) {
        return 'flat GitHub schema';
    }

    return 'unknown schema';
}

// ─────────────────────────────────────────────────────────────────────────────
// Field extraction
// ─────────────────────────────────────────────────────────────────────────────

function getTranscription(item) {
    // Old flat GitHub schema.
    if (item.Transcribed_Text) {
        return item.Transcribed_Text;
    }

    // Compact nested schema, e.g. "te": [{"type": "...", "text": "..."}].
    if (Array.isArray(item.te)) {
        return item.te
            .map(el => el && el.text ? el.text : '')
            .filter(Boolean)
            .join('\n');
    }

    // Full prompt schema.
    const textElements = getNested(item, 'section0_transcription.text_elements');
    if (Array.isArray(textElements)) {
        return textElements
            .map(el => el && el.transcription ? el.transcription : '')
            .filter(Boolean)
            .join('\n');
    }

    // Fallbacks.
    if (item.text) return item.text;
    if (item.transcription) return item.transcription;

    return '';
}

function getDateInfo(item) {
    const flatDate = item.date;

    const compactPrimary = getNested(item, 'date_info.date_standardised');
    const compactTranscribed = getNested(item, 'date_info.date_as_transcribed');

    const fullPrimary = getNested(item, 'section3_dates.date_primary.date_standardised');
    const fullTranscribed = getNested(item, 'section3_dates.date_primary.date_as_transcribed');
    const fullRelationship = getNested(item, 'section3_dates.date_primary.relationship_label');

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
    if (fullTranscribed) details.push(`Transcribed: ${fullTranscribed}`);
    if (fullRelationship) details.push(`Relationship: ${fullRelationship}`);

    return {
        display,
        details
    };
}

function getMaker(item) {
    // Old flat GitHub schema.
    if (item.maker) return item.maker;

    // Compact nested schema.
    if (Array.isArray(item.photographers) && item.photographers.length) {
        return item.photographers
            .map(p => p.name || p.name_standardised || p.name_as_transcribed)
            .filter(Boolean)
            .join('; ');
    }

    // Full prompt schema.
    const fullPhotographers = getNested(item, 'section1_people.photographers');
    if (Array.isArray(fullPhotographers) && fullPhotographers.length) {
        return fullPhotographers
            .map(p => p.name_standardised || p.name_as_transcribed)
            .filter(Boolean)
            .join('; ');
    }

    // Rights fallback.
    if (Array.isArray(item.rights) && item.rights.length) {
        return item.rights
            .map(r => r.holder)
            .filter(Boolean)
            .join('; ');
    }

    const fullRights = getNested(item, 'section5_rights.rights_and_ownership');
    if (Array.isArray(fullRights) && fullRights.length) {
        return fullRights
            .map(r => r.copyright_holder)
            .filter(Boolean)
            .join('; ');
    }

    return '';
}

function getImageLinks(item) {
    // Old flat GitHub schema.
    if (item.image_links) {
        return item.image_links
            .split(';')
            .map(s => s.trim())
            .filter(Boolean);
    }

    // Compact nested schema.
    if (item.img) {
        return [item.img];
    }

    // Possible alternatives if future records include them.
    if (item.image_url) return [item.image_url];
    if (item.image) return [item.image];

    return [];
}

function getCollectionUrl(item, uid) {
    if (item.url) {
        return item.url;
    }

    if (uid) {
        return `https://collection.sciencemuseumgroup.org.uk/objects/${uid}`;
    }

    return '';
}

function getStructuredMetadata(item) {
    const groups = [];

    // Compact nested schema.
    addGroup(groups, 'Photographers', extractCompactPeople(item.photographers, 'name'));
    addGroup(groups, 'People depicted', extractCompactPeople(item.depicted, 'name'));
    addGroup(groups, 'People mentioned', extractCompactPeople(item.mentioned, 'name'));
    addGroup(groups, 'Places depicted', extractCompactPeople(item.places_dep, 'name'));
    addGroup(groups, 'Places mentioned', extractCompactPeople(item.places_men, 'name'));
    addGroup(groups, 'Rights', extractCompactRights(item.rights));
    addGroup(groups, 'Editorial', extractEditorial(item.editorial));

    // Full prompt schema.
    addGroup(groups, 'Photographers', extractFullPeople(getNested(item, 'section1_people.photographers')));
    addGroup(groups, 'People depicted', extractFullPeople(getNested(item, 'section1_people.people_depicted')));
    addGroup(groups, 'People mentioned', extractFullPeople(getNested(item, 'section1_people.people_mentioned')));
    addGroup(groups, 'Places depicted', extractFullPlaces(getNested(item, 'section2_places.places_depicted')));
    addGroup(groups, 'Places mentioned', extractFullPlaces(getNested(item, 'section2_places.places_mentioned')));
    addGroup(groups, 'Rights', extractFullRights(getNested(item, 'section5_rights.rights_and_ownership')));
    addGroup(groups, 'Editorial', extractEditorial(getNested(item, 'section5_rights.editorial_metadata')));

    return mergeDuplicateGroups(groups);
}

function extractCompactPeople(arr, key) {
    if (!Array.isArray(arr)) return [];

    return arr
        .map(obj => {
            if (!obj) return '';
            if (typeof obj === 'string') return obj;

            const name = obj[key] || obj.name_standardised || obj.name_as_transcribed || '';
            const rel = obj.rel || obj.relationship_label || '';
            return rel ? `${name} — ${rel}` : name;
        })
        .filter(Boolean);
}

function extractCompactRights(arr) {
    if (!Array.isArray(arr)) return [];

    return arr
        .map(r => {
            if (!r) return '';
            const holder = r.holder || r.copyright_holder || '';
            const type = r.type || r.rights_type || '';
            return [holder, type].filter(Boolean).join(' — ');
        })
        .filter(Boolean);
}

function extractFullPeople(arr) {
    if (!Array.isArray(arr)) return [];

    return arr
        .map(p => {
            if (!p) return '';

            const name = p.name_standardised || p.name_as_transcribed || '';
            const rel = p.relationship_label || p.identification_certainty || '';
            return rel ? `${name} — ${rel}` : name;
        })
        .filter(Boolean);
}

function extractFullPlaces(arr) {
    if (!Array.isArray(arr)) return [];

    return arr
        .map(p => {
            if (!p) return '';

            const name = p.name_standardised || p.name_as_transcribed || '';
            const rel = p.relationship_label || p.place_type || '';
            return rel ? `${name} — ${rel}` : name;
        })
        .filter(Boolean);
}

function extractFullRights(arr) {
    if (!Array.isArray(arr)) return [];

    return arr
        .map(r => {
            if (!r) return '';

            const holder = r.copyright_holder || '';
            const type = r.rights_type || '';
            return [holder, type].filter(Boolean).join(' — ');
        })
        .filter(Boolean);
}

function extractEditorial(editorial) {
    if (!editorial || typeof editorial !== 'object') return [];

    const rows = [];

    const labels = {
        publication_name: 'Publication',
        story_or_series_title: 'Story / series',
        caption_reference_codes: 'Reference codes',
        image_sequence_number: 'Image sequence',
        accession_number: 'Accession number'
    };

    Object.entries(labels).forEach(([key, label]) => {
        const value = editorial[key];
        if (value) rows.push(`${label}: ${value}`);
    });

    return rows;
}

function addGroup(groups, label, values) {
    if (Array.isArray(values) && values.length) {
        groups.push({ label, values });
    }
}

function mergeDuplicateGroups(groups) {
    const merged = new Map();

    groups.forEach(group => {
        if (!merged.has(group.label)) {
            merged.set(group.label, new Set());
        }

        group.values.forEach(value => {
            if (value) merged.get(group.label).add(value);
        });
    });

    return Array.from(merged.entries())
        .map(([label, set]) => ({
            label,
            values: Array.from(set)
        }))
        .filter(group => group.values.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

function normaliseString(str) {
    return String(str || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildRegex(term) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = wholeWordMode ? `\\b${escaped}\\b` : escaped;
    return new RegExp(pattern, 'i');
}

function runSearch() {
    const raw = document.getElementById('searchInput').value.trim();

    if (!raw) {
        filteredData = [...allData];
        currentPage = 1;
        renderGallery('');
        return;
    }

    const regex = buildRegex(raw);

    filteredData = allData.filter(item => {
        const view = normaliseRecord(item);
        return regex.test(view.searchBlob);
    });

    currentPage = 1;
    renderGallery(raw);
}

function buildSearchBlob(item, view) {
    const coreParts = [
        view.transcription,
        view.title,
        view.description,
        view.maker,
        view.date,
        view.uid,
        view.identifier
    ];

    // Add structured display values.
    view.structured.forEach(group => {
        coreParts.push(group.label);
        group.values.forEach(value => coreParts.push(value));
    });

    // Add deep text from the record so both old and new schemas remain searchable.
    // By default this skips rationale fields to reduce noisy matches.
    const deepParts = collectDeepText(item, {
        includeRationales
    });

    return normaliseString([
        ...coreParts,
        ...deepParts
    ].join(' '));
}

function collectDeepText(value, options = {}, keyPath = '') {
    const parts = [];

    if (value === null || value === undefined) {
        return parts;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        if (!options.includeRationales && keyPath.toLowerCase().includes('rationale')) {
            return parts;
        }

        parts.push(String(value));
        return parts;
    }

    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            parts.push(...collectDeepText(entry, options, `${keyPath}[${index}]`));
        });
        return parts;
    }

    if (typeof value === 'object') {
        Object.entries(value).forEach(([key, entry]) => {
            parts.push(...collectDeepText(entry, options, keyPath ? `${keyPath}.${key}` : key));
        });
    }

    return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function renderGallery(searchTerm = '') {
    const container = document.getElementById('gallery-container');
    container.innerHTML = '';

    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const items = filteredData.slice(start, end);

    const summary = document.createElement('div');
    summary.id = 'results-summary';

    if (searchTerm) {
        const modeLabel = wholeWordMode ? 'whole word' : 'partial match';
        summary.textContent =
            `Showing ${allData.length} entries — ${filteredData.length} match "${searchTerm}" (${modeLabel})`;
    } else {
        summary.textContent = `Showing all ${allData.length} entries`;
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

    items.forEach(item => {
        const view = normaliseRecord(item);
        container.appendChild(renderCard(view));
    });

    const totalPages = Math.ceil(filteredData.length / itemsPerPage);

    document.getElementById('pageIndicator').innerText =
        `Page ${currentPage} of ${totalPages || 1}`;

    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage >= totalPages;

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderCard(view) {
    const card = document.createElement('div');
    card.className = 'card';

    const imageHtml = renderImages(view.imageLinks);
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
                ${view.uid ? `<span>UID: ${escapeHtml(view.uid)}</span>` : ''}
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
        return `
            <div class="photo-placeholder">
                <span>No image URL available</span>
            </div>
        `;
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

    return imageLinks
        .map((url, index) => {
            const label = index === 0 ? 'Image 1' : `Image ${index + 1}`;

            return `
                <div class="photo-wrapper">
                    <span>${escapeHtml(label)}</span>
                    <img
                        src="${escapeAttribute(url)}"
                        onclick="window.open('${escapeAttribute(url)}')"
                        loading="lazy"
                        alt="Daily Herald archive photograph ${index + 1}"
                    >
                </div>
            `;
        })
        .join('');
}

function renderStructuredMetadata(groups) {
    if (!groups.length) return '';

    const sections = groups.map(group => {
        const rows = group.values
            .map(value => `<li>${escapeHtml(value)}</li>`)
            .join('');

        return `
            <details class="metadata-group">
                <summary>${escapeHtml(group.label)}</summary>
                <ul>${rows}</ul>
            </details>
        `;
    }).join('');

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

    return path.split('.').reduce((acc, key) => {
        if (acc && Object.prototype.hasOwnProperty.call(acc, key)) {
            return acc[key];
        }

        return undefined;
    }, obj);
}

function getFirstValue(values) {
    return values.find(value => {
        if (Array.isArray(value)) return value.length > 0;
        return value !== undefined && value !== null && value !== '';
    });
}

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
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

document.getElementById('showStructuredToggle').addEventListener('change', event => {
    showStructuredMetadata = event.target.checked;
    renderGallery(document.getElementById('searchInput').value.trim());
});

document.getElementById('searchInput').addEventListener('input', runSearch);

document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        renderGallery(document.getElementById('searchInput').value.trim());
    }
});

document.getElementById('nextBtn').addEventListener('click', () => {
    if ((currentPage * itemsPerPage) < filteredData.length) {
        currentPage++;
        renderGallery(document.getElementById('searchInput').value.trim());
    }
});

loadData();
