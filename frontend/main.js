
const initData = window.Telegram?.WebApp?.initData || "";
let authHeaders = {};
let currentFolderId = null;
let currentFolderName = "";
let selectedPhotoId = null;
let selectedPhoto = null;
let selectedCoverFile = null;
let selectedCoverUrl = null;
let selectedItems = new Set();
let allFolders = [];
let allFiles = [];
let folderHistory = [];
let isLoading = false;

const $ = id => document.getElementById(id);

async function authenticate() {
    if (!initData) return false;

    try {
        const response = await fetch("/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ init_data: initData })
        });

        if (!response.ok) return false;

        const data = await response.json();
        authHeaders = { Authorization: `Bearer ${data.access_token}` };
        return true;
    } catch {
        return false;
    }
}

function notify(message, type = "info") {
    if (window.Telegram?.WebApp?.showAlert) {
        window.Telegram.WebApp.showAlert(message);
        return;
    }

    let toast = $("app-toast");

    if (!toast) {
        toast = document.createElement("div");
        toast.id = "app-toast";
        toast.className = "app-toast";
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.dataset.type = type;
    toast.classList.add("visible");

    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function confirmAction(message) {
    return new Promise(resolve => {
        if (window.Telegram?.WebApp?.showConfirm) {
            window.Telegram.WebApp.showConfirm(message, resolve);
        } else {
            resolve(window.confirm(message));
        }
    });
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;

    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;

    return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function getTotalSize(files) {
    return files.reduce((total, file) => total + (Number(file.size_bytes) || 0), 0);
}

function setStorageUsage(files) {
    const total = getTotalSize(files);
    const available = Math.max(0, 10 * 1024 ** 3 - total);
    const candidates = document.querySelectorAll(
        "#storage-usage, #storage-info, #available-storage, #header-storage"
    );

    candidates.forEach(element => {
        element.textContent = `10 GB · ${formatBytes(total)} usados`;
        element.title = `${formatBytes(available)} disponibles`;
    });

    const progress = $("storage-progress");

    if (progress) {
        progress.style.width = `${Math.min(100, total / (10 * 1024 ** 3) * 100)}%`;
    }

    const used = $("storage-used");

    if (used) used.textContent = formatBytes(total);

    const remaining = $("storage-remaining");

    if (remaining) remaining.textContent = `${formatBytes(available)} disponibles`;
}

async function apiFetch(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...authHeaders,
            ...(options.headers || {})
        }
    });

    if (response.status === 401) {
        notify("La sesión ha caducado. Vuelve a abrir la mini app.", "error");
    }

    return response;
}

async function loadFolders() {
    try {
        const params = new URLSearchParams();

        if (currentFolderId !== null) {
            params.set("parent_id", currentFolderId);
        }

        const response = await apiFetch(`/folders?${params.toString()}`);

        if (!response.ok) throw new Error("No se pudieron cargar las carpetas");

        allFolders = await response.json();
        renderFolders(allFolders);
    } catch (error) {
        console.error(error);
        notify("No se pudieron cargar las carpetas.", "error");
    }
}

async function loadFiles() {
    try {
        const params = new URLSearchParams();

        if (currentFolderId !== null) {
            params.set("folder_id", currentFolderId);
        }

        const response = await apiFetch(`/files?${params.toString()}`);

        if (!response.ok) throw new Error("No se pudieron cargar los archivos");

        allFiles = await response.json();
        renderGallery(allFiles);
        await updateStorageUsage();
    } catch (error) {
        console.error(error);
        notify("No se pudieron cargar los archivos.", "error");
    }
}

