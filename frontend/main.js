const telegramApp = window.Telegram?.WebApp;
const initData = telegramApp?.initData || "";
let authHeaders = {};
let currentFolderId = null;
let currentFolderName = "";
let currentFolders = [];
let currentFiles = [];
let folderPath = [];
let folderModalMode = "create";
let selectedCoverFileId = null;
let selectedCoverObjectUrl = null;
let selectedPhotoId = null;
let selectedPhoto = null;
let selectionMode = false;
let pendingConfirmation = null;
let toastTimer = null;
let viewerScale = 1;
let viewerX = 0;
let viewerY = 0;
let viewerStartDistance = 0;
let viewerStartScale = 1;
let viewerStartX = 0;
let viewerStartY = 0;
let viewerStartCenter = null;
let viewerWasGesture = false;
const viewerPointers = new Map();
const selectedItems = new Map();
const previewUrls = new Map();
const quotaBytes = 10 * 1024 * 1024 * 1024;
const onboardingKey = "horencloud_onboarding_completed";
const $ = (selector) => document.querySelector(selector);

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
        authHeaders = { "Authorization": `Bearer ${data.access_token}` };
        return true;
    } catch (error) {
        return false;
    }
}

async function fetchJson(url, options = {}) {
    try {
        const response = await fetch(url, {
            ...options,
            headers: { ...authHeaders, ...(options.headers || {}) }
        });

        if (!response.ok) {
            return { ok: false, data: null, response };
        }

        if (response.status === 204) {
            return { ok: true, data: null, response };
        }

        return {
            ok: true,
            data: await response.json(),
            response
        };
    } catch (error) {
        return { ok: false, data: null, response: null };
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
    const index = Math.min(
        Math.floor(Math.log(value) / Math.log(1024)),
        units.length - 1
    );

    const amount = value / Math.pow(1024, index);
    const digits = index === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2;

    return `${amount.toLocaleString("es-ES", {
        maximumFractionDigits: digits
    })} ${units[index]}`;
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

    toastTimer = window.setTimeout(() => {
        toast.classList.add("hidden");
    }, 3200);
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

function createSelectionMark() {
    const mark = document.createElement("span");
    mark.className = "select-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = checkIcon();
    return mark;
}

function updateSelectionUI() {
    const count = selectedItems.size;

    $("#selection-toolbar").classList.toggle("hidden", !selectionMode);
    $("#selection-count").textContent = `${count} seleccionado${count === 1 ? "" : "s"}`;
    $("#bulk-delete-btn").disabled = count === 0;
    $("#select-mode-btn").textContent = selectionMode ? "Cancelar" : "Seleccionar";
    $("#main-app").classList.toggle("selection-mode", selectionMode);
    $("#fab-btn").classList.toggle("hidden", selectionMode);

    document.querySelectorAll(".folder-item, .photo-item").forEach((card) => {
        const key = `${card.dataset.itemType}:${card.dataset.itemId}`;
        card.classList.toggle("selected", selectedItems.has(key));
    });

    updateHeaderActions();
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

    if (selectedItems.has(key)) {
        selectedItems.delete(key);
    } else {
        selectedItems.set(key, { type, item });
    }

    updateSelectionUI();
}

function fileIsImage(file) {
    if (file?.mime_type) {
        return file.mime_type.startsWith("image/");
    }

    return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(
        String(file?.name || "")
    );
}

function fileExtension(file) {
    const name = String(file?.name || "archivo");
    const parts = name.split(".");

    return parts.length > 1
        ? parts.pop().slice(0, 7).toUpperCase()
        : "ARCHIVO";
}

function previewSource(file) {
    return file?.storage_path || file?.url || file?.public_url || file?.download_url || "";
}

async function fetchPreviewUrl(file) {
    if (previewUrls.has(file.id)) {
        return previewUrls.get(file.id);
    }

    try {
        const response = await fetch(`/files/${file.id}/download`, {
            headers: authHeaders
        });

        if (!response.ok) return "";

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);

        previewUrls.set(file.id, objectUrl);

        return objectUrl;
    } catch (error) {
        return "";
    }
}

function updateHeaderActions() {
    const inFolder = currentFolderId !== null;

    $("#back-btn").classList.toggle("hidden", !inFolder);
    $("#delete-folder-btn").classList.toggle("hidden", !inFolder);
    $("#edit-folder-btn").classList.toggle("hidden", !inFolder || selectionMode);
    $("#add-subfolder-btn").classList.toggle("hidden", !inFolder || selectionMode);

    $("#home-hero").classList.toggle("hidden", inFolder);
    $("#home-section").classList.toggle("hidden", inFolder);
    $("#gallery-section").classList.toggle("hidden", !inFolder);
    $("#gallery-grid").classList.toggle("hidden", !inFolder);

    $("#subfolders-grid").classList.toggle(
        "hidden",
        !inFolder || currentFolders.length === 0
    );

    $("#fab-label").textContent = inFolder ? "Subir archivos" : "Nueva carpeta";
    $("#fab-btn").setAttribute(
        "aria-label",
        inFolder ? "Subir archivos" : "Crear carpeta"
    );
}

async function loadCurrentView() {
    const parentId = currentFolderId;

    const folderUrl = parentId === null
        ? "/folders"
        : `/folders?parent_id=${encodeURIComponent(parentId)}`;

    const fileUrl = parentId === null
        ? "/files"
        : `/files?folder_id=${encodeURIComponent(parentId)}`;

    const [folderResult, fileResult] = await Promise.all([
        fetchJson(folderUrl),
        fetchJson(fileUrl)
    ]);

    currentFolders = folderResult.ok && Array.isArray(folderResult.data)
        ? folderResult.data
        : [];

    currentFiles = fileResult.ok && Array.isArray(fileResult.data)
        ? fileResult.data
        : [];

    if (currentFolderId === null) {
        renderFolders(currentFolders);
        $("#subfolders-grid").innerHTML = "";
        $("#gallery-grid").classList.add("hidden");
        $("#gallery-section").classList.add("hidden");
    } else {
        renderSubfolders(currentFolders);
        renderGallery(currentFiles);
        $("#gallery-heading").textContent = currentFolderName || "Archivos";
    }

    updateHeaderActions();
    await updateStorageUsage();
}

function renderFolderCard(folder, index) {
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
        if (selectionMode) {
            toggleSelectedItem("folder", folder);
        } else {
            openFolder(folder);
        }
    });

    item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            item.click();
        }
    });

    return item;
}

