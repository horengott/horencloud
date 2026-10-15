const telegramApp = window.Telegram?.WebApp;
const initData = telegramApp?.initData || "";
let authHeaders = {};
let currentFolderId = null;
let currentFolderName = "";
let selectedCoverFile = null;
let selectedCoverObjectUrl = null;
let selectedPhotoId = null;
let selectedPhoto = null;
let currentFolders = [];
let currentFiles = [];
let selectionMode = false;
let pendingConfirmation = null;
let toastTimer = null;
const selectedItems = new Map();
const previewUrls = new Map();
const quotaBytes = 10 * 1024 * 1024 * 1024;
const $ = (selector) => document.querySelector(selector);

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

async function fetchJson(url) {
    try {
        const response = await fetch(url, { headers: authHeaders });
        if (!response.ok) return { ok: false, data: null };
        return { ok: true, data: await response.json() };
    } catch (error) {
        return { ok: false, data: null };
    }
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[character]));
}

function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / Math.pow(1024, index);
    const digits = index === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toLocaleString("es-ES", { maximumFractionDigits: digits })} ${units[index]}`;
}

function setTelegramAvatar() {
    const user = telegramApp?.initDataUnsafe?.user;
    const avatar = $("#user-avatar");
    if (user?.photo_url) {
        avatar.style.backgroundImage = `url("${String(user.photo_url).replace(/["\\]/g, "")}")`;
        avatar.textContent = "";
    } else if (user?.first_name) {
        avatar.textContent = String(user.first_name).trim().charAt(0).toUpperCase();
        avatar.style.display = "grid";
        avatar.style.placeItems = "center";
        avatar.style.color = "#d8ff35";
        avatar.style.fontWeight = "800";
    }
    const firstName = user?.first_name?.trim() || "amigo";
    $("#app-title").textContent = `zdarova, ${firstName}`;
}

function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.remove("hidden");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.add("hidden"), 3000);
}

function emptyState(title, description, icon = "folder") {
    const iconMarkup = icon === "image"
        ? '<svg viewBox="0 0 24 24" width="23" height="23"><rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><path d="m4 17 5-5 3 3 3-4 5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" width="23" height="23"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    return `<div class="empty-state"><div class="empty-state-icon">${iconMarkup}</div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(description)}</p></div>`;
}

function folderIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linejoin="round"/><path d="M3.5 10h17" fill="none" stroke="currentColor" stroke-width="1.45"/></svg>';
}

function checkIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.2 4.2L19 6.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function updateSelectionUI() {
    const toolbar = $("#selection-toolbar");
    const count = selectedItems.size;
    toolbar.classList.toggle("hidden", !selectionMode);
    $("#selection-count").textContent = `${count} seleccionado${count === 1 ? "" : "s"}`;
    $("#bulk-delete-btn").disabled = count === 0;
    $("#select-mode-btn").textContent = selectionMode ? "Cancelar" : "Seleccionar";
    $("#main-app").classList.toggle("selection-mode", selectionMode);
    $("#fab-btn").classList.toggle("hidden", selectionMode);
    document.querySelectorAll(".folder-item, .photo-item").forEach((card) => {
        const key = `${card.dataset.itemType}:${card.dataset.itemId}`;
        card.classList.toggle("selected", selectedItems.has(key));
    });
}

function startSelection() {
    selectionMode = true;
    selectedItems.clear();
    updateSelectionUI();
}

function stopSelection() {
    selectionMode = false;
    selectedItems.clear();
    updateSelectionUI();
}

function toggleSelectedItem(type, item) {
    const key = `${type}:${item.id}`;
    if (selectedItems.has(key)) selectedItems.delete(key);
    else selectedItems.set(key, { type, item });
    updateSelectionUI();
}

function createSelectionMark() {
    const mark = document.createElement("span");
    mark.className = "select-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = checkIcon();
    return mark;
}

async function loadFolders() {
    const result = await fetchJson("/folders");
    if (result.ok && Array.isArray(result.data)) {
        currentFolders = result.data;
        renderFolders(currentFolders);
        await updateStorageUsage(currentFolders);
    } else {
        currentFolders = [];
        renderFolders([]);
        updateStorageDisplay(0);
    }
}