async function updateStorageUsage() {
    try {
        const response = await apiFetch("/files");

        if (!response.ok) return;

        const rootFiles = await response.json();
        const foldersResponse = await apiFetch("/folders");

        if (!foldersResponse.ok) {
            setStorageUsage(rootFiles);
            return;
        }

        const folders = await foldersResponse.json();
        const filesById = new Map();

        rootFiles.forEach(file => filesById.set(file.id, file));

        async function collectFolder(folderId) {
            const response = await apiFetch(`/files?folder_id=${encodeURIComponent(folderId)}`);

            if (response.ok) {
                const files = await response.json();
                files.forEach(file => filesById.set(file.id, file));
            }

            const childrenResponse = await apiFetch(`/folders?parent_id=${encodeURIComponent(folderId)}`);

            if (childrenResponse.ok) {
                const children = await childrenResponse.json();

                for (const child of children) {
                    await collectFolder(child.id);
                }
            }
        }

        for (const folder of folders) {
            await collectFolder(folder.id);
        }

        setStorageUsage([...filesById.values()]);
    } catch (error) {
        console.error(error);
    }
}

function renderFolders(folders) {
    const grid = $("folders-grid");

    if (!grid) return;

    grid.innerHTML = "";
    selectedItems.clear();
    updateSelectionUI();

    if (!folders.length) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">✳</div>
                <h3>${currentFolderId === null ? "Tu nube empieza aquí" : "Esta carpeta está vacía"}</h3>
                <p>Crea una carpeta o sube tus primeras fotos.</p>
            </div>
        `;
        return;
    }

    folders.forEach(folder => {
        const item = document.createElement("article");
        item.className = "folder-item";
        item.dataset.id = folder.id;

        const cover = folder.cover_url
            ? `<img src="${escapeHTML(folder.cover_url)}" alt="" loading="lazy">`
            : `<div class="folder-placeholder"><span>▧</span></div>`;

        item.innerHTML = `
            ${cover}
            <button class="item-select" type="button" aria-label="Seleccionar carpeta">✓</button>
            <div class="folder-shade"></div>
            <div class="folder-title">
                <span>${escapeHTML(folder.name)}</span>
                <small>Carpeta</small>
            </div>
            <button class="folder-menu" type="button" aria-label="Opciones de carpeta">···</button>
        `;

        item.addEventListener("click", event => {
            if (event.target.closest(".item-select")) {
                event.stopPropagation();
                toggleSelection("folder", folder.id, item);
                return;
            }

            if (event.target.closest(".folder-menu")) {
                event.stopPropagation();
                showFolderActions(folder);
                return;
            }

            openFolder(folder.id, folder.name);
        });

        grid.appendChild(item);
    });
}

function renderGallery(files) {
    const grid = $("gallery-grid");

    if (!grid) return;

    grid.innerHTML = "";
    selectedItems.clear();
    updateSelectionUI();

    if (!files.length) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">✳</div>
                <h3>Sin archivos todavía</h3>
                <p>Sube fotos o vídeos para guardarlos en esta carpeta.</p>
            </div>
        `;
        return;
    }

    files.forEach(file => {
        const item = document.createElement("article");
        item.className = "photo-item";
        item.dataset.id = file.id;

        const isImage = !file.mime_type || file.mime_type.startsWith("image/");
        const preview = isImage
            ? `<img src="${escapeHTML(file.storage_path)}" alt="${escapeHTML(file.name)}" loading="lazy">`
            : `<div class="file-placeholder"><span>▤</span><small>${escapeHTML(file.mime_type || "Archivo")}</small></div>`;

        item.innerHTML = `
            ${preview}
            <button class="item-select" type="button" aria-label="Seleccionar archivo">✓</button>
            <div class="photo-shade"></div>
            <div class="photo-caption">
                <span>${escapeHTML(file.name)}</span>
                <small>${formatBytes(file.size_bytes)}</small>
            </div>
        `;

        item.addEventListener("click", event => {
            if (event.target.closest(".item-select")) {
                event.stopPropagation();
                toggleSelection("file", file.id, item);
                return;
            }

            openModal(file);
        });

        grid.appendChild(item);
    });
}

