#!/usr/bin/env python3
"""
使用 Gemini API 批量翻译 Danbooru 英文标签。

输入：前端「下载未翻译 JSON」得到的文件（或同结构的 JSON）
  {
    "version": 1,
    "tags": ["tag_a", "tag_b", ...]
  }
也兼容：纯字符串数组 JSON、旧版 TSV（首列 tag）。

输出：默认追加写入 TXT（每行 英文=中文），可选同时写出可合并的词典片段 JSON。
"""

import argparse
import csv
import json
import os
import time
import urllib.request
import urllib.error

# ================= 配置区 =================
API_KEY = os.getenv("GEMINI_API_KEY")

BATCH_SIZE = 100
DELAY_BETWEEN_REQUESTS = 6.0
MODEL_NAME = "gemini-2.5-flash"
# =========================================


def load_tags_from_json(json_path):
    """从未翻译标签 JSON 读取待翻译列表。"""
    tags = []
    if not os.path.exists(json_path):
        print(f"❌ 错误：找不到文件 '{json_path}'")
        return tags

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if isinstance(data, list):
        raw = data
    elif isinstance(data, dict):
        if isinstance(data.get("tags"), list):
            raw = data["tags"]
        elif isinstance(data.get("tags"), dict):
            # 兼容直接传入词典结构：取尚未有 zh 的 key，或全部 key
            raw = []
            for k, v in data["tags"].items():
                if v is None or v == "" or (isinstance(v, dict) and not (v.get("zh") or v.get("cn"))):
                    raw.append(k)
                elif not isinstance(v, (str, dict)):
                    raw.append(k)
            if not raw:
                raw = list(data["tags"].keys())
        else:
            # 可能是 { "tag1": null, ... } 形式
            raw = list(data.keys())
    else:
        print("❌ JSON 格式无法识别，需要是数组或含 tags 字段的对象")
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


