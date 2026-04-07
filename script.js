let allData = [];
let filteredData = [];
let currentPage = 1;
const itemsPerPage = 5;
let wholeWordMode = false;

// ── List your chunk files here ───────────────────────────────────────────────
const DATA_FILES = [
    'data_1.json',
    'data_2.json',
    // add data_3.json etc. if the Python script produced more
];

async function loadData() {
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

        allData = chunks.flat();
        allData.reverse();
        filteredData = [...allData];
        renderGallery();
    } catch (e) {
        console.error("Failed to load data", e);
    }
}

function normalise(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
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
        const text = normalise(item.Transcribed_Text);
        const title = normalise(item.title);
        return regex.test(text) || regex.test(title);
    });

    currentPage = 1;
    renderGallery(raw);
}

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

    items.forEach(item => {
        const links = item.image_links ? item.image_links.split(';') : [];
        const front = links[0] ? links[0].trim() : '';
        const back = links[1] ? links[1].trim() : front;

        const uid = item.uid || '';
        const collectionUrl = uid
            ? `https://collection.sciencemuseumgroup.org.uk/objects/${uid}`
            : '';

        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <div class="photo-column">
                <div class="photo-wrapper">
                    <span>Front</span>
                    <img src="${back}" onclick="window.open('${back}')" loading="lazy">
                </div>
                <div class="photo-wrapper">
                    <span>Back</span>
                    <img src="${front}" onclick="window.open('${front}')" loading="lazy">
                </div>
            </div>

            <div class="content-column">
                <div class="meta">
                    <span>📅 ${item.date || 'Undated'}</span> | 
                    <span>📷 ${item.maker || 'Unknown'}</span>
                </div>

                <h3>${item.title || 'Untitled Archive Record'}</h3>

                ${uid ? `<div class="uid-link">
                    🔗 <a href="${collectionUrl}" target="_blank" rel="noopener">View object ${uid}</a>
                </div>` : ''}

                <div style="font-size: 0.7rem; font-weight: bold; margin-bottom: 5px; color: #d35400;">
                    TRANSCRIPTION VERIFICATION
                </div>

                <div class="transcription-box">
                    ${item.Transcribed_Text || ''}
                </div>
            </div>
        `;

        container.appendChild(card);
    });

    const totalPages = Math.ceil(filteredData.length / itemsPerPage);
    document.getElementById('pageIndicator').innerText =
        `Page ${currentPage} of ${totalPages || 1}`;
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage >= totalPages;

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('wholeWordToggle').addEventListener('click', () => {
    wholeWordMode = !wholeWordMode;
    const btn = document.getElementById('wholeWordToggle');
    btn.classList.toggle('active', wholeWordMode);
    btn.title = wholeWordMode
        ? 'Whole word — click for partial match'
        : 'Partial match — click for whole word';
    runSearch();
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