function openFolder(folderId, folderName) {
    folderHistory.push({
        id: currentFolderId,
        name: currentFolderName
    });

    currentFolderId = folderId;
    currentFolderName = folderName;

    $("app-title").textContent = folderName;
    $("back-btn")?.classList.remove("hidden");
    $("delete-folder-btn")?.classList.remove("hidden");
    $("folders-grid")?.classList.add("hidden");
    $("gallery-grid")?.classList.remove("hidden");

    if ($("fab-btn")) $("fab-btn").dataset.mode = "files";

    loadFoldersForCurrentLevel();
    loadFiles();
    updateBreadcrumb();
}

async function loadFoldersForCurrentLevel() {
    try {
        const response = await apiFetch(`/folders?parent_id=${encodeURIComponent(currentFolderId)}`);

        if (!response.ok) return;

        const folders = await response.json();
        renderSubfolders(folders);
    } catch (error) {
        console.error(error);
    }
}

function renderSubfolders(folders) {
    const grid = $("gallery-grid");

    if (!grid) return;

    grid.querySelectorAll(".subfolder-item").forEach(item => item.remove());

    folders.forEach(folder => {
        const item = document.createElement("article");
        item.className = "folder-item subfolder-item";
        item.dataset.id = folder.id;

        item.innerHTML = `
            ${folder.cover_url
                ? `<img src="${escapeHTML(folder.cover_url)}" alt="" loading="lazy">`
                : `<div class="folder-placeholder"><span>▧</span></div>`}
            <button class="item-select" type="button" aria-label="Seleccionar carpeta">✓</button>
            <div class="folder-shade"></div>
            <div class="folder-title">
                <span>${escapeHTML(folder.name)}</span>
                <small>Carpeta</small>
            </div>
            <button class="folder-menu" type="button" aria-label="Opciones de carpeta">···</button>
        `;

        item.addEventListener("click", event => {
            if (event.target.closest(".item-select")) {
                event.stopPropagation();
                toggleSelection("folder", folder.id, item);
                return;
            }

            if (event.target.closest(".folder-menu")) {
                event.stopPropagation();
                showFolderActions(folder);
                return;
            }

            openFolder(folder.id, folder.name);
        });

        grid.prepend(item);
    });
}

function updateBreadcrumb() {
    const breadcrumb = $("folder-breadcrumb");

    if (!breadcrumb) return;

    breadcrumb.innerHTML = "";

    const root = document.createElement("button");
    root.type = "button";
    root.textContent = "Mi nube";
    root.addEventListener("click", goHome);
    breadcrumb.appendChild(root);

    folderHistory.forEach((folder, index) => {
        if (folder.id === null) return;

        const separator = document.createElement("span");
        separator.textContent = "/";
        breadcrumb.appendChild(separator);

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = folder.name;
        button.addEventListener("click", () => navigateToHistory(index));
        breadcrumb.appendChild(button);
    });

    if (currentFolderId !== null) {
        const separator = document.createElement("span");
        separator.textContent = "/";
        breadcrumb.appendChild(separator);

        const current = document.createElement("span");
        current.textContent = currentFolderName;
        breadcrumb.appendChild(current);
    }
}

function navigateToHistory(index) {
    const target = folderHistory[index];

    if (!target) return;

    folderHistory = folderHistory.slice(0, index);
    currentFolderId = target.id;
    currentFolderName = target.name;

    if (currentFolderId === null) {
        goHome();
        return;
    }

    $("app-title").textContent = currentFolderName;
    loadFoldersForCurrentLevel();
    loadFiles();
    updateBreadcrumb();
}

function goHome() {
    currentFolderId = null;
    currentFolderName = "";
    folderHistory = [];

    $("app-title").textContent = "Mi nube";
    $("back-btn")?.classList.add("hidden");
    $("delete-folder-btn")?.classList.add("hidden");
    $("gallery-grid")?.classList.add("hidden");
    $("folders-grid")?.classList.remove("hidden");

    if ($("fab-btn")) $("fab-btn").dataset.mode = "folders";

    loadFolders();
    updateBreadcrumb();
}