function renderFolders(folders) {
    const foldersGrid = $("#folders-grid");
    foldersGrid.innerHTML = "";
    $("#folder-count").textContent = `${folders.length} carpeta${folders.length === 1 ? "" : "s"}`;
    if (!folders.length) {
        foldersGrid.innerHTML = emptyState("Tu nube empieza aquí", "Crea una carpeta y empieza a guardar tus recuerdos.");
        return;
    }
    folders.forEach((folder, index) => {
        const item = document.createElement("div");
        item.className = "folder-item";
        item.dataset.itemType = "folder";
        item.dataset.itemId = String(folder.id);
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.setAttribute("aria-label", `Abrir carpeta ${folder.name || "sin nombre"}`);
        item.style.setProperty("--item-index", index);
        item.style.setProperty("--item-delay", `${Math.min(index, 8) * 35}ms`);
        const art = document.createElement("div");
        art.className = "folder-art";
        if (folder.cover_url) {
            const image = document.createElement("img");
            image.src = folder.cover_url;
            image.alt = folder.name || "Portada de carpeta";
            image.loading = "lazy";
            image.onerror = () => {
                image.remove();
                art.innerHTML = `<div class="folder-placeholder">${folderIcon()}</div>`;
            };
            art.appendChild(image);
        } else {
            art.innerHTML = `<div class="folder-placeholder">${folderIcon()}</div>`;
        }
        const title = document.createElement("div");
        title.className = "folder-title";
        title.innerHTML = `<span>${escapeHtml(folder.name || "Carpeta sin nombre")}</span><span class="folder-meta">Abrir colección <span aria-hidden="true">↗</span></span>`;
        item.append(art, createSelectionMark(), title);
        item.addEventListener("click", () => {
            if (selectionMode) toggleSelectedItem("folder", folder);
            else openFolder(folder.id, folder.name || "Carpeta");
        });
        item.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                item.click();
            }
        });
        foldersGrid.appendChild(item);
    });
    updateSelectionUI();
}

async function loadFiles() {
    if (currentFolderId === null) return;
    const result = await fetchJson(`/files?folder_id=${encodeURIComponent(currentFolderId)}`);
    if (result.ok && Array.isArray(result.data)) {
        currentFiles = result.data;
        renderGallery(currentFiles);
    } else {
        currentFiles = [];
        renderGallery([]);
    }
    updateStorageUsage(currentFolders);
}

function fileIsImage(file) {
    if (file?.mime_type) return file.mime_type.startsWith("image/");
    const name = String(file?.name || "").toLowerCase();
    return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/.test(name) || Boolean(file?.storage_path);
}

function fileExtension(file) {
    const name = String(file?.name || "archivo");
    const parts = name.split(".");
    return parts.length > 1 ? parts.pop().slice(0, 7).toUpperCase() : "ARCHIVO";
}

function previewSource(file) {
    return file?.storage_path || file?.url || file?.public_url || file?.download_url || "";
}

async function fetchPreviewUrl(file) {
    if (previewUrls.has(file.id)) return previewUrls.get(file.id);
    try {
        const response = await fetch(`/files/${file.id}/download`, { headers: authHeaders });
        if (!response.ok) return "";
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        previewUrls.set(file.id, objectUrl);
        return objectUrl;
    } catch (error) {
        return "";
    }
}

