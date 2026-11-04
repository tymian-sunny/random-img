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
    if (isLoading || isShowingFavorites) return;
    if (document.getElementById('dataSource').value === 'danbooru' && !danbooruHasMore) return;
    const scrollHeight = document.documentElement.scrollHeight;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const clientHeight = document.documentElement.clientHeight;
    if (scrollTop + clientHeight >= scrollHeight - 1000) fetchImages();
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
    await loadTagDictionary();
    initSettingsPersistence();
    initTagAutocomplete();
    setupColumns(true);
    fetchImages();
});
