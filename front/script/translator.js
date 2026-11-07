// ==================== Danbooru 中英标签词典与联想 ====================
const DICTIONARY_URL = '/data/danbooru_tags_zh.json';
const UNTRANSLATED_TAGS_KEY = 'multiSourceImageBrowser_untranslatedTags_v1';
let tagDictionary = { version: 1, tags: {}, aliases: {} };
/** @type {Set<string>} 运行期间遇到的、词典中尚无中文的英文标签 */
const untranslatedTags = new Set();

function normalizeTag(value) { return String(value || '').trim().toLowerCase(); }

function isMetaOrSpecialToken(token) {
    return /^(rating|score|order|id|parent|pool|user|fav|source|width|height|mpixels|filesize|date|age|status|tagcount|pixiv_id):/i.test(token)
        || /^[~-]/.test(token) && token.length <= 1;
}

function loadUntranslatedTagsFromStorage() {
    try {
        const raw = localStorage.getItem(UNTRANSLATED_TAGS_KEY);
        if (!raw) return;
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
            list.forEach(tag => {
                const n = normalizeTag(tag);
                if (n) untranslatedTags.add(n);
            });
        }
    } catch (_) {}
}

function persistUntranslatedTags() {
    try {
        localStorage.setItem(UNTRANSLATED_TAGS_KEY, JSON.stringify([...untranslatedTags].sort()));
    } catch (_) {}
    updateUntranslatedCountUI();
}

/**
 * 记录一个词典中不存在翻译的英文标签。
 * 仅记录看起来像真实 Danbooru tag 的字符串。
 */
function recordUntranslatedTag(tag) {
    const n = normalizeTag(tag);
    if (!n || n.length < 2) return;
    if (isMetaOrSpecialToken(n)) return;
    // 已有翻译则不记录
    if (tagDictionary.tags[n]) {
        // 若此前误记，移除
        if (untranslatedTags.delete(n)) persistUntranslatedTags();
        return;
    }
    if (!untranslatedTags.has(n)) {
        untranslatedTags.add(n);
        persistUntranslatedTags();
    }
}

function getUntranslatedTagsList() {
    return [...untranslatedTags].sort();
}

function clearUntranslatedTags() {
    untranslatedTags.clear();
    persistUntranslatedTags();
}

/**
 * 下载未翻译标签 JSON，供 translation.py 直接读取。
 * 格式：{ "version": 1, "generated_at": "...", "tags": ["tag1", "tag2", ...] }
 */