$("back-btn")?.addEventListener("click", () => {
    if (folderHistory.length) {
        const previous = folderHistory.pop();

        currentFolderId = previous.id;
        currentFolderName = previous.name;

        if (currentFolderId === null) {
            goHome();
            return;
        }

        $("app-title").textContent = currentFolderName;
        loadFoldersForCurrentLevel();
        loadFiles();
        updateBreadcrumb();
    } else {
        goHome();
    }
});

function toggleSelection(type, id, element) {
    const key = `${type}:${id}`;

    if (selectedItems.has(key)) {
        selectedItems.delete(key);
        element.classList.remove("selected");
    } else {
        selectedItems.add(key);
        element.classList.add("selected");
    }

    updateSelectionUI();
}

function updateSelectionUI() {
    const count = selectedItems.size;
    const bar = $("selection-bar");
    const countLabel = $("selection-count");

    if (bar) bar.classList.toggle("hidden", count === 0);
    if (countLabel) countLabel.textContent = `${count} seleccionados`;

    document.querySelectorAll(".item-select").forEach(button => {
        const item = button.closest("[data-id]");
        if (!item) return;

        const type = item.classList.contains("folder-item") ? "folder" : "file";
        const key = `${type}:${item.dataset.id}`;
        item.classList.toggle("selected", selectedItems.has(key));
    });
}

$("select-all-btn")?.addEventListener("click", () => {
    document.querySelectorAll(".folder-item, .photo-item").forEach(item => {
        const type = item.classList.contains("folder-item") ? "folder" : "file";
        selectedItems.add(`${type}:${item.dataset.id}`);
    });

    updateSelectionUI();
});

$("cancel-selection-btn")?.addEventListener("click", () => {
    selectedItems.clear();
    updateSelectionUI();
});

$("delete-selected-btn")?.addEventListener("click", async () => {
    if (!selectedItems.size) return;

    const confirmed = await confirmAction("¿Quieres eliminar los elementos seleccionados? Esta acción no se puede deshacer.");

    if (!confirmed) return;

    for (const key of selectedItems) {
        const [type, id] = key.split(":");

        try {
            if (type === "file") {
                await apiFetch(`/files/${id}`, { method: "DELETE" });
            } else {
                await apiFetch(`/folders/${id}`, { method: "DELETE" });
            }
        } catch (error) {
            console.error(error);
        }
    }

    selectedItems.clear();
    updateSelectionUI();

    if (currentFolderId === null) {
        await loadFolders();
    } else {
        await loadFoldersForCurrentLevel();
        await loadFiles();
    }

    notify("Operación de eliminación finalizada.");
});

function showFolderActions(folder) {
    const modal = $("folder-actions-modal");

    if (!modal) {
        const action = window.prompt(
            `Carpeta: ${folder.name}\n1. Cambiar nombre\n2. Cambiar portada\n3. Eliminar\nIntroduce 1, 2 o 3`
        );

        if (action === "1") editFolderName(folder);
        if (action === "2") openCoverEditor(folder);
        if (action === "3") deleteFolder(folder);

        return;
    }

    modal.dataset.folderId = folder.id;
    modal.dataset.folderName = folder.name;
    modal.classList.remove("hidden");
}

$("edit-folder-name-btn")?.addEventListener("click", async () => {
    const modal = $("folder-actions-modal");
    const folder = {
        id: Number(modal.dataset.folderId),
        name: modal.dataset.folderName
    };

    modal.classList.add("hidden");
    await editFolderName(folder);
});

$("edit-folder-cover-btn")?.addEventListener("click", () => {
    const modal = $("folder-actions-modal");
    const folder = {
        id: Number(modal.dataset.folderId),
        name: modal.dataset.folderName
    };

    modal.classList.add("hidden");
    openCoverEditor(folder);
});