function renderGallery(files) {
    const galleryGrid = $("#gallery-grid");
    galleryGrid.innerHTML = "";
    $("#file-count").textContent = `${files.length} archivo${files.length === 1 ? "" : "s"}`;
    if (!files.length) {
        galleryGrid.innerHTML = emptyState("Todavía no hay archivos", "Sube fotos o archivos a esta carpeta y aparecerán aquí.", "image");
        return;
    }
    files.forEach((file, index) => {
        const item = document.createElement("div");
        item.className = "photo-item";
        item.dataset.itemType = "file";
        item.dataset.itemId = String(file.id);
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.setAttribute("aria-label", `Abrir ${file.name || "archivo"}`);
        item.style.setProperty("--item-index", index);
        item.style.setProperty("--item-delay", `${Math.min(index, 8) * 35}ms`);
        const media = document.createElement("div");
        media.className = "file-media";
        const source = previewSource(file);
        if (source && fileIsImage(file)) {
            const img = document.createElement("img");
            img.src = source;
            img.alt = file.name || "Foto";
            img.loading = "lazy";
            img.onerror = async () => {
                if (img.dataset.fallbackTried === "true") return;
                img.dataset.fallbackTried = "true";
                const fallbackUrl = await fetchPreviewUrl(file);
                if (fallbackUrl) img.src = fallbackUrl;
                else {
                    img.remove();
                    const placeholder = document.createElement("div");
                    placeholder.className = "file-placeholder";
                    placeholder.innerHTML = `${folderIcon()}<span class="file-type-label">${escapeHtml(fileExtension(file))}</span>`;
                    media.prepend(placeholder);
                }
            };
            media.appendChild(img);
        } else {
            const placeholder = document.createElement("div");
            placeholder.className = "file-placeholder";
            placeholder.innerHTML = `${folderIcon()}<span class="file-type-label">${escapeHtml(fileExtension(file))}</span>`;
            media.appendChild(placeholder);
            if (!source && fileIsImage(file)) fetchPreviewUrl(file).then((url) => {
                if (url && item.isConnected) {
                    const img = document.createElement("img");
                    img.src = url;
                    img.alt = file.name || "Foto";
                    img.loading = "lazy";
                    placeholder.remove();
                    media.prepend(img);
                }
            });
        }
        const name = document.createElement("div");
        name.className = "file-name";
        name.textContent = file.name || "Archivo sin nombre";
        item.append(media, createSelectionMark(), name);
        item.addEventListener("click", () => {
            if (selectionMode) toggleSelectedItem("file", file);
            else openModal(file);
        });
        item.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                item.click();
            }
        });
        galleryGrid.appendChild(item);
    });
    updateSelectionUI();
}

function openFolder(folderId, folderName) {
    currentFolderId = folderId;
    currentFolderName = folderName;
    stopSelection();
    $("#app-title").textContent = folderName;
    $("#back-btn").classList.remove("hidden");
    $("#delete-folder-btn").classList.remove("hidden");
    $("#home-hero").classList.add("hidden");
    $("#home-section").classList.add("hidden");
    $("#gallery-section").classList.remove("hidden");
    $("#gallery-grid").classList.remove("hidden");
    $("#gallery-heading").textContent = folderName;
    $("#fab-label").textContent = "Subir archivos";
    $("#fab-btn").setAttribute("aria-label", "Subir archivos");
    loadFiles();
}

function goHome() {
    currentFolderId = null;
    currentFolderName = "";
    stopSelection();
    const user = telegramApp?.initDataUnsafe?.user;
    $("#app-title").textContent = `zdarova, ${user?.first_name?.trim() || "amigo"}`;
    $("#back-btn").classList.add("hidden");
    $("#delete-folder-btn").classList.add("hidden");
    $("#home-hero").classList.remove("hidden");
    $("#home-section").classList.remove("hidden");
    $("#gallery-section").classList.add("hidden");
    $("#gallery-grid").classList.add("hidden");
    $("#fab-label").textContent = "Nueva carpeta";
    $("#fab-btn").setAttribute("aria-label", "Crear carpeta");
    loadFolders();
}

function updateStorageDisplay(usedBytes) {
    const used = Math.max(0, Number(usedBytes) || 0);
    const free = Math.max(0, quotaBytes - used);
    const percent = Math.min(100, (used / quotaBytes) * 100);
    $("#storage-remaining").textContent = formatBytes(free);
    $("#storage-used-label").textContent = `${formatBytes(used)} usados de 10 GB`;
    $("#storage-percent").textContent = `${Math.round(percent)}%`;
    $("#storage-progress").style.width = `${percent}%`;
    $("#storage-summary").textContent = `${formatBytes(used)} usados · ${formatBytes(free)} libres`;
}

