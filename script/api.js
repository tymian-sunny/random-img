// ==================== 数据请求与解析 ====================
async function fetchImages() {
    if (isLoading || isShowingFavorites) return;
    const dataSource = document.getElementById('dataSource').value;
    if (dataSource === 'danbooru' && !danbooruHasMore) return;
    isLoading = true;
    const loadingStatus = document.getElementById('loadingStatus');
    loadingStatus.style.display = 'block';
    loadingStatus.textContent = '正在加载更多图片...';
    try {
        if (dataSource === 'setu') await fetchSetuImages();
        else if (dataSource === 'danbooru') await fetchDanbooruImages();
    } catch (error) {
        console.error('请求失败:', error);
        const errorMessage = `加载失败：${error.message}`;
        loadingStatus.textContent = errorMessage;
        setTimeout(() => {
            if (!isLoading && loadingStatus.textContent === errorMessage) loadingStatus.style.display = 'none';
        }, 4000);
    } finally {
        isLoading = false;
        if (dataSource === 'danbooru' && !danbooruHasMore) {
            loadingStatus.textContent = danbooruEndMessage;
            loadingStatus.style.display = 'block';
        } else if (!loadingStatus.textContent.startsWith('加载失败')) {
            loadingStatus.style.display = 'none';
        }
    }
}

// ==================== Setu API ====================
async function fetchSetuImages() {
    const API_URL = '/setu-proxy/setu/v2';
    const params = new URLSearchParams();
    params.append('size', 'thumb');
    params.append('size', 'original');
    params.append('num', 15);
    params.append('r18', document.getElementById('setu_r18').value);
    if (document.getElementById('setu_excludeAI').checked) params.append('excludeAI', 'true');
    const proxy = document.getElementById('setu_proxy').value.trim();
    if (proxy) params.append('proxy', proxy);
    const keyword = document.getElementById('setu_keyword').value.trim();
    if (keyword) params.append('keyword', keyword);
    const aspectRatio = document.getElementById('setu_aspectRatio').value.trim();
    if (aspectRatio) params.append('aspectRatio', aspectRatio);
    const tagInput = document.getElementById('tagInput').value.trim();
    if (tagInput) tagInput.split(',').forEach(t => { if (t.trim()) params.append('tag', t.trim()); });
    const uidInput = document.getElementById('setu_uid').value.trim();
    if (uidInput) uidInput.split(',').forEach(id => { if (id.trim() && !isNaN(id.trim())) params.append('uid', id.trim()); });
    const response = await fetch(`${API_URL}?${params.toString()}`);
    if (!response.ok) throw new Error(`Setu API HTTP ${response.status}`);
    const result = await response.json();
    if (result.error) { alert('Setu API 返回错误: ' + result.error); return; }
    if (result.data && result.data.length > 0) {
        result.data.forEach(item => {
            const original = item.urls.original;
            const thumb = getCustomSetuThumbUrl(original);
            const rawSetuTags = Array.isArray(item.tags)
                ? item.tags.map(tag => typeof tag === 'string' ? tag : (tag?.name || tag?.tag || '')).filter(Boolean).join(' ')
                : String(item.tags || '');
            const normalized = {
                source: 'setu', id: item.pid || item.id || '',
                title: item.title, displayTitle: item.title,
                author: item.author || '', uid: item.uid || '',
                subInfo: `作者: ${item.author || '未知'} (UID: ${item.uid || '未知'})`,
                width: item.width, height: item.height, tags: rawSetuTags,
                createDate: formatToBeijingTime(item.uploadDate || item.createDate || ''),
                urls: { original, thumb }
            };
            allItems.push(normalized);
            appendItemToDOM(normalized);
        });
        applyZoomOrScale();
    }
}

