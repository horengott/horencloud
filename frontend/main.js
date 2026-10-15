
const initData = window.Telegram?.WebApp?.initData || "";
let authHeaders = {};
let currentFolderId = null;
let selectedCoverFile = null;
let selectedPhotoId = null;
let totalBytes = 0;
let confirmCallback = null;
let scale = 1;

async function authenticate() {
    if (!initData) return false;
    try {
        const response = await fetch("/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ init_data: initData }) });
        if (response.ok) { const data = await response.json(); authHeaders = { "Authorization": `Bearer ${data.access_token}` }; return true; }
        return false;
    } catch (error) { return false; }
}

function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function updateStorageUI() {
    const totalGB = 10;
    const usedFormatted = formatBytes(totalBytes);
    document.getElementById("storage-info").textContent = `10 GB - ${usedFormatted} usados`;
}

async function loadFolders() {
    try {
        const response = await fetch("/folders", { headers: authHeaders });
        if (response.ok) {
            const folders = await response.json();
            renderFolders(folders);
        } else { renderFolders([]); }
    } catch (error) { renderFolders([]); }
}

function renderFolders(folders) {
    const foldersGrid = document.getElementById("folders-grid");
    foldersGrid.innerHTML = "";
    if (folders.length === 0) { foldersGrid.innerHTML = "<div style='grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);'>no hay carpetas</div>"; return; }
    folders.forEach(folder => {
        const item = document.createElement("div");
        item.className = "folder-item";
        item.innerHTML = `<img src="${folder.cover_url || ''}" alt="${folder.name}" loading="lazy"><div class="folder-title">${folder.name}</div>`;
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
            totalBytes = files.reduce((sum, f) => sum + (f.size_bytes || 0), 0);
            updateStorageUI();
            renderGallery(files);
        } else { renderGallery([]); }
    } catch (error) { renderGallery([]); }
}

function renderGallery(files) {
    const galleryGrid = document.getElementById("gallery-grid");
    galleryGrid.innerHTML = "";
    if (files.length === 0) { galleryGrid.innerHTML = "<div style='grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);'>carpeta vacía</div>"; return; }
    files.forEach(file => {
        const item = document.createElement("div");
        item.className = "photo-item";
        item.innerHTML = `<img src="${file.storage_path}" alt="${file.name}" loading="lazy">`;
        item.onclick = () => openModal({ id: file.id, url: file.storage_path, name: file.name });
        galleryGrid.appendChild(item);
    });
}

function openFolder(folderId, folderName) {
    currentFolderId = folderId;
    document.querySelector(".greeting").style.display = "none";
    document.getElementById("greeting-name").textContent = folderName;
    document.getElementById("back-btn").classList.remove("hidden");
    document.getElementById("delete-folder-btn").classList.remove("hidden");
    document.getElementById("folders-grid").classList.add("hidden");
    document.getElementById("gallery-grid").classList.remove("hidden");
    loadFiles();
}

document.getElementById("back-btn").addEventListener("click", () => {
    currentFolderId = null;
    document.querySelector(".greeting").style.display = "inline";
    setTelegramAvatar();
    document.getElementById("back-btn").classList.add("hidden");
    document.getElementById("delete-folder-btn").classList.add("hidden");
    document.getElementById("gallery-grid").classList.add("hidden");
    document.getElementById("folders-grid").classList.remove("hidden");
    loadFolders();
});

const fabBtn = document.getElementById("fab-btn");
const fileInput = document.getElementById("file-input");

fabBtn.addEventListener("click", () => {
    if (currentFolderId === null) { document.getElementById("folder-modal").classList.remove("hidden"); }
    else { fileInput.click(); }
});

document.getElementById("select-cover-btn").addEventListener("click", async () => {
    document.getElementById("cover-selection-modal").classList.remove("hidden");
    const coverGrid = document.getElementById("cover-grid");
    coverGrid.innerHTML = "<p style='grid-column: 1 / -1; text-align: center;'>cargando fotos...</p>";
    try {
        const url = currentFolderId ? `/files?folder_id=${currentFolderId}` : "/files";
        const response = await fetch(url, { headers: authHeaders });
        if (response.ok) {
            const files = await response.json();
            coverGrid.innerHTML = "";
            if (files.length === 0) { coverGrid.innerHTML = "<p style='grid-column: 1 / -1; text-align: center; color: var(--text-muted);'>no hay fotos</p>"; }
            else {
                files.forEach(file => {
                    const item = document.createElement("div");
                    item.className = "photo-item";
                    item.innerHTML = `<img src="${file.storage_path}" alt="${file.name}" loading="lazy">`;
                    item.onclick = () => selectCoverFromApp(file.id, file.name);
                    coverGrid.appendChild(item);
                });
            }
        }
    } catch (error) { coverGrid.innerHTML = "<p style='grid-column: 1 / -1; text-align: center;'>error</p>"; }
});

function closeCoverSelectionModal() { document.getElementById("cover-selection-modal").classList.add("hidden"); }

async function selectCoverFromApp(fileId, fileName) {
    closeCoverSelectionModal();
    const selectBtn = document.getElementById("select-cover-btn");
    selectBtn.textContent = "descargando...";
    try {
        const response = await fetch(`/files/${fileId}/download`, { headers: authHeaders });
        if (response.ok) {
            const blob = await response.blob();
            selectedCoverFile = new File([blob], fileName, { type: blob.type || "image/jpeg" });
            document.getElementById("cover-preview").src = URL.createObjectURL(selectedCoverFile);
            document.getElementById("cover-preview").classList.remove("hidden");
        }
    } catch (error) {}
    selectBtn.textContent = "seleccionar portada";
}

document.getElementById("create-folder-btn").addEventListener("click", async () => {
    const folderName = document.getElementById("folder-name").value;
    if (!folderName) return;
    const formData = new FormData();
    formData.append("name", folderName);
    if (selectedCoverFile) formData.append("cover", selectedCoverFile);
    try {
        const response = await fetch("/folders", { method: "POST", headers: authHeaders, body: formData });
        if (response.ok) { closeFolderModal(); loadFolders(); }
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
    fabBtn.innerHTML = "<span style='color:#000; font-weight:bold;'>...</span>";
    for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("folder_id", currentFolderId);
        try { await fetch("/files", { method: "POST", headers: authHeaders, body: formData }); } catch (error) {}
    }
    fabBtn.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 5v14M5 12h14" stroke="#000" stroke-width="2.5" stroke-linecap="round"/></svg>`;
    fileInput.value = "";
    loadFiles();
});

function openModal(photo) {
    selectedPhotoId = photo.id;
    const img = document.getElementById("modal-img");
    img.src = photo.url;
    img.alt = photo.name;
    img.style.transform = "scale(1)";
    scale = 1;
    document.getElementById("photo-modal").classList.remove("hidden");
}

function closeModal() {
    document.getElementById("photo-modal").classList.add("hidden");
    selectedPhotoId = null;
}

document.getElementById("modal-img").addEventListener("click", () => {
    scale = scale === 1 ? 2 : 1;
    document.getElementById("modal-img").style.transform = `scale(${scale})`;
});

document.getElementById("download-btn").addEventListener("click", async () => {
    if (!selectedPhotoId) return;
    try {
        const response = await fetch(`/files/${selectedPhotoId}/download`, { headers: authHeaders });
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
});

function showConfirm(title, desc, callback) {
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-desc").textContent = desc;
    confirmCallback = callback;
    document.getElementById("confirm-modal").classList.remove("hidden");
}

document.getElementById("confirm-cancel").addEventListener("click", () => {
    document.getElementById("confirm-modal").classList.add("hidden");
    confirmCallback = null;
});

document.getElementById("confirm-ok").addEventListener("click", () => {
    document.getElementById("confirm-modal").classList.add("hidden");
    if (confirmCallback) confirmCallback();
});

document.getElementById("delete-btn").addEventListener("click", () => {
    if (!selectedPhotoId) return;
    showConfirm("eliminar foto", "seguro que deseas eliminar esta foto?", async () => {
        try {
            const response = await fetch(`/files/${selectedPhotoId}`, { method: "DELETE", headers: authHeaders });
            if (response.ok) { closeModal(); loadFiles(); }
        } catch (error) {}
    });
});

document.getElementById("delete-folder-btn").addEventListener("click", () => {
    if (!currentFolderId) return;
    showConfirm("eliminar carpeta", "seguro que deseas eliminar esta carpeta y su contenido?", async () => {
        try {
            const response = await fetch(`/folders/${currentFolderId}`, { method: "DELETE", headers: authHeaders });
            if (response.ok) document.getElementById("back-btn").click();
        } catch (error) {}
    });
});

function setTelegramAvatar() {
    const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
    if (user) {
        if (user.photo_url) document.getElementById("user-avatar").style.backgroundImage = `url('${user.photo_url}')`;
        if (user.first_name) document.getElementById("greeting-name").textContent = user.first_name;
    } else {
        document.getElementById("greeting-name").textContent = "usuario";
    }
}

async function initApp() {
    if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
        setTelegramAvatar();
    }
    updateStorageUI();
    const isAuthenticated = await authenticate();
    if (isAuthenticated) { loadFolders(); }
    document.getElementById("main-app").classList.remove("hidden");
}

initApp();