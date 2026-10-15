const initData = window.Telegram?.WebApp?.initData || "";
let authHeaders = {};
let currentFolderId = null;
let selectedCoverFile = null;
let selectedPhotoId = null;

async function authenticate() {
    if (!initData) return false;
    try {
        const response = await fetch("/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ init_data: initData })
        });
        if (response.ok) {
            const data = await response.json();
            authHeaders = { "Authorization": `Bearer ${data.access_token}` };
            return true;
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function loadFolders() {
    try {
        const response = await fetch("/folders", { headers: authHeaders });
        if (response.ok) {
            const folders = await response.json();
            renderFolders(folders);
        } else {
            renderFolders([]);
        }
    } catch (error) {
        renderFolders([]);
    }
}

function renderFolders(folders) {
    const foldersGrid = document.getElementById("folders-grid");
    foldersGrid.innerHTML = "";
    if (folders.length === 0) {
        foldersGrid.innerHTML = "<div style=\"grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);\">no hay carpetas</div>";
        return;
    }
    folders.forEach(folder => {
        const item = document.createElement("div");
        item.className = "folder-item";
        const imgUrl = folder.cover_url || "";
        item.innerHTML = `
            <img src="${imgUrl}" alt="${folder.name}" loading="lazy">
            <div class="folder-title">${folder.name}</div>
        `;
        item.onclick = () => openFolder(folder.id, folder.name);
        foldersGrid.appendChild(item);
    });
}

async function loadFiles() {
    if (!currentFolderId) return;
    try {
        const response = await fetch(`/files?folder_id=${currentFolderId}`, { headers: authHeaders });
        if (response.ok) {
            const files = await response.json();
            renderGallery(files);
        } else {
            renderGallery([]);
        }
    } catch (error) {
        renderGallery([]);
    }
}

function renderGallery(files) {
    const galleryGrid = document.getElementById("gallery-grid");
    galleryGrid.innerHTML = "";
    if (files.length === 0) {
        galleryGrid.innerHTML = "<div style=\"grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);\">carpeta vacía</div>";
        return;
    }
    files.forEach(file => {
        const item = document.createElement("div");
        item.className = "photo-item";
        const imgUrl = file.storage_path;
        item.innerHTML = `<img src="${imgUrl}" alt="${file.name}" loading="lazy">`;
        item.onclick = () => openModal({ id: file.id, url: imgUrl, name: file.name });
        galleryGrid.appendChild(item);
    });
}

function openFolder(folderId, folderName) {
    currentFolderId = folderId;
    document.getElementById("app-title").textContent = folderName;
    document.getElementById("back-btn").classList.remove("hidden");
    document.getElementById("delete-folder-btn").classList.remove("hidden");
    document.getElementById("folders-grid").classList.add("hidden");
    document.getElementById("gallery-grid").classList.remove("hidden");
    loadFiles();
}

document.getElementById("back-btn").addEventListener("click", () => {
    currentFolderId = null;
    document.getElementById("app-title").textContent = "mi cloud";
    document.getElementById("back-btn").classList.add("hidden");
    document.getElementById("delete-folder-btn").classList.add("hidden");
    document.getElementById("gallery-grid").classList.add("hidden");
    document.getElementById("folders-grid").classList.remove("hidden");
    loadFolders();
});

const fabBtn = document.getElementById("fab-btn");
const fileInput = document.getElementById("file-input");

fabBtn.addEventListener("click", () => {
    if (currentFolderId === null) {
        document.getElementById("folder-modal").classList.remove("hidden");
    } else {
        fileInput.click();
    }
});

document.getElementById("select-cover-btn").addEventListener("click", async () => {
    document.getElementById("cover-selection-modal").classList.remove("hidden");
    const coverGrid = document.getElementById("cover-grid");
    coverGrid.innerHTML = "<p style=\"grid-column: 1 / -1; text-align: center;\">cargando fotos...</p>";
    try {
        const url = currentFolderId ? `/files?folder_id=${currentFolderId}` : "/files";
        const response = await fetch(url, { headers: authHeaders });
        if (response.ok) {
            const files = await response.json();
            coverGrid.innerHTML = "";
            if (files.length === 0) {
                coverGrid.innerHTML = "<p style=\"grid-column: 1 / -1; text-align: center; color: var(--text-muted);\">no hay fotos disponibles</p>";
            } else {
                files.forEach(file => {
                    const item = document.createElement("div");
                    item.className = "photo-item";
                    item.innerHTML = `<img src="${file.storage_path}" alt="${file.name}" loading="lazy">`;
                    item.onclick = () => selectCoverFromApp(file.id, file.name);
                    coverGrid.appendChild(item);
                });
            }
        }
    } catch (error) {
        coverGrid.innerHTML = "<p style=\"grid-column: 1 / -1; text-align: center;\">error al cargar</p>";
    }
});

function closeCoverSelectionModal() {
    document.getElementById("cover-selection-modal").classList.add("hidden");
}

async function selectCoverFromApp(fileId, fileName) {
    closeCoverSelectionModal();
    const selectBtn = document.getElementById("select-cover-btn");
    selectBtn.textContent = "descargando...";
    try {
        const response = await fetch(`/files/${fileId}/download`, { headers: authHeaders });
        if (response.ok) {
            const blob = await response.blob();
            selectedCoverFile = new File([blob], fileName, { type: blob.type || "image/jpeg" });
            const previewUrl = URL.createObjectURL(selectedCoverFile);
            const previewImg = document.getElementById("cover-preview");
            previewImg.src = previewUrl;
            previewImg.classList.remove("hidden");
        }
    } catch (error) {}
    selectBtn.textContent = "seleccionar portada";
}

document.getElementById("create-folder-btn").addEventListener("click", async () => {
    const folderName = document.getElementById("folder-name").value;
    if (!folderName) return;
    const formData = new FormData();
    formData.append("name", folderName);
    if (selectedCoverFile) {
        formData.append("cover", selectedCoverFile);
    }
    try {
        const response = await fetch("/folders", {
            method: "POST",
            headers: authHeaders,
            body: formData
        });
        if (response.ok) {
            closeFolderModal();
            loadFolders();
        }
    } catch (error) {}
});

function closeFolderModal() {
    document.getElementById("folder-modal").classList.add("hidden");
    document.getElementById("folder-name").value = "";
    document.getElementById("cover-preview").classList.add("hidden");
    document.getElementById("cover-preview").src = "";
    selectedCoverFile = null;
}

fileInput.addEventListener("change", async (e) => {
    const files = e.target.files;
    if (!files.length) return;
    const originalContent = fabBtn.innerHTML;
    fabBtn.innerHTML = "<span style=\"color:#000; font-weight:bold;\">...</span>";
    for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("folder_id", currentFolderId);
        try {
            await fetch("/files", {
                method: "POST",
                headers: authHeaders,
                body: formData
            });
        } catch (error) {}
    }
    fabBtn.innerHTML = originalContent;
    fileInput.value = "";
    loadFiles();
});

function openModal(photo) {
    selectedPhotoId = photo.id;
    document.getElementById("modal-img").src = photo.url;
    document.getElementById("modal-img").alt = photo.name;
    document.getElementById("photo-modal").classList.remove("hidden");
}

function closeModal() {
    document.getElementById("photo-modal").classList.add("hidden");
    selectedPhotoId = null;
}

document.getElementById("download-btn").addEventListener("click", async () => {
    if (selectedPhotoId) {
        try {
            const response = await fetch(`/files/${selectedPhotoId}/download`, {
                headers: authHeaders
            });
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = document.getElementById("modal-img").alt || "download";
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(url);
            }
        } catch (error) {}
    }
});

document.getElementById("delete-btn").addEventListener("click", async () => {
    if (selectedPhotoId) {
        try {
            const response = await fetch(`/files/${selectedPhotoId}`, {
                method: "DELETE",
                headers: authHeaders
            });
            if (response.ok) {
                closeModal();
                loadFiles();
            }
        } catch (error) {}
    }
});

document.getElementById("delete-folder-btn").addEventListener("click", async () => {
    if (currentFolderId) {
        try {
            const response = await fetch(`/folders/${currentFolderId}`, {
                method: "DELETE",
                headers: authHeaders
            });
            if (response.ok) {
                document.getElementById("back-btn").click();
            }
        } catch (error) {}
    }
});

function setTelegramAvatar() {
    const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
    if (user && user.photo_url) {
        document.getElementById("user-avatar").style.backgroundImage = `url('${user.photo_url}')`;
    }
}

async function initApp() {
    if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
        setTelegramAvatar();
    }
    const isAuthenticated = await authenticate();
    if (isAuthenticated) {
        loadFolders();
        document.getElementById("main-app").classList.remove("hidden");
    } else {
        document.getElementById("main-app").classList.remove("hidden");
    }
}

initApp();