#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
亚马逊热搜词数据抓取/处理工具（v8.0 - 双引擎 + 多站点）

支持 9 个亚马逊站点：美国、法国、墨西哥、英国、德国、意大利、西班牙、加拿大、日本。
默认美国站，指定站点无数据时自动遍历其他站点。

支持两种抓取引擎，根据运行环境自动或手动选择：
  - browser_use 模式：浏览器操作由悟空 browser_use 工具完成，
    本脚本仅接收已提取的 JSON 数据（通过 --input），计算涨跌并保存。
  - playwright 模式：脚本自行启动 Playwright headless 浏览器，
    完成页面抓取 + 数据处理 + 保存的全流程。

引擎选择逻辑：
  - 显式指定 --input 参数 → browser_use 模式（数据已由助手提取）
  - 未指定 --input → playwright 模式（脚本自行抓取）
  - 可通过 --engine 参数强制指定

使用方法：
    # browser_use 模式（沙箱环境，从文件读取已提取的数据）
    python3 amz123_enhanced_scraper_v2.py --keyword "dog bed" --input raw_data.json

    # playwright 模式（非沙箱环境，脚本自行抓取，默认 headless）
    python3 amz123_enhanced_scraper_v2.py --keyword "dog bed"
    python3 amz123_enhanced_scraper_v2.py --keyword "dog bed" --engine playwright

    # 从 stdin 读取数据（browser_use 模式）
    echo '[{"word":"dog bed","currentRank":1,"lastRank":3}]' | python3 amz123_enhanced_scraper_v2.py --keyword "dog bed" --input -
