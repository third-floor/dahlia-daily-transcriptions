// ─────────────────────────────────────────────────────────────────────────────
// worker.js
//
// All the heavy per-record work (schema detection, field extraction, and
// building the text "blobs" used for search) happens here, off the main
// thread, so the page never freezes while ~40k records are indexed.
//
// This file is loaded in TWO ways:
//   1. As a real Worker ( new Worker('worker.js') ) — the normal path.
//   2. As a plain <script> tag on the main thread — a fallback used only if
//      the browser has no Worker support. In that mode `self` just refers to
//      `window`, so `self.onmessage = ...` is harmless (nothing calls it),
//      but every function below (normaliseRecord, getMakerDetails, etc.)
//      becomes available to script.js so it can process records in chunks
//      on the main thread instead.
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = function (e) {
    const { rawRecords, batchSize } = e.data;
    const total = rawRecords.length;
    const size  = batchSize || 1500;

    for (let start = 0; start < total; start += size) {
        const slice     = rawRecords.slice(start, start + size);
        const processed = slice.map(normaliseRecord);
        self.postMessage({
            type: 'batch',
            records: processed,
            done: Math.min(start + size, total),
            total
        });
    }

    self.postMessage({ type: 'complete', total });
};

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

function normaliseRecord(item) {
    const schemaType    = detectSchemaType(item);
    const transcription = getTranscription(item);
    const dateInfo       = getDateInfo(item);
    const makerDetails   = getMakerDetails(item);
    const imageLinks      = getImageLinks(item);

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
    const structured     = getStructuredMetadata(item);

    const blobs = buildBlobs(item, {
        transcription,
        title,
        description,
        makerNames: makerDetails.map(m => m.name).join(' '),
        date: dateInfo.display,
        uid,
        identifier,
        structured
    });

    // NOTE: we deliberately do NOT return `item` (the original raw record).
    // Nothing in the UI needs it once normalisation is done, and dropping it
    // roughly halves the amount of data that has to be cloned/transferred
    // back from the worker for a dataset of this size.
    return {
        schemaType,
        uid,
        identifier,
        title,
        description,
        makerDetails,
        date: dateInfo.display,
        dateDetails: dateInfo.details,
        transcription,
        imageLinks,
        collectionUrl,
        structured,
        visibleBlob:   blobs.visibleBlob,
        deepBlob:      blobs.deepBlob,
        rationaleBlob: blobs.rationaleBlob
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
    const flatDate           = item.date;
    const compactPrimary     = getNested(item, 'date_info.date_standardised');
    const compactTranscribed = getNested(item, 'date_info.date_as_transcribed');
    const fullPrimary        = getNested(item, 'section3_dates.date_primary.date_standardised');
    const fullTranscribed    = getNested(item, 'section3_dates.date_primary.date_as_transcribed');
    const fullRelationship   = getNested(item, 'section3_dates.date_primary.relationship_label');

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

/**
 * Collects a photographer/maker name from EVERY field that can plausibly
 * supply one, instead of stopping at the first match. Each name is tagged
 * with the exact field it came from, so the UI can show that provenance
 * instead of a single, unattributed name.
 */
function getMakerDetails(item) {
    const details = [];
    const seen = new Set();

    function add(name, source) {
        if (!name || typeof name !== 'string') return;
        const key = name + '|' + source;
        if (seen.has(key)) return;
        seen.add(key);
        details.push({ name, source });
    }

    if (item.maker) add(item.maker, 'maker field');

    if (Array.isArray(item.photographers)) {
        item.photographers.forEach(p => {
            if (!p) return;
            const name = typeof p === 'string'
                ? p
                : (p.name || p.name_standardised || p.name_as_transcribed);
            add(name, 'photographers field');
        });
    }

    const fullPhotographers = getNested(item, 'section1_people.photographers');
    if (Array.isArray(fullPhotographers)) {
        fullPhotographers.forEach(p => {
            if (!p) return;
            add(p.name_standardised || p.name_as_transcribed, 'section1_people.photographers');
        });
    }

    if (Array.isArray(item.rights)) {
        item.rights.forEach(r => {
            if (!r) return;
            add(r.holder, 'rights field (copyright holder)');
        });
    }

    const fullRights = getNested(item, 'section5_rights.rights_and_ownership');
    if (Array.isArray(fullRights)) {
        fullRights.forEach(r => {
            if (!r) return;
            add(r.copyright_holder, 'section5_rights.rights_and_ownership (copyright holder)');
        });
    }

    return details;
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
        publication_name:        'Publication',
        story_or_series_title:   'Story / series',
        caption_reference_codes: 'Reference codes',
        image_sequence_number:   'Image sequence',
        accession_number:        'Accession number'
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

function getNested(obj, path) {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((acc, key) =>
        acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined, obj);
}

function getFirstValue(values) {
    return values.find(v =>
        Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Search blobs
//
// Everything a person can actually SEE on a card (transcription, title,
// description, maker names, date, identifiers, structured metadata values)
// goes into `visibleBlob`. Everything else buried in the raw JSON — fields
// that are never rendered — goes into `deepBlob`, with "rationale" fields
// split out separately into `rationaleBlob`. This is what fixes the
// "fuzzy search" complaint: by default the site only searches `visibleBlob`,
// so a hit always corresponds to something the user can see on the card.
// Searching hidden/rationale fields becomes an explicit opt-in.
// ─────────────────────────────────────────────────────────────────────────────

function buildBlobs(item, view) {
    const visibleParts = [
        view.transcription,
        view.title,
        view.description,
        view.makerNames,
        view.date,
        view.uid,
        view.identifier
    ];

    view.structured.forEach(group => {
        visibleParts.push(group.label);
        group.values.forEach(v => visibleParts.push(v));
    });

    const deepParts      = [];
    const rationaleParts = [];
    collectDeepTextSplit(item, deepParts, rationaleParts, '');

    return {
        visibleBlob:   normaliseString(visibleParts.join(' ')),
        deepBlob:      normaliseString(deepParts.join(' ')),
        rationaleBlob: normaliseString(rationaleParts.join(' '))
    };
}

function collectDeepTextSplit(value, deepParts, rationaleParts, keyPath) {
    if (value === null || value === undefined) return;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        if (keyPath.toLowerCase().includes('rationale')) {
            rationaleParts.push(String(value));
        } else {
            deepParts.push(String(value));
        }
        return;
    }

    if (Array.isArray(value)) {
        value.forEach((entry, i) =>
            collectDeepTextSplit(entry, deepParts, rationaleParts, `${keyPath}[${i}]`));
        return;
    }

    if (typeof value === 'object') {
        Object.entries(value).forEach(([key, entry]) =>
            collectDeepTextSplit(entry, deepParts, rationaleParts, keyPath ? `${keyPath}.${key}` : key));
    }
}

function normaliseString(str) {
    return String(str || '').replace(/\s+/g, ' ').trim();
}
