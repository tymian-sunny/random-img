import argparse
import csv
import json
import os
import time
import urllib.request
import urllib.error

# ================= 配置区 =================
# 设置你的 Gemini API Key (也可通过系统环境变量 GEMINI_API_KEY 配置)
API_KEY = os.getenv("GEMINI_API_KEY")

# 批处理配置
BATCH_SIZE = 100              # 一次请求发送的词条数
DELAY_BETWEEN_REQUESTS = 6.0  # 请求间隔秒数 (控制请求频率，避免超出限制)
MODEL_NAME = "gemini-2.5-flash" # 模型名称
# =========================================


def load_tags(tsv_path):
    """使用标准库 csv 读取 TSV 文件中的 Tag (兼容带表头或不带表头的情况)"""
    tags = []
    if not os.path.exists(tsv_path):
        print(f"❌ 错误：找不到文件 '{tsv_path}'")
        return tags
    
    with open(tsv_path, "r", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        for i, row in enumerate(reader):
            if row:
                tag = row[0].strip()
                # 如果第一行是表头 'tag'，则跳过
                if i == 0 and tag.lower() == "tag":
                    continue
                if tag:
                    tags.append(tag)
    return tags


def load_already_translated(txt_path):
    """每次调用时实时读取输出的 txt 文件，保证不重复翻译和写入"""
    translated_set = set()
    if os.path.exists(txt_path):
        with open(txt_path, "r", encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    en = line.split("=", 1)[0].strip()
                    translated_set.add(en)
    return translated_set


def translate_batch_native(api_key, batch):
    """使用标准库 urllib 直接向 Gemini REST API 发送 POST 请求"""
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
            if e.code == 429:  # 触发频率限制
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


def main():
    # 解析命令行参数 --input 和 --output
    parser = argparse.ArgumentParser(description="使用 Gemini API 翻译 TSV 标签文件")
    parser.add_argument("--input", required=True, help="输入的 TSV 文件路径")
    parser.add_argument("--output", required=True, help="输出的 TXT 文件路径")
    args = parser.parse_args()

    if API_KEY == "YOUR_GEMINI_API_KEY_HERE":
        print("请先在脚本中填写你的 GEMINI_API_KEY ！")
        return

    input_tsv_path = args.input
    output_txt_path = args.output

    # 读取输入文件中的所有 Tag
    all_tags = load_tags(input_tsv_path)
    if not all_tags:
        print("没有读取到任何有效的 Tag，程序退出。")
        return

    # 读取已翻译的记录进行去重过滤
    already_translated = load_already_translated(output_txt_path)
    remaining_tags = [tag for tag in all_tags if tag not in already_translated]
    
    print(f"📊 总 Tag 数: {len(all_tags)} | 已翻译: {len(already_translated)} | 剩余待翻译: {len(remaining_tags)}")

    if not remaining_tags:
        print("🎉 所有 Tag 均已翻译完成，无需重复处理！")
        return

    total_batches = (len(remaining_tags) + BATCH_SIZE - 1) // BATCH_SIZE

    # 循环批处理，并在每轮请求前动态校验
    for i in range(0, len(remaining_tags), BATCH_SIZE):
        batch = remaining_tags[i : i + BATCH_SIZE]
        current_batch_num = i // BATCH_SIZE + 1

        # 每次请求前实时重新读取一次输出文件，确保不重复翻译和写入
        current_already_translated = load_already_translated(output_txt_path)
        batch = [tag for tag in batch if tag not in current_already_translated]

        if not batch:
            print(f"[{current_batch_num}/{total_batches}] 当前批次所有词条均已存在于输出文件中，跳过...")
            continue

        print(f"[{current_batch_num}/{total_batches}] 正在翻译 {len(batch)} 个词条...")

        results = translate_batch_native(API_KEY, batch)

        valid_count = 0
        # 以追加模式打开文件写入
        with open(output_txt_path, "a", encoding="utf-8") as f_out:
            for line in results:
                line = line.strip()
                if "=" in line:
                    en_part = line.split("=", 1)[0].strip()
                    if en_part not in current_already_translated:
                        f_out.write(line + "\n")
                        current_already_translated.add(en_part)
                        valid_count += 1
        
        print(f"  └─ 成功保存 {valid_count} 条新记录")

        # 频率控制冷却
        if current_batch_num < total_batches:
            time.sleep(DELAY_BETWEEN_REQUESTS)

    print(f"✅ 翻译任务全部结束！结果已保存至: {output_txt_path}")


if __name__ == "__main__":
    main()