$("remove-folder-btn")?.addEventListener("click", async () => {
    const modal = $("folder-actions-modal");
    const folder = {
        id: Number(modal.dataset.folderId),
        name: modal.dataset.folderName
    };

    modal.classList.add("hidden");
    await deleteFolder(folder);
});

async function editFolderName(folder) {
    const name = window.prompt("Nuevo nombre de la carpeta:", folder.name);

    if (name === null || !name.trim() || name.trim() === folder.name) return;

    try {
        const formData = new FormData();
        formData.append("name", name.trim());

        const response = await apiFetch(`/folders/${folder.id}`, {
            method: "PATCH",
            body: formData
        });

        if (!response.ok) {
            notify("No se pudo cambiar el nombre. Comprueba que existe PATCH /folders/{folder_id} en el servidor.", "error");
            return;
        }

        if (currentFolderId === folder.id) {
            currentFolderName = name.trim();
            $("app-title").textContent = currentFolderName;
        }

        await loadFolders();

        if (currentFolderId !== null) {
            await loadFoldersForCurrentLevel();
        }

        notify("Nombre actualizado.");
    } catch (error) {
        console.error(error);
        notify("No se pudo cambiar el nombre.", "error");
    }
}

async function deleteFolder(folder) {
    const confirmed = await confirmAction(`¿Eliminar la carpeta "${folder.name}" y su contenido? Esta acción no se puede deshacer.`);

    if (!confirmed) return;

    try {
        const response = await apiFetch(`/folders/${folder.id}`, { method: "DELETE" });

        if (!response.ok) {
            notify("No se pudo eliminar la carpeta.", "error");
            return;
        }

        if (currentFolderId === folder.id) goHome();
        else if (currentFolderId === null) await loadFolders();
        else await loadFoldersForCurrentLevel();

        await updateStorageUsage();
        notify("Carpeta eliminada.");
    } catch (error) {
        console.error(error);
        notify("Error al eliminar la carpeta.", "error");
    }
}

$("delete-folder-btn")?.addEventListener("click", async () => {
    if (currentFolderId === null) return;

    await deleteFolder({
        id: currentFolderId,
        name: currentFolderName
    });
});

const fabBtn = $("fab-btn");
const fileInput = $("file-input");

fabBtn?.addEventListener("click", () => {
    if (currentFolderId === null) {
        openFolderModal();
    } else {
        fileInput?.click();
    }
});

function openFolderModal() {
    const modal = $("folder-modal");

    if (!modal) {
        const name = window.prompt("Nombre de la carpeta:");

        if (name?.trim()) createFolder(name.trim());
        return;
    }

    modal.classList.remove("hidden");
    $("folder-name").value = "";
}

function closeFolderModal() {
    $("folder-modal")?.classList.add("hidden");
    $("folder-name").value = "";
}

$("create-folder-btn")?.addEventListener("click", async () => {
    const name = $("folder-name")?.value.trim();

    if (!name) {
        notify("Escribe un nombre para la carpeta.");
        return;
    }

    await createFolder(name);
});

async function createFolder(name) {
    const formData = new FormData();
    formData.append("name", name);

    if (currentFolderId !== null) {
        formData.append("parent_id", currentFolderId);
    }

    try {
        const response = await apiFetch("/folders", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            notify("No se pudo crear la carpeta.", "error");
            return;
        }

        closeFolderModal();

        if (currentFolderId === null) await loadFolders();
        else await loadFoldersForCurrentLevel();

        notify("Carpeta creada.");
    } catch (error) {
        console.error(error);
        notify("Error al crear la carpeta.", "error");
    }
}

