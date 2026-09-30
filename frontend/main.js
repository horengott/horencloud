const initData = window.Telegram?.WebApp?.initData || '';
const authHeaders = { 
    'Authorization': `Bearer ${initData}` 
};

async function loadFiles() {
    try {
        // Llama al endpoint GET /files[cite: 11]
        const response = await fetch('/files', { headers: authHeaders });
        
        if (response.ok) {
            const files = await response.json();
            renderGallery(files);
        } else {
            console.error("Error al obtener los archivos");
        }
    } catch (error) {
        console.error("Error de red:", error);
    }
}

function renderGallery(files) {
    const galleryGrid = document.getElementById('gallery-grid');
    galleryGrid.innerHTML = '';

    if (files.length === 0) {
        galleryGrid.innerHTML = `
            <div class="empty-state">
                <p style="color: var(--text-secondary)">No tienes fotos guardadas aún</p>
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

loadFiles();