function renderFolders(folders) {
    const grid = $("#folders-grid");

    grid.innerHTML = "";
    $("#folder-count").textContent = `${folders.length} carpeta${folders.length === 1 ? "" : "s"}`;

    if (!folders.length) {
        grid.innerHTML = emptyState(
            "Tu nube empieza aquí",
            "Crea una carpeta y empieza a guardar tus recuerdos."
        );

        updateSelectionUI();
        return;
    }

    folders.forEach((folder, index) => {
        grid.appendChild(renderFolderCard(folder, index));
    });

    updateSelectionUI();
}

function renderSubfolders(folders) {
    const grid = $("#subfolders-grid");

    grid.innerHTML = "";
    grid.classList.toggle("hidden", folders.length === 0);

    folders.forEach((folder, index) => {
        grid.appendChild(renderFolderCard(folder, index));
    });

    updateSelectionUI();
}

function renderGallery(files) {
    const grid = $("#gallery-grid");

    grid.innerHTML = "";
    $("#file-count").textContent = `${files.length} archivo${files.length === 1 ? "" : "s"}`;

    if (!files.length && currentFolders.length === 0) {
        grid.innerHTML = emptyState(
            "Todavía no hay archivos",
            "Crea una subcarpeta o sube fotos y archivos aquí.",
            "image"
        );

        return;
    }

    if (!files.length) {
        grid.innerHTML = emptyState(
            "No hay archivos en esta carpeta",
            "Puedes subir archivos con el botón inferior.",
            "image"
        );

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
            const image = document.createElement("img");

            image.src = source;
            image.alt = file.name || "Foto";
            image.loading = "lazy";

            image.onerror = async () => {
                if (image.dataset.fallbackTried === "true") return;

                image.dataset.fallbackTried = "true";

                const fallbackUrl = await fetchPreviewUrl(file);

                if (fallbackUrl) {
                    image.src = fallbackUrl;
                } else {
                    image.remove();
                    media.innerHTML = `<div class="file-placeholder">${folderIcon()}<span class="file-type-label">${escapeHtml(fileExtension(file))}</span></div>`;
                }
            };

            media.appendChild(image);
        } else {
            const placeholder = document.createElement("div");

            placeholder.className = "file-placeholder";
            placeholder.innerHTML = `${folderIcon()}<span class="file-type-label">${escapeHtml(fileExtension(file))}</span>`;

            media.appendChild(placeholder);

            if (!source && fileIsImage(file)) {
                fetchPreviewUrl(file).then((url) => {
                    if (!url || !item.isConnected) return;

                    const image = document.createElement("img");

                    image.src = url;
                    image.alt = file.name || "Foto";
                    image.loading = "lazy";

                    placeholder.remove();
                    media.prepend(image);
                });
            }
        }

        const name = document.createElement("div");

        name.className = "file-name";
        name.textContent = file.name || "Archivo sin nombre";

        item.append(media, createSelectionMark(), name);

        item.addEventListener("click", () => {
            if (selectionMode) {
                toggleSelectedItem("file", file);
            } else {
                openModal(file);
            }
        });

        item.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                item.click();
            }
        });

        grid.appendChild(item);
    });

    updateSelectionUI();
}