async function updateStorageUsage(folders = currentFolders) {
    const allFiles = new Map();
    const rootResult = await fetchJson("/files");
    if (rootResult.ok && Array.isArray(rootResult.data)) {
        rootResult.data.forEach((file) => allFiles.set(String(file.id), file));
    }
    const folderList = Array.isArray(folders) ? folders : [];
    const folderResults = await Promise.all(folderList.map((folder) => fetchJson(`/files?folder_id=${encodeURIComponent(folder.id)}`)));
    folderResults.forEach((result) => {
        if (result.ok && Array.isArray(result.data)) {
            result.data.forEach((file) => allFiles.set(String(file.id), file));
        }
    });
    const usedBytes = Array.from(allFiles.values()).reduce((total, file) => total + Math.max(0, Number(file.size_bytes ?? file.size ?? 0) || 0), 0);
    updateStorageDisplay(usedBytes);
}

$("#back-btn").addEventListener("click", goHome);

$("#select-mode-btn").addEventListener("click", () => {
    if (selectionMode) stopSelection();
    else startSelection();
});

$("#cancel-selection-btn").addEventListener("click", stopSelection);

$("#bulk-delete-btn").addEventListener("click", () => {
    if (!selectedItems.size) return;
    const items = Array.from(selectedItems.values());
    const label = items.length === 1 ? "este elemento" : `estos ${items.length} elementos`;
    showConfirmation(
        "¿Eliminar selección?",
        `Vas a eliminar ${label}. Esta acción no se puede deshacer.`,
        async () => {
            const failed = [];
            for (const entry of items) {
                const endpoint = entry.type === "folder" ? `/folders/${entry.item.id}` : `/files/${entry.item.id}`;
                try {
                    const response = await fetch(endpoint, { method: "DELETE", headers: authHeaders });
                    if (!response.ok) failed.push(entry.item.name || "Elemento");
                } catch (error) {
                    failed.push(entry.item.name || "Elemento");
                }
            }
            stopSelection();
            if (currentFolderId === null) await loadFolders();
            else await loadFiles();
            await updateStorageUsage(currentFolders);
            if (failed.length) showToast(`No se pudieron eliminar ${failed.length} elementos`);
            else showToast("Selección eliminada");
        }
    );
});

$("#fab-btn").addEventListener("click", () => {
    if (currentFolderId === null) {
        $("#folder-modal").classList.remove("hidden");
        window.setTimeout(() => $("#folder-name").focus(), 100);
    } else {
        $("#file-input").click();
    }
});

$("#cancel-folder-btn").addEventListener("click", closeFolderModal);

$("#select-cover-btn").addEventListener("click", async () => {
    $("#cover-selection-modal").classList.remove("hidden");
    const coverGrid = $("#cover-grid");
    coverGrid.innerHTML = emptyState("Buscando fotos", "Cargando las imágenes que ya tienes guardadas.", "image");
    const files = await loadExistingFilesForCovers();
    const imageFiles = files.filter(fileIsImage);
    coverGrid.innerHTML = "";
    if (!imageFiles.length) {
        coverGrid.innerHTML = emptyState("No hay fotos todavía", "Sube una imagen a tu nube para usarla como portada.", "image");
        return;
    }
    imageFiles.forEach((file, index) => {
        const item = document.createElement("div");
        item.className = "photo-item";
        item.style.setProperty("--item-index", index);
        item.style.setProperty("--item-delay", `${Math.min(index, 8) * 35}ms`);
        const media = document.createElement("div");
        media.className = "file-media";
        const image = document.createElement("img");
        image.alt = file.name || "Foto";
        image.loading = "lazy";
        const source = previewSource(file);
        if (source) image.src = source;
        else fetchPreviewUrl(file).then((url) => {
            if (url) image.src = url;
        });
        image.onerror = async () => {
            if (image.dataset.fallbackTried === "true") return;
            image.dataset.fallbackTried = "true";
            const url = await fetchPreviewUrl(file);
            if (url) image.src = url;
        };
        const name = document.createElement("div");
        name.className = "file-name";
        name.textContent = file.name || "Foto";
        media.appendChild(image);
        item.append(media, name);
        item.addEventListener("click", () => selectCoverFromApp(file.id, file.name || "portada.jpg"));
        coverGrid.appendChild(item);
    });
});