def load_tags_from_tsv(tsv_path):
    """兼容旧版：使用标准库 csv 读取 TSV 文件中的 Tag。"""
    tags = []
    if not os.path.exists(tsv_path):
        print(f"❌ 错误：找不到文件 '{tsv_path}'")
        return tags

    with open(tsv_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        for i, row in enumerate(reader):
            if row:
                tag = row[0].strip()
                if i == 0 and tag.lower() == "tag":
                    continue
                if tag:
                    tags.append(tag)
    return tags


def load_tags(path):
    """按扩展名自动选择 JSON 或 TSV 加载。"""
    lower = path.lower()
    if lower.endswith(".json"):
        return load_tags_from_json(path)
    if lower.endswith(".tsv") or lower.endswith(".txt") or lower.endswith(".csv"):
        return load_tags_from_tsv(path)
    # 默认尝试 JSON，失败再试 TSV
    try:
        return load_tags_from_json(path)
    except json.JSONDecodeError:
        return load_tags_from_tsv(path)


def load_already_translated(txt_path):
    """每次调用时实时读取输出的 txt 文件，保证不重复翻译和写入。"""
    translated_set = set()
    if os.path.exists(txt_path):
        with open(txt_path, "r", encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    en = line.split("=", 1)[0].strip()
                    translated_set.add(en)
    return translated_set


def load_existing_dictionary(dict_path):
    """读取已有词典 JSON，用于去重与合并输出。"""
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
        "你是一个动漫与图像 Tag 翻译专家。请将以下 Danbooru 英文 Tag 翻译为中文。\n"
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
        # 去掉可能的 markdown 残留
        if line.startswith("```"):
            continue
        en_part, zh_part = line.split("=", 1)
        en_part = en_part.strip()
        zh_part = zh_part.strip()
        if en_part and zh_part:
            pairs.append((en_part, zh_part))
    return pairs


def main():
    parser = argparse.ArgumentParser(
        description="使用 Gemini API 翻译未翻译标签 JSON（前端导出）或旧版 TSV"
    )
    parser.add_argument(
        "--input", "-i",
        required=True,
        help="输入文件：前端下载的 untranslated_tags_*.json，或旧版 TSV"
    )
    parser.add_argument(
        "--output", "-o",
        default="translated_tags.txt",
        help="追加写入的 TXT 路径（每行 英文=中文），默认 translated_tags.txt"
    )
    parser.add_argument(
        "--dict", "-d",
        default="",
        help="可选：现有词典 JSON 路径，用于跳过已有翻译，并在 --merge-out 时作为合并基底"
    )
    parser.add_argument(
        "--merge-out",
        default="",
        help="可选：写出合并后的完整词典 JSON，管理员可直接替换 data/danbooru_tags_zh.json"
    )
    args = parser.parse_args()

    if not API_KEY or API_KEY == "YOUR_GEMINI_API_KEY_HERE":
        print("请先设置环境变量 GEMINI_API_KEY，或在脚本中填写 API Key！")
        return

    input_path = args.input
    output_txt_path = args.output

    all_tags = load_tags(input_path)
    if not all_tags:
        print("没有读取到任何有效的 Tag，程序退出。")
        return

    already_translated = load_already_translated(output_txt_path)

    # 若提供了词典，也把词典里已有条目视为已翻译
    dict_data = load_existing_dictionary(args.dict) if args.dict else None
    if dict_data:
        for key in dict_data.get("tags", {}):
            already_translated.add(key)
            already_translated.add(key.lower())

    remaining_tags = [tag for tag in all_tags if tag not in already_translated and tag.lower() not in already_translated]

    print(f"📊 总 Tag 数: {len(all_tags)} | 已翻译/已在词典: {len(all_tags) - len(remaining_tags)} | 剩余待翻译: {len(remaining_tags)}")

    if not remaining_tags:
        print("🎉 所有 Tag 均已翻译完成，无需重复处理！")
        if args.merge_out and dict_data is not None:
            # 仍可根据已有 txt 合并一次
            _merge_and_write(dict_data, output_txt_path, args.merge_out)
        return

    total_batches = (len(remaining_tags) + BATCH_SIZE - 1) // BATCH_SIZE
    new_pairs = []

    for i in range(0, len(remaining_tags), BATCH_SIZE):
        batch = remaining_tags[i : i + BATCH_SIZE]
        current_batch_num = i // BATCH_SIZE + 1

        current_already_translated = load_already_translated(output_txt_path)
        if dict_data:
            for key in dict_data.get("tags", {}):
                current_already_translated.add(key)
                current_already_translated.add(key.lower())
        batch = [tag for tag in batch if tag not in current_already_translated and tag.lower() not in current_already_translated]

        if not batch:
            print(f"[{current_batch_num}/{total_batches}] 当前批次所有词条均已存在，跳过...")
            continue

        print(f"[{current_batch_num}/{total_batches}] 正在翻译 {len(batch)} 个词条...")

        results = translate_batch_native(API_KEY, batch)
        pairs = parse_translation_lines(results)

        valid_count = 0
        with open(output_txt_path, "a", encoding="utf-8") as f_out:
            for en_part, zh_part in pairs:
                if en_part in current_already_translated or en_part.lower() in current_already_translated:
                    continue
                f_out.write(f"{en_part}={zh_part}\n")
                current_already_translated.add(en_part)
                current_already_translated.add(en_part.lower())
                new_pairs.append((en_part, zh_part))
                valid_count += 1

        print(f"  └─ 成功保存 {valid_count} 条新记录")

        if current_batch_num < total_batches:
            time.sleep(DELAY_BETWEEN_REQUESTS)

    print(f"✅ 翻译任务全部结束！结果已保存至: {output_txt_path}")

    if args.merge_out:
        base = dict_data if dict_data is not None else load_existing_dictionary(args.dict)
        _merge_and_write(base, output_txt_path, args.merge_out)


def _merge_and_write(base_dict, txt_path, merge_out_path):
    """把 TXT 中的 英文=中文 合并进词典结构并写出 JSON。"""
    tags = dict(base_dict.get("tags") or {})
    if os.path.exists(txt_path):
        with open(txt_path, "r", encoding="utf-8") as f:
            for line in f:
                if "=" not in line:
                    continue
                en, zh = line.split("=", 1)
                en = en.strip()
                zh = zh.strip()
                if not en or not zh:
                    continue
                key = en  # 保持原始大小写风格；Danbooru 多为小写
                existing = tags.get(key) or tags.get(key.lower())
                if isinstance(existing, dict):
                    existing = dict(existing)
                    existing["zh"] = zh
                    tags[key] = existing
                elif isinstance(existing, str):
                    tags[key] = {"zh": zh}
                else:
                    tags[key] = {"zh": zh}

    out = {
        "version": base_dict.get("version", 1),
        "description": base_dict.get("description")
        or "Danbooru 英文标签到简体中文的本地词典。可在网页收集未翻译标签并下载 JSON，经 translation.py 翻译后替换本文件。",
        "tags": tags,
        "aliases": base_dict.get("aliases") or {},
    }
    with open(merge_out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"📦 已写出合并词典: {merge_out_path} （共 {len(tags)} 个标签）")
    print("   管理员可将该文件手动替换为 data/danbooru_tags_zh.json")


if __name__ == "__main__":
    main()
