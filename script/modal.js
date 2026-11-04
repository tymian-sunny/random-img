// ==================== 作品详情与大图模态框交互 ====================
let detailModal, detailImage, activeDetailItem = null;
let modal, modalImg, modalLoading;
let currentScale = 1, translateX = 0, translateY = 0, isDragging = false, startX = 0, startY = 0;
/** 本次指针操作是否发生了有效拖动（用于区分点击关闭与拖动回位） */
let modalPointerMoved = false;
let pinchStartDist = 0;
let pinchStartScale = 1;
let lastTapTime = 0;

/** 打开弹层时锁定背后页面滚动位置，避免手机滑动/缩放带动主页 */
let bodyScrollLockCount = 0;
let bodyScrollLockY = 0;

function lockBodyScroll() {
    if (bodyScrollLockCount === 0) {
        bodyScrollLockY = window.scrollY || window.pageYOffset || 0;
        document.body.style.position = 'fixed';
        document.body.style.top = `-${bodyScrollLockY}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.width = '100%';
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        document.body.classList.add('modal-open');
    }
    bodyScrollLockCount += 1;
}

function unlockBodyScroll() {
    if (bodyScrollLockCount === 0) return;
    bodyScrollLockCount -= 1;
    if (bodyScrollLockCount > 0) return;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    document.body.classList.remove('modal-open');
    window.scrollTo(0, bodyScrollLockY);
}

function isScrollableElement(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    const canScrollY = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
    return canScrollY;
}

/** 弹层内：允许在可滚动区域滑动；其它区域阻止把滚动传给背后页面 */
function onOverlayTouchMove(event) {
    if (bodyScrollLockCount === 0) return;
    // 多指（双指缩放等）一律拦截，避免浏览器缩放整页
    if (event.touches && event.touches.length > 1) {
        event.preventDefault();
        return;
    }
    let node = event.target;
    while (node && node !== document.body) {
        if (isScrollableElement(node)) {
            return; // 让内部滚动自然发生
        }
        // 大图本身用 transform 拖动，不把 touch 交给页面
        if (node === modalImg || node === modal) {
            event.preventDefault();
            return;
        }
        node = node.parentElement;
    }
    event.preventDefault();
}

function initModalElements() {
    detailModal = document.getElementById('detailModal');
    detailImage = document.getElementById('detailImage');
    modal = document.getElementById('modal');
    modalImg = document.getElementById('modalImg');
    modalLoading = document.getElementById('modalLoading');

    // 全局拦截：弹层打开时，非内部滚动区域的 touchmove 不传到主页
    document.addEventListener('touchmove', onOverlayTouchMove, { passive: false });

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
        // 滚轮缩放（以指针为中心）
        modal.addEventListener('wheel', event => {
            if (!modal.classList.contains('active')) return;
            event.preventDefault();
            const zoomSpeed = 0.1;
            const delta = event.deltaY < 0 ? 1 + zoomSpeed : 1 - zoomSpeed;
            const oldScale = currentScale;
            currentScale = Math.max(0.2, Math.min(10, currentScale * delta));
            const actualDelta = currentScale / oldScale;
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            const mx = event.clientX;
            const my = event.clientY;
            translateX = (mx - cx) - (mx - cx - translateX) * actualDelta;
            translateY = (my - cy) - (my - cy - translateY) * actualDelta;
            clampImageTransform();
            updateTransform();
        }, { passive: false });

        // 整个大图层（含灰色区域）都可拖动回位；未缩放时点灰色关闭
        modal.addEventListener('mousedown', event => {
            if (!modal.classList.contains('active')) return;
            if (event.target.closest('.modal-close')) return;
            event.preventDefault();
            modalPointerMoved = false;
            isDragging = true;
            startX = event.clientX - translateX;
            startY = event.clientY - translateY;
        });

        modal.addEventListener('click', event => {
            if (!modal.classList.contains('active')) return;
            if (event.target.closest('.modal-close')) return;
            // 发生过拖动则不当作关闭点击
            if (modalPointerMoved) return;
            // 缩放/偏移状态下点灰色：复位；未缩放点灰色：关闭
            if (event.target === modal || event.target === modalLoading) {
                if (currentScale > 1.02 || Math.abs(translateX) > 8 || Math.abs(translateY) > 8) {
                    resetImageTransform();
                } else {
                    closeModal();
                }
            }
        });

        // 触摸：整层单指拖动 / 双指缩放；双击复位
        modal.addEventListener('touchstart', event => {
            if (!modal.classList.contains('active')) return;
            if (event.target.closest('.modal-close')) return;
            modalPointerMoved = false;
            if (event.touches.length === 1) {
                const now = Date.now();
                if (now - lastTapTime < 280) {
                    // 双击复位
                    resetImageTransform();
                    lastTapTime = 0;
                    isDragging = false;
                    return;
                }
                lastTapTime = now;
                isDragging = true;
                startX = event.touches[0].clientX - translateX;
                startY = event.touches[0].clientY - translateY;
            } else if (event.touches.length >= 2) {
                isDragging = false;
                const dx = event.touches[0].clientX - event.touches[1].clientX;
                const dy = event.touches[0].clientY - event.touches[1].clientY;
                pinchStartDist = Math.hypot(dx, dy) || 1;
                pinchStartScale = currentScale;
            }
        }, { passive: true });

        modal.addEventListener('touchmove', event => {
            if (!modal.classList.contains('active')) return;
            if (event.touches.length >= 2) {
                event.preventDefault();
                modalPointerMoved = true;
                const dx = event.touches[0].clientX - event.touches[1].clientX;
                const dy = event.touches[0].clientY - event.touches[1].clientY;
                const dist = Math.hypot(dx, dy) || 1;
                currentScale = Math.max(0.2, Math.min(10, pinchStartScale * (dist / pinchStartDist)));
                clampImageTransform();
                updateTransform();
            } else if (event.touches.length === 1 && isDragging) {
                event.preventDefault();
                const nx = event.touches[0].clientX - startX;
                const ny = event.touches[0].clientY - startY;
                if (Math.abs(nx - translateX) > 3 || Math.abs(ny - translateY) > 3) {
                    modalPointerMoved = true;
                }
                translateX = nx;
                translateY = ny;
                clampImageTransform();
                updateTransform();
            }
        }, { passive: false });

        modal.addEventListener('touchend', event => {
            if (!modal.classList.contains('active')) return;
            // 未缩放时，在灰色区域轻点关闭（未拖动）
            if (!modalPointerMoved && event.changedTouches.length === 1 && currentScale <= 1.02
                && Math.abs(translateX) <= 8 && Math.abs(translateY) <= 8) {
                const t = event.changedTouches[0];
                const el = document.elementFromPoint(t.clientX, t.clientY);
                if (el === modal || el === modalLoading) {
                    closeModal();
                }
            }
            if (event.touches.length === 0) {
                isDragging = false;
                clampImageTransform();
                updateTransform();
            }
        });
    }
}

/** 限制位移，保证图片至少有一部分留在视口内，避免拖出后无法再操作 */
function clampImageTransform() {
    if (!modalImg) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 使用布局尺寸 * scale；加载前可能为 0，给兜底
    const iw = (modalImg.offsetWidth || Math.min(vw * 0.9, 800)) * currentScale;
    const ih = (modalImg.offsetHeight || Math.min(vh * 0.9, 800)) * currentScale;
    // 至少保留 edge 像素在屏幕内
    const edge = 48;
    const maxX = Math.max(0, (iw / 2) + vw / 2 - edge);
    const maxY = Math.max(0, (ih / 2) + vh / 2 - edge);
    translateX = Math.min(maxX, Math.max(-maxX, translateX));
    translateY = Math.min(maxY, Math.max(-maxY, translateY));
    if (currentScale <= 1) {
        // 未放大时尽量回正，减少越界感
        const soft = 0.35;
        translateX *= soft;
        translateY *= soft;
        if (Math.abs(translateX) < 1) translateX = 0;
        if (Math.abs(translateY) < 1) translateY = 0;
    }
}

function resetImageTransform() {
    currentScale = 1;
    translateX = 0;
    translateY = 0;
    updateTransform();
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
    lockBodyScroll();
}

function closeDetail() {
    if (!detailModal.classList.contains('active')) return;
    detailModal.classList.remove('active');
    detailModal.setAttribute('aria-hidden', 'true');
    detailImage.src = '';
    activeDetailItem = null;
    unlockBodyScroll();
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
    if (!modalImg) return;
    modalImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentScale})`;
}

function openModal(originalUrl) {
    resetImageTransform();
    modalLoading.style.display = 'block';
    modalImg.src = '';
    modalImg.src = originalUrl;
    const wasActive = modal.classList.contains('active');
    modal.classList.add('active');
    if (!wasActive) lockBodyScroll();
}

function closeModal() {
    if (!modal.classList.contains('active')) return;
    modal.classList.remove('active');
    modalImg.src = '';
    resetImageTransform();
    isDragging = false;
    modalPointerMoved = false;
    unlockBodyScroll();
}
