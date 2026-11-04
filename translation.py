#!/usr/bin/env python3
"""
使用 Gemini API 批量翻译 Danbooru 英文标签，直接读写 danbooru_tags_zh.json 词典。
包含方案 1：使用临时文件和原子替换（Atomic Write），防止多程序并发修改时文件损坏。
"""

import argparse
import json
import os
import tempfile
import time
import urllib.request
import urllib.error

# ================= 配置区 =================
API_KEY = os.getenv("GEMINI_API_KEY")

BATCH_SIZE = 100
DELAY_BETWEEN_REQUESTS = 6.0
MODEL_NAME = "gemini-2.5-flash"
# =========================================


def load_input_tags(json_path):
    """从输入的未翻译 JSON 中读取待翻译标签列表。"""
    tags = []
    if not os.path.exists(json_path):
        print(f"❌ 错误：找不到输入文件 '{json_path}'")
        return tags

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, list):
        raw = data
    elif isinstance(data, dict):
        if isinstance(data.get("tags"), list):
            raw = data["tags"]
        elif isinstance(data.get("tags"), dict):
            raw = list(data["tags"].keys())
        else:
            raw = list(data.keys())
    else:
        print("❌ 输入 JSON 格式无法识别")
        return tags

    seen = set()
    for item in raw:
        if isinstance(item, dict):
            tag = str(item.get("name") or item.get("tag") or "").strip()
        else:
            tag = str(item).strip()
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        tags.append(tag)
    return tags


def load_dictionary(dict_path):
    """读取现有词典 JSON。"""
    if not dict_path or not os.path.exists(dict_path):
        return {"version": 1, "tags": {}, "aliases": {}}
    with open(dict_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        return {"version": 1, "tags": {}, "aliases": {}}
    return {
        "version": data.get("version", 1),
        "description": data.get("description", ""),
        "tags": data.get("tags") or {},
        "aliases": data.get("aliases") or {},
    }


def translate_batch_native(api_key, batch):
    """使用标准库 urllib 直接向 Gemini REST API 发送 POST 请求。"""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL_NAME}:generateContent?key={api_key}"

    prompt = (
        "你是一个动漫与图像 Tag 翻译专家。请将以下 Danbooru 英文 Tag 翻译为简体中文。\n"
        "【严格要求】：\n"
        "1. 每行输出格式必须严格为：英文=中文\n"
        "2. 不要添加任何解释、序言、Markdown 代码块标记（如 ```txt 或 ```）或序号。\n"
        "3. 保持输入列表的对应顺序和数量。\n\n"
        "需翻译的词条列表：\n" + "\n".join(batch)
    )

    payload = {
        "contents": [{
            "parts": [{"text": prompt}]
        }]
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    max_retries = 3
    retry_delay = 10.0

    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req) as response:
                response_body = response.read().decode("utf-8")
                result_json = json.loads(response_body)

                text_output = result_json["candidates"][0]["content"]["parts"][0]["text"]
                return text_output.strip().split("\n")

        except urllib.error.HTTPError as e:
            error_message = e.read().decode("utf-8")
            if e.code == 429:
                print(f"⚠️ 触发 Rate Limit (429)，等待 {retry_delay} 秒后重试...")
                time.sleep(retry_delay)
                retry_delay *= 2
            else:
                print(f"❌ API HTTP 错误 [{e.code}]: {error_message}")
                break
        except Exception as e:
            print(f"❌ 请求发生未知错误: {e}")
            break

    return []


def parse_translation_lines(results):
    """解析 API 返回的 英文=中文 行。"""
    pairs = []
    for line in results:
        line = line.strip()
        if not line or "=" not in line:
            continue
        if line.startswith("```"):
            continue
        en_part, zh_part = line.split("=", 1)
        en_part = en_part.strip()
        zh_part = zh_part.strip()
        if en_part and zh_part:
            pairs.append((en_part, zh_part))
    return pairs