$("#cancel-cover-btn").addEventListener("click", closeCoverSelectionModal);

async function loadExistingFilesForCovers() {
    const filesById = new Map();
    const rootResult = await fetchJson("/files");
    if (rootResult.ok && Array.isArray(rootResult.data)) {
        rootResult.data.forEach((file) => filesById.set(String(file.id), file));
    }
    const results = await Promise.all(currentFolders.map((folder) => fetchJson(`/files?folder_id=${encodeURIComponent(folder.id)}`)));
    results.forEach((result) => {
        if (result.ok && Array.isArray(result.data)) {
            result.data.forEach((file) => filesById.set(String(file.id), file));
        }
    });
    return Array.from(filesById.values());
}

function closeCoverSelectionModal() {
    $("#cover-selection-modal").classList.add("hidden");
}

async function selectCoverFromApp(fileId, fileName) {
    closeCoverSelectionModal();
    const selectBtn = $("#select-cover-btn");
    selectBtn.disabled = true;
    selectBtn.textContent = "Cargando...";
    try {
        const response = await fetch(`/files/${fileId}/download`, { headers: authHeaders });
        if (!response.ok) {
            showToast("No se pudo cargar esta foto");
            return;
        }
        const blob = await response.blob();
        if (selectedCoverObjectUrl) URL.revokeObjectURL(selectedCoverObjectUrl);
        selectedCoverFile = new File([blob], fileName, { type: blob.type || "image/jpeg" });
        selectedCoverObjectUrl = URL.createObjectURL(blob);
        const previewImg = $("#cover-preview");
        previewImg.src = selectedCoverObjectUrl;
        previewImg.classList.remove("hidden");
        const coverPreview = $("#cover-pick-preview");
        coverPreview.innerHTML = "";
        const thumb = document.createElement("img");
        thumb.src = selectedCoverObjectUrl;
        thumb.alt = "Portada seleccionada";
        coverPreview.appendChild(thumb);
        showToast("Portada seleccionada");
    } catch (error) {
        showToast("No se pudo cargar esta foto");
    } finally {
        selectBtn.disabled = false;
        selectBtn.textContent = "Elegir foto";
    }
}

$("#create-folder-btn").addEventListener("click", async () => {
    const folderName = $("#folder-name").value.trim();
    if (!folderName) {
        $("#folder-name").focus();
        showToast("Escribe un nombre para la carpeta");
        return;
    }
    const createButton = $("#create-folder-btn");
    createButton.disabled = true;
    createButton.innerHTML = "Creando...";
    const formData = new FormData();
    formData.append("name", folderName);
    if (selectedCoverFile) formData.append("cover", selectedCoverFile);
    try {
        const response = await fetch("/folders", {
            method: "POST",
            headers: authHeaders,
            body: formData
        });
        if (response.ok) {
            closeFolderModal();
            await loadFolders();
            showToast("Carpeta creada");
        } else {
            showToast(await getErrorMessage(response, "No se pudo crear la carpeta"));
        }
    } catch (error) {
        showToast("Error de conexión al crear la carpeta");
    } finally {
        createButton.disabled = false;
        createButton.innerHTML = 'Crear carpeta <span>↗</span>';
    }
});

function closeFolderModal() {
    $("#folder-modal").classList.add("hidden");
    $("#folder-name").value = "";
    $("#cover-preview").classList.add("hidden");
    $("#cover-preview").src = "";
    $("#cover-pick-preview").innerHTML = "<span>✳</span>";
    selectedCoverFile = null;
    if (selectedCoverObjectUrl) URL.revokeObjectURL(selectedCoverObjectUrl);
    selectedCoverObjectUrl = null;
}

$("#folder-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#create-folder-btn").click();
});

