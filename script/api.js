// ==================== 数据请求与解析 ====================
async function fetchImages() {
    if (isShowingFavorites) return;

    const dataSource = document.getElementById('dataSource').value;
    const randomEnabled = dataSource === 'danbooru' &&
                          document.getElementById('danbooru_random').checked;

    // 非随机模式：保持原来的 isLoading 互斥
    if (!randomEnabled && isLoading) return;

    // 随机模式：限制同时进行的批次数
    if (randomEnabled) {
        if (danbooruRandomInFlight >= DANBOORU_RANDOM_MAX_INFLIGHT) return;
        if (!danbooruHasMore) return;
    } else {
        if (dataSource === 'danbooru' && !danbooruHasMore) return;
        isLoading = true;
    }

    const loadingStatus = document.getElementById('loadingStatus');
    loadingStatus.style.display = 'block';
    loadingStatus.textContent = '正在加载更多图片...';

    try {
        if (dataSource === 'setu') {
            await fetchSetuImages();
        } else if (dataSource === 'danbooru') {
            await fetchDanbooruImages();
        }
    } catch (error) {
        console.error('请求失败:', error);
        const errorMessage = `加载失败：${error.message}`;
        loadingStatus.textContent = errorMessage;
        setTimeout(() => {
            if (loadingStatus.textContent === errorMessage) {
                loadingStatus.style.display = 'none';
            }
        }, 4000);
    } finally {
        if (!randomEnabled) {
            isLoading = false;
        }

        if (dataSource === 'danbooru' && !danbooruHasMore) {
            loadingStatus.textContent = danbooruEndMessage;
            loadingStatus.style.display = 'block';
        } else if (!loadingStatus.textContent.startsWith('加载失败')) {
            // 随机模式下如果还有在飞请求，可以继续显示 loading
            if (!(randomEnabled && danbooruRandomInFlight > 0)) {
                loadingStatus.style.display = 'none';
            }
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

    const login = document.getElementById('danbooru_login').value.trim();
    const apiKey = document.getElementById('danbooru_apikey').value.trim();
    const hasAuth = !!(login && apiKey);
    const randomEnabled = document.getElementById('danbooru_random').checked;

    let tags = translateSearchTags(document.getElementById('tagInput').value.trim());
    const rating = document.getElementById('danbooru_rating').value;
    if (rating) tags += `${tags ? ' ' : ''}rating:${rating}`;
    tags = tags.replace(/(?:^|\s)order:[^\s]+/ig, ' ')
               .replace(/\s+/g, ' ')
               .trim();

    // 随机模式：进入一批就 +1
    if (randomEnabled) {
        danbooruRandomInFlight++;
    }

    let posts = [];

    try {
        if (randomEnabled && hasAuth) {
            // ========== 方案 A：有 key，用 /posts/random ==========
            const CONCURRENCY = 6;
            const TOTAL = DANBOORU_PAGE_SIZE;

            const baseParams = new URLSearchParams();
            if (tags) baseParams.set('tags', tags);
            baseParams.set('login', login);
            baseParams.set('api_key', apiKey);

            const fetchOneRandom = () =>
                fetch(`/danbooru-api/posts/random.json?${baseParams.toString()}`, {
                    headers: { 'Accept': 'application/json' }
                }).then(async (r) => {
                    if (!r.ok) return null;
                    return r.json();
                }).catch(() => null);

            for (let i = 0; i < TOTAL; i += CONCURRENCY) {
                const batchSize = Math.min(CONCURRENCY, TOTAL - i);
                const batch = await Promise.all(
                    Array.from({ length: batchSize }, fetchOneRandom)
                );
                posts.push(...batch.filter(p => p && p.id != null));
            }

        } else {
            // ========== 方案 B 或 普通模式 ==========
            const params = new URLSearchParams();
            params.append('limit', String(DANBOORU_PAGE_SIZE));

            if (randomEnabled) {
                const maxRandomPage = 300;
                const randomPage = Math.floor(Math.random() * maxRandomPage) + 1;
                params.append('page', String(randomPage));
            } else {
                params.append('page', String(currentPage));
            }

            if (tags) params.set('tags', tags);
            if (hasAuth) {
                params.append('login', login);
                params.append('api_key', apiKey);
            }

            const response = await fetch(`/danbooru-api/posts.json?${params.toString()}`, {
                headers: { 'Accept': 'application/json' }
            });

            if (!response.ok) {
                let errorBody = '';
                try { errorBody = await response.text(); } catch (_) {}
                throw new Error(
                    `Danbooru API HTTP ${response.status}` +
                    (errorBody ? `: ${errorBody.slice(0, 300)}` : '')
                );
            }

            posts = await response.json();
            if (!Array.isArray(posts)) {
                throw new Error('Danbooru API 返回的数据格式不正确');
            }

            if (randomEnabled) {
                shuffleDanbooruPosts(posts);
            }
        }

        // ========== 处理返回的 posts（和原来一样） ==========
        if (posts.length === 0) {
            if (!randomEnabled) {
                danbooruHasMore = false;
                danbooruEndMessage = '已经没有更多符合条件的作品';
            }
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
                source: 'danbooru',
                id: post.id,
                title: rawTitle,
                displayTitle: translateReturnedTags(rawTitle),
                subInfo: `ID: ${post.id} | 分级: ${ratingLabel(post.rating)} | 评分: ${post.score ?? 0}`,
                width, height,
                tags: tagsForDisplay,
                rating: post.rating,
                score: post.score,
                favCount: post.fav_count,
                uploader: post.uploader_name || post.uploader_id || '',
                createdAt: formatToBeijingTime(post.created_at || ''),
                updatedAt: formatToBeijingTime(post.updated_at || ''),
                fileExt: post.file_ext || '',
                fileSize: post.file_size || '',
                sourceUrl: post.source || '',
                pixivId: post.pixiv_id || '',
                urls: { original, thumb }
            };

            allItems.push(normalized);
            appendItemToDOM(normalized);
            newItemsCount++;
        }

        if (!randomEnabled) {
            currentPage++;
        }

        if (newItemsCount === 0) {
            danbooruNoNewPages++;
        } else {
            danbooruNoNewPages = 0;
        }

        if (!randomEnabled) {
            if (posts.length < DANBOORU_PAGE_SIZE) {
                danbooruHasMore = false;
                danbooruEndMessage = `本次匹配结果已加载完（本页返回 ${posts.length} 条）`;
            } else if (danbooruNoNewPages >= DANBOORU_MAX_NO_NEW_PAGES) {
                danbooruHasMore = false;
                danbooruEndMessage = '连续 3 次请求没有发现新作品，已停止自动加载';
            }
        } else {
            // 随机模式：连续多次完全没抽到新图再停
            if (danbooruNoNewPages >= DANBOORU_MAX_NO_NEW_PAGES) {
                danbooruHasMore = false;
                danbooruEndMessage = '连续多次随机请求没有发现新作品，已停止自动加载';
            }
        }

        applyZoomOrScale();

    } finally {
        // 随机模式：无论成功失败，批次结束都要 -1
        if (randomEnabled) {
            danbooruRandomInFlight = Math.max(0, danbooruRandomInFlight - 1);
        }
    }
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