fileInput?.addEventListener("change", async event => {
    const files = Array.from(event.target.files || []);

    if (!files.length) return;

    if (isLoading) return;

    isLoading = true;

    const originalText = fabBtn?.innerHTML;

    if (fabBtn) {
        fabBtn.disabled = true;
        fabBtn.innerHTML = "<span class=\"upload-spinner\"></span>";
    }

    let successCount = 0;

    for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        if (currentFolderId !== null) {
            formData.append("folder_id", currentFolderId);
        }

        try {
            const response = await apiFetch("/files", {
                method: "POST",
                body: formData
            });

            if (response.ok) successCount++;
        } catch (error) {
            console.error(error);
        }
    }

    isLoading = false;

    if (fabBtn) {
        fabBtn.disabled = false;
        fabBtn.innerHTML = originalText;
    }

    fileInput.value = "";

    await loadFiles();
    await updateStorageUsage();

    notify(`Subida terminada: ${successCount} de ${files.length} archivos.`);
});

function openModal(file) {
    selectedPhotoId = file.id;
    selectedPhoto = file;

    const modal = $("photo-modal");
    const image = $("modal-img");

    image.src = file.storage_path;
    image.alt = file.name;

    modal?.classList.remove("hidden");
    document.body.classList.add("viewer-open");

    const name = $("modal-file-name");

    if (name) name.textContent = file.name;

    const size = $("modal-file-size");

    if (size) size.textContent = formatBytes(file.size_bytes);

    setupImageZoom(image);
}

function closeModal() {
    $("photo-modal")?.classList.add("hidden");
    document.body.classList.remove("viewer-open");

    const image = $("modal-img");

    if (image) {
        image.style.transform = "";
        image.style.transformOrigin = "";
    }

    selectedPhotoId = null;
    selectedPhoto = null;
}

$("download-btn")?.addEventListener("click", async () => {
    if (!selectedPhotoId) return;

    try {
        const response = await apiFetch(`/files/${selectedPhotoId}/download`);

        if (!response.ok) {
            notify("No se pudo descargar el archivo.", "error");
            return;
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");

        anchor.href = url;
        anchor.download = selectedPhoto?.name || "download";
        anchor.style.display = "none";

        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
        console.error(error);
        notify("Error al descargar el archivo.", "error");
    }
});

$("delete-btn")?.addEventListener("click", async () => {
    if (!selectedPhotoId) return;

    const confirmed = await confirmAction(`¿Eliminar "${selectedPhoto?.name || "este archivo"}"? Esta acción no se puede deshacer.`);

    if (!confirmed) return;

    try {
        const response = await apiFetch(`/files/${selectedPhotoId}`, {
            method: "DELETE"
        });

        if (!response.ok) {
            notify("No se pudo eliminar el archivo.", "error");
            return;
        }

        closeModal();
        await loadFiles();
        await updateStorageUsage();
        notify("Archivo eliminado.");
    } catch (error) {
        console.error(error);
        notify("Error al eliminar el archivo.", "error");
    }
});

function setupImageZoom(image) {
    if (!image || image.dataset.zoomReady) return;

    image.dataset.zoomReady = "true";

    let scale = 1;
    let startScale = 1;
    let originX = 0;
    let originY = 0;
    let startX = 0;
    let startY = 0;
    let lastDistance = 0;
    let lastTap = 0;

    const applyTransform = () => {
        image.style.transform = `translate(${originX}px, ${originY}px) scale(${scale})`;
    };

    image.addEventListener("touchstart", event => {
        if (event.touches.length === 2) {
            lastDistance = getTouchDistance(event.touches);
            startScale = scale;
        } else if (event.touches.length === 1) {
            startX = event.touches[0].clientX - originX;
            startY = event.touches[0].clientY - originY;

            const now = Date.now();

            if (now - lastTap < 300) {
                scale = scale > 1 ? 1 : 2;
                if (scale === 1) {
                    originX = 0;
                    originY = 0;
                }

                applyTransform();
            }

            lastTap = now;
        }
    }, { passive: true });

    image.addEventListener("touchmove", event => {
        if (event.touches.length === 2) {
            event.preventDefault();

            const distance = getTouchDistance(event.touches);

            if (lastDistance) {
                scale = Math.min(5, Math.max(1, startScale * distance / lastDistance));
                applyTransform();
            }
        } else if (event.touches.length === 1 && scale > 1) {
            event.preventDefault();

            originX = event.touches[0].clientX - startX;
            originY = event.touches[0].clientY - startY;

            applyTransform();
        }
    }, { passive: false });

    image.addEventListener("touchend", () => {
        if (scale < 1.05) {
            scale = 1;
            originX = 0;
            originY = 0;
            applyTransform();
        }
    });
}

function getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;

    return Math.hypot(dx, dy);
}

