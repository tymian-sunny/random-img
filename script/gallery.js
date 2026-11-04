// ==================== 瀑布流布局与渲染 ====================
function getGalleryAvailableWidth() {
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const horizontalPadding = window.innerWidth <= MOBILE_BREAKPOINT ? 20 : BODY_PADDING;
    return Math.max(0, viewportWidth - horizontalPadding);
}

function getGalleryGap() {
    return window.innerWidth <= MOBILE_BREAKPOINT ? MOBILE_GAP : GAP;
}

function calculateColumnCount() {
    const availableWidth = getGalleryAvailableWidth();
    const gap = getGalleryGap();

    if (window.innerWidth <= MOBILE_BREAKPOINT) {
        const minTwoColumnWidth = MOBILE_MIN_CARD_WIDTH * 2 + gap;
        return availableWidth >= minTwoColumnWidth ? 2 : 1;
    }

    let count = Math.floor((availableWidth + GAP) / (BASE_COL_WIDTH + GAP));
    count = Math.max(1, count);
    return Math.min(MAX_COLS, count);
}

function applyZoomOrScale() {
    const gallery = document.getElementById('gallery');
    const availableWidth = getGalleryAvailableWidth();
    const count = calculateColumnCount();
    if (count === MAX_COLS) {
        const baseWidth = MAX_COLS * BASE_COL_WIDTH + (MAX_COLS - 1) * GAP;
        let scale = availableWidth / baseWidth;
        if (scale < 1) scale = 1;
        gallery.style.zoom = scale;
    } else {
        gallery.style.zoom = 1;
    }
}

function setupColumns(forceRedraw = false) {
    const newCount = calculateColumnCount();
    const gallery = document.getElementById('gallery');
    const newGalleryWidth = getGalleryAvailableWidth();
    const widthChanged = Math.abs(newGalleryWidth - currentGalleryWidth) > 1;

    if (forceRedraw || newCount !== currentColumnCount || widthChanged) {
        currentColumnCount = newCount;
        currentGalleryWidth = newGalleryWidth;
        gallery.innerHTML = '';
        columns = [];
        columnHeights = new Array(currentColumnCount).fill(0);
        for (let i = 0; i < currentColumnCount; i++) {
            const col = document.createElement('div');
            col.className = 'gallery-col';
            gallery.appendChild(col);
            columns.push(col);
        }
        columnHeights.fill(0);
        allItems.forEach(item => appendItemToDOM(item));
    }
    applyZoomOrScale();
}

function appendItemToDOM(item) {
    if (!item.urls || !item.urls.original || !item.urls.thumb || !columns.length) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => openModal(item.urls.original);

    const ratio = (item.width && item.height) ? (item.width / item.height) : 1;
    let minIndex = 0;
    let minHeight = columnHeights[0] || 0;
    for (let i = 1; i < columnHeights.length; i++) {
        if (columnHeights[i] < minHeight) { minHeight = columnHeights[i]; minIndex = i; }
    }
    const galleryWidth = getGalleryAvailableWidth();
    const actualGap = getGalleryGap();
    const fallbackColumnWidth = columns.length
        ? (galleryWidth - actualGap * (columns.length - 1)) / columns.length
        : BASE_COL_WIDTH;
    const cardWidth = columns[minIndex].clientWidth || fallbackColumnWidth || BASE_COL_WIDTH;
    const estimatedCardHeight = (1 / ratio) * cardWidth + 60;
    columnHeights[minIndex] += estimatedCardHeight;
    card.dataset.colIndex = minIndex;
    card.dataset.estHeight = estimatedCardHeight;
    const wrapper = document.createElement('div');
    wrapper.className = 'img-wrapper'; wrapper.style.aspectRatio = String(ratio);
    const image = document.createElement('img');
    image.src = item.urls.thumb; image.alt = item.title || ''; image.loading = 'lazy';
    image.onerror = function () { handleImageError(this); };
    wrapper.appendChild(image);
    
    const info = document.createElement('div'); info.className = 'card-info';
    info.setAttribute('role', 'button'); info.setAttribute('tabindex', '0');
    info.setAttribute('aria-label', '查看作品详情');
    info.addEventListener('click', event => { event.stopPropagation(); openDetail(item); });
    info.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); openDetail(item); }
    });
    const heading = document.createElement('h3');
    heading.textContent = item.displayTitle || item.title || 'Untitled'; heading.title = item.title || '';
    const sub = document.createElement('p'); sub.textContent = item.subInfo || '';
    const dimensions = document.createElement('p'); dimensions.textContent = `尺寸: ${item.width || '?'} x ${item.height || '?'}`;
    info.append(heading, sub, dimensions);
    if (item.tags) {
        const tags = document.createElement('p'); tags.className = 'card-tags';
        tags.textContent = `标签: ${translateReturnedTags(item.tags).split(' ').slice(0, 14).join(' ')}`;
        tags.title = translateReturnedTags(item.tags);
        info.appendChild(tags);
    }

    const footerRow = document.createElement('div');
    footerRow.className = 'card-footer-row';
    footerRow.append(dimensions);
    
    const itemKey = getItemUniqueKey(item);
    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.setAttribute('data-key', itemKey);
    favBtn.className = `card-fav-btn ${isEasterUnlocked ? 'show' : ''} ${isFavorite(item) ? 'active' : ''}`;
    favBtn.textContent = isFavorite(item) ? '★ 已收藏' : '☆ 收藏';
    favBtn.onclick = (e) => toggleFavorite(item, e);
    footerRow.appendChild(favBtn);

    if (dimensions && dimensions.parentNode === info) {
        dimensions.remove();
    }
    info.appendChild(footerRow);

    card.append(wrapper, info);
    columns[minIndex].appendChild(card);
}

function handleImageError(img) {
    const card = img.closest('.card');
    if (!card) return;
    const colIndex = parseInt(card.dataset.colIndex, 10);
    const estHeight = parseFloat(card.dataset.estHeight);
    if (!isNaN(colIndex) && !isNaN(estHeight)) columnHeights[colIndex] = Math.max(0, columnHeights[colIndex] - estHeight);
    card.remove();
}
