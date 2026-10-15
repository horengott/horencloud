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
        foldersGrid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">no hay carpetas</div>`;
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
        galleryGrid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">carpeta vacía</div>`;
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
    document.getElementById("folders-grid").classList.add("hidden");
    document.getElementById("gallery-grid").classList.remove("hidden");
    loadFiles();
}

document.getElementById("back-btn").addEventListener("click", () => {
    currentFolderId = null;
    document.getElementById("app-title").textContent = "mi cloud";
    document.getElementById("back-btn").classList.add("hidden");
    document.getElementById("gallery-grid").classList.add("hidden");
    document.getElementById("folders-grid").classList.remove("hidden");
    loadFolders();
});

const fabBtn = document.getElementById("fab-btn");
const fileInput = document.getElementById("file-input");
const coverInput = document.getElementById("cover-input");

fabBtn.addEventListener("click", () => {
    if (currentFolderId === null) {
        document.getElementById("folder-modal").classList.remove("hidden");
    } else {
        fileInput.click();
    }
});

document.getElementById("select-cover-btn").addEventListener("click", () => coverInput.click());

coverInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) {
        selectedCoverFile = e.target.files[0];
        const previewUrl = URL.createObjectURL(selectedCoverFile);
        const previewImg = document.getElementById("cover-preview");
        previewImg.src = previewUrl;
        previewImg.classList.remove("hidden");
    }
});

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
    coverInput.value = "";
}

fileInput.addEventListener("change", async (e) => {
    const files = e.target.files;
    if (!files.length) return;
    const originalContent = fabBtn.innerHTML;
    fabBtn.innerHTML = '<span style="color:#000; font-weight:bold;">...</span>';
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
    document.getElementById("photo-modal").classList.remove("hidden");
}

function closeModal() {
    document.getElementById("photo-modal").classList.add("hidden");
    selectedPhotoId = null;
}

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