$("select-cover-btn")?.addEventListener("click", () => {
    const folder = currentFolderId === null
        ? null
        : { id: currentFolderId, name: currentFolderName };

    if (!folder) {
        notify("Abre la carpeta que quieres editar para cambiar su portada.");
        return;
    }

    openCoverEditor(folder);
});

async function openCoverEditor(folder) {
    selectedCoverUrl = null;
    selectedCoverFile = null;

    const modal = $("cover-selection-modal");
    const grid = $("cover-grid");

    if (!modal || !grid) {
        notify("Añade el modal cover-selection-modal y el contenedor cover-grid al HTML para elegir una portada.");
        return;
    }

    modal.classList.remove("hidden");
    grid.innerHTML = "<p class=\"loading-state\">Cargando fotos...</p>";

    try {
        const response = await apiFetch(`/files?folder_id=${encodeURIComponent(folder.id)}`);

        if (!response.ok) throw new Error("No se pudieron cargar las fotos");

        const files = await response.json();
        const images = files.filter(file => !file.mime_type || file.mime_type.startsWith("image/"));

        grid.innerHTML = "";

        if (!images.length) {
            grid.innerHTML = "<p class=\"empty-state\">No hay fotos en esta carpeta. Sube una imagen primero.</p>";
            return;
        }

        images.forEach(file => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "photo-item cover-choice";
            item.innerHTML = `<img src="${escapeHTML(file.storage_path)}" alt="${escapeHTML(file.name)}" loading="lazy">`;

            item.addEventListener("click", () => {
                selectedCoverUrl = file.storage_path;
                grid.querySelectorAll(".cover-choice").forEach(choice => choice.classList.remove("selected"));
                item.classList.add("selected");

                saveFolderCover(folder.id, file.id);
            });

            grid.appendChild(item);
        });
    } catch (error) {
        console.error(error);
        grid.innerHTML = "<p class=\"empty-state\">No se pudieron cargar las fotos.</p>";
    }
}

async function saveFolderCover(folderId, fileId) {
    try {
        const formData = new FormData();
        formData.append("file_id", fileId);

        const response = await apiFetch(`/folders/${folderId}/cover`, {
            method: "PATCH",
            body: formData
        });

        if (!response.ok) {
            notify("El servidor todavía no permite cambiar la portada. Hace falta implementar PATCH /folders/{folder_id}/cover.", "error");
            return;
        }

        $("cover-selection-modal")?.classList.add("hidden");

        if (currentFolderId === null) await loadFolders();
        else await loadFoldersForCurrentLevel();

        notify("Portada actualizada.");
    } catch (error) {
        console.error(error);
        notify("No se pudo actualizar la portada.", "error");
    }
}

function setTelegramAvatar() {
    const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
    const avatar = $("user-avatar");

    if (avatar && user?.photo_url) {
        avatar.style.backgroundImage = `url("${user.photo_url}")`;
    }

    const greeting = $("welcome-title");

    if (greeting && user?.first_name) {
        greeting.textContent = `Zdarova, ${user.first_name}`;
    }
}

function onboardingWasSeen() {
    try {
        return localStorage.getItem("horencloud_onboarding_seen") === "1";
    } catch {
        return false;
    }
}

function markOnboardingSeen() {
    try {
        localStorage.setItem("horencloud_onboarding_seen", "1");
    } catch {}
}

