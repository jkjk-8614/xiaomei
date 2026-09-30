#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A4-市场洞察·词路营销卖点拆解 - 通用分析脚本
技能编号: A4

用法:
    1. 修改下方"品类配置参数"区
    2. 运行脚本: uv run python build_A4.py
"""

import pandas as pd
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
import os
import sys
from collections import defaultdict

# ============================================================================
# 品类配置参数（换品类时只需修改此处）
# ============================================================================

CATEGORY_NAME = "亚麻裤男"                          # 品类名称
SEARCH_FILE = r"搜索需求分析.xlsx"                    # 搜索关键词文件路径
EVAL_FILE = r"评价汇总.xlsx"                          # 评价文件路径
OUTPUT_PATH = r"D:\宿主\表格\亚麻裤男_A4_词路营销卖点拆解.xlsx"

# 词根分类关键词库（按优先级降序排列）
KEYWORD_LIBS = {
    "品牌": ['优衣库', '无印良品', 'muji', '拉夫劳伦', 'zara', 'hm', '霞湖世家', '恒源祥', '罗蒙', '名创优品', 'ur', '啄木鸟', '山东', '法国'],
    "材质": ['天丝', '莱赛尔', '冰丝', '桑蚕丝', '真丝', '雨露', '纯亚麻', '百分百亚麻', '重磅', '高支高密', '人字纹', '条纹', '棉麻', '苎麻'],
    "风格": ['老钱风', '中国风', '日系', '韩版', '欧美', '复古', '简约', '商务', '休闲风', 'ins风', '潮牌', '外贸', '高端', '高档'],
    "人群": ['儿童', '大童', '青少年', '中老年', '高个子', '小个子', '大码', '加肥加大', '胖子', '瘦子', '学生', '青年', '中年'],
    "场景": ['休闲', '旅游', '出差', '上班', '居家', '户外', '度假', '旅行'],
    "颜色": ['白色', '黑色', '灰色', '卡其色', '蓝色', '藏青色', '浅卡其', '米色', '驼色', '军绿', '酒红', '棕色'],
    "款式": ['直筒', '宽松', '修身', '束脚', '阔腿', '小脚', '锥形', '哈伦', '九分', '七分', '八分', '加长', '高腰', '松紧腰', '拉链口袋'],
    "功能": ['薄款', '夏薄款', '轻薄款', '透气', '抗皱', '垂感', '小个子', '高个子', '大码', '加肥加大', '宽松大码', '加长款', '加肥', '加大'],
}

# 评价痛点关键词库
PAIN_KEYWORDS = {
    '皱/易皱': ['皱', '褶皱', '起皱', '易皱'],
    '缩水': ['缩水', '变小', '缩短'],
    '掉色/褪色': ['掉色', '褪色', '染色'],
    '质量差': ['质量差', '质量不好', '烂', '稀烂', '破洞', '烂个洞'],
    '面料差/不纯': ['面料差', '料子差', '料子挺差', '不是亚麻', '不是亚麻布料', '麻含量低', '麻含量1%'],
    '尺码不准': ['尺码不准', '尺码不合适', '偏大', '偏小', '裤长偏长', '裤腿偏宽'],
    '做工差': ['做工差', '走线不好', '线头', '多余的线头', '做工一般', '小瑕疵'],
    '太薄/透': ['太薄', '透', '透明'],
    '扎人/刺痒': ['扎人', '扎', '刺激皮肤'],
    '版型差': ['版型差', '不好看', '显胖'],
    '闷热不透气': ['闷热', '闷', '不透气'],
    '色差': ['色差', '颜色不同', '颜色不正'],
    '起球': ['起球', '起毛'],
    '变形': ['变形', '走形'],
}

# 正面评价关键词库
POS_KEYWORDS = {
    '舒适/柔软': ['舒适', '舒服', '亲肤', '手感好', '柔软'],
    '透气/凉快': ['透气', '凉快', '凉爽', '清爽', '不闷', '不闷热'],
    '版型好/显瘦': ['版型好', '显瘦', '显腿长', '百搭'],
    '质感好': ['质感', '有质感', '高级感', '品质好'],
    '轻薄': ['轻薄', '轻'],
    '做工好': ['做工好', '做工精细', '没有线头'],
    '垂感': ['垂感', '有垂感'],
    '不缩水': ['不缩水', '没缩水', '不变形'],
    '不掉色': ['不掉色', '没掉色', '不褪色'],
    '性价比高': ['性价比', '物有所值', '便宜', '实惠'],
}

# 竞品信息（Sheet5）
COMPETITORS = [
    {
        "品牌": "优衣库",
        "定位": "基础款+品质",
        "核心卖点": "基础款+品质感+高性价比",
        "标题模式": "优衣库亚麻裤男夏季薄款直筒",
        "词路特征": "基础/直筒/薄款/品质",
        "优势": "品牌认知强+品质稳定",
        "劣势": "款式单一/无差异化设计",
    },
    {
        "品牌": "无印良品",
        "定位": "简约+自然",
        "核心卖点": "简约设计+天然材质+MUJI风",
        "标题模式": "无印良品亚麻裤男夏季宽松",
        "词路特征": "简约/宽松/天然/MUJI",
        "优势": "品牌调性+简约设计",
        "劣势": "价格高/款式少",
    },
    {
        "品牌": "MUJI",
        "定位": "极简+环保",
        "核心卖点": "极简设计+环保材质+舒适",
        "标题模式": "muji亚麻裤男夏季直筒",
        "词路特征": "极简/环保/直筒/舒适",
        "优势": "品牌忠诚度+环保理念",
        "劣势": "价格高/款式单一",
    },
]

# 洞察文案（Sheet1 底部）
INSIGHTS = [
    "洞察1: 核心品类词人气最高但处于红海，需通过差异化词路突围",
    "洞察2: 薄款/夏薄款为功能第一大词路，夏季轻薄透气是核心功能诉求",
    "洞察3: 天丝材质词路人气领先，天丝+亚麻组合成为材质升级方向",
    "洞察4: 老钱风风格词路异军突起，风格差异化是蓝海机会",
    "洞察5: 大码/加肥加大人群词路转化率高，大码人群是黄金细分市场",
    "洞察6: 白色亚麻裤颜色词路人气领先，浅色系是夏季视觉差异化方向",
]

# 差异化切入点（Sheet5）
DIFFERENTIATION_POINTS = [
    ["切入点1", "天丝凉感 vs 普通亚麻", "天丝+亚麻混纺，凉感提升50%，夏季更清爽", "优衣库/无印良品普通亚麻闷热", "亚麻裤男天丝凉感夏季薄款直筒宽松透气", "天丝面料特写+凉感测试+夏季场景", "凉感数据+混纺工艺+透气测试+夏季穿搭"],
    ["切入点2", "抗皱免烫 vs 易皱亚麻", "抗皱处理工艺，久坐不起皱，易打理", "传统亚麻易皱难打理", "亚麻裤男夏季抗皱免烫直筒宽松薄款", "抗皱对比图+久坐测试+免烫标识", "抗皱工艺+免烫测试+打理指南+对比图"],
    ["切入点3", "天丝+莱赛尔 vs 纯亚麻", "天丝+莱赛尔+亚麻三重材质，柔软+环保+透气", "竞品单一材质功能局限", "亚麻裤男天丝莱赛尔夏季薄款直筒宽松", "三重材质剖面+柔软度测试+环保认证", "材质对比+柔软度数据+环保认证+工艺展示"],
    ["切入点4", "大码专属 vs 泛人群", "大码宽松直筒+薄款透气，专为大码人群设计", "竞品无大码专属款", "亚麻裤男夏季薄款宽松直筒大码透气", "大码模特上身+宽松版型+透气场景", "尺码表+大码展示+版型细节+透气测试"],
    ["切入点5", "老钱风颜值 vs 基础款", "老钱风设计+5色可选，颜值与品质兼具", "竞品均为基础款无设计感", "亚麻裤男老钱风夏季薄款直筒宽松休闲", "老钱风穿搭场景+5色展示+质感特写", "老钱风搭配+5色实拍+穿搭场景+质感细节"],
    ["切入点6", "加长款高个子 vs 标准款", "加长款设计，专为大长腿高个子男士", "竞品无加长款", "亚麻裤男夏季薄款加长直筒高个子休闲", "加长款平铺+高个子模特+长度对比", "尺码表+加长数据+高个子展示+长度对比"],
]

# ============================================================================
# 通用框架函数（以下逻辑换品类时无需修改）
# ============================================================================

# -------------------- 样式函数 --------------------
def apply_title_style(cell, text, font_size=14, font_color="FFFFFF", fill_color="2D2006"):
    cell.value = text
    cell.font = Font(name="微软雅黑", size=font_size, bold=True, color=font_color)
    cell.fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

def apply_header_style(cell, text, fill_color="375623", font_color="FFFFFF"):
    cell.value = text
    cell.font = Font(name="微软雅黑", size=10, bold=True, color=font_color)
    cell.fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

def apply_data_style(cell, value, is_alt=False, align="center"):
    cell.value = value
    cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
    bg = "F5F5F0" if is_alt else "FFFFFF"
    cell.fill = PatternFill(start_color=bg, end_color=bg, fill_type="solid")
    cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)

def apply_insight_style(cell, text):
    cell.value = text
    cell.font = Font(name="微软雅黑", size=10, color="2D2006")
    cell.fill = PatternFill(start_color="FFF2CC", end_color="FFF2CC", fill_type="solid")
    cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)

# -------------------- 数据读取与清洗 --------------------
def load_and_clean_data(search_path, eval_path):
    """读取并清洗数据源"""
    df_search = pd.read_excel(search_path)
    df_eval = pd.read_excel(eval_path)

    numeric_cols = ['预估搜索人气', '预估支付转化率', '需求供给比', '天猫商品点击占比', '预估支付买家数']
    for col in numeric_cols:
        if col in df_search.columns:
            df_search[col] = pd.to_numeric(df_search[col], errors='coerce').fillna(0)

    return df_search, df_eval

# -------------------- 词根分类 --------------------
def classify_word(word, keyword_libs):
    """按优先级对搜索词进行分类"""
    word_lower = word.lower()
    priority = ["品牌", "材质", "风格", "人群", "场景", "颜色", "款式", "功能"]

    for cat in priority:
        for kw in keyword_libs.get(cat, []):
            if cat == "品牌" and kw in word_lower:
                return cat, kw
            if cat != "品牌" and kw in word:
                return cat, kw
    return "品类", CATEGORY_NAME

# -------------------- 词根汇总计算 --------------------
def aggregate_roots(word_data):
    """按词根汇总搜索数据，并按搜索人气加权平均"""
    root_stats = defaultdict(lambda: {
        'count': 0, 'pop': 0, 'cvr_sum': 0, 'supply_sum': 0,
        'tmall_sum': 0, 'buyers_sum': 0, 'category': ''
    })

    for w in word_data:
        r = w['root']
        s = root_stats[r]
        s['count'] += 1
        s['pop'] += w['pop']
        s['cvr_sum'] += w['cvr'] * w['pop']
        s['supply_sum'] += w['supply'] * w['pop']
        s['tmall_sum'] += w['tmall'] * w['pop']
        s['buyers_sum'] += w['buyers']
        s['category'] = w['category']

    cat_map = {
        '功能': '🔴功能', '款式': '🔵款式', '材质': '🟠材质',
        '人群': '🟡人群', '场景': '🟢场景', '风格': '🟣风格',
        '颜色': '⚪颜色', '品牌': '🔵品牌', '品类': '⚪品类'
    }

    root_list = []
    for r, s in root_stats.items():
        pop = s['pop']
        if pop > 0:
            avg_cvr = s['cvr_sum'] / pop * 100
            avg_supply = s['supply_sum'] / pop
            avg_tmall = s['tmall_sum'] / pop * 100
        else:
            avg_cvr = avg_supply = avg_tmall = 0

        if avg_supply == 0:
            blue = '⚪数据缺失'
        elif avg_supply > 10:
            blue = '💎轻竞争词路'
        elif avg_supply > 5:
            blue = '🟡中等竞争'
        else:
            blue = '🔴红海词路'

        root_list.append({
            'category': cat_map.get(s['category'], s['category']),
            'root': r, 'count': s['count'], 'pop': int(pop),
            'cvr': round(avg_cvr, 2), 'supply': round(avg_supply, 2),
            'tmall': round(avg_tmall, 1), 'buyers': int(s['buyers_sum']),
            'blue': blue
        })

    root_list.sort(key=lambda x: -x['pop'])
    return root_list

# -------------------- 评价统计 --------------------
def analyze_evaluation(df_eval, pain_keywords, pos_keywords):
    """统计评价痛点和正面评价"""
    total = len(df_eval)
    pain_counts = defaultdict(int)
    pos_counts = defaultdict(int)

    for _, row in df_eval.iterrows():
        if pd.isna(row.iloc[1]):
            continue
        text = str(row.iloc[1])

        for pain, kws in pain_keywords.items():
            if any(kw in text for kw in kws):
                pain_counts[pain] += 1
                break

        for pos, kws in pos_keywords.items():
            if any(kw in text for kw in kws):
                pos_counts[pos] += 1
                break

    pain_list = [(k, v, round(v / total * 100, 1)) for k, v in pain_counts.items()]
    pain_list.sort(key=lambda x: -x[1])

    pos_list = [(k, v, round(v / total * 100, 1)) for k, v in pos_counts.items()]
    pos_list.sort(key=lambda x: -x[1])

    return pain_list, pos_list, total

# -------------------- Excel 生成 --------------------
def create_sheet_overview(wb, root_list, category_name, insights):
    """Sheet1: 词路总览"""
    ws = wb.create_sheet("1-词路总览")

    apply_title_style(ws['A1'], f"{category_name} · 词路营销卖点拆解总览", 16, "FFD700", "2D2006")
    ws.merge_cells('A1:J1')
    ws.row_dimensions[1].height = 30

    apply_title_style(ws['A2'], "数据源：搜索关键词 + 评价数据", 10, "FFFFFF", "2D2006")
    ws.merge_cells('A2:J2')

    headers = ['排名', '词根类别', '词根/词路', '词数', '搜索人气', 'CVR(%)', '供给比', '天猫占比(%)', '买家数', '蓝海判定']
    for col, h in enumerate(headers, 1):
        apply_header_style(ws.cell(row=4, column=col), h)
    ws.row_dimensions[4].height = 25

    for i, r in enumerate(root_list[:50], 1):
        row = 4 + i
        is_alt = i % 2 == 0
        for col, key in enumerate(['', 'category', 'root', 'count', 'pop', 'cvr', 'supply', 'tmall', 'buyers', 'blue'], 1):
            if col == 1:
                apply_data_style(ws.cell(row=row, column=col), i, is_alt)
            else:
                apply_data_style(ws.cell(row=row, column=col), r[key], is_alt)

    # 洞察
    ir = 4 + min(50, len(root_list)) + 3
    apply_title_style(ws.cell(row=ir, column=1), "赛道词路核心洞察", 12, "FFD700", "2D2006")
    ws.merge_cells(f'A{ir}:J{ir}')

    for j, ins in enumerate(insights, 1):
        r = ir + j
        apply_insight_style(ws.cell(row=r, column=1), ins)
        ws.merge_cells(f'A{r}:J{r}')
        ws.row_dimensions[r].height = 25

    for col in range(1, 11):
        ws.column_dimensions[get_column_letter(col)].width = 14
    ws.column_dimensions['C'].width = 18

    return ws


def create_sheet_function(wb, root_list, pain_list, pos_list, total_eval):
    """Sheet2: 功能词路卖点映射"""
    ws = wb.create_sheet("2-🔴功能词路卖点映射")

    apply_title_style(ws['A1'], "🔴功能词路卖点映射 (痛点→卖点→文案→主图构思)", 14, "FFFFFF", "2D2006")
    ws.merge_cells('A1:I1')
    ws.row_dimensions[1].height = 30

    apply_title_style(ws['A3'], f"评价痛点→卖点映射 ({total_eval}条评价数据)", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells('A3:I3')

    ph = ['痛点', '条数', '占比', '对应功能词根', '卖点提炼', '文案话术', '主图构思', '详情页构思', '标题建议']
    for col, h in enumerate(ph, 1):
        apply_header_style(ws.cell(row=4, column=col), h, "1E3A5F")

    # 取TOP痛点（最多6个）
    top_pains = pain_list[:6]
    pain_data = []
    for p_name, p_count, p_pct in top_pains:
        pain_data.append([
            p_name, p_count, f"{p_pct}%", '-', '-', '-', '-', '-', '-'
        ])

    for i, row_data in enumerate(pain_data, 1):
        row = 4 + i
        is_alt = i % 2 == 0
        for col, val in enumerate(row_data, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt, "left" if col > 3 else "center")
        ws.row_dimensions[row].height = 35

    # 功能词路明细
    func_start = 4 + len(pain_data) + 3
    apply_title_style(ws.cell(row=func_start, column=1), "功能词路搜索数据明细", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells(f'A{func_start}:I{func_start}')

    fh = ['词根', '词数', '搜索人气', 'CVR(%)', '供给比', '天猫占比(%)', '蓝海判定', '痛点关联', '卖点方向']
    for col, h in enumerate(fh, 1):
        apply_header_style(ws.cell(row=func_start + 1, column=col), h, "1E3A5F")

    func_roots = [r for r in root_list if r['category'] == '🔴功能']
    func_roots.sort(key=lambda x: -x['pop'])

    for i, r in enumerate(func_roots, 1):
        row = func_start + 1 + i
        is_alt = i % 2 == 0
        vals = [r['root'], r['count'], r['pop'], r['cvr'], r['supply'], r['tmall'], r['blue'], '-', '-']
        for col, val in enumerate(vals, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt)

    # 正面评价映射
    pos_start = func_start + 1 + len(func_roots) + 3
    apply_title_style(ws.cell(row=pos_start, column=1), "正面评价→卖点方向映射", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells(f'A{pos_start}:E{pos_start}')

    ph2 = ['正面评价', '条数', '占比', '关联功能词根', '卖点方向']
    for col, h in enumerate(ph2, 1):
        apply_header_style(ws.cell(row=pos_start + 1, column=col), h, "1E3A5F")

    top_pos = pos_list[:6]
    for i, (p_name, p_count, p_pct) in enumerate(top_pos, 1):
        row = pos_start + 1 + i
        is_alt = i % 2 == 0
        vals = [p_name, p_count, f"{p_pct}%", '-', '-']
        for col, val in enumerate(vals, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt)

    for col in range(1, 10):
        ws.column_dimensions[get_column_letter(col)].width = 16
    ws.column_dimensions['F'].width = 22
    ws.column_dimensions['G'].width = 22
    ws.column_dimensions['H'].width = 22
    ws.column_dimensions['I'].width = 28

    return ws


def create_sheet_material(wb, root_list):
    """Sheet3: 材质词路卖点映射"""
    ws = wb.create_sheet("3-🟠材质词路卖点映射")

    apply_title_style(ws['A1'], "🟠材质词路卖点映射 (卖点→差异化→壁垒)", 14, "FFFFFF", "2D2006")
    ws.merge_cells('A1:K1')
    ws.row_dimensions[1].height = 30

    apply_title_style(ws['A3'], "材质词路搜索数据 + 卖点映射", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells('A3:K3')

    mh = ['词根', '词数', '搜索人气', 'CVR(%)', '供给比', '天猫占比(%)', '蓝海判定', '卖点提炼', '差异化方向', '壁垒策略', '标题建议']
    for col, h in enumerate(mh, 1):
        apply_header_style(ws.cell(row=4, column=col), h, "1E3A5F")

    mat_roots = [r for r in root_list if r['category'] == '🟠材质']
    mat_roots.sort(key=lambda x: -x['pop'])

    for i, r in enumerate(mat_roots, 1):
        row = 4 + i
        is_alt = i % 2 == 0
        vals = [r['root'], r['count'], r['pop'], r['cvr'], r['supply'], r['tmall'], r['blue'], '-', '-', '-', '-']
        for col, val in enumerate(vals, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt)

    # 材质壁垒策略
    barrier_start = 4 + len(mat_roots) + 3
    apply_title_style(ws.cell(row=barrier_start, column=1), "材质壁垒策略总结", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells(f'A{barrier_start}:E{barrier_start}')

    bh = ['壁垒类型', '具体策略', '核心材质词根', '竞争壁垒强度', '执行建议']
    for col, h in enumerate(bh, 1):
        apply_header_style(ws.cell(row=barrier_start + 1, column=col), h, "1E3A5F")

    barrier_data = [
        ['原料认证壁垒', '获取材质认证标识，主图强化背书', '-', '强', '认证标识+主图展示'],
        ['混纺工艺壁垒', '标注混纺比例，展示工艺对比', '-', '中', '工艺对比图+比例标注'],
        ['品质承诺壁垒', '质保承诺+售后保障', '-', '强', '质保标识+售后承诺详情页'],
    ]

    for i, bd in enumerate(barrier_data, 1):
        row = barrier_start + 1 + i
        is_alt = i % 2 == 0
        for col, val in enumerate(bd, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt, "left" if col > 1 else "center")

    for col in range(1, 12):
        ws.column_dimensions[get_column_letter(col)].width = 16
    ws.column_dimensions['K'].width = 32

    return ws


def create_sheet_persona_scene(wb, root_list):
    """Sheet4: 人群+场景词路组合"""
    ws = wb.create_sheet("4-🟡人群+🟢场景词路组合")

    apply_title_style(ws['A1'], "🟡人群 × 🟢场景词路组合 (链接定位→标题建议)", 14, "FFFFFF", "2D2006")
    ws.merge_cells('A1:H1')
    ws.row_dimensions[1].height = 30

    # 人群
    apply_title_style(ws['A3'], "人群词路搜索数据", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells('A3:H3')

    prh = ['词根', '词数', '搜索人气', 'CVR(%)', '供给比', '天猫占比(%)', '蓝海判定']
    for col, h in enumerate(prh, 1):
        apply_header_style(ws.cell(row=4, column=col), h, "1E3A5F")

    person_roots = [r for r in root_list if r['category'] == '🟡人群']
    person_roots.sort(key=lambda x: -x['pop'])

    for i, r in enumerate(person_roots, 1):
        row = 4 + i
        is_alt = i % 2 == 0
        vals = [r['root'], r['count'], r['pop'], r['cvr'], r['supply'], r['tmall'], r['blue']]
        for col, val in enumerate(vals, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt)

    # 场景
    scene_start = 4 + len(person_roots) + 3
    apply_title_style(ws.cell(row=scene_start, column=1), "场景词路搜索数据", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells(f'A{scene_start}:H{scene_start}')

    for col, h in enumerate(prh, 1):
        apply_header_style(ws.cell(row=scene_start + 1, column=col), h, "1E3A5F")

    scene_roots = [r for r in root_list if r['category'] == '🟢场景']
    scene_roots.sort(key=lambda x: -x['pop'])

    for i, r in enumerate(scene_roots, 1):
        row = scene_start + 1 + i
        is_alt = i % 2 == 0
        vals = [r['root'], r['count'], r['pop'], r['cvr'], r['supply'], r['tmall'], r['blue']]
        for col, val in enumerate(vals, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt)

    # 人群×场景组合
    combo_start = scene_start + 1 + len(scene_roots) + 3
    apply_title_style(ws.cell(row=combo_start, column=1), "人群 × 场景组合 → 链接定位 → 标题建议", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells(f'A{combo_start}:H{combo_start}')

    ch = ['链接编号', '人群定位', '场景定位', '款式定位', '核心卖点', '链接定位描述', '标题建议', '投放策略']
    for col, h in enumerate(ch, 1):
        apply_header_style(ws.cell(row=combo_start + 1, column=col), h, "1E3A5F")

    # 自动生成交叉组合（取前3人群 × 前2场景）
    combos = []
    for pi, pr in enumerate(person_roots[:3], 1):
        for si, sr in enumerate(scene_roots[:2], 1):
            combos.append([
                f"链接{len(combos)+1}", pr['root'], sr['root'], '-',
                f"{pr['root']}+{sr['root']}", '-', '-', '💎差异化-细分链接'
            ])

    for i, cd in enumerate(combos, 1):
        row = combo_start + 1 + i
        is_alt = i % 2 == 0
        for col, val in enumerate(cd, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt, "left" if col > 1 else "center")
        ws.row_dimensions[row].height = 30

    for col in range(1, 9):
        ws.column_dimensions[get_column_letter(col)].width = 16
    ws.column_dimensions['G'].width = 36
    ws.column_dimensions['H'].width = 20

    return ws


def create_sheet_competitor(wb, root_list, competitors, diff_points):
    """Sheet5: 竞品词路差异化策略"""
    ws = wb.create_sheet("5-竞品词路差异化策略")

    apply_title_style(ws['A1'], "竞品词路差异化策略 (品牌词路对比+差异化切入点)", 14, "FFFFFF", "2D2006")
    ws.merge_cells('A1:H1')
    ws.row_dimensions[1].height = 30

    apply_title_style(ws['A3'], f"竞品品牌3强：{'/'.join([c['品牌'] for c in competitors])}", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells('A3:H3')

    comp_h = ['品牌', '定位', '核心卖点', '标题模式', '词路特征', '优势', '劣势', '差异化切入点']
    for col, h in enumerate(comp_h, 1):
        apply_header_style(ws.cell(row=4, column=col), h, "1E3A5F")

    for i, c in enumerate(competitors, 1):
        row = 4 + i
        is_alt = i % 2 == 0
        vals = [c['品牌'], c['定位'], c['核心卖点'], c['标题模式'], c['词路特征'], c['优势'], c['劣势'], '→ 见下方差异化策略']
        for col, val in enumerate(vals, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt, "left" if col > 1 else "center")
        ws.row_dimensions[row].height = 35

    # 词路对比矩阵
    matrix_start = 4 + len(competitors) + 3
    apply_title_style(ws.cell(row=matrix_start, column=1), "词路对比矩阵(功能×材质×款式×人群×场景×痛点)", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells(f'A{matrix_start}:H{matrix_start}')

    mh = ['词路维度'] + [c['品牌'] for c in competitors] + ['我们的差异化切入']
    for col, h in enumerate(mh, 1):
        apply_header_style(ws.cell(row=matrix_start + 1, column=col), h, "1E3A5F")

    dimensions = ['功能词路', '材质词路', '款式词路', '人群词路', '场景词路', '痛点覆盖']
    for i, dim in enumerate(dimensions, 1):
        row = matrix_start + 1 + i
        is_alt = i % 2 == 0
        apply_data_style(ws.cell(row=row, column=1), dim, is_alt)
        for col in range(2, len(mh) + 1):
            apply_data_style(ws.cell(row=row, column=col), '-', is_alt, "left")
        ws.row_dimensions[row].height = 30

    # 差异化切入点策略
    diff_start = matrix_start + 1 + len(dimensions) + 3
    apply_title_style(ws.cell(row=diff_start, column=1), "差异化切入点策略(6大切入点)", 11, "FFFFFF", "1E3A5F")
    ws.merge_cells(f'A{diff_start}:H{diff_start}')

    dh = ['切入点编号', '切入点', '差异化描述', '对标竞品弱点', '标题建议', '主图策略', '详情页策略']
    for col, h in enumerate(dh, 1):
        apply_header_style(ws.cell(row=diff_start + 1, column=col), h, "1E3A5F")

    for i, dd in enumerate(diff_points, 1):
        row = diff_start + 1 + i
        is_alt = i % 2 == 0
        for col, val in enumerate(dd, 1):
            apply_data_style(ws.cell(row=row, column=col), val, is_alt, "left" if col > 1 else "center")
        ws.row_dimensions[row].height = 40

    for col in range(1, 9):
        ws.column_dimensions[get_column_letter(col)].width = 16
    ws.column_dimensions['C'].width = 28
    ws.column_dimensions['D'].width = 24
    ws.column_dimensions['E'].width = 36
    ws.column_dimensions['F'].width = 26
    ws.column_dimensions['G'].width = 26

    return ws


# ============================================================================
# 主函数
# ============================================================================
def main():
    print(f"[{CATEGORY_NAME}] A4-词路营销卖点拆解 开始生成...")

    # 1. 读取数据
    df_search, df_eval = load_and_clean_data(SEARCH_FILE, EVAL_FILE)
    print(f"  搜索词: {len(df_search)} 条, 评价: {len(df_eval)} 条")

    # 2. 词根分类
    word_data = []
    for _, row in df_search.iterrows():
        word = row['相关搜索词']
        cat, root = classify_word(word, KEYWORD_LIBS)
        word_data.append({
            'word': word, 'category': cat, 'root': root,
            'pop': row['预估搜索人气'], 'cvr': row['预估支付转化率'],
            'supply': row['需求供给比'], 'tmall': row['天猫商品点击占比'],
            'buyers': row['预估支付买家数']
        })

    # 3. 词根汇总
    root_list = aggregate_roots(word_data)
    print(f"  提取词根: {len(root_list)} 个")

    # 4. 评价分析
    pain_list, pos_list, total_eval = analyze_evaluation(df_eval, PAIN_KEYWORDS, POS_KEYWORDS)
    print(f"  痛点类型: {len(pain_list)} 种, 正面类型: {len(pos_list)} 种")

    # 5. 生成 Excel
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    create_sheet_overview(wb, root_list, CATEGORY_NAME, INSIGHTS)
    print("  Sheet1 词路总览 OK")

    create_sheet_function(wb, root_list, pain_list, pos_list, total_eval)
    print("  Sheet2 功能词路卖点映射 OK")

    create_sheet_material(wb, root_list)
    print("  Sheet3 材质词路卖点映射 OK")

    create_sheet_persona_scene(wb, root_list)
    print("  Sheet4 人群+场景词路组合 OK")

    create_sheet_competitor(wb, root_list, COMPETITORS, DIFFERENTIATION_POINTS)
    print("  Sheet5 竞品词路差异化策略 OK")

    wb.save(OUTPUT_PATH)
    print(f"\n[完成] 已保存: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
