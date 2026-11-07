// ==================== 主入口与全局监听 ====================
let resizeTimer;

window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => setupColumns(false), 150);
});

window.addEventListener('mousemove', event => {
    if (!isDragging || !modal || !modal.classList.contains('active')) return;
    event.preventDefault();
    const nx = event.clientX - startX;
    const ny = event.clientY - startY;
    if (Math.abs(nx - translateX) > 3 || Math.abs(ny - translateY) > 3) {
        modalPointerMoved = true;
    }
    translateX = nx;
    translateY = ny;
    if (typeof clampImageTransform === 'function') clampImageTransform();
    updateTransform();
});

window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    if (typeof clampImageTransform === 'function') {
        clampImageTransform();
        updateTransform();
    }
});

window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const authDialog = document.getElementById('authDialog');
    if (authDialog && !authDialog.hidden) closeAuthDialog();
    else if (modal && modal.classList.contains('active')) closeModal();
    else if (detailModal && detailModal.classList.contains('active')) closeDetail();
});

window.addEventListener('scroll', () => {
    if (isShowingFavorites) return;

    const dataSource = document.getElementById('dataSource').value;
    const randomEnabled = dataSource === 'danbooru' &&
                          document.getElementById('danbooru_random').checked;

    // 随机模式用 in-flight 限制，非随机用 isLoading
    if (randomEnabled) {
        if (danbooruRandomInFlight >= DANBOORU_RANDOM_MAX_INFLIGHT) return;
        if (!danbooruHasMore) return;
    } else {
        if (isLoading) return;
        if (dataSource === 'danbooru' && !danbooruHasMore) return;
    }

    const scrollHeight = document.documentElement.scrollHeight;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const clientHeight = document.documentElement.clientHeight;

    // 提前约 1.8 屏开始加载
    const threshold = clientHeight * 1.8;

    if (scrollTop + clientHeight >= scrollHeight - threshold) {
        fetchImages();
    }
}, { passive: true });

window.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('authForm').addEventListener('submit', submitAuthForm);
    document.getElementById('authDialog').addEventListener('click', event => {
        if (event.target.id === 'authDialog') closeAuthDialog();
    });

    backToTopButton = document.getElementById('backToTop');
    if (backToTopButton) {
        window.addEventListener('scroll', () => {
            backToTopButton.classList.toggle('show', window.scrollY > 300);
        }, { passive: true });
        backToTopButton.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    initModalElements();
    loadSettings();
    checkEasterUnlocked();
    await loadFavorites();
    loadUntranslatedTagsFromStorage();
    await loadTagDictionary();
    initSettingsPersistence();
    initTagAutocomplete();
    initUntranslatedTagsUI();
    updateDanbooruRandomStrategyUI();
    setupColumns(true);
    fetchImages();
});