async function openFolder(folder) {
    if (selectionMode) return;

    folderPath.push({
        id: Number(folder.id),
        name: folder.name || "Carpeta",
        parent_id: folder.parent_id ?? null,
        cover_url: folder.cover_url || null
    });

    syncFolderState();
    await loadCurrentView();
}

function syncFolderState() {
    const activeFolder = folderPath[folderPath.length - 1] || null;

    currentFolderId = activeFolder ? activeFolder.id : null;
    currentFolderName = activeFolder ? activeFolder.name : "";

    const user = telegramApp?.initDataUnsafe?.user;

    $("#app-title").textContent = activeFolder
        ? activeFolder.name
        : `zdarova, ${user?.first_name?.trim() || "amigo"}`;

    $("#gallery-heading").textContent = activeFolder
        ? activeFolder.name
        : "Tus fotos";

    updateHeaderActions();
}

async function navigateBack() {
    if (!folderPath.length) return;

    folderPath.pop();

    stopSelection();
    syncFolderState();

    await loadCurrentView();
}

async function goHome() {
    folderPath = [];

    stopSelection();
    syncFolderState();

    await loadCurrentView();
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

async function updateStorageUsage() {
    const allFiles = new Map();

    const rootResult = await fetchJson("/files");

    if (rootResult.ok && Array.isArray(rootResult.data)) {
        rootResult.data.forEach((file) => {
            allFiles.set(String(file.id), file);
        });
    }

    const foldersResult = await fetchJson("/folders");

    const rootFolders = foldersResult.ok && Array.isArray(foldersResult.data)
        ? foldersResult.data
        : [];

    const foldersToVisit = [...rootFolders];
    const visited = new Set();

    while (foldersToVisit.length) {
        const folder = foldersToVisit.shift();

        if (visited.has(String(folder.id))) continue;

        visited.add(String(folder.id));

        const [filesResult, childFoldersResult] = await Promise.all([
            fetchJson(`/files?folder_id=${encodeURIComponent(folder.id)}`),
            fetchJson(`/folders?parent_id=${encodeURIComponent(folder.id)}`)
        ]);

        if (filesResult.ok && Array.isArray(filesResult.data)) {
            filesResult.data.forEach((file) => {
                allFiles.set(String(file.id), file);
            });
        }

        if (childFoldersResult.ok && Array.isArray(childFoldersResult.data)) {
            foldersToVisit.push(...childFoldersResult.data);
        }
    }

    const usedBytes = Array.from(allFiles.values()).reduce(
        (total, file) => total + Math.max(0, Number(file.size_bytes ?? file.size ?? 0) || 0),
        0
    );

    updateStorageDisplay(usedBytes);
}

function openCreateFolderModal() {
    folderModalMode = "create";
    selectedCoverFileId = null;

    $("#folder-modal-kicker").textContent = currentFolderId === null
        ? "NUEVA COLECCIÓN"
        : "NUEVA SUBCARPETA";

    $("#folder-modal-title").textContent = currentFolderId === null
        ? "Crear carpeta"
        : "Crear subcarpeta";

    $("#create-folder-btn").innerHTML = currentFolderId === null
        ? 'Crear carpeta <span>↗</span>'
        : 'Crear subcarpeta <span>↗</span>';

    $("#folder-name").value = "";
    $("#folder-cover-row").classList.add("hidden");
    $("#cover-preview").classList.add("hidden");
    $("#cover-preview").removeAttribute("src");
    $("#cover-pick-preview").innerHTML = "<span>✳</span>";

    $("#folder-modal").classList.remove("hidden");

    window.setTimeout(() => $("#folder-name").focus(), 100);
}

function openEditFolderModal() {
    const folder = folderPath[folderPath.length - 1];

    if (!folder) return;

    folderModalMode = "edit";
    selectedCoverFileId = null;

    $("#folder-modal-kicker").textContent = "PERSONALIZA TU COLECCIÓN";
    $("#folder-modal-title").textContent = "Editar carpeta";
    $("#create-folder-btn").innerHTML = 'Guardar cambios <span>↗</span>';
    $("#folder-name").value = folder.name;
    $("#folder-cover-row").classList.remove("hidden");
    $("#cover-preview").classList.add("hidden");
    $("#cover-preview").removeAttribute("src");

    const preview = $("#cover-pick-preview");

    preview.innerHTML = "<span>✳</span>";

    if (folder.cover_url) {
        const image = document.createElement("img");

        image.src = folder.cover_url;
        image.alt = "Portada actual";

        preview.replaceChildren(image);
    }

    $("#folder-modal").classList.remove("hidden");

    window.setTimeout(() => $("#folder-name").focus(), 100);
}

function closeFolderModal() {
    $("#folder-modal").classList.add("hidden");
    $("#folder-name").value = "";
    $("#cover-preview").classList.add("hidden");
    $("#cover-preview").removeAttribute("src");
    $("#cover-pick-preview").innerHTML = "<span>✳</span>";
    $("#folder-cover-row").classList.add("hidden");

    selectedCoverFileId = null;

    if (selectedCoverObjectUrl) {
        URL.revokeObjectURL(selectedCoverObjectUrl);
    }

    selectedCoverObjectUrl = null;
}

async function saveFolder() {
    const name = $("#folder-name").value.trim();

    if (!name) {
        $("#folder-name").focus();
        showToast("Escribe un nombre para la carpeta");
        return;
    }

    const button = $("#create-folder-btn");
    const oldContent = button.innerHTML;

    button.disabled = true;
    button.textContent = folderModalMode === "edit" ? "Guardando..." : "Creando...";

    const formData = new FormData();

    formData.append("name", name);

    let endpoint = "/folders";
    let method = "POST";

    if (folderModalMode === "edit") {
        const folder = folderPath[folderPath.length - 1];

        if (!folder) {
            button.disabled = false;
            button.innerHTML = oldContent;
            return;
        }

        endpoint = `/folders/${folder.id}`;
        method = "PATCH";

        if (selectedCoverFileId !== null) {
            formData.append("cover_file_id", String(selectedCoverFileId));
        }
    } else if (currentFolderId !== null) {
        formData.append("parent_id", String(currentFolderId));
    }

    try {
        const result = await fetchJson(endpoint, {
            method,
            body: formData
        });

        if (!result.ok) {
            showToast(await getErrorMessage(
                result.response,
                folderModalMode === "edit"
                    ? "No se pudo editar la carpeta"
                    : "No se pudo crear la carpeta"
            ));

            return;
        }

        const wasEdit = folderModalMode === "edit";

        if (wasEdit) {
            const folder = folderPath[folderPath.length - 1];

            folder.name = result.data?.name || name;
            folder.cover_url = result.data?.cover_url || folder.cover_url || null;
            currentFolderName = folder.name;
        }

        closeFolderModal();
        syncFolderState();
        await loadCurrentView();

        showToast(wasEdit ? "Carpeta actualizada" : "Carpeta creada");
    } catch (error) {
        showToast("Error de conexión al guardar la carpeta");
    } finally {
        button.disabled = false;
        button.innerHTML = oldContent;
    }
}

async function openCoverSelectionModal() {
    if (currentFolderId === null) {
        showToast("Abre una carpeta para elegir una portada");
        return;
    }

    $("#cover-selection-modal").classList.remove("hidden");

    const coverGrid = $("#cover-grid");

    coverGrid.innerHTML = emptyState(
        "Buscando fotos",
        "Cargando las imágenes de esta carpeta.",
        "image"
    );

    const result = await fetchJson(
        `/files?folder_id=${encodeURIComponent(currentFolderId)}`
    );

    const files = result.ok && Array.isArray(result.data)
        ? result.data.filter(fileIsImage)
        : [];

    coverGrid.innerHTML = "";

    if (!files.length) {
        coverGrid.innerHTML = emptyState(
            "No hay fotos todavía",
            "Sube una imagen a esta carpeta para usarla como portada.",
            "image"
        );

        return;
    }

    files.forEach((file, index) => {
        const item = document.createElement("div");

        item.className = "photo-item cover-choice-item";
        item.style.setProperty("--item-index", index);
        item.style.setProperty("--item-delay", `${Math.min(index, 8) * 35}ms`);

        const media = document.createElement("div");
        media.className = "file-media";

        const image = document.createElement("img");

        image.alt = file.name || "Foto";
        image.loading = "lazy";
        image.src = previewSource(file) || "";

        image.onerror = async () => {
            const url = await fetchPreviewUrl(file);

            if (url) {
                image.src = url;
            }
        };

        const name = document.createElement("div");

        name.className = "file-name";
        name.textContent = file.name || "Foto";

        media.appendChild(image);
        item.append(media, name);

        item.addEventListener("click", () => selectCoverFromApp(file));

        coverGrid.appendChild(item);
    });
}

function closeCoverSelectionModal() {
    $("#cover-selection-modal").classList.add("hidden");
}

function selectCoverFromApp(file) {
    selectedCoverFileId = Number(file.id);

    const imageUrl = previewSource(file);
    const preview = $("#cover-pick-preview");
    const thumb = document.createElement("img");

    thumb.src = imageUrl;
    thumb.alt = "Portada seleccionada";

    preview.replaceChildren(thumb);

    $("#cover-preview").src = imageUrl;
    $("#cover-preview").classList.remove("hidden");

    closeCoverSelectionModal();

    showToast("Portada elegida. Guarda los cambios para aplicarla.");
}

async function updateFolderCoverFromPhoto(file) {
    const folder = folderPath[folderPath.length - 1];

    if (!folder || !fileIsImage(file)) return;

    const formData = new FormData();

    formData.append("cover_file_id", String(file.id));

    const button = $("#set-cover-btn");

    button.disabled = true;

    try {
        const result = await fetchJson(`/folders/${folder.id}`, {
            method: "PATCH",
            body: formData
        });

        if (!result.ok) {
            showToast(await getErrorMessage(
                result.response,
                "No se pudo cambiar la portada"
            ));

            return;
        }

        folder.cover_url = result.data?.cover_url || folder.cover_url;

        showToast("Foto establecida como portada");
    } catch (error) {
        showToast("Error al cambiar la portada");
    } finally {
        button.disabled = false;
    }
}

function deleteSelection() {
    if (!selectedItems.size) return;

    const items = Array.from(selectedItems.values());
    const label = items.length === 1
        ? "este elemento"
        : `estos ${items.length} elementos`;

    showConfirmation(
        "¿Eliminar selección?",
        `Vas a eliminar ${label}, incluidos los archivos que haya dentro de las carpetas seleccionadas. Esta acción no se puede deshacer.`,
        async () => {
            let failed = 0;

            for (const entry of items) {
                const endpoint = entry.type === "folder"
                    ? `/folders/${entry.item.id}`
                    : `/files/${entry.item.id}`;

                try {
                    const response = await fetch(endpoint, {
                        method: "DELETE",
                        headers: authHeaders
                    });

                    if (!response.ok) {
                        failed++;
                    } else if (entry.type === "file" && previewUrls.has(entry.item.id)) {
                        URL.revokeObjectURL(previewUrls.get(entry.item.id));
                        previewUrls.delete(entry.item.id);
                    }
                } catch (error) {
                    failed++;
                }
            }

            stopSelection();

            await loadCurrentView();

            if (failed) {
                showToast(`No se pudieron eliminar ${failed} elementos`);
            } else {
                showToast("Selección eliminada");
            }
        }
    );
}

function openModal(file) {
    selectedPhotoId = file.id;
    selectedPhoto = file;

    $("#modal-img").classList.add("hidden");
    $("#modal-img").dataset.fallbackTried = "false";
    $("#modal-img").removeAttribute("src");

    $("#viewer-file-placeholder").classList.add("hidden");

    resetViewerTransform();

    $("#photo-caption").textContent = file.name || "Archivo";
    $("#photo-subcaption").textContent = `${formatBytes(file.size_bytes || 0)}${file.mime_type ? ` · ${file.mime_type}` : ""}`;
    $("#photo-modal").classList.remove("hidden");

    $("#set-cover-btn").classList.toggle(
        "hidden",
        currentFolderId === null || !fileIsImage(file)
    );

    if (fileIsImage(file)) {
        const source = previewSource(file);

        if (source) {
            $("#modal-img").src = source;
            $("#modal-img").classList.remove("hidden");
        } else {
            fetchPreviewUrl(file).then((url) => {
                if (
                    selectedPhotoId !== file.id ||
                    $("#photo-modal").classList.contains("hidden")
                ) {
                    return;
                }

                if (url) {
                    $("#modal-img").src = url;
                    $("#modal-img").classList.remove("hidden");
                } else {
                    showViewerFilePlaceholder(file);
                }
            });
        }
    } else {
        showViewerFilePlaceholder(file);
    }
}

function showViewerFilePlaceholder(file) {
    $("#viewer-file-name").textContent = file.name || "Archivo";
    $("#viewer-file-placeholder").classList.remove("hidden");
}

function applyViewerTransform() {
    $("#modal-img").style.transform =
        `translate3d(${viewerX}px, ${viewerY}px, 0) scale(${viewerScale})`;

    $("#viewer-stage").classList.toggle("zoomed", viewerScale > 1.01);

    $("#zoom-btn").setAttribute(
        "aria-label",
        viewerScale > 1.01 ? "Reducir foto" : "Ampliar foto"
    );
}

function resetViewerTransform() {
    viewerScale = 1;
    viewerX = 0;
    viewerY = 0;

    viewerPointers.clear();
    viewerStartDistance = 0;
    viewerWasGesture = false;

    applyViewerTransform();
}

function setViewerScale(nextScale, centerX = 0, centerY = 0) {
    const previousScale = viewerScale;

    viewerScale = Math.max(1, Math.min(5, nextScale));

    if (viewerScale === 1) {
        viewerX = 0;
        viewerY = 0;
    } else if (previousScale > 0) {
        const ratio = viewerScale / previousScale;

        viewerX = viewerX * ratio + centerX * (1 - ratio);
        viewerY = viewerY * ratio + centerY * (1 - ratio);
    }

    applyViewerTransform();
}

function pointerDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointerCenter(a, b) {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2
    };
}

