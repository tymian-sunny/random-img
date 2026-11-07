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
/** 收藏 API 根路径；与 Go 后端 /api/favorites 对应。可用 localStorage 覆盖。 */
const FAVORITES_API_BASE = (typeof localStorage !== 'undefined' && localStorage.getItem('multiSourceImageBrowser_favoritesApi')) || '/api/favorites';
/** 服务端是否可用；启动时探测 */
let favoritesServerAvailable = false;
let authDialogMode = 'login';

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
        void toggleFavoritesPage();
        easterClickTimes = [];
    }
}

function unlockFavoritesUI() {
    const btn = document.getElementById('favPageBtn');
    if (btn) btn.classList.add('show');
    document.querySelectorAll('.card-fav-btn, .modal-fav-btn').forEach(el => el.classList.add('show'));
    setupColumns(true);
}

function favoritesAuthHeaders() {
    return { 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

function saveFavoritesLocal() {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoritesList)); } catch (_) {}
}

function loadFavoritesLocal() {
    try {
        const raw = localStorage.getItem(FAVORITES_KEY);
        if (raw) favoritesList = JSON.parse(raw);
        else favoritesList = [];
    } catch (_) {
        favoritesList = [];
    }
}

/** 从 Go 后端拉取收藏；失败则回退 localStorage。首次服务端为空时自动上传本地数据。 */
async function loadFavorites() {
    loadFavoritesLocal();
    try {
        const res = await fetch(FAVORITES_API_BASE, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
        favoritesServerAvailable = true;

        if (items.length > 0) {
            favoritesList = items;
            saveFavoritesLocal();
        } else if (favoritesList.length > 0) {
            // 服务端空、本地有：迁移上传
            await fetch(FAVORITES_API_BASE, {
                method: 'PUT',
                headers: favoritesAuthHeaders(),
                body: JSON.stringify({ items: favoritesList })
            });
        }
    } catch (err) {
        favoritesServerAvailable = false;
        console.warn('收藏服务不可用，使用浏览器本地存储:', err);
    }
}

async function persistFavoriteAdd(item) {
    if (!favoritesServerAvailable) return;
    try {
        const res = await fetch(FAVORITES_API_BASE, {
            method: 'POST',
            headers: favoritesAuthHeaders(),
            body: JSON.stringify(item)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        console.warn('同步收藏到服务端失败:', err);
        favoritesServerAvailable = false;
    }
}

async function persistFavoriteRemove(item) {
    if (!favoritesServerAvailable) return;
    const source = encodeURIComponent(String(item.source || ''));
    const id = encodeURIComponent(String(item.id ?? ''));
    try {
        const res = await fetch(`${FAVORITES_API_BASE}/${source}/${id}`, {
            method: 'DELETE',
            headers: favoritesAuthHeaders()
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        console.warn('同步取消收藏到服务端失败:', err);
        favoritesServerAvailable = false;
    }
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
        saveFavoritesLocal();
        persistFavoriteAdd(item);
    } else {
        favoritesList.splice(index, 1);
        saveFavoritesLocal();
        persistFavoriteRemove(item);
    }

    if (isShowingFavorites) {
        renderFavoritesPage();
    } else {
        const btn = document.querySelector(`.card-fav-btn[data-key="${key}"]`);
        if (btn) {
            btn.classList.toggle('active', nextState);
            btn.textContent = nextState ? '★ 已收藏' : '☆ 收藏';
        }
    }
    if (typeof activeDetailItem !== 'undefined' && activeDetailItem && getItemUniqueKey(activeDetailItem) === key) {
        updateModalFavBtnStatus();
    }
}

async function toggleFavoritesPage() {
    if (isShowingFavorites) {
        leaveFavoritesPage();
        return;
    }

    try {
        const response = await fetch('/api/auth/status', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json();
        if (status.authenticated) {
            await loadFavorites();
            enterFavoritesPage();
            return;
        }
        openAuthDialog(status.setupRequired ? 'setup' : 'login');
    } catch (error) {
        openAuthDialog('login');
        document.getElementById('authMessage').textContent = '账号服务暂不可用，请检查后端连接。';
    }
}

function enterFavoritesPage() {
    isShowingFavorites = true;
    const btn = document.getElementById('favPageBtn');
    const logoutBtn = document.getElementById('authLogoutBtn');
    const formGrid = document.getElementById('filterFormGrid');
    const fetchBtn = document.getElementById('fetchBtn');
    const title = document.getElementById('panelTitle');

    btn.textContent = '返回主页';
    btn.classList.add('active');
    logoutBtn.hidden = false;
    title.textContent = '我的收藏';
    formGrid.style.display = 'none';
    fetchBtn.style.display = 'none';
    renderFavoritesPage();
}

function leaveFavoritesPage() {
    isShowingFavorites = false;
    const btn = document.getElementById('favPageBtn');
    btn.textContent = '查看收藏页';
    btn.classList.remove('active');
    document.getElementById('authLogoutBtn').hidden = true;
    document.getElementById('panelTitle').textContent = '多源图库 API 浏览器';
    document.getElementById('filterFormGrid').style.display = 'grid';
    document.getElementById('fetchBtn').style.display = 'block';
    resetAndFetch();
}

function openAuthDialog(mode) {
    authDialogMode = mode;
    const setup = mode === 'setup';
    document.getElementById('authTitle').textContent = setup ? '设置收藏账号' : '登录收藏账号';
    document.getElementById('authDescription').textContent = setup
        ? '首次使用请创建账号和密码。密码至少 10 个字符。'
        : '输入账号和密码以查看收藏。';
    document.getElementById('authPassword').autocomplete = setup ? 'new-password' : 'current-password';
    document.getElementById('authSubmitBtn').textContent = setup ? '创建账号并打开收藏' : '登录并打开收藏';
    document.getElementById('authMessage').textContent = '';
    document.getElementById('authDialog').hidden = false;
    document.getElementById('authUsername').focus();
}

function closeAuthDialog() {
    document.getElementById('authDialog').hidden = true;
    document.getElementById('authForm').reset();
}

async function submitAuthForm(event) {
    event.preventDefault();
    const submitButton = document.getElementById('authSubmitBtn');
    const message = document.getElementById('authMessage');
    const credentials = {
        username: document.getElementById('authUsername').value.trim(),
        password: document.getElementById('authPassword').value
    };
    const endpoint = authDialogMode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
    submitButton.disabled = true;
    message.textContent = '';
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: favoritesAuthHeaders(),
            body: JSON.stringify(credentials)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        closeAuthDialog();
        await loadFavorites();
        enterFavoritesPage();
    } catch (error) {
        message.textContent = error.message || '登录失败，请重试。';
    } finally {
        submitButton.disabled = false;
    }
}

async function logoutFavoriteAccount() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {
    } finally {
        favoritesServerAvailable = false;
        leaveFavoritesPage();
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