$("#file-input").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const fab = $("#fab-btn");
    const originalContent = fab.innerHTML;
    fab.disabled = true;
    fab.innerHTML = '<span class="uploading-label">Subiendo...</span>';
    let uploaded = 0;
    let failed = 0;
    for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("folder_id", currentFolderId);
        try {
            const response = await fetch("/files", {
                method: "POST",
                headers: authHeaders,
                body: formData
            });
            if (response.ok) uploaded++;
            else failed++;
        } catch (error) {
            failed++;
        }
    }
    fab.innerHTML = originalContent;
    fab.disabled = false;
    event.target.value = "";
    await loadFiles();
    if (uploaded && !failed) showToast(`${uploaded} archivo${uploaded === 1 ? "" : "s"} subido${uploaded === 1 ? "" : "s"}`);
    else if (uploaded && failed) showToast(`${uploaded} subidos, ${failed} con error`);
    else showToast("No se pudieron subir los archivos");
});

async function openModal(file) {
    selectedPhotoId = file.id;
    selectedPhoto = file;
    $("#modal-img").classList.add("hidden");
    $("#modal-img").dataset.fallbackTried = "false";
    $("#modal-img").removeAttribute("src");
    $("#viewer-file-placeholder").classList.add("hidden");
    $("#viewer-stage").classList.remove("zoomed");
    $("#photo-caption").textContent = file.name || "Archivo";
    $("#photo-subcaption").textContent = `${formatBytes(file.size_bytes || 0)}${file.mime_type ? ` · ${file.mime_type}` : ""}`;
    $("#photo-modal").classList.remove("hidden");
    const source = previewSource(file);
    if (fileIsImage(file)) {
        let imageUrl = source;
        if (!imageUrl) imageUrl = await fetchPreviewUrl(file);
        if (selectedPhotoId !== file.id || $("#photo-modal").classList.contains("hidden")) return;
        if (imageUrl) {
            $("#modal-img").src = imageUrl;
            $("#modal-img").classList.remove("hidden");
        } else {
            showViewerFilePlaceholder(file);
        }
    } else {
        showViewerFilePlaceholder(file);
    }
}

function showViewerFilePlaceholder(file) {
    $("#viewer-file-name").textContent = file.name || "Archivo";
    $("#viewer-file-placeholder").classList.remove("hidden");
}

function closeModal() {
    $("#photo-modal").classList.add("hidden");
    $("#viewer-stage").classList.remove("zoomed");
    selectedPhotoId = null;
    selectedPhoto = null;
}

$("#close-photo-btn").addEventListener("click", closeModal);

$("#zoom-btn").addEventListener("click", () => {
    const stage = $("#viewer-stage");
    stage.classList.toggle("zoomed");
    $("#zoom-btn").setAttribute("aria-label", stage.classList.contains("zoomed") ? "Reducir foto" : "Ampliar foto");
});

$("#modal-img").addEventListener("error", async () => {
    const file = selectedPhoto;
    const image = $("#modal-img");
    if (!file || !fileIsImage(file)) {
        if (file) showViewerFilePlaceholder(file);
        image.classList.add("hidden");
        return;
    }
    if (image.dataset.fallbackTried === "true") {
        image.classList.add("hidden");
        showViewerFilePlaceholder(file);
        return;
    }
    image.dataset.fallbackTried = "true";
    const fallbackUrl = await fetchPreviewUrl(file);
    if (selectedPhotoId !== file.id) return;
    if (fallbackUrl) image.src = fallbackUrl;
    else {
        image.classList.add("hidden");
        showViewerFilePlaceholder(file);
    }
});

$("#modal-img").addEventListener("click", () => {
    $("#viewer-stage").classList.toggle("zoomed");
});

$("#download-btn").addEventListener("click", async () => {
    if (!selectedPhotoId) return;
    const button = $("#download-btn");
    button.disabled = true;
    try {
        const response = await fetch(`/files/${selectedPhotoId}/download`, { headers: authHeaders });
        if (!response.ok) {
            showToast("No se pudo descargar el archivo");
            return;
        }
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = selectedPhoto?.name || $("#modal-img").alt || "download";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        showToast("Descarga iniciada");
    } catch (error) {
        showToast("Error al descargar el archivo");
    } finally {
        button.disabled = false;
    }
});

