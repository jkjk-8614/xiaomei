#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
G1-自己店铺·数据深度诊断分析
基于生意参谋商品排行数据生成21Sheet诊断报告

用法:
    python build_G1.py --input "生意参谋数据.csv" --output "输出目录" --shop-name "店铺名称"

参数:
    --input        生意参谋商品排行CSV路径（必填）
    --output       输出目录，默认当前工作目录下的 ./outputs
    --shop-name    店铺名称，用于文件名和报告标题
    --word-hints   词根关键词列表，逗号分隔（默认自动从标题提取高频词）
    --fabric-hints 面料/材质关键词列表，逗号分隔（默认自动从标题提取高频词）
"""

import pandas as pd
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
import argparse
import re
import os

# ==================== 命令行参数 ====================
parser = argparse.ArgumentParser(description="G1-数据深度诊断分析")
parser.add_argument("--input", required=True, help="生意参谋商品排行CSV路径")
# 默认用户文件位置来自 TOOLS.md → 常用路径
DEFAULT_OUTPUT_DIR = os.path.join(os.getcwd(), "outputs")

parser.add_argument("--output", default=os.path.join(os.getcwd(), "outputs"), help="输出目录，默认当前工作目录下的 ./outputs")
parser.add_argument("--shop-name", default="", help="店铺名称（用于报告标题）")
parser.add_argument("--word-hints", default="", help="词根关键词列表，逗号分隔（默认自动从标题提取高频词）")
parser.add_argument("--fabric-hints", default="", help="面料/材质关键词列表，逗号分隔（默认自动从标题提取高频词）")
args = parser.parse_args()

CSV_PATH = args.input
OUTPUT_DIR = args.output
SHOP_NAME = args.shop_name if args.shop_name else os.path.splitext(os.path.basename(CSV_PATH))[0].split("_")[1] if "_" in os.path.basename(CSV_PATH) else "店铺"

# 从文件名提取日期范围作为后缀
base_name = os.path.splitext(os.path.basename(CSV_PATH))[0]
date_match = re.search(r'(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})', base_name)
date_suffix = f"_{date_match.group(1)}至{date_match.group(2)}" if date_match else ""

OUTPUT_PATH = os.path.join(OUTPUT_DIR, f"{SHOP_NAME}_G1_数据深度诊断分析{date_suffix}.xlsx")
os.makedirs(OUTPUT_DIR, exist_ok=True)
print(f"输出路径: {OUTPUT_PATH}")

# 解析用户自定义词库（逗号分隔）
CUSTOM_WORD_HINTS = [w.strip() for w in args.word_hints.split(",") if w.strip()] if args.word_hints else []
CUSTOM_FABRIC_HINTS = [w.strip() for w in args.fabric_hints.split(",") if w.strip()] if args.fabric_hints else []
print(f"自定义词根: {CUSTOM_WORD_HINTS if CUSTOM_WORD_HINTS else '自动提取'}")
print(f"自定义面料: {CUSTOM_FABRIC_HINTS if CUSTOM_FABRIC_HINTS else '自动提取'}")

# ==================== 样式定义 ====================
FILL_TITLE = PatternFill(start_color="2D2006", end_color="2D2006", fill_type="solid")
FILL_TITLE_GOLD = PatternFill(start_color="2D2006", end_color="2D2006", fill_type="solid")
FILL_HEADER_GREEN = PatternFill(start_color="375623", end_color="375623", fill_type="solid")
FILL_HEADER_BLUE = PatternFill(start_color="1E3A5F", end_color="1E3A5F", fill_type="solid")
FILL_ALT_ROW = PatternFill(start_color="F5F5F0", end_color="F5F5F0", fill_type="solid")
FILL_LIGHT_GREEN = PatternFill(start_color="C6D988", end_color="C6D988", fill_type="solid")
FILL_LIGHT_YELLOW = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")

FONT_TITLE = Font(name="微软雅黑", size=14, bold=True, color="FFD700")
FONT_TITLE_WHITE = Font(name="微软雅黑", size=14, bold=True, color="FFFFFF")
FONT_HEADER = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
FONT_DATA = Font(name="微软雅黑", size=9, color="1A1A1A")
FONT_GREEN = Font(name="微软雅黑", size=9, color="336600")
FONT_BROWN = Font(name="微软雅黑", size=9, color="2D2006")
FONT_RED = Font(name="微软雅黑", size=9, color="FF0000")

ALIGN_CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
ALIGN_LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)

THIN_BORDER = Border(
    left=Side(style='thin', color='D0D0D0'),
    right=Side(style='thin', color='D0D0D0'),
    top=Side(style='thin', color='D0D0D0'),
    bottom=Side(style='thin', color='D0D0D0')
)

def style_title_row(ws, row, text, cols, fill=FILL_TITLE, font=FONT_TITLE):
    """设置标题行样式"""
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=cols)
    cell = ws.cell(row=row, column=1)
    cell.value = text
    cell.font = font
    cell.fill = fill
    cell.alignment = ALIGN_CENTER
    ws.row_dimensions[row].height = 30

def style_header_row(ws, row, headers, fill=FILL_HEADER_GREEN):
    """设置表头样式"""
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=row, column=col)
        cell.value = h
        cell.font = FONT_HEADER
        cell.fill = fill
        cell.alignment = ALIGN_CENTER
        cell.border = THIN_BORDER

def style_data_cell(ws, row, col, value, is_alt=False, font=None):
    """设置数据单元格样式"""
    cell = ws.cell(row=row, column=col)
    cell.value = value
    cell.font = font or FONT_DATA
    if is_alt:
        cell.fill = FILL_ALT_ROW
    cell.alignment = ALIGN_CENTER
    cell.border = THIN_BORDER

def style_data_row(ws, row, values, is_alt=False, font=None):
    """设置整行数据样式"""
    for col, v in enumerate(values, 1):
        style_data_cell(ws, row, col, v, is_alt, font)

def auto_width(ws, min_width=10, max_width=50):
    """自动调整列宽"""
    from openpyxl.utils import get_column_letter
    for col_idx, col in enumerate(ws.columns, 1):
        max_length = 0
        column = get_column_letter(col_idx)
        for cell in col:
            try:
                if cell.value and not isinstance(cell, openpyxl.cell.cell.MergedCell):
                    max_length = max(max_length, len(str(cell.value)))
            except:
                pass
        adjusted_width = min(max(min_width, max_length + 2), max_width)
        ws.column_dimensions[column].width = adjusted_width

def format_currency(val):
    if pd.isna(val) or val == 0:
        return "-"
    return f"¥{val:,.2f}"

def format_percent(val, decimals=1):
    if pd.isna(val):
        return "-"
    return f"{val*100:.{decimals}f}%"

def format_number(val):
    if pd.isna(val):
        return "-"
    return f"{val:,.0f}"

def safe_div(a, b, default=0):
    if b == 0 or pd.isna(b) or pd.isna(a):
        return default
    return a / b

def extract_high_freq_words(titles, min_len=2, max_len=4, top_n=30):
    """从标题列表中提取高频中文词汇"""
    from collections import Counter
    import re

    # 停用词：通用电商词汇 + 类目无关词 + 常见无意义组合
    stop_words = {'新款', '夏季', '春季', '秋季', '冬季', '2026', '2025', '2027',
                  '男', '女', '儿童', '大童', '小童', '宝宝', '婴儿', '女童', '男童', '女孩', '男孩',
                  '批发', '包邮', '特价', '优惠', '促销', '正品', '现货',
                  '厂家', '直销', '定制', '定做', '一件代发',
                  '的', '了', '和', '与', '或', '及', '等', '之', '而',
                  '可以', '适合', '适用', '专用', '通用', '加大', '加宽', '加长',
                  '一件', '两件', '三件', '多款', '各种', '多种', '系列',
                  '款女', '童夏', '夏装', '装女', '款男', '款童', '衣女', '裤男', '款儿',
                  '款儿童', '儿童款', '大童', '小童', '中大童', '初中生', '小学生',
                  '女款', '男款', '童款', '女式', '男式', '儿童款', '成人款', '女大童', '女大', '中生',
                  '新款儿', '女童夏', '女孩大', '女孩中', '女孩小', '男童夏', '男孩大',
                  '新款儿童', '孩大童', '女孩大童', '童夏季', '童夏装', '大童夏', '套装夏', '款女孩', '两件套',
                  '上衣', '下装', '裤子', '衣服', '服装', '服饰', '单品',
                  '连衣', '衣裙', '新款女', '洋装', '套装裙', '裙裤',
                  '第一款', '第二款', '第三款', '第四款', '第五款',
                  ' version', ' style', ' type', ' size'}

    word_counter = Counter()
    for title in titles:
        if pd.isna(title):
            continue
        # 提取连续中文字符
        chars = re.findall(r'[\u4e00-\u9fff]+', str(title))
        for seg in chars:
            for length in range(min_len, min(max_len + 1, len(seg) + 1)):
                for i in range(len(seg) - length + 1):
                    word = seg[i:i + length]
                    if word not in stop_words and not re.match(r'^\d+$', word):
                        word_counter[word] += 1

    # 返回出现次数>=2的高频词
    common = [(w, c) for w, c in word_counter.most_common(top_n) if c >= 2]
    return [w for w, c in common]

# ==================== 数据读取与清洗 ====================
print("读取CSV数据...")
df = pd.read_csv(CSV_PATH, encoding='utf-8-sig')

# 数据清洗 - 转换数值列
numeric_cols = ['访客数', '销售额', '退款后销售额', 'UV价值', '搜索支付转化率', '支付转化率',
                '平均停留时长(秒)', '收藏率', '加购率', '退款率', '跳失率', '评分',
                '退款金额', '支付人数', '支付件数', '搜索人数', '搜索UV价值', '搜索占比',
                '收藏人数', '加购人数', '加购件数', '客单价', '近7天搜索渠道点击率',
                '总推广花费', '总推广花费占比', '退款后总推广花费占比', '总推广花费排名',
                '总展现量', '总点击量', '总点击率', '总平均点击花费', '总成交金额', '总成交笔数',
                '总购物车数', '总收藏数', '总成交转化率', '总宝贝收藏成本', '总收藏宝贝数', '总收藏店铺数',
                '关键词推广花费(元)', '关键词推广销售额', '关键词推广投产', '关键词推广访客数', '关键词推广访客占比', '关键词推广PPC',
                '万相台花费(元)', '万相台销售额', '万相台投产', '万相台访客数', '万相台访客占比', '万相台PPC',
                '精准人群推广花费(元)', '精准人群推广销售额', '精准人群推广投产', '精准人群推广访客数', '精准人群推广访客占比', '精准人群推广PPC',
                '全站推广花费(元)', '全站推广销售额', '全站推广投产', '全站推广访客数', '全站推广访客占比', '全站推广PPC']

for col in numeric_cols:
    if col in df.columns:
        df[col] = pd.to_numeric(df[col], errors='coerce')

# 移除完全空的行
df = df.dropna(subset=['宝贝ID'])

# 计算关键指标
total_sales = df['销售额'].sum()
total_refund_sales = df['退款后销售额'].sum()
total_refund = df['退款金额'].sum()
total_promo = df['总推广花费'].sum()
total_visitors = df['访客数'].sum()
total_payers = df['支付人数'].sum()
overall_refund_rate = safe_div(total_refund, total_sales, 0)
overall_promo_rate = safe_div(total_promo, total_sales, 0)
overall_uv = safe_div(total_sales, total_visitors, 0)

# 推广渠道汇总
promo_channels = {
    '关键词推广(直通车)': df['关键词推广花费(元)'].sum(),
    '万相台': df['万相台花费(元)'].sum(),
    '精准人群推广': df['精准人群推广花费(元)'].sum(),
    '全站推广': df['全站推广花费(元)'].sum(),
}

# 提取一级类目
df['一级类目'] = df['商品类目'].str.split('>').str[0]
df['二级类目'] = df['商品类目'].str.split('>').str[1]

# 爆款定义：销售额>5000 且 退款率<50%
df['是否爆款'] = (df['销售额'] > 5000) & (df['退款率'] < 0.5)

# 高退款：销售额>5000 且 退款率>80%
df['是否高退款'] = (df['销售额'] > 5000) & (df['退款率'] > 0.8)

# 僵尸链接：支付人数=0 或 销售额<100
df['是否僵尸'] = (df['支付人数'].fillna(0) == 0) | (df['销售额'].fillna(0) < 100)

# 推广占比分档
def promo_level(row):
    r = row['总推广花费占比']
    if pd.isna(r) or r == 0:
        return '未推广'
    elif r < 0.1:
        return '🟢10%以内'
    elif r < 0.2:
        return '🟡10-20%'
    elif r < 0.3:
        return '🟠20-30%'
    else:
        return '🔴30%以上'
df['推广占比档位'] = df.apply(promo_level, axis=1)

# 修正：对NaN退款率根据退款金额推算
df['退款率'] = df.apply(lambda r: safe_div(r['退款金额'], r['销售额'], 0) if pd.isna(r['退款率']) else r['退款率'], axis=1)

# 退款率分档
def refund_level(r):
    if pd.isna(r):
        return '🟢10%以内'
    elif r < 0.1:
        return '🟢10%以内'
    elif r < 0.2:
        return '🟡10-20%'
    elif r < 0.4:
        return '🟠20-40%'
    elif r < 0.6:
        return '🔴40-60%'
    else:
        return '💀60%以上'
df['退款率档位'] = df['退款率'].apply(refund_level)

# 退款后推广占比
df['退款后推广占比'] = df['退款后总推广花费占比']

# 健康度评分计算（供后续Sheet使用）
def health_score(row):
    s = 100
    if row['退款率'] > 0.3: s -= 15
    elif row['退款率'] > 0.2: s -= 8
    if row['总推广花费占比'] > 0.3: s -= 15
    elif row['总推广花费占比'] > 0.2: s -= 8
    if row['支付转化率'] < 0.01: s -= 10
    if row['跳失率'] > 0.8: s -= 10
    if row['UV价值'] < 1: s -= 10
    return max(s, 0)

df['健康度'] = df.apply(health_score, axis=1)

# ==================== 创建Excel ====================
print("创建Excel工作簿...")
wb = openpyxl.Workbook()
wb.remove(wb.active)

# ---------- Sheet 0: 报告目录 ----------
ws = wb.create_sheet("📋-报告目录")
style_title_row(ws, 1, "📊 子瑞巴巴旗舰店 — 深度分析报告目录（共21个Sheet）", 3, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['Sheet', '内容', '关键发现'])
style_header_row(ws, 3, ['Sheet', '内容', '关键发现'])

total_links = len(df)
hot_links = df['是否爆款'].sum()
zombie_links = df['是否僵尸'].sum()

# 预计算各Sheet的关键发现
top1 = df.loc[df['销售额'].idxmax()]
top1_name = top1['商品信息'][:20] if pd.notna(top1['商品信息']) else '-'
top1_sales = top1['销售额']

promo_dist_counts = df.groupby('推广占比档位').size().to_dict()
refund_dist_counts = df.groupby('退款率档位').size().to_dict()
refund_loss = total_refund - total_promo
refund_promo_ratio = safe_div(total_refund, total_promo, 0)

high_risk_count = len(df[df['销售额'] > 1000].sort_values('退款率', ascending=False).head(5))

summary_data = [
    ['1-店铺总览KPI', '核心指标+健康度5维+推广占比KPI+退款率KPI', f'退款率{overall_refund_rate*100:.1f}% / 总销售额¥{total_sales/10000:.1f}万'],
    ['2-退款率分布', '按退款率5档拆解链接分布', f'高退款链接{df["是否高退款"].sum()}条'],
    ['3-类目分析', '一级类目结构+销售+退款率', f'一级类目{df["一级类目"].nunique()}个'],
    ['4-面料材质分析', '从标题提取面料关键词分析', '按标题关键词提取'],
    ['5-爆款识别', '销售额>¥5000 且 退款率<50%', f'爆款{hot_links}条'],
    ['6-高退款警告', '销售额>¥5000 且 退款率>80%', f'高退款{df["是否高退款"].sum()}条'],
    ['7-推广渠道', '4大推广渠道花费/ROI/效率', f'推广占比{overall_promo_rate*100:.1f}%'],
    ['8-僵尸链接诊断', '零销售或极低销售链接诊断', f'僵尸链接{zombie_links}条'],
    ['9-词根分析', '从标题提取核心词根分析', '按标题关键词提取'],
    ['10-行动建议', '基于数据的P0-P3行动清单', f'P0退款控制+僵尸清理 / P1爆款培育'],
    ['11-TOP1链接诊断', '销售额TOP1链接深度拆解', f'{top1_name}… / ¥{top1_sales:,.0f}'],
    ['12-推广费占比总览', '推广占比5档分布', f'推广占比{overall_promo_rate*100:.1f}% / 4档分布'],
    ['13-类目×推广占比交叉', '类目与推广占比交叉矩阵', f'{df["一级类目"].nunique()}个类目×4档推广占比'],
    ['14-推广占比明细', '按类目×推广占比档位拆解', f'按类目×档位逐条拆解明细'],
    ['15-退款后推广占比分析', '退款后真实推广占比分布', f'退款后推广占比{safe_div(total_promo,total_refund_sales,0)*100:.1f}%'],
    ['16-退款率分布总览', '退款率5档详细分布', f'退款率{overall_refund_rate*100:.1f}% / 5档分布'],
    ['17-类目×退款率交叉', '类目与退款率交叉矩阵', f'{df["一级类目"].nunique()}个类目×5档退款率'],
    ['18-退款率明细', '按类目×退款率档位拆解', f'按类目×档位逐条拆解明细'],
    ['19-退款损失分析', '退款后真实利润视角分析', f'退款损失¥{total_refund:,.0f} / 占推广{refund_promo_ratio:.1f}倍'],
    ['20-总数据分析看板', '总览数据看板', f'TOP5爆款+{high_risk_count}条高风险链接汇总'],
]
for i, row_data in enumerate(summary_data, 4):
    is_alt = (i - 4) % 2 == 1
    style_data_row(ws, i, row_data, is_alt)
ws.column_dimensions['A'].width = 22
ws.column_dimensions['B'].width = 40
ws.column_dimensions['C'].width = 40

# ---------- Sheet 1: 店铺总览KPI ----------
ws = wb.create_sheet("1-店铺总览KPI")
style_title_row(ws, 1, "子瑞巴巴旗舰店 — 店铺总览KPI", 7, fill=FILL_TITLE, font=FONT_TITLE)
ws.append(['指标', '数值', '健康标准', '差距', '状态', '诊断', '建议'])
style_header_row(ws, 2, ['指标', '数值', '健康标准', '差距', '状态', '诊断', '建议'])

# 计算额外指标
avg_price = safe_div(total_sales, total_payers, 0)
total_search_people = df['搜索人数'].sum()
search_ratio = safe_div(total_search_people, total_visitors, 0)
promo_roi_total = safe_div(df['总成交金额'].sum(), total_promo, 0)
promo_roi_after = safe_div(df['总成交金额'].sum() * (1-overall_refund_rate), total_promo, 0)
zero_sales = len(df[df['支付人数'].fillna(0) == 0])
zero_sales_pct = safe_div(zero_sales, total_links, 0)
hot_pct = safe_div(hot_links, total_links, 0)

# 核心KPI数据（对齐参考示例）
kpi_data = [
    ['总销售额', f'¥{total_sales:,.2f}', '参考:同行均值', '-', '🟢', '达标', '需提升爆款数量'],
    ['退款后销售额', f'¥{total_refund_sales:,.2f}', '应>销售额70%', f'{safe_div(total_refund_sales,total_sales,0)*100:.1f}%', '🟢' if safe_div(total_refund_sales,total_sales,0)>0.7 else '🟡', '健康', '退款率需紧急控制'],
    ['退款金额', f'¥{total_refund:,.2f}', '-', '-', '🔴' if overall_refund_rate>0.2 else '🟡', '高' if overall_refund_rate>0.2 else '正常', '需排查退款原因'],
    ['退款率', f'{overall_refund_rate*100:.1f}%', '<20%健康', f'{overall_refund_rate*100-20:.1f}%', '🟡' if overall_refund_rate<0.2 else '🟠', '偏高' if overall_refund_rate>0.2 else '健康', '退款率需紧急控制'],
    ['总访客数', f'{total_visitors:,.0f}', '-', '-', '🟡', '中等', '需加大推广'],
    ['UV价值', f'{overall_uv:.2f}', '>2健康', f'{overall_uv-2:.2f}', '🟢' if overall_uv>2 else '🟡', '健康', '提升转化率'],
    ['客单价', f'¥{avg_price:,.2f}', '-', '-', '🟡', '中等', '优化SKU定价'],
    ['支付人数', f'{total_payers:,.0f}', '-', '-', '🟡', '中等', '提升转化'],
    ['搜索占比', f'{search_ratio*100:.1f}%', '>20%健康', f'{search_ratio*100-20:.1f}%', '🟢' if search_ratio>0.2 else '🟡', '健康' if search_ratio>0.2 else '一般', '优化搜索词'],
    ['总推广花费', f'¥{total_promo:,.2f}', '-', f'{overall_promo_rate*100:.1f}%', '🟠', '正常', '优化推广ROI'],
    ['推广ROI(含退款)', f'{promo_roi_total:.2f}', '>3健康', f'{promo_roi_total-3:.2f}', '🟢' if promo_roi_total>3 else '🟡', '健康', '优化推广策略'],
    ['推广ROI(退款后)', f'{promo_roi_after:.2f}', '>2健康', f'{promo_roi_after-2:.2f}', '🟢' if promo_roi_after>2 else '🟡', '健康', '控制退款率'],
    ['总链接数', f'{total_links}', '-', '-', '🟡', '中等', '-'],
    ['零销售链接', f'{zero_sales}', '<10%健康', f'{zero_sales_pct*100:.1f}%', '🔴' if zero_sales_pct>0.1 else '🟢', '严重' if zero_sales_pct>0.1 else '正常', '清理或激活'],
    ['爆款链接数', f'{hot_links}', '>5%健康', f'{hot_pct*100:.1f}%', '🟠', '正常', '加大爆款孵化'],
]
for i, row_data in enumerate(kpi_data, 3):
    is_alt = (i - 3) % 2 == 1
    style_data_row(ws, i, row_data, is_alt)

# 店铺健康度评分区块
row = ws.max_row + 2
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=7)
cell = ws.cell(row=row, column=1, value='店铺健康度评分')
cell.font = FONT_HEADER
cell.fill = FILL_HEADER_BLUE
cell.alignment = ALIGN_CENTER
style_header_row(ws, row+1, ['维度', '得分', '权重', '加权得分', '评级', '说明', '改善建议'])

# 计算各维度得分
refund_score = max(0, min(100, 100 - (overall_refund_rate - 0.1) * 500))  # 退款率越高得分越低
traffic_score = 100 if search_ratio > 0.3 else (80 if search_ratio > 0.2 else 60)
sales_score = max(0, min(100, 100 - zero_sales_pct * 150))  # 零销售占比越高得分越低
promo_eff_score = 100 if promo_roi_after > 5 else (80 if promo_roi_after > 3 else 60)
product_score = max(0, min(100, hot_pct * 2000))  # 爆款率越高得分越高

weighted_refund = refund_score * 0.30
traffic_weighted = traffic_score * 0.20
sales_weighted = sales_score * 0.20
promo_weighted = promo_eff_score * 0.15
product_weighted = product_score * 0.15
total_score = weighted_refund + traffic_weighted + sales_weighted + promo_weighted + product_weighted

health_rows = [
    ['退款健康度', f'{refund_score:.0f}', '30%', f'{weighted_refund:.1f}', f'{"🟢健康" if refund_score>=70 else ("🟡中等" if refund_score>=50 else "🟠警告")}', f'退款率{overall_refund_rate*100:.1f}%', '控制退款率至20%以下'],
    ['流量健康度', f'{traffic_score:.0f}', '20%', f'{traffic_weighted:.1f}', f'{"🟢健康" if traffic_score>=70 else ("🟡中等" if traffic_score>=50 else "🟠警告")}', f'搜索占比{search_ratio*100:.1f}%', '提升搜索流量'],
    ['动销健康度', f'{sales_score:.0f}', '20%', f'{sales_weighted:.1f}', f'{"🟢健康" if sales_score>=70 else ("🟡中等" if sales_score>=50 else "🟠警告")}', f'零销售{zero_sales_pct*100:.1f}%', '清理僵尸链接'],
    ['推广效率', f'{promo_eff_score:.0f}', '15%', f'{promo_weighted:.1f}', f'{"🟢健康" if promo_eff_score>=70 else ("🟡中等" if promo_eff_score>=50 else "🟠警告")}', f'退款后ROI={promo_roi_after:.2f}', '优化推广ROI'],
    ['产品力', f'{product_score:.0f}', '15%', f'{product_weighted:.1f}', f'{"🟢健康" if product_score>=70 else ("🟡中等" if product_score>=50 else "🟠警告")}', f'爆款率{hot_pct*100:.1f}%', '孵化更多爆款'],
    ['综合评分', f'{total_score:.0f}分', '100%', f'{total_score:.1f}', f'{"🟢健康" if total_score>=70 else ("🟡中等" if total_score>=50 else "🟠警告")}', '需优化', '参考各维度建议'],
]
for i, vals in enumerate(health_rows, ws.max_row + 1):
    is_alt = (i - ws.max_row) % 2 == 1
    style_data_row(ws, i, vals, is_alt)

# 推广费占比核心指标区块
row = ws.max_row + 2
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=7)
cell = ws.cell(row=row, column=1, value='推广费占比核心指标')
cell.font = FONT_HEADER
cell.fill = FILL_HEADER_BLUE
cell.alignment = ALIGN_CENTER
style_header_row(ws, row+1, ['指标', '数值', '健康标准', '差距', '状态', '诊断', '建议'])

promo_after_rate = safe_div(total_promo, total_refund_sales, 0)
promo_kpi = [
    ['推广费占比(含退款)', f'{overall_promo_rate*100:.1f}%', '<10%健康', f'{overall_promo_rate*100-10:.1f}%', '🟡' if overall_promo_rate<0.1 else '🟠', '合理', '需优化推广结构'],
    ['推广费占比(退款后)', f'{promo_after_rate*100:.1f}%', '<15%健康', f'{promo_after_rate*100-15:.1f}%', '🟡' if promo_after_rate<0.15 else '🟠', '合理', '退款侵蚀利润严重'],
]
for i, vals in enumerate(promo_kpi, ws.max_row + 1):
    is_alt = (i - ws.max_row) % 2 == 1
    style_data_row(ws, i, vals, is_alt)

# 推广占比各档位链接数
promo_levels = ['🟢10%以内', '🟡10-20%', '🟠20-30%', '🔴30%以上']
for level in promo_levels:
    sub = df[df['推广占比档位'] == level]
    count = len(sub)
    pct = safe_div(count, total_links, 0)
    diag = '🟢高效推广' if level=='🟢10%以内' else ('🟡合理推广' if level=='🟡10-20%' else ('🟠推广偏高' if level=='🟠20-30%' else '🔴推广过高'))
    advice = '加大投入' if level=='🟢10%以内' else ('维持观察' if level=='🟡10-20%' else ('优化ROI' if level=='🟠20-30%' else '暂停/优化'))
    status_emoji = level[0] if level else '-'
    vals = [f'{level}链接', f'{count}条', f'{pct*100:.1f}%', '-', status_emoji, diag, advice]
    style_data_row(ws, ws.max_row + 1, vals, ws.max_row % 2 == 1)

# 退款率核心指标区块
row = ws.max_row + 2
ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=7)
cell = ws.cell(row=row, column=1, value='退款率核心指标')
cell.font = FONT_HEADER
cell.fill = FILL_HEADER_BLUE
cell.alignment = ALIGN_CENTER
style_header_row(ws, row+1, ['指标', '数值', '健康标准', '差距', '状态', '诊断', '建议'])

refund_promo_ratio = safe_div(total_refund, total_promo, 0)
refund_kpi = [
    ['店铺整体退款率', f'{overall_refund_rate*100:.1f}%', '<20%健康', f'{overall_refund_rate*100-20:.1f}%', '🟠' if overall_refund_rate>0.2 else '🟡', '偏高' if overall_refund_rate>0.2 else '正常', '需紧急排查退款原因'],
    ['退款损失金额', f'¥{total_refund:,.2f}', '-', '-', '🔴' if total_refund>total_promo else '🟡', '损失>推广' if total_refund>total_promo else '可控', '退款损失超过推广投入' if total_refund>total_promo else '推广可覆盖'],
    ['退款占推广比', f'{refund_promo_ratio:.1f}倍', '<1倍健康', f'{refund_promo_ratio-1:.1f}倍', '🟡' if refund_promo_ratio<1 else '🟠', '正常' if refund_promo_ratio<1 else '偏高', '推广效益可覆盖退款' if refund_promo_ratio<1 else '退款侵蚀利润'],
]
for i, vals in enumerate(refund_kpi, ws.max_row + 1):
    is_alt = (i - ws.max_row) % 2 == 1
    style_data_row(ws, i, vals, is_alt)

# 退款率各档位链接数
refund_levels = ['🟢10%以内', '🟡10-20%', '🟠20-40%', '🔴40-60%', '💀60%以上']
for level in refund_levels:
    sub = df[df['退款率档位'] == level]
    count = len(sub)
    pct = safe_div(count, total_links, 0)
    diag = '🟢退款健康' if level=='🟢10%以内' else ('🟡退款正常' if level=='🟡10-20%' else ('🟠退款偏高' if level=='🟠20-40%' else ('🔴退款过高' if level=='🔴40-60%' else '💀退款致命')))
    advice = '利润充足' if level=='🟢10%以内' else ('略有影响' if level=='🟡10-20%' else ('需排查退款原因' if level=='🟠20-40%' else ('严重亏损风险' if level=='🔴40-60%' else '几乎无利润')))
    status_emoji = level[0] if level else '-'
    vals = [f'{level}链接', f'{count}条', f'{pct*100:.1f}%', '-', status_emoji, diag, advice]
    style_data_row(ws, ws.max_row + 1, vals, ws.max_row % 2 == 1)

auto_width(ws)

# ---------- Sheet 2: 退款率分布 ----------
ws = wb.create_sheet("2-退款率分布")
style_title_row(ws, 1, "退款率分布", 7, fill=FILL_TITLE, font=FONT_TITLE)
ws.append(['退款率区间', '链接数', '占比', '涉及销售额', '风险等级', '行动建议', '涉及退款金额'])
style_header_row(ws, 2, ['退款率区间', '链接数', '占比', '涉及销售额', '风险等级', '行动建议', '涉及退款金额'])

# 按参考示例的区间划分
def refund_level_exact(rr):
    if pd.isna(rr) or rr == 0:
        return '0%'
    elif rr < 0.3:
        return '0-30%'
    elif rr < 0.5:
        return '30-50%'
    elif rr < 0.7:
        return '50-70%'
    elif rr < 0.9:
        return '70-90%'
    elif rr < 1.0:
        return '90-100%'
    else:
        return '100%+'

df['退款率区间_精确'] = df['退款率'].apply(refund_level_exact)

refund_dist = df.groupby('退款率区间_精确').agg({
    '宝贝ID': 'count',
    '销售额': 'sum',
    '退款金额': 'sum'
}).reset_index()
refund_dist.columns = ['退款率区间', '链接数', '涉及销售额', '涉及退款金额']
refund_dist['占比'] = refund_dist['链接数'] / total_links

# 确保所有区间都有行
interval_order = ['0%', '0-30%', '30-50%', '50-70%', '70-90%', '90-100%', '100%+']
refund_map = {row['退款率区间']: row for _, row in refund_dist.iterrows()}

risk_map = {
    '0%': ('🟢低风险', '正常运营'),
    '0-30%': ('🟢低风险', '正常运营'),
    '30-50%': ('🟡中等风险', '关注退款原因'),
    '50-70%': ('🟠高风险', '优化产品/描述'),
    '70-90%': ('🔴极高风险', '暂停推广/排查'),
    '90-100%': ('🔴致命', '立即下架/止损'),
    '100%+': ('🔴致命', '立即下架/止损'),
}

for i, interval in enumerate(interval_order, 3):
    is_alt = (i - 3) % 2 == 1
    if interval in refund_map:
        row = refund_map[interval]
        count = row['链接数']
        sales = row['涉及销售额']
        refund_amt = row['涉及退款金额']
        pct = row['占比']
    else:
        count, sales, refund_amt, pct = 0, 0, 0, 0
    risk, action = risk_map[interval]
    vals = [interval, count, f'{pct*100:.1f}%', f'¥{sales:,.2f}', risk, action, f'¥{refund_amt:,.2f}']
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 3: 类目分析 ----------
ws = wb.create_sheet("3-类目分析")
style_title_row(ws, 1, "类目分析", 9, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['类目', '链接数', '销售额', '退款率', '访客数', 'UV价值', '支付人数', '评级', '诊断'])
style_header_row(ws, 3, ['类目', '链接数', '销售额', '退款率', '访客数', 'UV价值', '支付人数', '评级', '诊断'])

cat_analysis = df.groupby('一级类目').agg({
    '宝贝ID': 'count',
    '销售额': 'sum',
    '退款金额': 'sum',
    '访客数': 'sum',
    '支付人数': 'sum',
}).reset_index()
cat_analysis.columns = ['类目', '链接数', '销售额', '退款金额', '访客数', '支付人数']
cat_analysis['退款率'] = cat_analysis['退款金额'] / cat_analysis['销售额']
cat_analysis['UV价值'] = cat_analysis['销售额'] / cat_analysis['访客数']
cat_analysis = cat_analysis.sort_values('销售额', ascending=False)

def cat_rating(row):
    if row['退款率'] < 0.15 and row['UV价值'] > 2:
        return '🟢健康'
    elif row['退款率'] < 0.3 and row['UV价值'] > 1:
        return '🟡一般'
    else:
        return '🔴需关注'

def cat_diag(row):
    if row['退款率'] < 0.15:
        return '退款健康，有利润空间'
    elif row['退款率'] < 0.3:
        return '退款偏高，需优化品控'
    else:
        return '退款严重，需紧急处理'

cat_analysis['评级'] = cat_analysis.apply(cat_rating, axis=1)
cat_analysis['诊断'] = cat_analysis.apply(cat_diag, axis=1)

for i, row in enumerate(cat_analysis.itertuples(), 4):
    is_alt = (i - 4) % 2 == 1
    vals = [row.类目, row.链接数, f'¥{row.销售额:,.2f}', f'{row.退款率*100:.1f}%',
            f'{row.访客数:,.0f}', f'{row.UV价值:.2f}', f'{row.支付人数:,.0f}', row.评级, row.诊断]
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 4: 面料/材质关键词分析 ----------
ws = wb.create_sheet("4-面料材质分析")
style_title_row(ws, 1, "面料/材质分析（从标题关键词提取）", 8, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['面料/材质', '链接数', '销售额', '退款率', '退款后销售额', '访客数', 'UV价值', '盈利诊断'])
style_header_row(ws, 3, ['面料/材质', '链接数', '销售额', '退款率', '退款后销售额', '访客数', 'UV价值', '盈利诊断'])

# 面料关键词：用户自定义 > 自动提取 > 通用fallback
if CUSTOM_FABRIC_HINTS:
    fabric_keywords = CUSTOM_FABRIC_HINTS
    print(f"使用自定义面料词库: {fabric_keywords}")
else:
    # 尝试自动提取高频3字词
    auto_fabric = extract_high_freq_words(df['商品信息'].tolist(), min_len=3, max_len=4, top_n=30)
    # 过滤质量：排除包含常见无意义字符的词，并去重子串
    bad_chars = ['款', '童', '女', '男', '孩', '装', '新', '大', '小']
    good_fabric = [w for w in auto_fabric if len(w) >= 3 and not any(c in w for c in bad_chars)]
    # 去重：如果一个词是另一个词的子串，保留较长的
    unique_fabric = []
    for w in sorted(good_fabric, key=len, reverse=True):
        if not any(w in u or u in w for u in unique_fabric):
            unique_fabric.append(w)
    good_fabric = unique_fabric
    if good_fabric and len(good_fabric) >= 5:
        fabric_keywords = good_fabric[:20]
        print(f"自动提取面料词: {fabric_keywords}")
    else:
        # fallback到通用面料词库（不绑定特定类目）
        fabric_keywords = ['棉', '涤纶', '聚酯纤维', '尼龙', '氨纶', '莫代尔',
                           '牛仔', '针织', '梭织', '蕾丝', '网纱', '绸缎',
                           'PU', 'PVC', '帆布', '无纺布', '硅胶', '橡胶',
                           '不锈钢', '铝合金', '塑料', '木质', '玻璃', '陶瓷',
                           '纯棉', '真丝', '羊毛', '羊绒', '麻', '亚麻', '皮革']
        print(f"自动提取质量不足，使用通用面料词库: {fabric_keywords}")

fabric_data = []
for kw in fabric_keywords:
    mask = df['商品信息'].str.contains(kw, na=False)
    if mask.sum() > 0:
        sub = df[mask]
        sales = sub['销售额'].sum()
        refund_rate = sub['退款金额'].sum() / sales if sales > 0 else 0
        fabric_data.append([kw, mask.sum(), sales, refund_rate,
                           sub['退款后销售额'].sum(), sub['访客数'].sum(),
                           sales / sub['访客数'].sum() if sub['访客数'].sum() > 0 else 0])

fabric_df = pd.DataFrame(fabric_data, columns=['面料', '链接数', '销售额', '退款率', '退款后销售额', '访客数', 'UV价值'])
fabric_df = fabric_df.sort_values('销售额', ascending=False)

for i, row in enumerate(fabric_df.itertuples(), 4):
    is_alt = (i - 4) % 2 == 1
    diag = '🟢盈利' if row.UV价值 > 2 and row.退款率 < 0.3 else ('🟡微利' if row.UV价值 > 1 else '🔴亏损')
    vals = [row.面料, row.链接数, f'¥{row.销售额:,.2f}', f'{row.退款率*100:.1f}%',
            f'¥{row.退款后销售额:,.2f}', f'{row.访客数:,.0f}', f'{row.UV价值:.2f}', diag]
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 5: 爆款识别 ----------
ws = wb.create_sheet("5-爆款识别")
style_title_row(ws, 1, "爆款识别（销售额>¥5000 且 退款率<50%）", 10, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['排名', '商品名称', '宝贝ID', '销售额', '退款率', '访客数', 'UV价值', '支付人数', '转化率', '推广花费'])
style_header_row(ws, 3, ['排名', '商品名称', '宝贝ID', '销售额', '退款率', '访客数', 'UV价值', '支付人数', '转化率', '推广花费'])

hot = df[df['是否爆款']].sort_values('销售额', ascending=False).head(30)
for i, row in enumerate(hot.itertuples(), 4):
    is_alt = (i - 4) % 2 == 1
    vals = [i-3, row.商品信息[:30], str(row.宝贝ID), f'¥{row.销售额:,.2f}',
            f'{row.退款率*100:.1f}%', f'{row.访客数:,.0f}', f'{row.UV价值:.2f}',
            f'{row.支付人数:,.0f}', f'{row.支付转化率*100:.1f}%', f'¥{row.总推广花费:,.2f}' if pd.notna(row.总推广花费) else '-']
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 6: 高退款警告 ----------
ws = wb.create_sheet("6-高退款警告")
style_title_row(ws, 1, "高退款警告（销售额>¥5000 且 退款率>80%）", 9, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['排名', '商品名称', '销售额', '退款率', '退款金额', '访客数', '支付人数', '退款后销售额', '亏损诊断'])
style_header_row(ws, 3, ['排名', '商品名称', '销售额', '退款率', '退款金额', '访客数', '支付人数', '退款后销售额', '亏损诊断'])

high_refund = df[df['是否高退款']].sort_values('退款率', ascending=False)
if len(high_refund) > 0:
    for i, row in enumerate(high_refund.itertuples(), 4):
        is_alt = (i - 4) % 2 == 1
        vals = [i-3, row.商品信息[:30], f'¥{row.销售额:,.2f}', f'{row.退款率*100:.1f}%',
                f'¥{row.退款金额:,.2f}', f'{row.访客数:,.0f}', f'{row.支付人数:,.0f}',
                f'¥{row.退款后销售额:,.2f}', '🔴严重亏损，建议下架']
        style_data_row(ws, i, vals, is_alt)
else:
    ws.append(['暂无高退款链接（销售额>¥5000且退款率>80%），整体退款控制良好', None, None, None, None, None, None, None, None])
    ws.merge_cells(start_row=4, start_column=1, end_row=4, end_column=9)
auto_width(ws)

# ---------- Sheet 7: 推广渠道 ----------
ws = wb.create_sheet("7-推广渠道")
style_title_row(ws, 1, "推广渠道分析", 9, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['渠道', '花费', '销售额', 'ROI(含退款)', '退款率(估)', 'ROI(退款后)', '占比', '效率', '诊断'])
style_header_row(ws, 3, ['渠道', '花费', '销售额', 'ROI(含退款)', '退款率(估)', 'ROI(退款后)', '占比', '效率', '诊断'])

channel_data = []
for name, col_sales, col_cost in [
    ('关键词推广(直通车)', '关键词推广销售额', '关键词推广花费(元)'),
    ('万相台', '万相台销售额', '万相台花费(元)'),
    ('精准人群推广', '精准人群推广销售额', '精准人群推广花费(元)'),
    ('全站推广', '全站推广销售额', '全站推广花费(元)'),
]:
    cost = df[col_cost].sum() if col_cost in df.columns else 0
    sales = df[col_sales].sum() if col_sales in df.columns else 0
    if cost > 0:
        roi = sales / cost if cost > 0 else 0
        refund_rate = overall_refund_rate  # 估算
        roi_after = roi * (1 - refund_rate)
        pct = cost / total_promo if total_promo > 0 else 0
        eff = '🟢高' if roi_after > 3 else ('🟡中' if roi_after > 1.5 else '🔴低')
        diag = '🟢优秀' if roi_after > 3 else ('🟡一般' if roi_after > 1.5 else '🔴需优化')
        channel_data.append([name, cost, sales, f'{roi:.2f}', f'{refund_rate*100:.1f}%',
                            f'{roi_after:.2f}', f'{pct*100:.1f}%', eff, diag])

for i, vals in enumerate(channel_data, 4):
    is_alt = (i - 4) % 2 == 1
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 8: 僵尸链接诊断 ----------
ws = wb.create_sheet("8-僵尸链接诊断")
style_title_row(ws, 1, "僵尸链接诊断", 9, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['指标', '数值', '健康标准', '差距', '状态', '诊断', '建议', '具体操作', '执行周期'])
style_header_row(ws, 3, ['指标', '数值', '健康标准', '差距', '状态', '诊断', '建议', '具体操作', '执行周期'])

zombie_pct = zombie_links / total_links
zombie_data = [
    ['零销售链接数', zombie_links, '<10%', f'{zombie_pct*100:.1f}%', '🔴' if zombie_pct > 0.1 else '🟢',
     '偏高' if zombie_pct > 0.1 else '正常', '清理或重新激活', '逐条评估，30天内无改善则下架', '2周'],
    ['极低销售链接数', len(df[(df['销售额'] > 0) & (df['销售额'] < 100)]), '<5%', '-', '🟡',
     '偏多', '优化或合并', '分析原因，改进主图/标题', '1月'],
    ['总链接数', total_links, '-', '-', '-', '-', '-', '-', '-'],
    ['活跃链接占比', f'{(1-zombie_pct)*100:.1f}%', '>90%', '-', '🟢' if (1-zombie_pct) > 0.9 else '🟡',
     '正常' if (1-zombie_pct) > 0.9 else '偏低', '提升活跃率', '上新+优化', '持续'],
]
for i, vals in enumerate(zombie_data, 4):
    is_alt = (i - 4) % 2 == 1
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 9: 词根分析 ----------
ws = wb.create_sheet("9-词根分析")
style_title_row(ws, 1, "词根分析（从标题提取核心词根）", 8, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['词根', '链接数', '销售额', '退款率', '访客数', 'UV价值', '评级', '盈利诊断'])
style_header_row(ws, 3, ['词根', '链接数', '销售额', '退款率', '访客数', 'UV价值', '评级', '盈利诊断'])

# 词根关键词：用户自定义 > 自动提取 > 通用fallback
if CUSTOM_WORD_HINTS:
    word_roots = CUSTOM_WORD_HINTS
    print(f"使用自定义词根: {word_roots}")
else:
    # 尝试自动提取高频3-4字词
    auto_words = extract_high_freq_words(df['商品信息'].tolist(), min_len=3, max_len=4, top_n=35)
    # 过滤质量：排除包含常见无意义字符的词，并去重子串
    bad_chars = ['款', '童', '女', '男', '孩', '装']
    good_words = [w for w in auto_words if len(w) >= 3 and not any(c in w for c in bad_chars)]
    # 去重：如果一个词是另一个词的子串，保留较长的
    unique_words = []
    for w in sorted(good_words, key=len, reverse=True):
        if not any(w in u or u in w for u in unique_words):
            unique_words.append(w)
    good_words = unique_words
    if good_words and len(good_words) >= 5:
        word_roots = good_words[:25]
        print(f"自动提取词根: {word_roots}")
    else:
        # fallback到通用词库（不绑定特定类目）
        word_roots = ['新款', '夏季', '春季', '秋季', '冬季',
                      '时尚', '简约', '休闲', '商务', '运动',
                      '可爱', '优雅', '个性', '复古', '潮流',
                      '舒适', '透气', '轻便', '耐用', '防水']
        print(f"自动提取质量不足，使用通用词库: {word_roots}")

root_data = []
for root in word_roots:
    mask = df['商品信息'].str.contains(root, na=False)
    if mask.sum() > 0:
        sub = df[mask]
        sales = sub['销售额'].sum()
        rr = sub['退款金额'].sum() / sales if sales > 0 else 0
        uv = sales / sub['访客数'].sum() if sub['访客数'].sum() > 0 else 0
        root_data.append([root, mask.sum(), sales, rr, sub['访客数'].sum(), uv])

root_df = pd.DataFrame(root_data, columns=['词根', '链接数', '销售额', '退款率', '访客数', 'UV价值'])
root_df = root_df.sort_values('销售额', ascending=False)

for i, row in enumerate(root_df.itertuples(), 4):
    is_alt = (i - 4) % 2 == 1
    rating = '🟢健康' if row.UV价值 > 2 and row.退款率 < 0.3 else ('🟡一般' if row.UV价值 > 1 else '🔴差')
    profit = '🟢盈利词根' if row.UV价值 > 2 and row.退款率 < 0.3 else ('🟡微利' if row.UV价值 > 1 else '🔴亏损词根')
    vals = [row.词根, row.链接数, f'¥{row.销售额:,.2f}', f'{row.退款率*100:.1f}%',
            f'{row.访客数:,.0f}', f'{row.UV价值:.2f}', rating, profit]
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 10: 行动建议 ----------
ws = wb.create_sheet("10-行动建议")
style_title_row(ws, 1, "行动建议", 6, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['优先级', '类别', '具体行动', '预期效果', '周期', '负责人/备注'])
style_header_row(ws, 3, ['优先级', '类别', '具体行动', '预期效果', '周期', '负责人/备注'])

action_items = [
    ['P0紧急', '退款控制', f'调研退款原因(退款率{overall_refund_rate*100:.1f}%)，暂停高退款链接推广', '减少退款损失30%+', '本周', '客服+运营'],
    ['P0紧急', '僵尸清理', f'清理{zombie_links}条僵尸链接，释放库存和运营成本', '提升店铺动销率', '2周', '运营'],
    ['P1重要', '爆款培育', f'重点维护{hot_links}条爆款，加大推广投入', '提升销售额20%+', '1月', '运营+推广'],
    ['P1重要', '推广优化', f'优化推广ROI，当前整体ROI偏低', '降低推广占比5%', '1月', '推广'],
    ['P2中期', '类目优化', '聚焦退款率低、UV价值高的类目', '提升整体利润率', '1季度', '运营'],
    ['P2中期', '上新策略', '根据词根分析，布局盈利词根产品', '拓展新增长点', '1季度', '产品'],
    ['P3长期', '品牌建设', '提升品牌认知度，降低对推广依赖', '自然流量占比提升', '长期', '品牌'],
    ['P3长期', '数据监控', '建立周报机制，持续监控KPI变化', '及时发现问题', '持续', '数据'],
]
for i, vals in enumerate(action_items, 4):
    is_alt = (i - 4) % 2 == 1
    # P0用红色，P1用橙色，P2用黄色，P3用绿色
    font = FONT_RED if vals[0] == 'P0紧急' else (Font(name="微软雅黑", size=9, color="FF8800") if vals[0] == 'P1重要' else 
          (Font(name="微软雅黑", size=9, color="CC9900") if vals[0] == 'P2中期' else FONT_GREEN))
    style_data_row(ws, i, vals, is_alt, font)
auto_width(ws)

# ---------- Sheet 11: TOP1链接诊断 ----------
ws = wb.create_sheet("11-TOP1链接诊断")
style_title_row(ws, 1, "TOP1链接深度诊断", 6, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])

top1 = df.loc[df['销售额'].idxmax()]
ws.append(['基本信息'])
ws.merge_cells(start_row=3, start_column=1, end_row=3, end_column=6)
ws.cell(row=3, column=1).font = FONT_HEADER
ws.cell(row=3, column=1).fill = FILL_HEADER_BLUE

ws.append(['字段', '数值', '字段', '数值', '字段', '数值'])
style_header_row(ws, 4, ['字段', '数值', '字段', '数值', '字段', '数值'])

top1_data = [
    ['商品名称', top1['商品信息'][:40], '宝贝ID', str(top1['宝贝ID']), '类目', top1['商品类目'][:20]],
    ['销售额', f'¥{top1["销售额"]:,.2f}', '退款后销售额', f'¥{top1["退款后销售额"]:,.2f}', '退款率', f'{top1["退款率"]*100:.1f}%'],
    ['访客数', f'{top1["访客数"]:,.0f}', 'UV价值', f'{top1["UV价值"]:.2f}', '支付人数', f'{top1["支付人数"]:,.0f}'],
    ['支付转化率', f'{top1["支付转化率"]*100:.2f}%', '收藏率', f'{top1["收藏率"]*100:.2f}%' if pd.notna(top1["收藏率"]) else '-',
     '加购率', f'{top1["加购率"]*100:.2f}%' if pd.notna(top1["加购率"]) else '-'],
    ['推广花费', f'¥{top1["总推广花费"]:,.2f}' if pd.notna(top1["总推广花费"]) else '-',
     '推广占比', f'{top1["总推广花费占比"]*100:.1f}%' if pd.notna(top1["总推广花费占比"]) else '-',
     '推广ROI', f'{top1["总成交金额"]/top1["总推广花费"]:.2f}' if pd.notna(top1["总推广花费"]) and top1["总推广花费"] > 0 else '-'],
    ['搜索占比', f'{top1["搜索占比"]*100:.1f}%' if pd.notna(top1["搜索占比"]) else '-',
     '跳失率', f'{top1["跳失率"]*100:.1f}%', '评分', f'{top1["评分"]}'],
]
for i, vals in enumerate(top1_data, 5):
    is_alt = (i - 5) % 2 == 1
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 12: 推广费占比总览 ----------
ws = wb.create_sheet("12-推广费占比总览")
style_title_row(ws, 1, "推广费占比分布总览", 10, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['推广占比区间', '链接数', '销售额', '退款后销售额', '退款率', '推广花费', '推广ROI(退款后)', 'UV价值', '转化率', '诊断'])
style_header_row(ws, 3, ['推广占比区间', '链接数', '销售额', '退款后销售额', '退款率', '推广花费', '推广ROI(退款后)', 'UV价值', '转化率', '诊断'])

promo_dist = df.groupby('推广占比档位').agg({
    '宝贝ID': 'count',
    '销售额': 'sum',
    '退款后销售额': 'sum',
    '退款金额': 'sum',
    '总推广花费': 'sum',
    '访客数': 'sum',
    '支付人数': 'sum',
}).reset_index()
promo_dist.columns = ['推广占比区间', '链接数', '销售额', '退款后销售额', '退款金额', '推广花费', '访客数', '支付人数']
promo_dist['退款率'] = promo_dist['退款金额'] / promo_dist['销售额']
promo_dist['推广ROI'] = promo_dist['退款后销售额'] / promo_dist['推广花费']
promo_dist['UV价值'] = promo_dist['销售额'] / promo_dist['访客数']
promo_dist['转化率'] = promo_dist['支付人数'] / promo_dist['访客数']

promo_order = ['未推广', '🟢10%以内', '🟡10-20%', '🟠20-30%', '🔴30%以上']
promo_dist['sort_key'] = promo_dist['推广占比区间'].apply(lambda x: promo_order.index(x) if x in promo_order else 99)
promo_dist = promo_dist.sort_values('sort_key')

for i, row in enumerate(promo_dist.itertuples(), 4):
    is_alt = (i - 4) % 2 == 1
    diag = '🟢推广效率优秀' if row.推广占比区间 == '🟢10%以内' else (
        '🟡推广效率一般' if row.推广占比区间 == '🟡10-20%' else (
        '🟠推广效率偏低' if row.推广占比区间 == '🟠20-30%' else '🔴推广严重亏损'))
    vals = [row.推广占比区间, row.链接数, f'¥{row.销售额:,.2f}', f'¥{row.退款后销售额:,.2f}',
            f'{row.退款率*100:.1f}%', f'¥{row.推广花费:,.2f}', f'{row.推广ROI:.2f}',
            f'{row.UV价值:.2f}', f'{row.转化率*100:.1f}%', diag]
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 13: 类目×推广占比交叉 ----------
ws = wb.create_sheet("13-类目×推广占比交叉")
style_title_row(ws, 1, "类目×推广占比交叉分析矩阵", 10, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['类目', '链接数', '销售额', '退款率', '推广花费', '推广占比', '🟢10%以内', '🟡10-20%', '🟠20-30%', '🔴30%以上'])
style_header_row(ws, 3, ['类目', '链接数', '销售额', '退款率', '推广花费', '推广占比', '🟢10%以内', '🟡10-20%', '🟠20-30%', '🔴30%以上'])

cat_promo = df.groupby(['一级类目', '推广占比档位']).size().unstack(fill_value=0)
for cat in cat_analysis['类目']:
    sub = df[df['一级类目'] == cat]
    sales = sub['销售额'].sum()
    rr = sub['退款金额'].sum() / sales if sales > 0 else 0
    promo = sub['总推广花费'].sum()
    promo_pct = promo / sales if sales > 0 else 0
    row_vals = [cat, len(sub), f'¥{sales:,.2f}', f'{rr*100:.1f}%',
                f'¥{promo:,.2f}', f'{promo_pct*100:.1f}%']
    for level in ['🟢10%以内', '🟡10-20%', '🟠20-30%', '🔴30%以上']:
        row_vals.append(cat_promo.loc[cat, level] if cat in cat_promo.index and level in cat_promo.columns else 0)
    style_data_row(ws, len(ws['A'])+1, row_vals)
auto_width(ws)

# ---------- Sheet 14: 推广占比明细 ----------
ws = wb.create_sheet("14-推广占比明细")
style_title_row(ws, 1, "推广占比明细（按类目×推广占比档位拆解）", 13, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])

for cat in cat_analysis['类目'].head(5):
    for level in ['🟢10%以内', '🟡10-20%', '🟠20-30%', '🔴30%以上']:
        sub = df[(df['一级类目'] == cat) & (df['推广占比档位'] == level)].sort_values('销售额', ascending=False)
        if len(sub) > 0:
            ws.append([f'{cat} — {level}推广占比（{len(sub)}条）'])
            ws.merge_cells(start_row=ws.max_row, start_column=1, end_row=ws.max_row, end_column=13)
            ws.cell(row=ws.max_row, column=1).font = FONT_HEADER
            ws.cell(row=ws.max_row, column=1).fill = FILL_HEADER_BLUE
            ws.append(['排名', '宝贝ID', '商品名称', '销售额', '退款后销售额', '退款率', '推广花费', '推广占比', '退款后推广占比', 'ROI(退款后)', '访客数', '支付人数', '诊断'])
            style_header_row(ws, ws.max_row, ['排名', '宝贝ID', '商品名称', '销售额', '退款后销售额', '退款率', '推广花费', '推广占比', '退款后推广占比', 'ROI(退款后)', '访客数', '支付人数', '诊断'])
            for i, row in enumerate(sub.head(5).itertuples(), ws.max_row + 1):
                is_alt = i % 2 == 1
                roi_after = row.退款后销售额 / row.总推广花费 if pd.notna(row.总推广花费) and row.总推广花费 > 0 else 0
                diag = '🟢' if roi_after > 3 else ('🟡' if roi_after > 1 else '🔴')
                vals = [i - ws.max_row, str(row.宝贝ID), row.商品信息[:25],
                        f'¥{row.销售额:,.2f}', f'¥{row.退款后销售额:,.2f}', f'{row.退款率*100:.1f}%',
                        f'¥{row.总推广花费:,.2f}' if pd.notna(row.总推广花费) else '-',
                        f'{row.总推广花费占比*100:.1f}%' if pd.notna(row.总推广花费占比) else '-',
                        f'{row.退款后总推广花费占比*100:.1f}%' if pd.notna(row.退款后总推广花费占比) else '-',
                        f'{roi_after:.2f}', f'{row.访客数:,.0f}', f'{row.支付人数:,.0f}', diag]
                style_data_row(ws, i, vals, is_alt)
            ws.append([])
auto_width(ws)

# ---------- Sheet 15: 退款后推广占比分析 ----------
ws = wb.create_sheet("15-退款后推广占比分析")
style_title_row(ws, 1, "退款后推广占比分布（更真实视角）", 10, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['退款后推广占比区间', '链接数', '销售额', '退款后销售额', '退款率', '推广花费', '推广ROI(退款后)', 'UV价值', '转化率', '诊断'])
style_header_row(ws, 3, ['退款后推广占比区间', '链接数', '销售额', '退款后销售额', '退款率', '推广花费', '推广ROI(退款后)', 'UV价值', '转化率', '诊断'])

# 重新定义退款后推广占比档位
def refund_promo_level(row):
    r = row['退款后总推广花费占比']
    if pd.isna(r) or r == 0:
        return '未推广'
    elif r < 0.1:
        return '🟢10%以内'
    elif r < 0.2:
        return '🟡10-20%'
    elif r < 0.3:
        return '🟠20-30%'
    else:
        return '🔴30%以上'
df['退款后推广占比档位'] = df.apply(refund_promo_level, axis=1)

rp_dist = df.groupby('退款后推广占比档位').agg({
    '宝贝ID': 'count',
    '销售额': 'sum',
    '退款后销售额': 'sum',
    '退款金额': 'sum',
    '总推广花费': 'sum',
    '访客数': 'sum',
    '支付人数': 'sum',
}).reset_index()
rp_dist.columns = ['退款后推广占比区间', '链接数', '销售额', '退款后销售额', '退款金额', '推广花费', '访客数', '支付人数']
rp_dist['退款率'] = rp_dist['退款金额'] / rp_dist['销售额']
rp_dist['推广ROI'] = rp_dist['退款后销售额'] / rp_dist['推广花费']
rp_dist['UV价值'] = rp_dist['销售额'] / rp_dist['访客数']
rp_dist['转化率'] = rp_dist['支付人数'] / rp_dist['访客数']

for i, row in enumerate(rp_dist.itertuples(), 4):
    is_alt = (i - 4) % 2 == 1
    diag = '🟢推广效率优秀(退款后仍盈利)' if row.退款后推广占比区间 == '🟢10%以内' else (
        '🟡推广效率一般' if row.退款后推广占比区间 == '🟡10-20%' else (
        '🟠推广效率偏低' if row.退款后推广占比区间 == '🟠20-30%' else '🔴推广严重亏损'))
    vals = [row.退款后推广占比区间, row.链接数, f'¥{row.销售额:,.2f}', f'¥{row.退款后销售额:,.2f}',
            f'{row.退款率*100:.1f}%', f'¥{row.推广花费:,.2f}', f'{row.推广ROI:.2f}',
            f'{row.UV价值:.2f}', f'{row.转化率*100:.1f}%', diag]
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 16: 退款率分布总览 ----------
ws = wb.create_sheet("16-退款率分布总览")
style_title_row(ws, 1, "退款率分布总览（按5档退款率拆解）", 11, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['退款率区间', '链接数', '销售额', '退款后销售额', '退款金额', '退款率', '推广花费', '推广ROI(退款后)', 'UV价值', '转化率', '诊断'])
style_header_row(ws, 3, ['退款率区间', '链接数', '销售额', '退款后销售额', '退款金额', '退款率', '推广花费', '推广ROI(退款后)', 'UV价值', '转化率', '诊断'])

for i, row in enumerate(refund_dist.itertuples(), 4):
    is_alt = (i - 4) % 2 == 1
    promo_cost = df[df['退款率档位'] == row.退款率区间]['总推广花费'].sum()
    roi_after = row.涉及退款金额 / promo_cost if promo_cost > 0 else 0
    # 重新计算更准确的数据
    sub = df[df['退款率档位'] == row.退款率区间]
    promo_cost = sub['总推广花费'].sum()
    sales = sub['销售额'].sum()
    refund_sales = sub['退款后销售额'].sum()
    refund_amt = sub['退款金额'].sum()
    visitors = sub['访客数'].sum()
    payers = sub['支付人数'].sum()
    rr = refund_amt / sales if sales > 0 else 0
    uv = sales / visitors if visitors > 0 else 0
    cr = payers / visitors if visitors > 0 else 0
    roi = refund_sales / promo_cost if promo_cost > 0 else 0
    
    diag = '🟢退款健康，利润充足' if row.退款率区间 == '🟢10%以内' else (
        '🟡退款可控，需关注' if row.退款率区间 == '🟡10-20%' else (
        '🟠退款偏高，需优化' if row.退款率区间 == '🟠20-40%' else '🔴退款严重，紧急处理'))
    vals = [row.退款率区间, row.链接数, f'¥{sales:,.2f}', f'¥{refund_sales:,.2f}',
            f'¥{refund_amt:,.2f}', f'{rr*100:.1f}%', f'¥{promo_cost:,.2f}',
            f'{roi:.2f}', f'{uv:.2f}', f'{cr*100:.1f}%', diag]
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 17: 类目×退款率交叉 ----------
ws = wb.create_sheet("17-类目×退款率交叉")
style_title_row(ws, 1, "类目×退款率交叉分析矩阵", 11, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['类目', '链接数', '销售额', '退款金额', '退款率', '推广花费', '🟢10%以内', '🟡10-20%', '🟠20-40%', '🔴40-60%', '💀60%以上'])
style_header_row(ws, 3, ['类目', '链接数', '销售额', '退款金额', '退款率', '推广花费', '🟢10%以内', '🟡10-20%', '🟠20-40%', '🔴40-60%', '💀60%以上'])

cat_refund = df.groupby(['一级类目', '退款率档位']).size().unstack(fill_value=0)
for cat in cat_analysis['类目']:
    sub = df[df['一级类目'] == cat]
    sales = sub['销售额'].sum()
    refund = sub['退款金额'].sum()
    rr = refund / sales if sales > 0 else 0
    promo = sub['总推广花费'].sum()
    row_vals = [cat, len(sub), f'¥{sales:,.2f}', f'¥{refund:,.2f}', f'{rr*100:.1f}%', f'¥{promo:,.2f}']
    for level in ['🟢10%以内', '🟡10-20%', '🟠20-40%', '🔴40-60%', '💀60%以上']:
        row_vals.append(cat_refund.loc[cat, level] if cat in cat_refund.index and level in cat_refund.columns else 0)
    style_data_row(ws, len(ws['A'])+1, row_vals)
auto_width(ws)

# ---------- Sheet 18: 退款率明细 ----------
ws = wb.create_sheet("18-退款率明细")
style_title_row(ws, 1, "退款率明细（按类目×退款率档位拆解）", 14, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])

for cat in cat_analysis['类目'].head(5):
    for level in ['🟢10%以内', '🟡10-20%', '🟠20-40%', '🔴40-60%', '💀60%以上']:
        sub = df[(df['一级类目'] == cat) & (df['退款率档位'] == level)].sort_values('退款率', ascending=False)
        if len(sub) > 0:
            ws.append([f'{cat} — {level}退款率（{len(sub)}条）'])
            ws.merge_cells(start_row=ws.max_row, start_column=1, end_row=ws.max_row, end_column=14)
            ws.cell(row=ws.max_row, column=1).font = FONT_HEADER
            ws.cell(row=ws.max_row, column=1).fill = FILL_HEADER_BLUE
            ws.append(['排名', '宝贝ID', '商品名称', '销售额', '退款后销售额', '退款金额', '退款率', '推广花费', '推广占比', '退款后推广占比', 'ROI(退款后)', '访客数', '支付人数', '诊断'])
            style_header_row(ws, ws.max_row, ['排名', '宝贝ID', '商品名称', '销售额', '退款后销售额', '退款金额', '退款率', '推广花费', '推广占比', '退款后推广占比', 'ROI(退款后)', '访客数', '支付人数', '诊断'])
            for i, row in enumerate(sub.head(5).itertuples(), ws.max_row + 1):
                is_alt = i % 2 == 1
                roi_after = row.退款后销售额 / row.总推广花费 if pd.notna(row.总推广花费) and row.总推广花费 > 0 else 0
                diag = '🟢' if row.退款率 < 0.1 else ('🟡' if row.退款率 < 0.3 else '🔴')
                vals = [i - ws.max_row + 1, str(row.宝贝ID), row.商品信息[:25],
                        f'¥{row.销售额:,.2f}', f'¥{row.退款后销售额:,.2f}', f'¥{row.退款金额:,.2f}',
                        f'{row.退款率*100:.1f}%',
                        f'¥{row.总推广花费:,.2f}' if pd.notna(row.总推广花费) else '-',
                        f'{row.总推广花费占比*100:.1f}%' if pd.notna(row.总推广花费占比) else '-',
                        f'{row.退款后总推广花费占比*100:.1f}%' if pd.notna(row.退款后总推广花费占比) else '-',
                        f'{roi_after:.2f}', f'{row.访客数:,.0f}', f'{row.支付人数:,.0f}', diag]
                style_data_row(ws, i, vals, is_alt)
            ws.append([])
auto_width(ws)

# ---------- Sheet 19: 退款损失分析 ----------
ws = wb.create_sheet("19-退款损失分析")
style_title_row(ws, 1, "退款损失分析（退款后真实利润视角）", 11, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['退款率区间', '链接数', '销售额', '退款后销售额', '退款损失金额', '退款率', '推广花费', '推广ROI(退款后)', '净损失(退款-推广)', '退款占推广比', '诊断'])
style_header_row(ws, 3, ['退款率区间', '链接数', '销售额', '退款后销售额', '退款损失金额', '退款率', '推广花费', '推广ROI(退款后)', '净损失(退款-推广)', '退款占推广比', '诊断'])

for i, row in enumerate(refund_dist.itertuples(), 4):
    is_alt = (i - 4) % 2 == 1
    sub = df[df['退款率档位'] == row.退款率区间]
    sales = sub['销售额'].sum()
    refund_sales = sub['退款后销售额'].sum()
    refund_amt = sub['退款金额'].sum()
    rr = refund_amt / sales if sales > 0 else 0
    promo_cost = sub['总推广花费'].sum()
    net_loss = refund_amt - promo_cost
    refund_promo_ratio = refund_amt / promo_cost if promo_cost > 0 else 0
    roi_after = refund_sales / promo_cost if promo_cost > 0 else 0
    
    diag = '🟢退款损失可控' if row.退款率区间 == '🟢10%以内' else (
        '🟡退款损失需关注' if row.退款率区间 == '🟡10-20%' else (
        '🟠退款损失偏高' if row.退款率区间 == '🟠20-40%' else '🔴退款损失严重'))
    vals = [row.退款率区间, row.链接数, f'¥{sales:,.2f}', f'¥{refund_sales:,.2f}',
            f'¥{refund_amt:,.2f}', f'{rr*100:.1f}%', f'¥{promo_cost:,.2f}',
            f'{roi_after:.2f}', f'¥{net_loss:,.2f}', f'{refund_promo_ratio*100:.0f}%', diag]
    style_data_row(ws, i, vals, is_alt)
auto_width(ws)

# ---------- Sheet 20: 总数据分析看板 ----------
ws = wb.create_sheet("20-总数据分析看板")
style_title_row(ws, 1, "📊 总数据分析看板 — 子瑞巴巴旗舰店", 12, fill=FILL_TITLE, font=FONT_TITLE)
ws.append([])
ws.append(['核心经营指标'])
ws.merge_cells(start_row=3, start_column=1, end_row=3, end_column=12)
ws.cell(row=3, column=1).font = FONT_HEADER
ws.cell(row=3, column=1).fill = FILL_HEADER_BLUE
ws.cell(row=3, column=1).alignment = ALIGN_CENTER

ws.append(['💰 总销售额', None, None, '💎 退款后销售额', None, None, '💸 退款金额', None, None, '📉 退款率', None, None])
for col in [1, 4, 7, 10]:
    ws.merge_cells(start_row=4, start_column=col, end_row=4, end_column=col+2)
    ws.cell(row=4, column=col).font = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
    ws.cell(row=4, column=col).fill = FILL_HEADER_GREEN
    ws.cell(row=4, column=col).alignment = ALIGN_CENTER

ws.append([f'¥{total_sales:,.2f}', None, None, f'¥{total_refund_sales:,.2f}', None, None,
           f'¥{total_refund:,.2f}', None, None, f'{overall_refund_rate*100:.1f}%', None, None])
for col in [1, 4, 7, 10]:
    ws.merge_cells(start_row=5, start_column=col, end_row=5, end_column=col+2)
    ws.cell(row=5, column=col).font = Font(name="微软雅黑", size=16, bold=True, color="2D2006")
    ws.cell(row=5, column=col).alignment = ALIGN_CENTER
ws.row_dimensions[5].height = 40

ws.append([])
ws.append(['👥 总访客数', None, None, '💳 支付人数', None, None, '💵 UV价值', None, None, '📊 推广占比', None, None])
for col in [1, 4, 7, 10]:
    ws.merge_cells(start_row=7, start_column=col, end_row=7, end_column=col+2)
    ws.cell(row=7, column=col).font = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
    ws.cell(row=7, column=col).fill = FILL_HEADER_BLUE
    ws.cell(row=7, column=col).alignment = ALIGN_CENTER

ws.append([f'{total_visitors:,.0f}', None, None, f'{total_payers:,.0f}', None, None,
           f'{overall_uv:.2f}', None, None, f'{overall_promo_rate*100:.1f}%', None, None])
for col in [1, 4, 7, 10]:
    ws.merge_cells(start_row=8, start_column=col, end_row=8, end_column=col+2)
    ws.cell(row=8, column=col).font = Font(name="微软雅黑", size=16, bold=True, color="1E3A5F")
    ws.cell(row=8, column=col).alignment = ALIGN_CENTER
ws.row_dimensions[8].height = 40

ws.append([])
ws.append(['🏆 TOP5 爆款'])
ws.merge_cells(start_row=10, start_column=1, end_row=10, end_column=12)
ws.cell(row=10, column=1).font = FONT_HEADER
ws.cell(row=10, column=1).fill = FILL_HEADER_GREEN
ws.cell(row=10, column=1).alignment = ALIGN_CENTER

ws.append(['排名', '商品名称', '宝贝ID', '销售额', '退款率', '访客数', 'UV价值', '支付人数', '推广花费', '推广占比', '健康度', '诊断'])
style_header_row(ws, 11, ['排名', '商品名称', '宝贝ID', '销售额', '退款率', '访客数', 'UV价值', '支付人数', '推广花费', '推广占比', '健康度', '诊断'])

top5 = df.sort_values('销售额', ascending=False).head(5)
for i, row in enumerate(top5.itertuples(), 12):
    is_alt = (i - 12) % 2 == 1
    health = df.loc[row.Index, '健康度']
    diag = '🟢' if health >= 70 else ('🟡' if health >= 50 else '🔴')
    vals = [i-11, row.商品信息[:30], str(row.宝贝ID), f'¥{row.销售额:,.2f}',
            f'{row.退款率*100:.1f}%', f'{row.访客数:,.0f}', f'{row.UV价值:.2f}',
            f'{row.支付人数:,.0f}', f'¥{row.总推广花费:,.2f}' if pd.notna(row.总推广花费) else '-',
            f'{row.总推广花费占比*100:.1f}%' if pd.notna(row.总推广花费占比) else '-',
            f'{health:.0f}', diag]
    style_data_row(ws, i, vals, is_alt)

ws.append([])
ws.append(['⚠️ TOP5 高风险链接（退款率最高）'])
ws.merge_cells(start_row=ws.max_row, start_column=1, end_row=ws.max_row, end_column=12)
ws.cell(row=ws.max_row, column=1).font = FONT_HEADER
ws.cell(row=ws.max_row, column=1).fill = FILL_HEADER_BLUE
ws.cell(row=ws.max_row, column=1).alignment = ALIGN_CENTER

ws.append(['排名', '商品名称', '宝贝ID', '销售额', '退款率', '访客数', 'UV价值', '支付人数', '退款金额', '退款后销售额', '健康度', '诊断'])
style_header_row(ws, ws.max_row, ['排名', '商品名称', '宝贝ID', '销售额', '退款率', '访客数', 'UV价值', '支付人数', '退款金额', '退款后销售额', '健康度', '诊断'])

high_risk = df[df['销售额'] > 1000].sort_values('退款率', ascending=False).head(5)
for i, row in enumerate(high_risk.itertuples(), ws.max_row + 1):
    is_alt = i % 2 == 1
    health = df.loc[row.Index, '健康度']
    diag = '🔴' if health < 50 else ('🟡' if health < 70 else '🟢')
    vals = [i - ws.max_row + 1, row.商品信息[:30], str(row.宝贝ID), f'¥{row.销售额:,.2f}',
            f'{row.退款率*100:.1f}%', f'{row.访客数:,.0f}', f'{row.UV价值:.2f}',
            f'{row.支付人数:,.0f}', f'¥{row.退款金额:,.2f}', f'¥{row.退款后销售额:,.2f}',
            f'{health:.0f}', diag]
    style_data_row(ws, i, vals, is_alt)

auto_width(ws)

# ==================== 保存 ====================
print(f"保存Excel到: {OUTPUT_PATH}")
wb.save(OUTPUT_PATH)
print("完成!")