"""

import os
import json
import sys
import csv
from datetime import datetime
import argparse
from urllib.parse import quote

# Playwright 为可选依赖，仅在 playwright 引擎模式下需要
try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ============================================================
# 站点映射表（9 个亚马逊站点）
# ============================================================
# key: 站点代码（用于 --site 参数），value: AMZ123 URL 路径前缀
SITE_MAP = {
    'us':  'usatopkeywords',
    'usa': 'usatopkeywords',
    'fr':  'frtopkeywords',
    'mx':  'mxtopkeywords',
    'uk':  'uktopkeywords',
    'de':  'detopkeywords',
    'it':  'ittopkeywords',
    'es':  'esptopkeywords',
    'esp': 'esptopkeywords',
    'ca':  'catopkeywords',
    'jp':  'jptopkeywords',
}

# 遍历顺序（fallback 时使用，去重后的 9 个站点代码）
SITE_FALLBACK_ORDER = ['us', 'fr', 'mx', 'uk', 'de', 'it', 'es', 'ca', 'jp']

# 站点代码 → 显示名称
SITE_DISPLAY_NAME = {
    'us': '美国', 'fr': '法国', 'mx': '墨西哥', 'uk': '英国',
    'de': '德国', 'it': '意大利', 'es': '西班牙', 'ca': '加拿大', 'jp': '日本',
}


# ============================================================
# 通用工具函数
# ============================================================

def calculate_trend(current_rank, last_rank):
    """
    根据排名变化计算涨跌幅度

    规则：
    - 本周排名 < 上周排名 → 上升（数字越小排名越靠前）
    - 本周排名 > 上周排名 → 下降
    - 本周排名 == 上周排名 → 持平
    - 上周排名为 0 或空 → 上升（新上榜）
    """
    if last_rank == 0 or last_rank is None:
        return "上升"
    elif current_rank < last_rank:
        return "上升"
    elif current_rank > last_rank:
        return "下降"
    else:
        return "持平"


def format_data_for_table(raw_data):
    """
    格式化数据以匹配表格字段

    Args:
        raw_data: 原始数据列表，每项包含 word, currentRank, lastRank

    Returns:
        list: 格式化后的数据
    """
    formatted_data = []
    for item in raw_data:
        formatted_data.append({
            "搜索词": item['word'],
            "本周排名": item['currentRank'],
            "上周排名": item['lastRank'],
            "涨跌幅度": calculate_trend(item['currentRank'], item['lastRank'])
        })
    return formatted_data


# ============================================================
# Playwright 抓取引擎（非沙箱环境使用）
# ============================================================

def launch_browser(playwright, headless=True):
    """启动 Playwright Chromium 浏览器并返回 (browser, page)"""
    try:
        # 使用系统已安装的 Edge
        edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        browser = playwright.chromium.launch(headless=headless, executable_path=edge_path)
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()
        mode_label = "headless" if headless else "headed"
        print(f"[信息] Playwright Chromium 浏览器启动成功（{mode_label} 模式）")
        return browser, page
    except Exception as e:
        print(f"[错误] 启动浏览器失败：{e}")
        print("[提示] 请确保已安装 Playwright 浏览器：python3 -m playwright install chromium")
        return None, None


def extract_hot_words(page, max_count=200):
    """
    使用 Playwright 从页面提取热搜词数据
    """
    import time

    try:
        page.wait_for_selector(".table-body-item-words-word", timeout=15000)
        print("[信息] 搜索结果已加载")
    except PlaywrightTimeout:
        print("[警告] 等待搜索结果超时，尝试继续抓取...")
        time.sleep(3)

    data = page.evaluate(f"""() => {{
        const items = Array.from(document.querySelectorAll('.table-body-item'));
        return items.slice(0, {max_count}).map(item => {{
            const wordElem = item.querySelector('.table-body-item-words-word');
            const word = wordElem ? wordElem.textContent.trim() : '';

            const rankContainer = item.querySelector('.table-body-item-rank');
            let currentRank = 0;
            let lastRank = 0;

            if (rankContainer) {{
                const spans = rankContainer.querySelectorAll('span');
                if (spans.length >= 2) {{
                    const currentText = spans[0].textContent.trim();
                    const lastText = spans[1].textContent.trim();
                    currentRank = /^\\d+$/.test(currentText) ? parseInt(currentText) : 0;
                    lastRank = /^\\d+$/.test(lastText) ? parseInt(lastText) : 0;
                }}
            }}

            return {{ word, currentRank, lastRank }};
        }});
    }}""")

    filtered_data = [item for item in data if item['word'] and len(item['word']) > 0]
    return filtered_data


def search_keyword_in_amz123_single(page, keyword, site_prefix, max_results=200):
    """
    在 AMZ123 指定站点搜索关键词并抓取数据（Playwright 引擎，单站点）

    Args:
        page: Playwright Page 对象
        keyword: 搜索关键词
        site_prefix: AMZ123 URL 路径前缀（如 usatopkeywords）
        max_results: 最大结果数

    Returns:
        list: 热搜词数据列表（可能为空）
    """
    import time

    encoded_keyword = quote(keyword)
    search_url = f"https://www.amz123.com/{site_prefix}?k={encoded_keyword}"
    print(f"[信息] 访问搜索页面：{search_url}")
    page.goto(search_url, wait_until="domcontentloaded")

    # 等待 SPA 页面渲染
    time.sleep(5)

    keywords_data = extract_hot_words(page, max_results)

    if not keywords_data:
        print("[警告] 未能从页面提取到数据，尝试滚动页面...")
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        time.sleep(3)
        page.evaluate("window.scrollTo(0, 0)")
        time.sleep(2)
        keywords_data = extract_hot_words(page, max_results)

    return keywords_data


def search_keyword_in_amz123(page, keyword, site='us', max_results=200):
    """
    在 AMZ123 中搜索关键词并抓取数据（Playwright 引擎，支持多站点 fallback）

    逻辑：
    1. 先在指定站点（默认美国站）搜索
    2. 如果结果为空，自动遍历其他站点
    3. 找到数据就返回，并标注数据来源站点

    Args:
        page: Playwright Page 对象
        keyword: 搜索关键词
        site: 站点代码（us/fr/mx/uk/de/it/es/ca/jp），默认 us
        max_results: 最大结果数

    Returns:
        tuple: (热搜词数据列表, 实际命中的站点代码)
    """
    # 解析站点前缀
    site_lower = site.lower()
    primary_prefix = SITE_MAP.get(site_lower)
    if not primary_prefix:
        print(f"[错误] 不支持的站点代码：{site}")
        print(f"[提示] 支持的站点：{', '.join(SITE_FALLBACK_ORDER)}")
        return [], site

    # 标准化站点代码（usa → us, esp → es）
    primary_site = site_lower
    if primary_site == 'usa':
        primary_site = 'us'
    elif primary_site == 'esp':
        primary_site = 'es'

    primary_name = SITE_DISPLAY_NAME.get(primary_site, site)
    print(f"[信息] 正在搜索与 '{keyword}' 相关的关键词（{primary_name}站）...")

    # 1. 先在指定站点搜索
    keywords_data = search_keyword_in_amz123_single(page, keyword, primary_prefix, max_results)

    if keywords_data:
        print(f"[成功] 在{primary_name}站找到 {len(keywords_data)} 个相关关键词")
        return keywords_data, primary_site

    # 2. 指定站点无数据，自动遍历其他站点
    print(f"[信息] {primary_name}站未找到相关数据，开始遍历其他站点...")

    for fallback_site in SITE_FALLBACK_ORDER:
        if fallback_site == primary_site:
            continue  # 跳过已尝试的站点

        fallback_prefix = SITE_MAP[fallback_site]
        fallback_name = SITE_DISPLAY_NAME[fallback_site]
        print(f"[信息] 尝试{fallback_name}站...")

        keywords_data = search_keyword_in_amz123_single(page, keyword, fallback_prefix, max_results)

        if keywords_data:
            print(f"[成功] 在{fallback_name}站找到 {len(keywords_data)} 个相关关键词")
            return keywords_data, fallback_site

    print(f"[警告] 所有 9 个站点均未找到与 '{keyword}' 相关的热搜词数据")
    return [], primary_site


def scrape_with_playwright(keyword, site='us', headless=True):
    """
    使用 Playwright 引擎完成完整的抓取流程

    Args:
        keyword: 搜索关键词
        site: 站点代码（us/fr/mx/uk/de/it/es/ca/jp），默认 us
        headless: 是否使用无头模式

    Returns:
        tuple: (原始数据列表, 实际命中的站点代码)，失败返回 (None, site)
    """
    if not HAS_PLAYWRIGHT:
        print("[错误] Playwright 未安装，无法使用 playwright 引擎")
        print("[提示] 请安装：pip3 install playwright && python3 -m playwright install chromium")
        return None, site

    with sync_playwright() as pw:
        browser, page = launch_browser(pw, headless)
        if not browser or not page:
            return None, site

        try:
            raw_data, actual_site = search_keyword_in_amz123(page, keyword, site=site, max_results=200)
            return (raw_data if raw_data else None), actual_site
        except Exception as e:
            print(f"[错误] Playwright 抓取异常：{e}")
            import traceback
            traceback.print_exc()
            return None, site
        finally:
            print("[信息] 关闭浏览器...")
            browser.close()


# ============================================================
# 存储模式实现
# ============================================================

def save_to_csv(data, keyword, csv_dir=None):
    """
    CSV 存储模式：将数据保存到本地 CSV 文件

    Args:
        data: 格式化后的数据列表
        keyword: 搜索关键词（用于文件命名）
        csv_dir: CSV 保存目录，默认为 scripts/data/

    Returns:
        str: 保存的文件路径，失败返回 None
    """
    if not data:
        print("[错误] 没有数据可保存")
        return None

    if not csv_dir:
        csv_dir = os.path.join(SCRIPT_DIR, "data")

    os.makedirs(csv_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_keyword = keyword.replace(" ", "_").replace("/", "_")
    filename = os.path.join(csv_dir, f"hotwords_{safe_keyword}_{timestamp}.csv")

    with open(filename, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["搜索词", "本周排名", "上周排名", "涨跌幅度"])
        writer.writeheader()
        writer.writerows(data)

    print(f"[成功] CSV 数据已保存到 {filename}")
    return filename


def save_for_json(data, keyword):
    """
    json 存储模式：将数据输出为 JSON 文件，供当前宿主继续处理

    Args:
        data: 格式化后的数据列表
        keyword: 搜索关键词

    Returns:
        str: JSON 文件路径，失败返回 None
    """
    if not data:
        print("[错误] 没有数据可输出")
        return None

    output_dir = os.path.join(SCRIPT_DIR, "data")
    os.makedirs(output_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_keyword = keyword.replace(" ", "_").replace("/", "_")
    filename = os.path.join(output_dir, f"hotwords_{safe_keyword}_{timestamp}.json")

    output = {
        "metadata": {
            "keyword": keyword,
            "scraped_at": datetime.now().isoformat(),
            "total_records": len(data),
            "storage_mode": "json",
            "fields": ["搜索词", "本周排名", "上周排名", "涨跌幅度"]
        },
        "records": data
    }

    with open(filename, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"[成功] JSON 数据已输出到 {filename}")
    print(f"[信息] 共 {len(data)} 条记录，等待助手通过 宿主表格工具 技能自动创建 AI 表格并写入")
    return filename


def main():
    """主函数"""
    parser = argparse.ArgumentParser(
        description="亚马逊热搜词数据抓取/处理工具（v8.0 - 双引擎 + 多站点）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
引擎选择：
  有 --input 参数 → browser_use 模式（数据已由悟空助手提取）
  无 --input 参数 → playwright 模式（脚本自行启动浏览器抓取，默认 headless）

站点选择（--site）：
  默认美国站（us）。如果指定站点无数据，自动遍历其他 8 个站点。
  支持：us, fr, mx, uk, de, it, es, ca, jp

示例:
  # 美国站（默认）
  python3 amz123_enhanced_scraper_v2.py --keyword "dog bed"

  # 指定日本站
  python3 amz123_enhanced_scraper_v2.py --keyword "dog bed" --site jp

  # browser_use 模式 + json 存储
  python3 amz123_enhanced_scraper_v2.py --keyword "dog bed" --input raw_data.json --storage json
        """
    )
    parser.add_argument("--keyword", type=str, required=True,
                        help="搜索关键词（用于文件命名和 Playwright 模式下的搜索）")
    parser.add_argument("--input", type=str, default=None,
                        help="原始数据 JSON 文件路径（browser_use 模式）。"
                             "提供此参数则使用 browser_use 模式，不提供则使用 Playwright 抓取。"
                             "传 '-' 表示从 stdin 读取")
    parser.add_argument("--engine", type=str, choices=["browser_use", "playwright"], default=None,
                        help="强制指定抓取引擎。不指定时自动判断：有 --input 用 browser_use，无则用 playwright")
    parser.add_argument("--storage", type=str, choices=["csv", "json"], default="csv",
                        help="数据存储模式：csv（本地CSV文件）或 json（输出 JSON 供当前宿主继续处理）")
    parser.add_argument("--no-write", action="store_true",
                        help="仅处理数据，不保存（用于测试）")
    parser.add_argument("--headless", type=str, default="true",
                        help="Playwright 模式下是否使用无头模式 (true/false)，默认 true")
    parser.add_argument("--csv-dir", type=str, default=None,
                        help="CSV 保存目录（仅 csv 模式有效）")
    parser.add_argument("--site", type=str, default="us",
                        help="亚马逊站点代码（us/fr/mx/uk/de/it/es/ca/jp），默认 us。"
                             "指定站点无数据时自动遍历其他站点")

    args = parser.parse_args()

    # 确定引擎模式
    if args.engine:
        engine = args.engine
    elif args.input:
        engine = "browser_use"
    else:
        engine = "playwright"

    keyword = args.keyword.strip()
    storage_mode = args.storage
    site = args.site.lower()

    # 验证站点代码
    if site not in SITE_MAP:
        print(f"[错误] 不支持的站点代码：{site}")
        print(f"[提示] 支持的站点：{', '.join(SITE_FALLBACK_ORDER)}")
        return 1

    site_name = SITE_DISPLAY_NAME.get(site, site)

    print("=" * 60)
    print(f"亚马逊热搜词工具（v8.0 - {engine} 引擎）")
    print("=" * 60)
    print(f"\n[信息] 搜索关键词：'{keyword}'")
    print(f"[信息] 目标站点: {site_name}站（{site}）")
    print(f"[信息] 抓取引擎: {engine}")
    print(f"[信息] 存储模式: {storage_mode}")

    # ---- 获取原始数据 ----
    raw_data = None

    if engine == "browser_use":
        # browser_use 模式：从文件或 stdin 读取已提取的数据
        try:
            if args.input and args.input != "-":
                print(f"[信息] 从文件读取数据：{args.input}")
                with open(args.input, "r", encoding="utf-8") as f:
                    raw_data = json.load(f)
            else:
                print("[信息] 从 stdin 读取数据...")
                raw_data = json.load(sys.stdin)
        except FileNotFoundError:
            print(f"[错误] 文件不存在：{args.input}")
            return 1
        except json.JSONDecodeError as e:
            print(f"[错误] JSON 解析失败：{e}")
            return 1

    elif engine == "playwright":
        # playwright 模式：脚本自行抓取
        if not HAS_PLAYWRIGHT:
            print("[错误] 当前环境未安装 Playwright，无法使用 playwright 引擎")
            print("[提示] 安装方法：pip3 install playwright && python3 -m playwright install chromium")
            print("[提示] 如果在悟空沙箱环境中，请使用 --input 参数传入 browser_use 提取的数据")
            return 1

        headless = args.headless.lower() == "true"
        print(f"[信息] Playwright headless: {headless}")

        print(f"\n{'=' * 60}")
        print("开始抓取数据...")
        print("=" * 60)

        raw_data, actual_site = scrape_with_playwright(keyword, site=site, headless=headless)
        if actual_site != site:
            actual_name = SITE_DISPLAY_NAME.get(actual_site, actual_site)
            print(f"[信息] 注意：数据来自{actual_name}站（{actual_site}），非原始指定的{site_name}站")

    if not raw_data:
        print("[错误] 未能获取到任何数据")
        return 1

    # 过滤无效数据
    raw_data = [item for item in raw_data if item.get('word') and len(item['word']) > 0]
    print(f"[信息] 共 {len(raw_data)} 条有效原始数据")

    # 格式化数据
    formatted_data = format_data_for_table(raw_data)
    print(f"[信息] 共 {len(formatted_data)} 条格式化数据")

    # 预览前 5 条
    print("\n[预览] 前 5 条数据：")
    for i, item in enumerate(formatted_data[:5]):
        print(f"  {i+1}. {item['搜索词']} | 本周#{item['本周排名']} | "
              f"上周#{item['上周排名']} | {item['涨跌幅度']}")

    # 仅处理模式
    if args.no_write:
        print("\n[信息] 已启用 --no-write 模式，跳过保存步骤")
        print("\n[数据] JSON 输出：")
        print(json.dumps(formatted_data[:5], ensure_ascii=False, indent=2))
        return 0

    # 保存数据
    print(f"\n{'=' * 60}")
    print(f"开始保存数据（{storage_mode} 模式）...")
    print("=" * 60)

    if storage_mode == "csv":
        result_file = save_to_csv(formatted_data, keyword, args.csv_dir)
    elif storage_mode == "json":
        result_file = save_for_json(formatted_data, keyword)
    else:
        print(f"[错误] 未知的存储模式：{storage_mode}")
        return 1

    if result_file:
        print(f"\n{'=' * 60}")
        print("[成功] 任务完成！")
        print(f"[信息] 抓取引擎：{engine}")
        print(f"[信息] 输出文件：{result_file}")
        if storage_mode == "json":
            print("[提示] 请使用当前宿主读取上述 JSON 文件继续分析或导出")
        print("=" * 60)
        return 0
    else:
        print("\n[错误] 数据保存失败")
        return 1


if __name__ == '__main__':
    sys.exit(main())