function closeModal() {
    $("#photo-modal").classList.add("hidden");

    selectedPhotoId = null;
    selectedPhoto = null;

    resetViewerTransform();
}

async function downloadSelectedFile() {
    if (!selectedPhotoId) return;

    const button = $("#download-btn");

    button.disabled = true;

    try {
        const response = await fetch(
            `/files/${selectedPhotoId}/download`,
            { headers: authHeaders }
        );

        if (!response.ok) {
            showToast(await getErrorMessage(
                response,
                "No se pudo descargar el archivo"
            ));

            return;
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");

        anchor.href = url;
        anchor.download = selectedPhoto?.name || "download";

        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        window.setTimeout(() => URL.revokeObjectURL(url), 1500);

        showToast("Descarga iniciada");
    } catch (error) {
        showToast("Error al descargar el archivo");
    } finally {
        button.disabled = false;
    }
}

function deleteSelectedFile() {
    if (!selectedPhotoId) return;

    const fileId = selectedPhotoId;
    const fileName = selectedPhoto?.name || "este archivo";

    showConfirmation(
        "¿Eliminar archivo?",
        `Se eliminará “${fileName}” de tu nube y del almacenamiento. Esta acción no se puede deshacer.`,
        async () => {
            try {
                const response = await fetch(`/files/${fileId}`, {
                    method: "DELETE",
                    headers: authHeaders
                });

                if (!response.ok) {
                    showToast(await getErrorMessage(
                        response,
                        "No se pudo eliminar el archivo"
                    ));

                    return;
                }

                closeModal();

                if (previewUrls.has(fileId)) {
                    URL.revokeObjectURL(previewUrls.get(fileId));
                    previewUrls.delete(fileId);
                }

                await loadCurrentView();

                showToast("Archivo eliminado");
            } catch (error) {
                showToast("Error de conexión al eliminar el archivo");
            }
        }
    );
}

function deleteCurrentFolder() {
    const folder = folderPath[folderPath.length - 1];

    if (!folder) return;

    showConfirmation(
        "¿Eliminar carpeta?",
        `Se eliminará “${folder.name}”, con sus subcarpetas y archivos. El contenido también se eliminará del almacenamiento y no se podrá recuperar.`,
        async () => {
            try {
                const response = await fetch(`/folders/${folder.id}`, {
                    method: "DELETE",
                    headers: authHeaders
                });

                if (!response.ok) {
                    showToast(await getErrorMessage(
                        response,
                        "No se pudo eliminar la carpeta"
                    ));

                    return;
                }

                folderPath.pop();

                stopSelection();
                syncFolderState();

                await loadCurrentView();

                showToast("Carpeta eliminada");
            } catch (error) {
                showToast("Error de conexión al eliminar la carpeta");
            }
        }
    );
}

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

async function getErrorMessage(response, fallback) {
    if (!response) return fallback;

    try {
        const data = await response.json();
        return data.detail || fallback;
    } catch (error) {
        return fallback;
    }
}

function showOnboarding() {
    $("#main-app").classList.add("hidden");
    $("#onboarding").classList.remove("hidden");

    $("#indicators").innerHTML = '<span class="dot active"></span>';
    $("#btn-text").textContent = "Entrar";
    $("#next-btn").classList.add("finish");
}

async function showApplication() {
    $("#onboarding").classList.add("hidden");
    $("#main-app").classList.remove("hidden");

    if (telegramApp) {
        telegramApp.ready();
        telegramApp.expand();
        setTelegramAvatar();
    } else {
        $("#app-title").textContent = "zdarova, amigo";
    }

    const isAuthenticated = await authenticate();

    if (!isAuthenticated) {
        renderFolders([]);
        updateStorageDisplay(0);

        if (initData) {
            showToast("No se pudo iniciar sesión. Cierra y vuelve a abrir la mini app.");
        }

        return;
    }

    await loadCurrentView();
}

$("#next-btn").addEventListener("click", async () => {
    try {
        localStorage.setItem(onboardingKey, "true");
    } catch (error) {}

    await showApplication();
});

$("#back-btn").addEventListener("click", navigateBack);

$("#select-mode-btn").addEventListener("click", () => {
    if (selectionMode) {
        stopSelection();
    } else {
        startSelection();
    }
});

$("#cancel-selection-btn").addEventListener("click", stopSelection);
$("#bulk-delete-btn").addEventListener("click", deleteSelection);
$("#delete-folder-btn").addEventListener("click", deleteCurrentFolder);
$("#add-subfolder-btn").addEventListener("click", openCreateFolderModal);
$("#edit-folder-btn").addEventListener("click", openEditFolderModal);

$("#fab-btn").addEventListener("click", () => {
    if (currentFolderId === null) {
        openCreateFolderModal();
    } else {
        $("#file-input").click();
    }
});

$("#cancel-folder-btn").addEventListener("click", closeFolderModal);
$("#create-folder-btn").addEventListener("click", saveFolder);
$("#select-cover-btn").addEventListener("click", openCoverSelectionModal);
$("#cancel-cover-btn").addEventListener("click", closeCoverSelectionModal);
$("#close-photo-btn").addEventListener("click", closeModal);
$("#download-btn").addEventListener("click", downloadSelectedFile);
$("#delete-btn").addEventListener("click", deleteSelectedFile);

$("#set-cover-btn").addEventListener("click", () => {
    if (selectedPhoto) {
        updateFolderCoverFromPhoto(selectedPhoto);
    }
});

$("#confirm-cancel-btn").addEventListener("click", closeConfirmation);

$("#confirm-action-btn").addEventListener("click", async () => {
    if (!pendingConfirmation) return;

    const action = pendingConfirmation;
    const button = $("#confirm-action-btn");

    button.disabled = true;
    button.textContent = "Procesando...";

    closeConfirmation();

    try {
        await action();
    } finally {
        button.disabled = false;
        button.textContent = "Sí, eliminar";
    }
});

$("#folder-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        $("#create-folder-btn").click();
    }
});