function getCustomSetuThumbUrl(originalUrl) {
    if (!originalUrl) return '';
    let u = originalUrl.replace('img-original', 'img-master');
    u = u.replace(/\/c\/[^/]+\//, '/');
    u = u.replace(/(_p\d+)(_[^.]+)?\.(png|jpg|jpeg|webp)$/i, '$1_master1200.jpg');
    u = u.replace(/(https?:\/\/[^/]+\/)/, '$1c/540x540_70/');
    return u;
}

// ==================== Danbooru API ====================
function findDanbooruVariant(post, type) {
    const variants = Array.isArray(post.media_asset?.variants) ? post.media_asset.variants : [];
    const variant = variants.find(item => item && item.type === type && item.url);
    return variant ? variant.url : '';
}

function getDanbooruPreviewUrl(post) {
    const size = document.getElementById('danbooru_image_size').value;
    const original = post.file_url || findDanbooruVariant(post, 'original') || post.large_file_url;
    const large = post.large_file_url || findDanbooruVariant(post, 'sample') || findDanbooruVariant(post, '720x720') || original;
    switch (size) {
        case '180': return findDanbooruVariant(post, '180x180') || post.preview_file_url || large || original;
        case '360': return findDanbooruVariant(post, '360x360') || findDanbooruVariant(post, '720x720') || large || original;
        case '720': return findDanbooruVariant(post, '720x720') || large || original;
        case 'large': return post.large_file_url || findDanbooruVariant(post, 'sample') || findDanbooruVariant(post, '720x720') || original;
        case 'original': return original;
        default: return findDanbooruVariant(post, '720x720') || large || original;
    }
}

function toDanbooruProxyUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
        const url = new URL(rawUrl, window.location.origin);
        if (url.hostname === 'cdn.donmai.us') return `/danbooru-proxy/${url.pathname.replace(/^\/+/, '')}${url.search}`;
    } catch (error) { console.warn('无法解析 CDN URL:', rawUrl, error); }
    return rawUrl;
}

function ratingLabel(rating) {
    return ({ g: '安全', s: '敏感', q: '可疑', e: '限制级' })[rating] || rating || '未知';
}

function shuffleDanbooruPosts(posts) {
    for (let i = posts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [posts[i], posts[j]] = [posts[j], posts[i]];
    }
    return posts;
}

