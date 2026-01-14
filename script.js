let allData = [];
let filteredData = [];
let currentPage = 1;
const itemsPerPage = 5;

async function loadData() {
    try {
        const response = await fetch('data.json');
        allData = await response.json();
        // Show newest first
        allData.reverse(); 
        filteredData = [...allData];
        renderGallery();
    } catch (e) {
        console.error("Failed to load data.json", e);
    }
}

function renderGallery() {
    const container = document.getElementById('gallery-container');
    container.innerHTML = '';

    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const items = filteredData.slice(start, end);

    items.forEach(item => {
        const links = item.image_links ? item.image_links.split(';') : [];
        const front = links[0] ? links[0].trim() : '';
        const back = links[1] ? links[1].trim() : front;

        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <div class="photo-column">
                <div class="photo-wrapper">
                    <span>Front</span>
                    <img src="${front}" onclick="window.open('${front}')" loading="lazy">
                </div>
                <div class="photo-wrapper">
                    <span>Back</span>
                    <img src="${back}" onclick="window.open('${back}')" loading="lazy">
                </div>
            </div>
            <div class="content-column">
                <div class="meta">
                    <span>📅 ${item.date || 'Undated'}</span> | 
                    <span>📷 ${item.maker || 'Unknown'}</span>
                </div>
                <h3>${item.title || 'Untitled Archive Record'}</h3>
                <div style="font-size: 0.7rem; font-weight: bold; margin-bottom: 5px; color: #d35400;">TRANSCRIPTION VERIFICATION</div>
                <div class="transcription-box">${item.Transcribed_Text}</div>
            </div>
        `;
        container.appendChild(card);
    });

    // Pagination UI
    const totalPages = Math.ceil(filteredData.length / itemsPerPage);
    document.getElementById('pageIndicator').innerText = `Page ${currentPage} of ${totalPages || 1}`;
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage >= totalPages;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Search
document.getElementById('searchInput').addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    filteredData = allData.filter(item => 
        (item.Transcribed_Text && item.Transcribed_Text.toLowerCase().includes(term)) || 
        (item.title && item.title.toLowerCase().includes(term))
    );
    currentPage = 1;
    renderGallery();
});

document.getElementById('prevBtn').addEventListener('click', () => { if(currentPage > 1) { currentPage--; renderGallery(); } });
document.getElementById('nextBtn').addEventListener('click', () => { if((currentPage * itemsPerPage) < filteredData.length) { currentPage++; renderGallery(); } });

loadData();