$("#file-input").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);

    if (!files.length || currentFolderId === null) return;

    const fab = $("#fab-btn");
    const originalContent = fab.innerHTML;

    fab.disabled = true;
    fab.innerHTML = '<span class="uploading-label">Subiendo...</span>';

    let uploaded = 0;
    let failed = 0;

    for (const file of files) {
        const formData = new FormData();

        formData.append("file", file);
        formData.append("folder_id", String(currentFolderId));

        try {
            const response = await fetch("/files", {
                method: "POST",
                headers: authHeaders,
                body: formData
            });

            if (response.ok) {
                uploaded++;
            } else {
                failed++;
            }
        } catch (error) {
            failed++;
        }
    }

    fab.innerHTML = originalContent;
    fab.disabled = false;
    event.target.value = "";

    await loadCurrentView();

    if (uploaded && !failed) {
        showToast(`${uploaded} archivo${uploaded === 1 ? "" : "s"} subido${uploaded === 1 ? "" : "s"}`);
    } else if (uploaded && failed) {
        showToast(`${uploaded} subidos, ${failed} con error`);
    } else {
        showToast("No se pudieron subir los archivos");
    }
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

    if (fallbackUrl) {
        image.src = fallbackUrl;
        image.classList.remove("hidden");
    } else {
        image.classList.add("hidden");
        showViewerFilePlaceholder(file);
    }
});