def save_dictionary_safely(dict_data, dict_path):
    """
    方案1：使用临时文件 + 原子替换（Atomic Write）安全地保存词典。
    防止写入过程中断电、异常或多程序并发写入时导致 JSON 文件损坏。
    """
    dir_name = os.path.dirname(dict_path) or "."
    # 在同目录下创建一个临时文件并写入
    with tempfile.NamedTemporaryFile("w", dir=dir_name, delete=False, encoding="utf-8") as tf:
        json.dump(dict_data, tf, ensure_ascii=False, indent=2)
        tf.write("\n")
        temp_name = tf.name
    
    # 原子替换：操作系统保证这一瞬间要么全换过去，要么保留旧文件
    os.replace(temp_name, dict_path)


def main():
    parser = argparse.ArgumentParser(
        description="使用 Gemini API 翻译标签并采用原子写入安全更新 danbooru_tags_zh.json"
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="输入文件：前端下载的未翻译 JSON"
    )
    parser.add_argument(
        "--dict", "-d",
        default="danbooru_tags_zh.json",
        help="目标词典 JSON 路径（默认：danbooru_tags_zh.json）"
    )
    args = parser.parse_args()

    if not API_KEY or API_KEY == "YOUR_GEMINI_API_KEY_HERE":
        print("请先设置环境变量 GEMINI_API_KEY！")
        return

    input_path = args.input
    dict_path = args.dict

    # 1. 加载待翻译标签
    all_tags = load_input_tags(input_path)
    if not all_tags:
        print("没有读取到任何有效的 Tag，程序退出。")
        return

    # 2. 加载现有词典
    dict_data = load_dictionary(dict_path)
    existing_tags = dict_data.get("tags", {})

    translated_set = set()
    for k in existing_tags.keys():
        translated_set.add(k)
        translated_set.add(k.lower())

    # 3. 过滤掉已经翻译过的标签
    remaining_tags = [
        tag for tag in all_tags 
        if tag not in translated_set and tag.lower() not in translated_set
    ]

    print(f"📊 总 Tag 数: {len(all_tags)} | 词典已存在: {len(all_tags) - len(remaining_tags)} | 剩余待翻译: {len(remaining_tags)}")

    if not remaining_tags:
        print("🎉 所有 Tag 均已在词典中存在，无需翻译！")
        return

    total_batches = (len(remaining_tags) + BATCH_SIZE - 1) // BATCH_SIZE

    # 4. 分批调用 API 并安全写入词典
    for i in range(0, len(remaining_tags), BATCH_SIZE):
        batch = remaining_tags[i : i + BATCH_SIZE]
        current_batch_num = i // BATCH_SIZE + 1

        # 动态重新检查，支持随时中断续传
        current_dict = load_dictionary(dict_path)
        cur_tags_keys = set(current_dict.get("tags", {}).keys())
        cur_tags_keys_lower = {k.lower() for k in cur_tags_keys}

        batch = [t for t in batch if t not in cur_tags_keys and t.lower() not in cur_tags_keys_lower]

        if not batch:
            print(f"[{current_batch_num}/{total_batches}] 当前批次词条均已存在，跳过...")
            continue

        print(f"[{current_batch_num}/{total_batches}] 正在翻译 {len(batch)} 个词条...")

        results = translate_batch_native(API_KEY, batch)
        pairs = parse_translation_lines(results)

        valid_count = 0
        for en_part, zh_part in pairs:
            if en_part not in current_dict["tags"]:
                current_dict["tags"][en_part] = {"zh": zh_part, "category": "general"}
                valid_count += 1

        # 使用方案1的原子写入安全保存
        save_dictionary_safely(current_dict, dict_path)
        print(f"  └─ 成功翻译并安全更新 {valid_count} 条记录到 {dict_path}")

        if current_batch_num < total_batches:
            time.sleep(DELAY_BETWEEN_REQUESTS)

    print(f"✅ 翻译任务全部结束！词典已安全更新并保存至: {dict_path}")


if __name__ == "__main__":
    main()
