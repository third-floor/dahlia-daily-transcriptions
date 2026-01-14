let allData = [];
let filteredData = [];
let currentPage = 1;
const itemsPerPage = 5; // As requested, only 5 images/cards displayed at once

async function loadData() {
    try {
        const response = await fetch('data.json');
        allData = await response.json();
        
        // Reverse the data so the most recent transcriptions (bottom of spreadsheet) appear first
        allData.reverse(); 
        
        filteredData = [...allData];
        renderGallery();
    } catch (error) {
        console.error("Error loading the JSON data:", error);
        document.getElementById('gallery-container').innerHTML = "<p>Error loading archives. Please ensure data.json is uploaded.</p>";
    }
}

function renderGallery() {
    const container = document.getElementById('gallery-container');
    container.innerHTML = '';
    
    // Pagination math
    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const paginatedItems = filteredData.slice(start, end);

    paginatedItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'card';

        // Split the image_links string into an array
        // Expected format in Excel: "url1;url2"
        const links = item.image_links ? item.image_links.split(';') : [];
        const frontImg = links[0] ? links[0].trim() : '';
        const backImg = links[1] ? links[1].trim() : frontImg; // Fallback to front if back is missing

        // Build the card HTML
        card.innerHTML = `
            <div class="photo-pair">
                <div class="photo-wrapper">
                    <small>Front</small>
                    <img src="${frontImg}" alt="Photo Front" loading="lazy" onclick="window.open('${frontImg}')">
                </div>
                <div class="photo-wrapper">
                    <small>Back</small>
                    <img src="${backImg}" alt="Photo Back" loading="lazy" onclick="window.open('${backImg}')">
                </div>
            </div>
            <div class="card-content">
                <div class="meta">
                    <span class="date">📅 ${item.date || 'Undated'}</span>
                    <span class="maker">📷 ${item.maker || 'Unknown Photographer'}</span>
                </div>
                <h3>${item.title || 'Daily Herald Archive'}</h3>
                <div class="transcription-label">TRANSRIPTION</div>
                <div class="transcription">${item.Transcribed_Text}</div>
            </div>
        `;
        container.appendChild(card);
    });

    // Update Pagination UI
    const totalPages = Math.ceil(filteredData.length / itemsPerPage);
    document.getElementById('pageIndicator').innerText = `Page ${currentPage} of ${totalPages || 1}`;
    document.getElementById('prevBtn').disabled = currentPage === 1;
    document.getElementById('nextBtn').disabled = currentPage >= totalPages;
    
    // Smooth scroll back to top when page changes
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Search Functionality (Filters through Title or Transcribed Text)
document.getElementById('searchInput').addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    filteredData = allData.filter(item => 
        (item.Transcribed_Text && item.Transcribed_Text.toLowerCase().includes(term)) || 
        (item.title && item.title.toLowerCase().includes(term)) ||
        (item.maker && item.maker.toLowerCase().includes(term))
    );
    currentPage = 1;
    renderGallery();
});

// Button Listeners
document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        renderGallery();
    }
});

document.getElementById('nextBtn').addEventListener('click', () => {
    if ((currentPage * itemsPerPage) < filteredData.length) {
        currentPage++;
        renderGallery();
    }
});

// Initial Load
loadData();