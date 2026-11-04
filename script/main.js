// ==================== 主入口与全局监听 ====================
let resizeTimer;

window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => setupColumns(false), 150);
});

window.addEventListener('mousemove', event => {
    if (!isDragging) return;
    event.preventDefault();
    translateX = event.clientX - startX;
    translateY = event.clientY - startY;
    updateTransform();
});

window.addEventListener('mouseup', () => { if (isDragging) isDragging = false; });

window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (modal && modal.classList.contains('active')) closeModal();
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
    loadFavorites();
    loadUntranslatedTagsFromStorage();
    await loadTagDictionary();
    initSettingsPersistence();
    initTagAutocomplete();
    initUntranslatedTagsUI();
    setupColumns(true);
    fetchImages();
});
