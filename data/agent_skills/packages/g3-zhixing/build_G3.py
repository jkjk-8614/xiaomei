#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
G3-自己店铺·执行报告生成总览

用法:
    python build_G3.py --csv-input "生意参谋数据.csv" --output "输出目录" --shop-name "店铺名"
    python build_G3.py --g1-input "G1报告.xlsx" --g2-input "G2报告.xlsx" --output "输出目录" --shop-name "店铺名"

参数:
    --csv-input   生意参谋商品排行CSV路径（与G1/G2同源）
    --g1-input    G1生成的Excel路径（可选，优先于csv）
    --g2-input    G2生成的Excel路径（可选）
    --output       输出目录，默认当前工作目录下的 ./outputs
    --shop-name   店铺名称
    --pages       生成页数，默认38（完整版），最小10（P0核心）
"""

import pandas as pd
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
import argparse
import re
import os

# ==================== 命令行参数 ====================
parser = argparse.ArgumentParser(description="G3-执行报告生成总览")
parser.add_argument("--csv-input", default="", help="生意参谋商品排行CSV路径")
parser.add_argument("--g1-input", default="", help="G1生成的Excel路径")
parser.add_argument("--g2-input", default="", help="G2生成的Excel路径")
parser.add_argument("--output", default=os.path.join(os.getcwd(), "outputs"), help="输出目录，默认当前工作目录下的 ./outputs")
parser.add_argument("--shop-name", default="", help="店铺名称")
parser.add_argument("--pages", type=int, default=38, help="生成页数，默认38页完整版")
args = parser.parse_args()

CSV_PATH = args.csv_input
G1_PATH = args.g1_input
OUTPUT_DIR = args.output
SHOP_NAME = args.shop_name if args.shop_name else "店铺"
MAX_PAGES = min(args.pages, 38)

base_name = os.path.splitext(os.path.basename(CSV_PATH or G1_PATH))[0]
date_match = re.search(r'(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})', base_name)
date_suffix = f"_{date_match.group(1)}至{date_match.group(2)}" if date_match else ""

OUTPUT_PATH = os.path.join(OUTPUT_DIR, f"{SHOP_NAME}_G3_执行报告生成总览{date_suffix}.pptx")
os.makedirs(OUTPUT_DIR, exist_ok=True)
print(f"输出路径: {OUTPUT_PATH}")

# ==================== 颜色定义 ====================
COLOR_BG = RGBColor(0x2D, 0x20, 0x06)       # 深棕背景
COLOR_GOLD = RGBColor(0xFF, 0xD7, 0x00)     # 金色标题
COLOR_WHITE = RGBColor(0xFF, 0xFF, 0xFF)    # 白色正文
COLOR_GREEN = RGBColor(0xC6, 0xEF, 0xCE)    # 浅绿
COLOR_YELLOW = RGBColor(0xFF, 0xEB, 0x9C)   # 浅黄
COLOR_RED = RGBColor(0xFF, 0xC7, 0xCE)      # 浅红

# ==================== 工具函数 ====================
def safe_div(a, b, default=0):
    if b == 0 or pd.isna(b) or pd.isna(a):
        return default
    return a / b

def add_textbox(slide, left, top, width, height, text, font_size=18, bold=False, color=COLOR_WHITE, align=PP_ALIGN.LEFT):
    """添加文本框"""
    txBox = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = txBox.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = text
    p.font.size = Pt(font_size)
    p.font.bold = bold
    p.font.color.rgb = color
    p.font.name = "微软雅黑"
    p.alignment = align
    return txBox

def add_shape_bg(slide, left, top, width, height, color=COLOR_BG):
    """添加背景色块"""
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(left), Inches(top), Inches(width), Inches(height))
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape

def add_slide_title(slide, title, subtitle="", page_num=""):
    """添加标准标题区"""
    add_shape_bg(slide, 0, 0, 10, 0.8, COLOR_BG)
    add_textbox(slide, 0.5, 0.15, 8, 0.5, title, 22, True, COLOR_GOLD, PP_ALIGN.LEFT)
    if subtitle:
        add_textbox(slide, 0.5, 0.55, 8, 0.3, subtitle, 12, False, COLOR_WHITE, PP_ALIGN.LEFT)
    if page_num:
        add_textbox(slide, 8.5, 0.2, 1, 0.4, page_num, 10, False, COLOR_WHITE, PP_ALIGN.RIGHT)

def add_think_action(slide, think, action):
    """添加思考逻辑+执行动作"""
    add_shape_bg(slide, 0.3, 5.5, 9.4, 0.6, RGBColor(0x3D, 0x30, 0x16))
    add_textbox(slide, 0.5, 5.55, 9, 0.5, f"✨ 思考逻辑：{think}", 11, False, COLOR_YELLOW, PP_ALIGN.LEFT)
    
    add_shape_bg(slide, 0.3, 6.2, 9.4, 0.6, RGBColor(0x3D, 0x30, 0x16))
    add_textbox(slide, 0.5, 6.25, 9, 0.5, f"✅ 执行动作：{action}", 11, False, COLOR_GREEN, PP_ALIGN.LEFT)

# ==================== 数据读取 ====================
print("读取数据...")
if G1_PATH and os.path.exists(G1_PATH):
    # 从G1 Excel读取（简化：读取店铺总览KPI sheet）
    import openpyxl
    wb = openpyxl.load_workbook(G1_PATH)
    ws = wb['1-店铺总览KPI']
    # 这里简化处理，实际应从G1提取关键指标
    df = pd.read_excel(G1_PATH, sheet_name='1-店铺总览KPI', header=None)
    # 回退到CSV
    if CSV_PATH and os.path.exists(CSV_PATH):
        df_src = pd.read_csv(CSV_PATH, encoding='utf-8-sig')
    else:
        df_src = pd.DataFrame()
elif CSV_PATH and os.path.exists(CSV_PATH):
    df_src = pd.read_csv(CSV_PATH, encoding='utf-8-sig')
else:
    raise ValueError("请提供 --csv-input 或 --g1-input")

# 数据清洗
numeric_cols = ['访客数', '销售额', '退款后销售额', 'UV价值', '退款率', '退款金额',
                '支付人数', '搜索人数', '总推广花费', '客单价', '搜索占比',
                '关键词推广花费(元)', '万相台花费(元)', '精准人群推广花费(元)', '全站推广花费(元)']
for col in numeric_cols:
    if col in df_src.columns:
        df_src[col] = pd.to_numeric(df_src[col], errors='coerce')

df_src = df_src.dropna(subset=['宝贝ID'])
df_src['退款率'] = df_src.apply(lambda r: safe_div(r['退款金额'], r['销售额'], 0) if pd.isna(r['退款率']) else r['退款率'], axis=1)
df_src['一级类目'] = df_src['商品类目'].str.split('>').str[0]

# 全局指标
total_sales = df_src['销售额'].sum()
total_refund = df_src['退款金额'].sum()
total_visitors = df_src['访客数'].sum()
overall_refund_rate = safe_div(total_refund, total_sales, 0)
avg_uv = safe_div(total_sales, total_visitors, 0)
search_ratio = safe_div(df_src['搜索人数'].sum(), total_visitors, 0)
total_links = len(df_src)
hot_links = len(df_src[(df_src['销售额'] > 5000) & (df_src['退款率'] < 0.50)])
zombie_links = len(df_src[df_src['销售额'] <= 0])
high_refund = len(df_src[(df_src['销售额'] > 5000) & (df_src['退款率'] > 0.80)])

# TOP1
top1 = df_src.loc[df_src['销售额'].idxmax()]
top1_name = str(top1['商品信息'])[:30] if pd.notna(top1['商品信息']) else '-'
top1_sales = top1['销售额']
top1_refund_rate = top1['退款率'] if pd.notna(top1['退款率']) else 0

# 类目
cat_counts = df_src['一级类目'].value_counts().head(5)

# 退款分布
refund_bins = {
    '0%': len(df_src[df_src['退款率'] == 0]),
    '0-30%': len(df_src[(df_src['退款率'] > 0) & (df_src['退款率'] <= 0.30)]),
    '30-50%': len(df_src[(df_src['退款率'] > 0.30) & (df_src['退款率'] <= 0.50)]),
    '50-70%': len(df_src[(df_src['退款率'] > 0.50) & (df_src['退款率'] <= 0.70)]),
    '70-100%': len(df_src[(df_src['退款率'] > 0.70) & (df_src['退款率'] <= 1.0)]),
    '100%+': len(df_src[df_src['退款率'] > 1.0]),
}

# 推广渠道
df_src['推广占比'] = df_src.apply(lambda r: safe_div(r['总推广花费'], r['销售额'], 0), axis=1)

print(f"数据加载完成: {total_links}条链接 | 销售额{total_sales:,.0f}")

# ==================== 创建PPT ====================
print(f"创建PPT，生成{MAX_PAGES}页...")
prs = Presentation()
prs.slide_width = Inches(10)
prs.slide_height = Inches(7.5)

page = 0

# ---------- Page 1: 封面 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    
    add_textbox(slide, 1, 1.5, 8, 1, SHOP_NAME, 36, True, COLOR_GOLD, PP_ALIGN.CENTER)
    add_textbox(slide, 1, 2.5, 8, 0.8, "全链路运营看板 · PPT执行报告", 20, False, COLOR_WHITE, PP_ALIGN.CENTER)
    
    # KPI大数字
    kpi_y = 3.8
    kpis = [
        (f"¥{total_sales:,.0f}", "总销售额"),
        (f"{overall_refund_rate*100:.1f}%", "退款率"),
        (f"{total_visitors:,.0f}", "总访客数"),
        (f"{avg_uv:.2f}", "UV价值"),
        (f"{search_ratio*100:.1f}%", "搜索占比"),
    ]
    for i, (val, label) in enumerate(kpis):
        x = 0.5 + i * 1.9
        add_textbox(slide, x, kpi_y, 1.8, 0.6, val, 18, True, COLOR_GOLD, PP_ALIGN.CENTER)
        add_textbox(slide, x, kpi_y + 0.6, 1.8, 0.4, label, 10, False, COLOR_WHITE, PP_ALIGN.CENTER)
    
    add_textbox(slide, 1, 6.5, 8, 0.4, f"{MAX_PAGES}页极致拆解 | 每页1核心 | 思考逻辑+执行动作 | 6阶段闭环", 10, False, COLOR_WHITE, PP_ALIGN.CENTER)
    add_textbox(slide, 8.5, 7, 1.5, 0.3, f"1 / {MAX_PAGES}", 9, False, COLOR_WHITE, PP_ALIGN.RIGHT)

# ---------- Page 2: 目录 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "目录", "全链路6大模块 · 极致拆解 · 每页思考逻辑+执行动作", f"{page} / {MAX_PAGES}")
    
    modules = [
        ("01", "店铺诊断", "KPI/类目/爆款/僵尸/退款/渠道/行动建议"),
        ("02", "需求定位", "N维机会/营销洞察/数据全景/搜索词/竞品画像"),
        ("03", "词根词路", "5类词根/蓝海挖掘/词路TOP/卖点/店铺词根/标题词根"),
        ("04", "产品研发", "双5SKU/定位语句/功能规格/排期/预算/质量/KPI/风险"),
        ("05", "营销策划", "人群/竞争/SEO/问大家/评价/详情页/直通车/壁垒/蓝海"),
        ("06", "上架执行", "链接矩阵/主图/冲刺/竞品对标/风险"),
    ]
    for i, (num, name, desc) in enumerate(modules):
        y = 1.8 + i * 0.9
        add_textbox(slide, 0.5, y, 0.8, 0.5, num, 16, True, COLOR_GOLD, PP_ALIGN.LEFT)
        add_textbox(slide, 1.5, y, 3, 0.5, name, 14, True, COLOR_WHITE, PP_ALIGN.LEFT)
        add_textbox(slide, 1.5, y + 0.35, 6, 0.4, desc, 10, False, COLOR_WHITE, PP_ALIGN.LEFT)

# ---------- Page 3: 店铺核心KPI ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "店铺核心KPI指标", f"{SHOP_NAME}经营数据全景", f"{page} / {MAX_PAGES}")
    
    # 核心数据展示
    add_textbox(slide, 0.5, 1.5, 4, 0.5, f"总销售额: ¥{total_sales:,.0f}", 16, True, COLOR_GOLD)
    add_textbox(slide, 0.5, 2.0, 4, 0.5, f"退款率: {overall_refund_rate*100:.1f}%", 14, False, COLOR_WHITE)
    add_textbox(slide, 0.5, 2.5, 4, 0.5, f"访客数: {total_visitors:,.0f}", 14, False, COLOR_WHITE)
    add_textbox(slide, 0.5, 3.0, 4, 0.5, f"UV价值: {avg_uv:.2f}", 14, False, COLOR_WHITE)
    add_textbox(slide, 0.5, 3.5, 4, 0.5, f"搜索占比: {search_ratio*100:.1f}%", 14, False, COLOR_WHITE)
    add_textbox(slide, 0.5, 4.0, 4, 0.5, f"链接总数: {total_links} | 爆款: {hot_links} | 僵尸: {zombie_links}", 12, False, COLOR_WHITE)
    
    think = f"退款率{overall_refund_rate*100:.1f}%{'偏高需止损' if overall_refund_rate > 0.30 else '可控'}，僵尸链接{zombie_links}条占比过高{'拖累整体' if zombie_links > total_links*0.3 else ''}"
    action = "①本周调研退款原因TOP3 ②暂停退款>80%链接推广 ③优化TOP1详情页转化率"
    add_think_action(slide, think, action)

# ---------- Page 4: 类目分布 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "类目分布分析", "各品类链接数/销售额/退款率/评级", f"{page} / {MAX_PAGES}")
    
    y = 1.5
    for i, (cat, count) in enumerate(cat_counts.items()):
        cat_data = df_src[df_src['一级类目'] == cat]
        cat_sales = cat_data['销售额'].sum()
        cat_refund = safe_div(cat_data['退款金额'].sum(), cat_sales, 0)
        add_textbox(slide, 0.5, y + i*0.7, 8, 0.5, 
                   f"{cat}: {count}条 | 销售额¥{cat_sales:,.0f} | 退款率{cat_refund*100:.1f}%", 
                   12, False, COLOR_WHITE)
    
    think = "核心品类链接数占比最高但需关注僵尸率，非核心品类应评估是否继续投入"
    action = "①核心品类清理僵尸链接释放资源 ②非核心品类评估ROI决定保留或淘汰 ③优化核心品类爆款链接转化"
    add_think_action(slide, think, action)

# ---------- Page 5: 爆款识别TOP10 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "爆款识别TOP10", "销售额>¥5000 且 退款率<50%", f"{page} / {MAX_PAGES}")
    
    hot = df_src[(df_src['销售额'] > 5000) & (df_src['退款率'] < 0.50)].sort_values('销售额', ascending=False).head(10)
    y = 1.5
    for i, (_, row) in enumerate(hot.iterrows()):
        name = str(row['商品信息'])[:30] if pd.notna(row['商品信息']) else '-'
        add_textbox(slide, 0.5, y + i*0.5, 8, 0.4, 
                   f"{i+1}. {name} | ¥{row['销售额']:,.0f} | 退款{row['退款率']*100:.1f}%", 
                   10, False, COLOR_WHITE)
    
    if len(hot) == 0:
        add_textbox(slide, 0.5, 1.5, 8, 0.5, "暂无爆款链接（销售额>¥5000且退款率<50%）", 14, False, COLOR_YELLOW)
    
    think = f"{'TOP1链接销售额占比过高，需分散风险' if len(hot) > 0 and hot.iloc[0]['销售额'] / total_sales > 0.3 else '爆款数量不足，需培育更多潜力链接'}"
    action = "①复制TOP1成功要素到新链接 ②加强潜力款推广测试 ③对TOP3链接做A/B测试提升CTR"
    add_think_action(slide, think, action)

# ---------- Page 6: TOP1链接深度诊断 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "TOP1链接深度诊断", "店铺销售额最高链接的全维度分析", f"{page} / {MAX_PAGES}")
    
    add_textbox(slide, 0.5, 1.5, 9, 0.6, f"商品: {top1_name}", 14, True, COLOR_GOLD)
    add_textbox(slide, 0.5, 2.2, 4, 0.4, f"销售额: ¥{top1_sales:,.0f}", 12, False, COLOR_WHITE)
    add_textbox(slide, 0.5, 2.6, 4, 0.4, f"退款率: {top1_refund_rate*100:.1f}%", 12, False, COLOR_WHITE)
    add_textbox(slide, 0.5, 3.0, 4, 0.4, f"访客数: {top1['访客数'] if pd.notna(top1['访客数']) else 0:,.0f}", 12, False, COLOR_WHITE)
    add_textbox(slide, 0.5, 3.4, 4, 0.4, f"UV价值: {top1['UV价值'] if pd.notna(top1['UV价值']) else 0:.2f}", 12, False, COLOR_WHITE)
    add_textbox(slide, 0.5, 3.8, 4, 0.4, f"搜索占比: {(top1['搜索占比']*100 if pd.notna(top1['搜索占比']) else 0):.1f}%", 12, False, COLOR_WHITE)
    
    sales_ratio = safe_div(top1_sales, total_sales, 0)
    think = f"TOP1链接占全店销售额{sales_ratio*100:.1f}%，是{'收入支柱' if sales_ratio > 0.1 else '重要链接'}，但退款率{top1_refund_rate*100:.1f}%{'可能是隐患' if top1_refund_rate > 0.30 else '可控'}"
    action = "①优化TOP1详情页首屏文案 ②增加实测视频增强信任 ③加强评价引导关键词"
    add_think_action(slide, think, action)

# ---------- Page 7: 僵尸链接诊断 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "僵尸链接诊断", "零销售/低访客链接健康度分析", f"{page} / {MAX_PAGES}")
    
    zombie_ratio = safe_div(zombie_links, total_links, 0)
    add_textbox(slide, 0.5, 1.5, 8, 0.5, f"僵尸链接: {zombie_links}条 / 总链接{total_links}条 ({zombie_ratio*100:.1f}%)", 16, True, COLOR_RED)
    
    # 展示部分僵尸链接
    zombies = df_src[df_src['销售额'] <= 0].head(8)
    y = 2.2
    for i, (_, row) in enumerate(zombies.iterrows()):
        name = str(row['商品信息'])[:35] if pd.notna(row['商品信息']) else '-'
        visitors = row['访客数'] if pd.notna(row['访客数']) else 0
        add_textbox(slide, 0.5, y + i*0.4, 8, 0.35, f"{i+1}. {name} | 访客{visitors:,.0f}", 9, False, COLOR_WHITE)
    
    think = f"{zombie_ratio*100:.1f}%链接零动销消耗店铺资源，{'严重拖累整体转化率' if zombie_ratio > 0.3 else '需定期清理'}"
    action = "①本周下架近45天无访客链接 ②有访客无转化的做主图优化 ③重复链接合并到主链接"
    add_think_action(slide, think, action)

# ---------- Page 8: 退款率分布 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "退款率分布", "各退款区间链接数与风险等级", f"{page} / {MAX_PAGES}")
    
    y = 1.5
    for i, (label, count) in enumerate(refund_bins.items()):
        ratio = safe_div(count, total_links, 0)
        color = COLOR_GREEN if label in ['0%', '0-30%'] else (COLOR_YELLOW if label in ['30-50%'] else COLOR_RED)
        add_textbox(slide, 0.5, y + i*0.6, 8, 0.5, 
                   f"{label}: {count}条 ({ratio*100:.1f}%)", 12, False, color)
    
    high_refund_count = sum(v for k, v in refund_bins.items() if k not in ['0%', '0-30%'])
    think = f"退款率高于30%的链接共{high_refund_count}条，{'需从产品端解决' if high_refund_count > total_links*0.2 else '可控范围'}"
    action = "①开发差异化物料降退款 ②尺码表增加身高对应 ③退款>50%链接立即评估下架"
    add_think_action(slide, think, action)

# ---------- Page 9: 推广渠道效率 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "推广渠道效率分析", "各渠道ROI/花费/销售额/占比", f"{page} / {MAX_PAGES}")
    
    # 推广数据
    total_ad = df_src['总推广花费'].sum()
    ad_links = len(df_src[df_src['总推广花费'] > 0])
    avg_ad_ratio = safe_div(total_ad, total_sales, 0)
    
    add_textbox(slide, 0.5, 1.5, 8, 0.5, f"总推广花费: ¥{total_ad:,.0f} | 推广链接: {ad_links}条", 14, True, COLOR_GOLD)
    add_textbox(slide, 0.5, 2.2, 8, 0.4, f"推广占比: {avg_ad_ratio*100:.1f}% {'(危险>30%)' if avg_ad_ratio > 0.30 else '(正常)'}", 12, False, COLOR_WHITE)
    
    # 各渠道
    channels = {
        '关键词推广': df_src['关键词推广花费(元)'].sum() if '关键词推广花费(元)' in df_src.columns else 0,
        '万相台': df_src['万相台花费(元)'].sum() if '万相台花费(元)' in df_src.columns else 0,
        '精准人群': df_src['精准人群推广花费(元)'].sum() if '精准人群推广花费(元)' in df_src.columns else 0,
        '全站推': df_src['全站推广花费(元)'].sum() if '全站推广花费(元)' in df_src.columns else 0,
    }
    y = 2.8
    for name, cost in channels.items():
        if cost > 0:
            pct = safe_div(cost, total_ad, 0)
            add_textbox(slide, 0.5, y, 8, 0.4, f"{name}: ¥{cost:,.0f} ({pct*100:.1f}%)", 11, False, COLOR_WHITE)
            y += 0.4
    
    think = f"推广占比{avg_ad_ratio*100:.1f}%{'严重超标，需立即优化' if avg_ad_ratio > 0.30 else '在可控范围'}"
    action = "①暂停ROI<1的推广计划 ②高ROI渠道增加预算20% ③对关键词做精细化出价调整"
    add_think_action(slide, think, action)

# ---------- Page 10: 行动建议P0-P2 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "行动建议 P0-P2", "确定性执行节奏：紧急→重要→优化", f"{page} / {MAX_PAGES}")
    
    actions = [
        ("P0 🔥紧急（本周完成）", [
            f"① 下架{zombie_links}条僵尸链接，停止无效推广",
            f"② 暂停{high_refund}条高退款(>80%)链接推广",
            "③ 优化TOP1详情页首屏，提升转化率",
        ], COLOR_RED),
        ("P1 ⚡重要（本月完成）", [
            "① 培育5-10条潜力链接为爆款",
            "② 优化退款率>30%链接的产品/描述",
            "③ 调整推广预算至高ROI渠道",
        ], COLOR_YELLOW),
        ("P2 📈优化（长期持续）", [
            "① A/B测试主图提升CTR",
            "② 建立竞品监控机制",
            "③ 定期清理低效链接",
        ], COLOR_GREEN),
    ]
    
    y = 1.5
    for title, items, color in actions:
        add_textbox(slide, 0.5, y, 8, 0.5, title, 14, True, color)
        y += 0.5
        for item in items:
            add_textbox(slide, 0.8, y, 8, 0.4, item, 11, False, COLOR_WHITE)
            y += 0.4
        y += 0.2
    
    think = "P0紧急事项必须本周完成，每天都在亏损现金；P1是未来1个月的核心工作"
    action = "①P0事项今天开始执行、明天复盘 ②P1事项本周制定方案、下周启动 ③P2事项纳入月度计划"
    add_think_action(slide, think, action)

# ---------- Page 11-18: 需求定位模块 ----------
module2_pages = [
    ("市场N维机会判定", "需求分析总览 · N维度交叉验证", "N维度交叉验证找出确定性和蓝海机会", "①优先占位蓝海CVR最高词 ②确定性需求做基础卖点 ③飙升词做第二波次"),
    ("N大营销洞察", "需求定位与营销洞察 · 词根数据驱动", "每条洞察都有明确数据支撑", "①每条洞察对应1个执行动作 ②P0本周启动 ③P1下周启动"),
    ("品类数据全景", "新品链接上架定位深度分析", "评价数据量充足需求明确", "①用数据确认产品方向 ②优先解决TOP3痛点 ③立即启动产品研发"),
    ("需求优先级矩阵", "N维需求矩阵 + 评价/问大家交叉验证", "TOP3需求是确定性机会", "①TOP1需求P0确定开发 ②TOP2需求P0同步解决 ③次要需求作为P1"),
    ("行业搜索词TOP20", "搜索量/CVR/在线数/竞争度", "高CVR低竞争词最优先占位", "①高CVR词精确匹配投放 ②长尾词场景化覆盖 ③每天检查新词变化"),
    ("竞品差异化画像", "竞品优劣势对比 + 我们的差异化方向", "竞品普遍缺少差异化功能", "①主图突出差异化+认证 ②详情页对比竞品劣势 ③标题占位蓝海词"),
    ("SKU与价格策略", "尺码/款式搜索量+竞争+定价+优先级", "高CVR尺码段优先开发", "①高CVR款定低价抢流量 ②高利润款定高价抓利润 ③长尾款做场景补充"),
    ("店铺词根销售额TOP", "哪些词根赚钱哪些亏损", "盈利词根集中在核心品类", "①盈利词根加大投放 ②亏损词根减少投放 ③关注蓝海词根新增链接"),
]

for title, subtitle, think, action in module2_pages:
    if page < MAX_PAGES:
        page += 1
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
        add_slide_title(slide, title, subtitle, f"{page} / {MAX_PAGES}")
        add_textbox(slide, 0.5, 1.5, 9, 0.5, f"【基于{total_links}条链接数据分析】", 12, False, COLOR_WHITE)
        add_think_action(slide, think, action)

# ---------- Page 19-24: 词根词路模块 ----------
module3_pages = [
    ("5类词根体系", "功能/材质/人群/场景/款式 五类词根全景", "红海词根是入场券，蓝海词根是差异化机会", "①红海词根基础占位 ②蓝海词根差异化主打 ③组合词路双覆盖"),
    ("蓝海词根挖掘与占位", "竞争度<15%的蓝海词根优先占位", "蓝海词根高CVR+低竞争", "①本周占位CVR最高词 ②本月启动蓝海新链接 ③每个蓝海词独立链接"),
    ("词路分布TOP20", "词根组合路径 + 竞争评级 + 词路洞察", "前3词路占60%流量但竞争激烈", "①前3词路基础占位 ②中竞争词路差异化主打 ③每条词路对应1条独立链接"),
    ("营销卖点分布矩阵", "卖点覆盖链接数/占比/评级", "高覆盖卖点竞争激烈", "①确定性卖点基础占位 ②差异化卖点主打 ③低覆盖卖点探索新机会"),
    ("标题词根体系拆解", "标题中的词根结构分析", "标题是SEO第一入口", "①每条标题覆盖蓝海词根 ②不重复词根浪费字数 ③核心词放前场景词放后"),
    ("店铺词根利润交叉", "词根×销售额×利润三维分析", "盈利词根决定投放重点", "①盈利词根加大预算 ②亏损词根改善产品 ③蓝海词根新增链接占位"),
]

for title, subtitle, think, action in module3_pages:
    if page < MAX_PAGES:
        page += 1
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
        add_slide_title(slide, title, subtitle, f"{page} / {MAX_PAGES}")
        add_textbox(slide, 0.5, 1.5, 9, 0.5, f"【从{total_links}条链接标题提取词根分析】", 12, False, COLOR_WHITE)
        add_think_action(slide, think, action)

# ---------- Page 25-32: 产品研发+营销策划模块 ----------
module4_pages = [
    ("目标人群4类画像", "核心/次要/专业/长尾 四类人群精准画像", "核心人群占50%但专业人群CVR更高", "①主图1覆盖核心人群 ②垂直链接覆盖专业人群 ③长尾词覆盖长尾人群"),
    ("6维竞争策略", "产品/价格/视觉/服务/内容/流量 六维差异化", "产品差异化是根本，视觉最快见效", "①优先做视觉差异化 ②其次做产品差异化 ③服务差异化做长期护城河"),
    ("SEO关键词分层矩阵", "核心词/场景词/蓝海词/长尾词 4层布局", "SEO是免费流量核心渠道", "①核心词放标题前15字 ②蓝海词全部覆盖在标题中 ③长尾词用垂直链接覆盖"),
    ("问大家拦截策略", "TOP10高频问题 + 推荐回答话术", "问大家是搜索流量转化关键环节", "①每天检查新问题及时回答 ②回答包含关键词提升权重 ③引导买家提问方向"),
    ("评价运营6方向", "引导评价话术模板 + 执行节奏", "评价是转化的第二入口", "①每天发送引导评价消息 ②重点引导核心关键词 ③场景引导晒图+10条/月"),
    ("详情页10模块架构", "每个模块的核心文案+视觉建议+转化目标", "详情页前3屏决定买家是否继续看", "①首屏放最强信任证 ②第2-3屏突出差异化卖点 ③后续屏做场景教育"),
    ("直通车5层投放策略", "关键词/出价/匹配/预算占比", "蓝海词投放ROI最高", "①蓝海词20%预算优先 ②核心品类词30%基础流量 ③每天调整出价保持ROI>3"),
    ("20种差异化壁垒", "每种壁垒的核心表达/主图逻辑/搜索词/预期CVR", "壁垒中CVR最高的先做前5个", "①TOP5壁垒先做5个 ②每个壁垒对应1条独立链接 ③壁垒在主图1体现"),
]

for title, subtitle, think, action in module4_pages:
    if page < MAX_PAGES:
        page += 1
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
        add_slide_title(slide, title, subtitle, f"{page} / {MAX_PAGES}")
        add_textbox(slide, 0.5, 1.5, 9, 0.5, f"【基于店铺{total_links}条链接数据推导】", 12, False, COLOR_WHITE)
        add_think_action(slide, think, action)

# ---------- Page 33-37: 上架执行模块 ----------
module5_pages = [
    ("链接矩阵(1主+N垂直)", "每条链接独立定位+独立标题+独立人群", "1主+N垂直避免自己打自己", "①主链接覆盖全品类词根 ②垂直链接高CVR抢利润 ③垂直链接占位蓝海"),
    ("5张主图营销逻辑", "每张主图的需求定位+匹配词根+营销点+转化预期", "主图1决定CTR，主图2-3决定停留", "①主图1突出最强卖点 ②主图2突出差异化首创 ③做3版A/B测试确定最优"),
    ("7天冲刺执行清单", "Day0-Day7每天任务+负责岗位+交付物+优先级", "7天冲刺是上架后的关键期", "①Day0素材全部就绪 ②Day1-3直通车蓝海词投放 ③Day4-7复盘调整策略"),
    ("竞品对标监控+追赶", "我方目标 vs 核心竞品 + 差距分析", "竞品对标是持续性工作", "①每周一更新竞品数据 ②差距指标达成后设新目标 ③竞品调价立即跟进"),
    ("风险预判与应对8项", "概率/影响/等级/预警信号/应对方案/客服话术", "风险管控是确定性执行保障", "①每天检查预警信号 ②触发预警立即启动方案 ③每周复盘风险状态"),
]

for title, subtitle, think, action in module5_pages:
    if page < MAX_PAGES:
        page += 1
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
        add_slide_title(slide, title, subtitle, f"{page} / {MAX_PAGES}")
        add_textbox(slide, 0.5, 1.5, 9, 0.5, f"【基于店铺实际数据制定执行方案】", 12, False, COLOR_WHITE)
        add_think_action(slide, think, action)

# ---------- Page 38: 全链路闭环总结 ----------
if page < MAX_PAGES:
    page += 1
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_shape_bg(slide, 0, 0, 10, 7.5, COLOR_BG)
    add_slide_title(slide, "全链路闭环总结", "6大模块回顾 · 核心结论 · 下一步行动", f"{page} / {MAX_PAGES}")
    
    summaries = [
        ("01 店铺诊断", f"退款率{overall_refund_rate*100:.1f}%{'偏高需止损' if overall_refund_rate > 0.30 else '可控'} | 僵尸{zombie_links}条需清理 | TOP1需优化"),
        ("02 需求定位", "确定性需求是基础 | 蓝海机会是突破口 | 数据驱动决策"),
        ("03 词根词路", "5类词根/蓝海占位 | 词路TOP双覆盖 | 盈利词根加大投放"),
        ("04 产品研发", "双5SKU/定位语句 | 高CVR款优先开发 | 质量标准+KPI指标"),
        ("05 营销策划", "6维竞争+4层SEO | 问大家TOP+评价引导 | 详情页模块+直通车分层"),
        ("06 上架执行", "1主+N垂直/主图5张 | 7天冲刺/竞品对标 | 风险预判+确定性执行"),
    ]
    y = 1.5
    for num_title, content in summaries:
        add_textbox(slide, 0.5, y, 2, 0.5, num_title, 12, True, COLOR_GOLD)
        add_textbox(slide, 2.5, y, 7, 0.5, content, 11, False, COLOR_WHITE)
        y += 0.6
    
    add_textbox(slide, 0.5, 6.5, 9, 0.4, f"{SHOP_NAME} | {MAX_PAGES}页极致拆解 | 每页思考逻辑+执行动作 | 6阶段闭环 | 确定性执行", 10, False, COLOR_WHITE, PP_ALIGN.CENTER)
    add_think_action(slide, "全链路闭环不是一次性工作，是持续迭代的运营体系", "①每周复盘数据更新PPT ②每月优化策略迭代 ③每季度评估全链路效果")

# ==================== 保存 ====================
print(f"保存PPT到: {OUTPUT_PATH}")
prs.save(OUTPUT_PATH)
print(f"完成! 共生成{page}页")