$("#zoom-btn").addEventListener("click", () => {
    setViewerScale(viewerScale > 1 ? 1 : 2.2);
});

$("#viewer-stage").addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    viewerPointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
    });

    viewerWasGesture = false;

    try {
        event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {}

    if (viewerPointers.size === 1) {
        viewerStartX = event.clientX;
        viewerStartY = event.clientY;

        viewerStartCenter = {
            x: event.clientX,
            y: event.clientY
        };

        viewerStartDistance = 0;
    } else if (viewerPointers.size === 2) {
        const points = Array.from(viewerPointers.values());

        viewerStartDistance = pointerDistance(points[0], points[1]);
        viewerStartScale = viewerScale;
        viewerStartCenter = pointerCenter(points[0], points[1]);
        viewerStartX = viewerX;
        viewerStartY = viewerY;
        viewerWasGesture = true;
    }
});

$("#viewer-stage").addEventListener("pointermove", (event) => {
    if (!viewerPointers.has(event.pointerId)) return;

    viewerPointers.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
    });

    if (viewerPointers.size >= 2) {
        const points = Array.from(viewerPointers.values());
        const distance = pointerDistance(points[0], points[1]);
        const center = pointerCenter(points[0], points[1]);

        if (viewerStartDistance > 0) {
            viewerScale = Math.max(
                1,
                Math.min(5, viewerStartScale * distance / viewerStartDistance)
            );

            viewerX = viewerStartX + center.x - viewerStartCenter.x;
            viewerY = viewerStartY + center.y - viewerStartCenter.y;

            if (viewerScale === 1) {
                viewerX = 0;
                viewerY = 0;
            }

            applyViewerTransform();
        }

        viewerWasGesture = true;
    } else if (viewerPointers.size === 1 && viewerScale > 1) {
        const point = viewerPointers.get(event.pointerId);

        viewerX += point.x - viewerStartX;
        viewerY += point.y - viewerStartY;

        viewerStartX = point.x;
        viewerStartY = point.y;

        applyViewerTransform();

        viewerWasGesture = true;
    } else if (viewerPointers.size === 1) {
        const point = viewerPointers.get(event.pointerId);

        if (Math.hypot(
            point.x - viewerStartX,
            point.y - viewerStartY
        ) > 7) {
            viewerWasGesture = true;
        }
    }
});

