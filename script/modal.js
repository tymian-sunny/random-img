// ==================== 作品详情与大图模态框交互 ====================
let detailModal, detailImage, activeDetailItem = null;
let modal, modalImg, modalLoading;
let currentScale = 1, translateX = 0, translateY = 0, isDragging = false, startX = 0, startY = 0;

function initModalElements() {
    detailModal = document.getElementById('detailModal');
    detailImage = document.getElementById('detailImage');
    modal = document.getElementById('modal');
    modalImg = document.getElementById('modalImg');
    modalLoading = document.getElementById('modalLoading');

    const detailCloseBtn = document.getElementById('detailClose');
    if (detailCloseBtn) {
        detailCloseBtn.addEventListener('click', closeDetail);
    }
    if (detailModal) {
        detailModal.addEventListener('click', event => { if (event.target === detailModal) closeDetail(); });
    }
    if (detailImage) {
        detailImage.addEventListener('click', () => {
            if (activeDetailItem?.urls?.original) openModal(activeDetailItem.urls.original);
        });
    }

    if (modal) {
        modal.addEventListener('mousedown', event => {
            if (event.target === modal) closeModal();
        });
        modal.addEventListener('wheel', event => {
            if (!modal.classList.contains('active')) return;
            event.preventDefault();
            const zoomSpeed = 0.1;
            const delta = event.deltaY < 0 ? 1 + zoomSpeed : 1 - zoomSpeed;
            const oldScale = currentScale;
            currentScale *= delta;
            currentScale = Math.max(0.2, Math.min(currentScale, 10));
            const actualDelta = currentScale / oldScale;
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            const mx = event.clientX;
            const my = event.clientY;
            translateX = (mx - cx) - (mx - cx - translateX) * actualDelta;
            translateY = (my - cy) - (my - cy - translateY) * actualDelta;
            updateTransform();
        }, { passive: false });
    }

    if (modalImg) {
        modalImg.addEventListener('mousedown', event => {
            event.preventDefault();
            isDragging = true;
            startX = event.clientX - translateX;
            startY = event.clientY - translateY;
        });
    }
}

function detailAddFieldHTML(label, htmlContent) {
    if (!htmlContent) return;
    const fields = document.getElementById('detailFields');
    const name = document.createElement('div'); name.className = 'detail-field-label'; name.textContent = label;
    const content = document.createElement('div'); content.className = 'detail-field-value';
    content.innerHTML = htmlContent;
    fields.append(name, content);
}

function detailAddField(label, value) {
    if (value === undefined || value === null || value === '') return;
    detailAddFieldHTML(label, document.createTextNode(String(value)).textContent);
}

function getDetailTagList(item) {
    if (Array.isArray(item.tags)) return item.tags.map(tag => typeof tag === 'string' ? tag : (tag?.name || tag?.tag || '')).filter(Boolean);
    return String(item.tags || '').split(/[\s,，]+/).filter(Boolean);
}

function updateModalFavBtnStatus() {
    const modalFavBtn = document.getElementById('modalFavBtn');
    if (!modalFavBtn || !activeDetailItem) return;
    const active = isFavorite(activeDetailItem);
    modalFavBtn.classList.toggle('active', active);
    modalFavBtn.textContent = active ? '★ 已收藏' : '☆ 收藏';
}

function toggleModalFav() {
    if (activeDetailItem) {
        toggleFavorite(activeDetailItem);
    }
}

function openDetail(item) {
    if (!item) return;
    activeDetailItem = item;
    document.getElementById('detailTitle').textContent = item.displayTitle || item.title || '作品详情';
    document.getElementById('detailSubtitle').textContent = item.subInfo || '';
    detailImage.src = item.urls?.thumb || item.urls?.original || '';
    detailImage.alt = item.title || '作品预览';
    document.getElementById('detailFields').replaceChildren();
    document.getElementById('detailTags').replaceChildren();
    
    updateModalFavBtnStatus();

    detailAddField('数据源', item.source === 'danbooru' ? 'Danbooru' : 'Setu');
    detailAddField('作品 ID', item.id);
    detailAddField('作者', item.author || item.uploader);
    detailAddField('用户 UID', item.uid);
    detailAddField('图片尺寸', item.width && item.height ? `${item.width} × ${item.height}` : '');
    detailAddField('分级', item.rating ? ratingLabel(item.rating) : '');
    detailAddField('评分', item.score);
    detailAddField('收藏数', item.favCount);
    detailAddField('文件格式', item.fileExt);
    if (item.fileSize) detailAddField('文件大小', `${Number(item.fileSize) > 1024 * 1024 ? (Number(item.fileSize) / 1024 / 1024).toFixed(2) + ' MB' : item.fileSize + ' B'}`);
    detailAddField('上传时间', item.createdAt || item.createDate);
    detailAddField('更新时间', item.updatedAt);
    detailAddField('Pixiv ID', item.pixivId);

    if (item.sourceUrl) {
        const isUrl = /^https?:\/\//i.test(item.sourceUrl);
        if (isUrl) {
            detailAddFieldHTML('原始来源', `<a href="${item.sourceUrl}" target="_blank" rel="noopener noreferrer">${item.sourceUrl}</a>`);
        } else {
            detailAddField('原始来源', item.sourceUrl);
        }
    }
    if (item.source === 'danbooru' && item.id) {
        const danbooruPostUrl = `https://danbooru.donmai.us/posts/${item.id}`;
        detailAddFieldHTML('Danbooru 源', `<a href="${danbooruPostUrl}" target="_blank" rel="noopener noreferrer">${danbooruPostUrl}</a>`);
    }

    const tags = getDetailTagList(item);
    const tagContainer = document.getElementById('detailTags');
    if (!tags.length) {
        const empty = document.createElement('span'); empty.className = 'muted'; empty.textContent = '该作品没有返回标签信息';
        tagContainer.appendChild(empty);
    } else {
        tags.forEach(tag => {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'detail-tag';
            const translated = getTagTranslation(tag);
            button.textContent = translated && translated !== tag ? `${translated} · ${tag}` : tag;
            button.title = `点击搜索：${tag}`;
            button.addEventListener('click', () => searchByDetailTag(tag));
            tagContainer.appendChild(button);
        });
    }
    detailModal.classList.add('active');
    detailModal.setAttribute('aria-hidden', 'false');
}

function closeDetail() {
    detailModal.classList.remove('active');
    detailModal.setAttribute('aria-hidden', 'true');
    detailImage.src = '';
    activeDetailItem = null;
}

function searchByDetailTag(tag) {
    if (isShowingFavorites) toggleFavoritesPage();
    const input = document.getElementById('tagInput');
    const source = document.getElementById('dataSource').value;
    const token = String(tag || '').trim();
    if (!token) return;
    const delimiter = source === 'setu' ? ',' : ' ';
    const existing = source === 'setu'
        ? input.value.split(',').map(value => value.trim()).filter(Boolean)
        : input.value.split(/\s+/).map(value => value.trim()).filter(Boolean);
    const key = token.toLowerCase();
    if (!existing.some(value => value.toLowerCase() === key)) existing.push(token);
    input.value = existing.join(delimiter === ',' ? ', ' : ' ');
    hideTagSuggestions();
    closeDetail();
    resetAndFetch();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateTransform() {
    modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentScale})`;
}

function openModal(originalUrl) {
    currentScale = 1; translateX = 0; translateY = 0;
    updateTransform();
    modalLoading.style.display = 'block';
    modalImg.src = '';
    modalImg.src = originalUrl;
    modal.classList.add('active');
}

function closeModal() {
    modal.classList.remove('active');
    modalImg.src = '';
}