async function fetchDanbooruImages() {
    if (!danbooruHasMore) return;

    const API_URL = '/danbooru-api/posts.json';
    const params = new URLSearchParams();
    params.append('page', String(currentPage));
    params.append('limit', String(DANBOORU_PAGE_SIZE));

    let tags = translateSearchTags(document.getElementById('tagInput').value.trim());
    const rating = document.getElementById('danbooru_rating').value;
    if (rating) tags += `${tags ? ' ' : ''}rating:${rating}`;

    tags = tags.replace(/(?:^|\s)order:[^\s]+/ig, ' ')
               .replace(/\s+/g, ' ')
               .trim();

    const randomEnabled = document.getElementById('danbooru_random').checked;
    let useLocalRandom = randomEnabled && (!tags || danbooruRandomFallbackForCurrentQuery);

    if (tags) {
        if (randomEnabled && !danbooruRandomFallbackForCurrentQuery) {
            params.set('tags', `${tags} order:random`);
        } else {
            params.set('tags', tags);
        }
    }

    const login = document.getElementById('danbooru_login').value.trim();
    const apiKey = document.getElementById('danbooru_apikey').value.trim();
    if (login && apiKey) {
        params.append('login', login);
        params.append('api_key', apiKey);
    }

    let response = await fetch(`${API_URL}?${params.toString()}`, {
        headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
        let errorBody = '';
        try { errorBody = await response.text(); } catch (_) {}

        const isQueryTimeout = response.status === 500 &&
            /ActiveRecord::QueryCanceled|database timed out/i.test(errorBody);

        if (isQueryTimeout && randomEnabled && tags && !useLocalRandom) {
            console.warn('Danbooru 官方随机查询超时，移除 order:random 并重试；本轮后续分页使用本地随机。');
            danbooruRandomFallbackForCurrentQuery = true;
            useLocalRandom = true;
            params.set('tags', tags);

            response = await fetch(`${API_URL}?${params.toString()}`, {
                headers: { 'Accept': 'application/json' }
            });
        } else {
            throw new Error(
                `Danbooru API HTTP ${response.status}` +
                (errorBody ? `: ${errorBody.slice(0, 300)}` : '')
            );
        }
    }

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(
            `Danbooru API HTTP ${response.status}` +
            (errorBody ? `: ${errorBody.slice(0, 300)}` : '')
        );
    }

    const posts = await response.json();
    if (!Array.isArray(posts)) {
        throw new Error('Danbooru API 返回的数据格式不正确');
    }

    if (useLocalRandom) shuffleDanbooruPosts(posts);

    if (posts.length === 0) {
        danbooruHasMore = false;
        danbooruEndMessage = '已没有更多符合条件的作品';
        return;
    }

    let newItemsCount = 0;
    for (const post of posts) {
        if (!post || post.id == null || danbooruSeenIds.has(String(post.id))) continue;

        danbooruSeenIds.add(String(post.id));

        const rawOriginal = post.file_url || findDanbooruVariant(post, 'original') || post.large_file_url;
        const rawPreview = getDanbooruPreviewUrl(post);
        if (!rawOriginal || !rawPreview) continue;

        const original = toDanbooruProxyUrl(rawOriginal);
        const thumb = toDanbooruProxyUrl(rawPreview);
        const width = post.image_width || 800;
        const height = post.image_height || 1200;
        const rawTitle = post.tag_string_character || post.tag_string_artist || `Post #${post.id}`;
        const tagsForDisplay = post.tag_string || [
            post.tag_string_character,
            post.tag_string_copyright,
            post.tag_string_artist,
            post.tag_string_general,
            post.tag_string_meta
        ].filter(Boolean).join(' ');

        const normalized = {
            source: 'danbooru', id: post.id,
            title: rawTitle,
            displayTitle: translateReturnedTags(rawTitle),
            subInfo: `ID: ${post.id} | 分级: ${ratingLabel(post.rating)} | 评分: ${post.score ?? 0}`,
            width, height, tags: tagsForDisplay,
            rating: post.rating, score: post.score, favCount: post.fav_count,
            uploader: post.uploader_name || post.uploader_id || '',
            createdAt: formatToBeijingTime(post.created_at || ''), 
            updatedAt: formatToBeijingTime(post.updated_at || ''),
            fileExt: post.file_ext || '', fileSize: post.file_size || '',
            sourceUrl: post.source || '', pixivId: post.pixiv_id || '',
            urls: { original, thumb }
        };

        allItems.push(normalized);
        appendItemToDOM(normalized);
        newItemsCount++;
    }

    currentPage++;

    if (newItemsCount === 0) {
        danbooruNoNewPages++;
        console.warn(`Danbooru 本页没有新作品，连续次数：${danbooruNoNewPages}/${DANBOORU_MAX_NO_NEW_PAGES}`);
    } else {
        danbooruNoNewPages = 0;
    }

    if (posts.length < DANBOORU_PAGE_SIZE) {
        danbooruHasMore = false;
        danbooruEndMessage = `本次匹配结果已加载完（本页返回 ${posts.length} 条）`;
    } else if (danbooruNoNewPages >= DANBOORU_MAX_NO_NEW_PAGES) {
        danbooruHasMore = false;
        danbooruEndMessage = '连续 3 次请求没有发现新作品，已停止自动加载';
        console.info('Danbooru 连续多次没有新作品，已停止自动加载。');
    }

    applyZoomOrScale();
}

function resetAndFetch() {
    if (isShowingFavorites) return;
    saveSettings();
    allItems = [];
    currentPage = 1;
    danbooruSeenIds.clear();
    danbooruNoNewPages = 0;
    danbooruHasMore = true;
    danbooruEndMessage = '已没有更多符合条件的作品';
    danbooruRandomFallbackForCurrentQuery = false;
    setupColumns(true);
    const status = document.getElementById('loadingStatus');
    status.textContent = '正在加载更多图片...';
    status.style.display = 'none';
    fetchImages();
}