function releaseViewerPointer(event) {
    viewerPointers.delete(event.pointerId);

    if (viewerPointers.size === 1) {
        const point = Array.from(viewerPointers.values())[0];

        viewerStartX = point.x;
        viewerStartY = point.y;
        viewerStartDistance = 0;
    } else if (viewerPointers.size === 0) {
        viewerStartDistance = 0;
    }
}

$("#viewer-stage").addEventListener("pointerup", releaseViewerPointer);
$("#viewer-stage").addEventListener("pointercancel", releaseViewerPointer);

$("#viewer-stage").addEventListener("wheel", (event) => {
    if (!selectedPhoto || !fileIsImage(selectedPhoto)) return;

    event.preventDefault();

    const bounds = $("#viewer-stage").getBoundingClientRect();
    const centerX = event.clientX - bounds.left - bounds.width / 2;
    const centerY = event.clientY - bounds.top - bounds.height / 2;

    setViewerScale(
        viewerScale * Math.exp(-event.deltaY * 0.002),
        centerX,
        centerY
    );
}, { passive: false });

$("#modal-img").addEventListener("click", () => {
    if (viewerWasGesture) {
        viewerWasGesture = false;
        return;
    }

    if (viewerScale > 1) {
        setViewerScale(1);
    } else {
        setViewerScale(2);
    }
});