function showScreen(screenId) {
    document.querySelectorAll(".screen").forEach(screen => screen.classList.add("hidden"));
    $(screenId)?.classList.remove("hidden");
}

function setupOnboarding() {
    const onboarding = $("onboarding");

    if (!onboarding) {
        showScreen("main-app");
        return;
    }

    const nextButton = $("next-btn");
    const slides = [
        {
            title: "welcome to horencloud",
            description: "tu galería privada en Telegram"
        },
        {
            title: "tus recuerdos, siempre contigo",
            description: "Organiza fotos y vídeos en carpetas."
        },
        {
            title: "todo en un solo lugar",
            description: "Tu nube personal, sencilla y rápida."
        }
    ];

    let currentSlide = 0;

    const title = $("slide-title");
    const description = $("slide-desc");
    const buttonText = $("btn-text");
    const indicators = $("indicators");

    if (!nextButton || !title || !description) {
        showScreen("main-app");
        return;
    }

    if (onboardingWasSeen()) {
        showScreen("main-app");
        return;
    }

    if (indicators) {
        indicators.innerHTML = slides.map((slide, index) =>
            `<span class="dot${index === 0 ? " active" : ""}"></span>`
        ).join("");
    }

    function renderSlide() {
        title.textContent = slides[currentSlide].title;
        description.textContent = slides[currentSlide].description;

        if (buttonText) {
            buttonText.textContent = currentSlide === slides.length - 1 ? "empezar" : "siguiente";
        }

        nextButton.classList.toggle("finish", currentSlide === slides.length - 1);

        indicators?.querySelectorAll(".dot").forEach((dot, index) => {
            dot.classList.toggle("active", index === currentSlide);
        });
    }

    nextButton.addEventListener("click", () => {
        if (currentSlide < slides.length - 1) {
            currentSlide++;
            renderSlide();
            return;
        }

        markOnboardingSeen();
        showScreen("main-app");
    });

    showScreen("onboarding");
    renderSlide();
}

function setupSwipeBack() {
    let startX = 0;
    let startY = 0;
    let tracking = false;

    document.addEventListener("touchstart", event => {
        if (event.touches.length !== 1) return;

        startX = event.touches[0].clientX;
        startY = event.touches[0].clientY;
        tracking = startX < 35;
    }, { passive: true });

    document.addEventListener("touchend", event => {
        if (!tracking || !event.changedTouches.length) return;

        const endX = event.changedTouches[0].clientX;
        const endY = event.changedTouches[0].clientY;
        const deltaX = endX - startX;
        const deltaY = Math.abs(endY - startY);

        tracking = false;

        if (deltaX > 90 && deltaY < 80) {
            if (!$("photo-modal")?.classList.contains("hidden")) {
                closeModal();
            } else if (!$("cover-selection-modal")?.classList.contains("hidden")) {
                closeCoverSelectionModal();
            } else if (!$("folder-modal")?.classList.contains("hidden")) {
                closeFolderModal();
            } else if (currentFolderId !== null) {
                $("back-btn")?.click();
            }
        }
    }, { passive: true });
}

function closeCoverSelectionModal() {
    $("cover-selection-modal")?.classList.add("hidden");
}

async function initApp() {
    if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
        setTelegramAvatar();
    }

    setupOnboarding();
    setupSwipeBack();

    const authenticated = await authenticate();

    if (!authenticated) {
        if (!initData) {
            notify("Abre Horen Cloud desde Telegram para iniciar sesión.", "error");
        } else {
            notify("No se pudo autenticar con Telegram. Inténtalo de nuevo.", "error");
        }

        return;
    }

    if (onboardingWasSeen()) showScreen("main-app");

    await Promise.all([
        loadFolders(),
        updateStorageUsage()
    ]);
}

window.closeModal = closeModal;
window.closeFolderModal = closeFolderModal;
window.closeCoverSelectionModal = closeCoverSelectionModal;

initApp();
