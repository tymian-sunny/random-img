// ==================== 页面状态与常量 ====================
let isLoading = false;
let allItems = [];
let columns = [];
let columnHeights = [];
let currentColumnCount = 0;
let currentGalleryWidth = 0;
let currentPage = 1;
let isShowingFavorites = false;

// Danbooru 随机分页状态
let danbooruSeenIds = new Set();
let danbooruNoNewPages = 0;
let danbooruHasMore = true;
const DANBOORU_MAX_NO_NEW_PAGES = 3;
const DANBOORU_PAGE_SIZE = 10;
let danbooruEndMessage = '已没有更多符合条件的作品';
let danbooruRandomFallbackForCurrentQuery = false;
// 当前正在进行的随机批次数量
let danbooruRandomInFlight = 0;
// 最多同时跑几批（建议 2）
const DANBOORU_RANDOM_MAX_INFLIGHT = 4;

const BASE_COL_WIDTH = 240;
const GAP = 15;
const MOBILE_GAP = 8;
const MOBILE_BREAKPOINT = 600;
const MOBILE_MIN_CARD_WIDTH = 120;
const MAX_COLS = 5;
const BODY_PADDING = 40;

// ==================== 用户配置持久化 ====================
const SETTINGS_KEY = 'multiSourceImageBrowser_settings_v1';
const FAVORITES_KEY = 'multiSourceImageBrowser_favorites_v1';
const EASTER_UNLOCKED_KEY = 'multiSourceImageBrowser_easterUnlocked_v1';

let backToTopButton;

// ==================== 辅助函数：东八区时间格式化 ====================
function formatToBeijingTime(dateInput) {
    if (!dateInput) return '';
    try {
        const date = new Date(dateInput);
        if (isNaN(date.getTime())) return String(dateInput);
        
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).format(date);
    } catch (_) {
        return String(dateInput);
    }
}

// ==================== 隐藏彩蛋与收藏功能状态 ====================
let easterClickTimes = [];
let isEasterUnlocked = false;
let favoritesList = [];

function checkEasterUnlocked() {
    try {
        isEasterUnlocked = localStorage.getItem(EASTER_UNLOCKED_KEY) === 'true';
    } catch (_) {}
    if (isEasterUnlocked) unlockFavoritesUI();
}

function handleEasterClick() {
    const now = Date.now();
    easterClickTimes.push(now);
    easterClickTimes = easterClickTimes.filter(t => now - t <= 3000);
    if (easterClickTimes.length >= 6) {
        isEasterUnlocked = true;
        try { localStorage.setItem(EASTER_UNLOCKED_KEY, 'true'); } catch (_) {}
        unlockFavoritesUI();
        alert('🎉 隐藏功能已解锁：开启收藏图库功能！');
        easterClickTimes = [];
    }
}

function unlockFavoritesUI() {
    const btn = document.getElementById('favPageBtn');
    if (btn) btn.classList.add('show');
    document.querySelectorAll('.card-fav-btn, .modal-fav-btn').forEach(el => el.classList.add('show'));
    setupColumns(true);
}

function loadFavorites() {
    try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        if (raw) favoritesList = JSON.parse(raw);
    } catch (_) {}
}

function saveFavorites() {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoritesList)); } catch (_) {}
}

function getItemUniqueKey(item) {
    return `${item.source}_${item.id}`;
}

function isFavorite(item) {
    if (!item) return false;
    const key = getItemUniqueKey(item);
    return favoritesList.some(fav => getItemUniqueKey(fav) === key);
}

function toggleFavorite(item, event) {
    if (event) event.stopPropagation();
    if (!item) return;
    const key = getItemUniqueKey(item);
    const index = favoritesList.findIndex(fav => getItemUniqueKey(fav) === key);
    const nextState = index < 0;
    
    if (nextState) {
        favoritesList.push(item);
    } else {
        favoritesList.splice(index, 1);
    }
    saveFavorites();
    
    if (isShowingFavorites) {
        renderFavoritesPage();
    } else {
        const btn = document.querySelector(`.card-fav-btn[data-key="${key}"]`);
        if (btn) {
            btn.classList.toggle('active', nextState);
            btn.textContent = nextState ? '★ 已收藏' : '☆ 收藏';
        }
    }
    if (activeDetailItem && getItemUniqueKey(activeDetailItem) === key) {
        updateModalFavBtnStatus();
    }
}

function toggleFavoritesPage() {
    isShowingFavorites = !isShowingFavorites;
    const btn = document.getElementById('favPageBtn');
    const formGrid = document.getElementById('filterFormGrid');
    const fetchBtn = document.getElementById('fetchBtn');
    const title = document.getElementById('panelTitle');

    if (isShowingFavorites) {
        btn.textContent = '返回主页';
        btn.classList.add('active');
        title.textContent = '我的收藏';
        formGrid.style.display = 'none';
        fetchBtn.style.display = 'none';
        renderFavoritesPage();
    } else {
        btn.textContent = '查看收藏页';
        btn.classList.remove('active');
        title.textContent = '多源图库 API 浏览器';
        formGrid.style.display = 'grid';
        fetchBtn.style.display = 'block';
        resetAndFetch();
    }
}

function renderFavoritesPage() {
    allItems = [...favoritesList];
    setupColumns(true);
    const loadingStatus = document.getElementById('loadingStatus');
    if (allItems.length === 0) {
        loadingStatus.textContent = '暂无收藏的作品';
        loadingStatus.style.display = 'block';
    } else {
        loadingStatus.style.display = 'none';
    }
}

function saveSettings() {
    const settings = {};
    document.querySelectorAll('input[id], select[id]').forEach(element => {
        settings[element.id] = element.type === 'checkbox' ? element.checked : element.value;
    });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
    catch (error) { console.error('保存用户配置失败:', error); }
}

function loadSettings() {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            const settings = JSON.parse(saved);
            document.querySelectorAll('input[id], select[id]').forEach(element => {
                if (!Object.prototype.hasOwnProperty.call(settings, element.id)) return;
                if (element.type === 'checkbox') element.checked = Boolean(settings[element.id]);
                else element.value = settings[element.id];
            });
        }
    } catch (error) { console.error('恢复用户配置失败:', error); }
    document.body.setAttribute('data-source', document.getElementById('dataSource').value);
}

function initSettingsPersistence() {
    document.querySelectorAll('input[id], select[id]').forEach(element => {
        element.addEventListener('input', saveSettings);
        element.addEventListener('change', saveSettings);
    });
}

function switchDataSource() {
    saveSettings();
    document.body.setAttribute('data-source', document.getElementById('dataSource').value);
    
    const tagInput = document.getElementById('tagInput');
    if (tagInput) tagInput.value = '';
    hideTagSuggestions();
    if (typeof updateDanbooruRandomStrategyUI === 'function') {
        updateDanbooruRandomStrategyUI();
    }

    if (isShowingFavorites) {
        toggleFavoritesPage();
    } else {
        resetAndFetch();
    }
}