$("#photo-modal").addEventListener("click", (event) => {
    if (event.target === $("#photo-modal")) {
        closeModal();
    }
});

$("#folder-modal").addEventListener("click", (event) => {
    if (event.target === $("#folder-modal")) {
        closeFolderModal();
    }
});

$("#cover-selection-modal").addEventListener("click", (event) => {
    if (event.target === $("#cover-selection-modal")) {
        closeCoverSelectionModal();
    }
});

let edgeSwipeStart = null;

document.addEventListener("pointerdown", (event) => {
    if (currentFolderId === null || event.clientX > 30) return;

    const modalSelectors = [
        "#photo-modal",
        "#folder-modal",
        "#cover-selection-modal",
        "#confirm-modal"
    ];

    if (modalSelectors.some((selector) => {
        return !$(selector).classList.contains("hidden");
    })) {
        return;
    }

    edgeSwipeStart = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId
    };
});

document.addEventListener("pointerup", async (event) => {
    if (!edgeSwipeStart || edgeSwipeStart.pointerId !== event.pointerId) {
        return;
    }

    const start = edgeSwipeStart;

    edgeSwipeStart = null;

    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;

    if (dx > 85 && Math.abs(dy) < 70) {
        await navigateBack();
    }
});

document.addEventListener("pointercancel", () => {
    edgeSwipeStart = null;
});

window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (!$("#confirm-modal").classList.contains("hidden")) {
        closeConfirmation();
    } else if (!$("#cover-selection-modal").classList.contains("hidden")) {
        closeCoverSelectionModal();
    } else if (!$("#folder-modal").classList.contains("hidden")) {
        closeFolderModal();
    } else if (!$("#photo-modal").classList.contains("hidden")) {
        closeModal();
    } else if (selectionMode) {
        stopSelection();
    } else if (currentFolderId !== null) {
        navigateBack();
    }
});

window.addEventListener("pointermove", (event) => {
    if (
        event.pointerType === "touch" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
        return;
    }

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
    }

    let completed = false;

    try {
        completed = localStorage.getItem(onboardingKey) === "true";
    } catch (error) {}

    if (completed) {
        await showApplication();
    } else {
        showOnboarding();
    }
}

initApp();