function downloadUntranslatedTagsJson() {
    const tags = getUntranslatedTagsList();
    const payload = {
        version: 1,
        description: '前端收集到的尚未翻译的 Danbooru 英文标签，可直接作为 translation.py 的输入。',
        generated_at: new Date().toISOString(),
        count: tags.length,
        tags
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `untranslated_tags_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function updateUntranslatedCountUI() {
    const el = document.getElementById('untranslatedCount');
    if (el) el.textContent = String(untranslatedTags.size);
    const btn = document.getElementById('downloadUntranslatedBtn');
    if (btn) btn.disabled = untranslatedTags.size === 0;
}

async function loadTagDictionary() {
    try {
        const response = await fetch(`${DICTIONARY_URL}?v=1`, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const base = await response.json();
        tagDictionary = {
            version: base.version || 1,
            tags: base.tags || {},
            aliases: base.aliases || {}
        };
        // 词典更新后，清理已翻译成功的词
        let changed = false;
        for (const tag of [...untranslatedTags]) {
            if (tagDictionary.tags[tag]) {
                untranslatedTags.delete(tag);
                changed = true;
            }
        }
        if (changed) persistUntranslatedTags();
        else updateUntranslatedCountUI();
    } catch (error) {
        console.warn('读取服务器标签词典失败:', error);
    }
}

function getTagTranslation(tag) {
    const n = normalizeTag(tag);
    const entry = tagDictionary.tags[n];
    if (!entry) {
        if (n) recordUntranslatedTag(n);
        return '';
    }
    if (typeof entry === 'string') return entry;
    return String(entry.zh || entry.cn || '').trim();
}

function translateSearchTags(input) {
    const reverseMap = new Map();
    Object.entries(tagDictionary.tags).forEach(([english, entry]) => {
        const chinese = typeof entry === 'string' ? entry : (entry.zh || entry.cn || '');
        if (chinese) reverseMap.set(String(chinese).trim().toLowerCase(), english);
    });
    const aliasMap = new Map();
    Object.entries(tagDictionary.aliases || {}).forEach(([alias, target]) => aliasMap.set(String(alias).trim().toLowerCase(), String(target).trim()));
    return String(input || '').trim().split(/\s+/).filter(Boolean).map(token => {
        if (/^(rating|score|order|id|parent|pool|user|fav|source|width|height|mpixels|filesize|date|age|status|tagcount|pixiv_id):/i.test(token)) return token;
        const modifier = /^[~-]/.test(token) ? token[0] : '';
        const body = modifier ? token.slice(1) : token;
        const normalized = body.toLowerCase();
        const translated = aliasMap.get(normalized) || reverseMap.get(normalized);
        return translated ? `${modifier}${translated}` : token;
    }).join(' ');
}

function translateReturnedTags(tagString) {
    return String(tagString || '').split(/\s+/).filter(Boolean).map(tag => {
        const zh = getTagTranslation(tag);
        return zh || tag;
    }).join(' ');
}

const DANBOORU_TAGS_API = '/danbooru-api/tags.json';
let tagSuggestionTimer = null;
let tagSuggestionAbortController = null;
let tagSuggestionRequestId = 0;
let lastTagApiRequestAt = 0;
const tagSuggestionCache = new Map();
let currentTagSuggestions = [];
let activeTagSuggestionIndex = -1;
let isTagInputComposing = false;

function getTagInputContext(input) {
    const value = input.value || '';
    const cursor = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
    let start = cursor, end = cursor;
    while (start > 0 && !/\s/.test(value[start - 1])) start--;
    while (end < value.length && !/\s/.test(value[end])) end++;
    const rawBeforeCursor = value.slice(start, cursor);
    let prefix = '', query = rawBeforeCursor;
    if (/^[~-]/.test(query)) { prefix = query[0]; query = query.slice(1); }
    return { value, cursor, start, end, prefix, query, rawBeforeCursor };
}

function tagCategoryLabel(category) {
    const numeric = { 0: '一般', 1: '画师', 3: '作品', 4: '角色', 5: '元标签' };
    const names = { general: '一般', artist: '画师', copyright: '作品', character: '角色', meta: '元标签' };
    return numeric[category] || names[String(category || '').toLowerCase()] || '';
}

function localTagSuggestionMatches(query) {
    const q = normalizeTag(query);
    if (!q) return [];
    const matches = new Map();
    const add = (english, entry, aliasText = '') => {
        const name = normalizeTag(english);
        if (!name) return;
        const chinese = getTagTranslation(name);
        const fields = [name, chinese, ...(aliasText ? [String(aliasText)] : [])].map(value => String(value || '').toLowerCase());
        if (!fields.some(value => value.includes(q))) return;
        const starts = fields.some(value => value.startsWith(q));
        const category = entry && typeof entry === 'object' ? entry.category : '';
        const postCount = Number(entry && typeof entry === 'object' ? (entry.post_count || entry.count || 0) : 0);
        const candidate = { name, zh: chinese, category: tagCategoryLabel(category), postCount: Number.isFinite(postCount) ? postCount : 0, rank: starts ? 0 : 1, source: 'local' };
        const previous = matches.get(name);
        if (!previous || candidate.rank < previous.rank || candidate.postCount > previous.postCount) matches.set(name, candidate);
    };
    Object.entries(tagDictionary.tags || {}).forEach(([english, entry]) => add(english, entry));
    Object.entries(tagDictionary.aliases || {}).forEach(([alias, target]) => add(target, tagDictionary.tags[normalizeTag(target)], alias));
    return [...matches.values()].sort((a, b) => a.rank - b.rank || b.postCount - a.postCount || a.name.localeCompare(b.name));
}

function mergeTagSuggestions(localItems, remoteItems) {
    const merged = new Map();
    [...localItems, ...remoteItems].forEach(item => {
        const name = normalizeTag(item.name);
        if (!name) return;
        const previous = merged.get(name);
        const chinese = getTagTranslation(name);
        const next = {
            ...item, name, zh: chinese || item.zh || '',
            postCount: Math.max(Number(item.postCount || 0), Number(previous?.postCount || 0)),
            rank: Math.min(Number(item.rank ?? 2), Number(previous?.rank ?? 2))
        };
        if (!previous || next.postCount >= previous.postCount || next.zh) merged.set(name, next);
    });
    return [...merged.values()].sort((a, b) => a.rank - b.rank || b.postCount - a.postCount || a.name.localeCompare(b.name)).slice(0, 12);
}

function renderTagSuggestions(items, hint = '') {
    const input = document.getElementById('tagInput');
    const panel = document.getElementById('tagSuggestions');
    if (!input || !panel) return;
    currentTagSuggestions = items.slice(0, 12);
    activeTagSuggestionIndex = -1;
    panel.replaceChildren();
    if (!currentTagSuggestions.length) {
        if (hint) {
            const message = document.createElement('div');
            message.className = 'tag-suggestion-hint'; message.textContent = hint;
            panel.appendChild(message); panel.hidden = false; input.setAttribute('aria-expanded', 'true');
        } else hideTagSuggestions();
        return;
    }
    currentTagSuggestions.forEach((item, index) => {
        const option = document.createElement('div');
        option.className = 'tag-suggestion-item'; option.id = `tag-suggestion-${index}`;
        option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
        option.addEventListener('pointerdown', event => { event.preventDefault(); selectTagSuggestion(index); });
        const main = document.createElement('div'); main.className = 'tag-suggestion-main';
        const title = document.createElement('span'); title.className = 'tag-suggestion-title'; title.textContent = item.zh || item.name;
        const meta = document.createElement('span'); meta.className = 'tag-suggestion-meta';
        const details = [];
        if (item.category) details.push(item.category);
        if (item.postCount > 0) details.push(`${item.postCount.toLocaleString()} posts`);
        if (!item.zh) details.push('未翻译');
        meta.textContent = details.join(' · '); main.append(title, meta);
        const english = document.createElement('div'); english.className = 'tag-suggestion-en'; english.textContent = item.name;
        option.append(main, english); panel.appendChild(option);
    });
    panel.hidden = false; input.setAttribute('aria-expanded', 'true');
}

function hideTagSuggestions() {
    if (tagSuggestionTimer) { clearTimeout(tagSuggestionTimer); tagSuggestionTimer = null; }
    if (tagSuggestionAbortController) { tagSuggestionAbortController.abort(); tagSuggestionAbortController = null; }
    tagSuggestionRequestId++;
    const input = document.getElementById('tagInput');
    const panel = document.getElementById('tagSuggestions');
    if (panel) panel.hidden = true;
    if (input) { input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
    currentTagSuggestions = []; activeTagSuggestionIndex = -1;
}

function updateActiveTagSuggestion() {
    const panel = document.getElementById('tagSuggestions');
    if (!panel) return;
    [...panel.querySelectorAll('.tag-suggestion-item')].forEach((element, index) => {
        const active = index === activeTagSuggestionIndex;
        element.classList.toggle('active', active); element.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const input = document.getElementById('tagInput');
    if (input) {
        if (activeTagSuggestionIndex >= 0) input.setAttribute('aria-activedescendant', `tag-suggestion-${activeTagSuggestionIndex}`);
        else input.removeAttribute('aria-activedescendant');
    }
    const activeElement = panel.querySelector('.tag-suggestion-item.active');
    if (activeElement) activeElement.scrollIntoView({ block: 'nearest' });
}

function selectTagSuggestion(index) {
    const input = document.getElementById('tagInput');
    const item = currentTagSuggestions[index];
    if (!input || !item) return;
    const context = getTagInputContext(input);
    const selectedTag = `${context.prefix}${item.name}`;
    const before = context.value.slice(0, context.start);
    const after = context.value.slice(context.end);
    const needsSpace = after.length === 0 || !/^\s/.test(after);
    const insertion = selectedTag + (needsSpace ? ' ' : '');
    input.value = before + insertion + after;
    const caret = (before + insertion).length;
    input.focus(); input.setSelectionRange(caret, caret);
    saveSettings(); hideTagSuggestions();
}

async function fetchRemoteTagSuggestions(query, requestId, localItems) {
    // ... 保持原有远程联想逻辑不变（此处省略未改部分，你本地文件已是完整版）
}

function scheduleTagSuggestions() {
    // ... 保持原有逻辑
}

function initTagAutocomplete() {
    const input = document.getElementById('tagInput');
    if (!input) return;
    input.addEventListener('input', () => { saveSettings(); scheduleTagSuggestions(); });
    input.addEventListener('focus', () => { if (input.value) scheduleTagSuggestions(); });
    input.addEventListener('keydown', event => {
        const panel = document.getElementById('tagSuggestions');
        if (event.key === 'ArrowDown' && !panel.hidden) {
            event.preventDefault();
            if (currentTagSuggestions.length) { activeTagSuggestionIndex = (activeTagSuggestionIndex + 1) % currentTagSuggestions.length; updateActiveTagSuggestion(); }
        } else if (event.key === 'ArrowUp' && !panel.hidden) {
            event.preventDefault();
            if (currentTagSuggestions.length) { activeTagSuggestionIndex = activeTagSuggestionIndex <= 0 ? currentTagSuggestions.length - 1 : activeTagSuggestionIndex - 1; updateActiveTagSuggestion(); }
        } else if (event.key === 'Enter' && !panel.hidden && currentTagSuggestions.length) {
            event.preventDefault(); selectTagSuggestion(activeTagSuggestionIndex >= 0 ? activeTagSuggestionIndex : 0);
        } else if (event.key === 'Enter') {
            event.preventDefault(); hideTagSuggestions(); resetAndFetch();
        } else if (event.key === 'Escape') hideTagSuggestions();
    });
    input.addEventListener('compositionstart', () => { isTagInputComposing = true; });
    input.addEventListener('compositionend', () => { isTagInputComposing = false; scheduleTagSuggestions(); });
    input.addEventListener('blur', () => { setTimeout(() => hideTagSuggestions(), 120); });
    document.addEventListener('pointerdown', event => {
        const group = input.closest('.tag-autocomplete-group');
        if (group && !group.contains(event.target)) hideTagSuggestions();
    });
}

/** 初始化未翻译标签收集与管理按钮 */
function initUntranslatedTagsUI() {
    loadUntranslatedTagsFromStorage();
    updateUntranslatedCountUI();

    const downloadBtn = document.getElementById('downloadUntranslatedBtn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            if (untranslatedTags.size === 0) {
                alert('当前没有收集到未翻译标签。浏览含有新标签的作品后会自动记录。');
                return;
            }
            downloadUntranslatedTagsJson();
        });
    }
    const clearBtn = document.getElementById('clearUntranslatedBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (untranslatedTags.size === 0) return;
            if (confirm(`确定清空已收集的 ${untranslatedTags.size} 个未翻译标签？`)) {
                clearUntranslatedTags();
            }
        });
    }
}
