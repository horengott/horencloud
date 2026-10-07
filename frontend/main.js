const initData = window.Telegram?.WebApp?.initData || '';
let authHeaders = {};

async function authenticate() {
    if (!initData) {
        document.body.innerHTML = "<h3 style='color:white;text-align:center;margin-top:50px;'>open telegram pls.../h3>";
        return false;
    }

    try {
        const response = await fetch('/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ init_data: initData })
        });

        if (response.ok) {
            const data = await response.json();
            authHeaders = { 'Authorization': `Bearer ${data.access_token}` };
            return true;
        } else {
            console.error("server authorization error");
            return false;
        }
    } catch (error) {
        console.error("web authorization error:", error);
        return false;
    }
}

async function loadFiles() {
    try {
        const response = await fetch('/files', { headers: authHeaders });
        
        if (response.ok) {
            const files = await response.json();
            renderGallery(files);
        } else {
            console.error("error of getting files");
        }
    } catch (error) {
        console.error("web error:", error);
    }
}

function renderGallery(files) {
    const galleryGrid = document.getElementById('gallery-grid');
    galleryGrid.innerHTML = '';

    if (files.length === 0) {
        galleryGrid.innerHTML = `
            <div class="empty-state">
                <p style="color: var(--text-secondary)">no photos</p>
            </div>`;
        return;
    }

    files.forEach(file => {
        const item = document.createElement('div');
        item.className = 'photo-item';
        
        const imgUrl = `/files/${file.id}/download`; 
        
        item.innerHTML = `<img src="${imgUrl}" alt="${file.name}" loading="lazy">`;
        item.onclick = () => openModal({ id: file.id, url: imgUrl, name: file.name });
        
        galleryGrid.appendChild(item);
    });
}

const fileInput = document.getElementById('file-input');
const uploadBtn = document.getElementById('upload-btn');

uploadBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files.length) return;

    const originalContent = uploadBtn.innerHTML;
    uploadBtn.innerHTML = '<span style="color:#000; font-weight:bold;">...</span>';

    for (const file of files) {
        const formData = new FormData();
        formData.append('file', file); 

        try {
            await fetch('/files', {
                method: 'POST',
                headers: authHeaders, 
                body: formData
            });
        } catch (error) {
            console.error(`Error subiendo ${file.name}:`, error);
        }
    }

    uploadBtn.innerHTML = originalContent;
    fileInput.value = '';
    loadFiles(); 
});

const deleteBtn = document.getElementById('delete-btn');
let selectedPhotoId = null;

function openModal(photo) {
    selectedPhotoId = photo.id;
    document.getElementById('modal-img').src = photo.url;
    document.getElementById('photo-modal').classList.add('open');
}

function closeModal() {
    document.getElementById('photo-modal').classList.remove('open');
    selectedPhotoId = null;
}

deleteBtn.addEventListener('click', async () => {
    if (selectedPhotoId) {
        try {
            const response = await fetch(`/files/${selectedPhotoId}`, {
                method: 'DELETE',
                headers: authHeaders
            });
            
            if (response.ok) {
                closeModal();
                loadFiles(); 
            }
        } catch (error) {
            console.error("failed deleting", error);
        }
    }
});


async function initApp() {
    if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
    }
    
    const isAuthenticated = await authenticate();
    if (isAuthenticated) {
        loadFiles();
    }
}

initApp();