$("#delete-btn").addEventListener("click", () => {
    if (!selectedPhotoId) return;
    const photoId = selectedPhotoId;
    const photoName = selectedPhoto?.name || "este archivo";
    showConfirmation(
        "¿Eliminar archivo?",
        `Se eliminará “${photoName}” de tu nube. Esta acción no se puede deshacer.`,
        async () => {
            try {
                const response = await fetch(`/files/${photoId}`, {
                    method: "DELETE",
                    headers: authHeaders
                });
                if (response.ok) {
                    closeModal();
                    await loadFiles();
                    await updateStorageUsage(currentFolders);
                    showToast("Archivo eliminado");
                } else {
                    showToast(await getErrorMessage(response, "No se pudo eliminar el archivo"));
                }
            } catch (error) {
                showToast("Error de conexión al eliminar el archivo");
            }
        }
    );
});

$("#delete-folder-btn").addEventListener("click", () => {
    if (currentFolderId === null) return;
    const folderId = currentFolderId;
    const folderName = currentFolderName || "esta carpeta";
    showConfirmation(
        "¿Eliminar carpeta?",
        `Se eliminará la carpeta “${folderName}”. Comprueba que quieras continuar antes de borrarla.`,
        async () => {
            try {
                const response = await fetch(`/folders/${folderId}`, {
                    method: "DELETE",
                    headers: authHeaders
                });
                if (response.ok) {
                    closeModal();
                    goHome();
                    showToast("Carpeta eliminada");
                } else {
                    showToast(await getErrorMessage(response, "No se pudo eliminar la carpeta"));
                }
            } catch (error) {
                showToast("Error de conexión al eliminar la carpeta");
            }
        }
    );
});

function showConfirmation(title, message, action) {
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    pendingConfirmation = action;
    $("#confirm-modal").classList.remove("hidden");
}

function closeConfirmation() {
    $("#confirm-modal").classList.add("hidden");
    pendingConfirmation = null;
}

$("#confirm-cancel-btn").addEventListener("click", closeConfirmation);

$("#confirm-action-btn").addEventListener("click", async () => {
    if (!pendingConfirmation) return;
    const action = pendingConfirmation;
    const button = $("#confirm-action-btn");
    button.disabled = true;
    button.textContent = "Eliminando...";
    try {
        closeConfirmation();
        await action();
    } finally {
        button.disabled = false;
        button.textContent = "Sí, eliminar";
    }
});

async function getErrorMessage(response, fallback) {
    try {
        const data = await response.json();
        return data.detail || fallback;
    } catch (error) {
        return fallback;
    }
}

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        if (!$("#confirm-modal").classList.contains("hidden")) closeConfirmation();
        else if (!$("#cover-selection-modal").classList.contains("hidden")) closeCoverSelectionModal();
        else if (!$("#folder-modal").classList.contains("hidden")) closeFolderModal();
        else if (!$("#photo-modal").classList.contains("hidden")) closeModal();
        else if (selectionMode) stopSelection();
    }
});

$("#photo-modal").addEventListener("click", (event) => {
    if (event.target === $("#photo-modal")) closeModal();
});

$("#folder-modal").addEventListener("click", (event) => {
    if (event.target === $("#folder-modal")) closeFolderModal();
});

$("#cover-selection-modal").addEventListener("click", (event) => {
    if (event.target === $("#cover-selection-modal")) closeCoverSelectionModal();
});

window.addEventListener("pointermove", (event) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const x = (event.clientX / Math.max(window.innerWidth, 1) - 0.5) * 28;
    const y = (event.clientY / Math.max(window.innerHeight, 1) - 0.5) * 28;
    const app = $("#main-app");
    app.style.setProperty("--parallax-x", `${x.toFixed(1)}px`);
    app.style.setProperty("--parallax-y", `${y.toFixed(1)}px`);
});

async function initApp() {
    if (telegramApp) {
        telegramApp.ready();
        telegramApp.expand();
        setTelegramAvatar();
    } else {
        $("#app-title").textContent = "zdarova, tip";
    }
    const isAuthenticated = await authenticate();
    $("#main-app").classList.remove("hidden");
    if (isAuthenticated) await loadFolders();
    else {
        renderFolders([]);
        updateStorageDisplay(0);
    }
}

initApp();