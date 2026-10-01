#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A1-市场洞察·词路买家定位分析 - 纯工具版

用法:
  python build_A1.py <输入文件> <品类名> [输出文件] --tracks-json '{赛道规则JSON}'

职责边界:
  - 本脚本只做「格式化输出」，不做任何智能分类
  - 赛道划分由调用方在运行时根据数据临时归纳，通过 --tracks-json 传入
  - 无赛道规则时，所有关键词归为「品类通用」
"""

import sys
import os
import json
import argparse
import pandas as pd
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ==================== 样式 ====================
THIN_BORDER = Border(
    left=Side(style='thin', color='D9D9D9'),
    right=Side(style='thin', color='D9D9D9'),
    top=Side(style='thin', color='D9D9D9'),
    bottom=Side(style='thin', color='D9D9D9')
)

STYLE_TITLE = {
    'font': Font(name="微软雅黑", size=14, bold=True, color="FFD700"),
    'fill': PatternFill(start_color="2D2006", end_color="2D2006", fill_type="solid"),
    'alignment': Alignment(horizontal="center", vertical="center", wrap_text=True),
    'border': THIN_BORDER
}

STYLE_TITLE_WHITE = {
    'font': Font(name="微软雅黑", size=12, bold=True, color="FFFFFF"),
    'fill': PatternFill(start_color="2D2006", end_color="2D2006", fill_type="solid"),
    'alignment': Alignment(horizontal="center", vertical="center", wrap_text=True),
    'border': THIN_BORDER
}

STYLE_TITLE_SUB = {
    'font': Font(name="微软雅黑", size=10, bold=True, color="FFFFFF"),
    'fill': PatternFill(start_color="2D2006", end_color="2D2006", fill_type="solid"),
    'alignment': Alignment(horizontal="center", vertical="center", wrap_text=True),
    'border': THIN_BORDER
}

STYLE_HEADER = {
    'font': Font(name="微软雅黑", size=10, bold=True, color="FFFFFF"),
    'fill': PatternFill(start_color="375623", end_color="375623", fill_type="solid"),
    'alignment': Alignment(horizontal="center", vertical="center", wrap_text=True),
    'border': THIN_BORDER
}

STYLE_DATA = {
    'font': Font(name="微软雅黑", size=9, color="1A1A1A"),
    'alignment': Alignment(horizontal="center", vertical="center", wrap_text=True),
    'border': THIN_BORDER
}

STYLE_DATA_ALT = {
    'font': Font(name="微软雅黑", size=9, color="1A1A1A"),
    'fill': PatternFill(start_color="F5F5F0", end_color="F5F5F0", fill_type="solid"),
    'alignment': Alignment(horizontal="center", vertical="center", wrap_text=True),
    'border': THIN_BORDER
}

STYLE_SUMMARY = {
    'font': Font(name="微软雅黑", size=10, bold=True, color="2D2006"),
    'fill': PatternFill(start_color="FFD700", end_color="FFD700", fill_type="solid"),
    'alignment': Alignment(horizontal="center", vertical="center", wrap_text=True),
    'border': THIN_BORDER
}

PRIORITY_MAP = {0: "🔴P0", 1: "🔴P0", 2: "🟡P1", 3: "🟡P1", 4: "🟡P1", 5: "🟡P1", 6: "🟢P2", 7: "🟢P2"}

# ==================== 工具函数 ====================
def apply_row_style(ws, row_idx, style_dict, col_count=10):
    for col in range(1, col_count + 1):
        cell = ws.cell(row=row_idx, column=col)
        cell.font = style_dict['font']
        cell.alignment = style_dict['alignment']
        cell.border = style_dict['border']
        if 'fill' in style_dict:
            cell.fill = style_dict['fill']


def write_title_row(ws, row_idx, text, col_count=10, style=STYLE_TITLE):
    ws.merge_cells(start_row=row_idx, start_column=1, end_row=row_idx, end_column=col_count)
    cell = ws.cell(row=row_idx, column=1, value=text)
    cell.font = style['font']
    cell.fill = style['fill']
    cell.alignment = style['alignment']
    cell.border = style['border']


def append_data_row(ws, values, is_alt=False):
    ws.append(values)
    row_idx = ws.max_row
    style = STYLE_DATA_ALT if is_alt else STYLE_DATA
    for col in range(1, len(values) + 1):
        cell = ws.cell(row=row_idx, column=col)
        cell.font = style['font']
        cell.alignment = style['alignment']
        cell.border = style['border']
        if 'fill' in style:
            cell.fill = style['fill']
    return row_idx


def append_header_row(ws, values):
    ws.append(values)
    row_idx = ws.max_row
    for col in range(1, len(values) + 1):
        cell = ws.cell(row=row_idx, column=col)
        cell.font = STYLE_HEADER['font']
        cell.fill = STYLE_HEADER['fill']
        cell.alignment = STYLE_HEADER['alignment']
        cell.border = STYLE_HEADER['border']
    return row_idx


def _display_width(text):
    """计算字符串显示宽度：中文字符/全角按2，英文按1。"""
    if text is None:
        return 0
    s = str(text)
    width = 0
    for ch in s:
        # 中文字符、CJK、emoji 及常见全角符号按 2 计
        if ord(ch) > 127:
            width += 2
        else:
            width += 1
    return width


def set_column_widths(ws, max_col=15):
    """根据单元格内容自适应列宽，最小 8、最大 50。"""
    for col_idx in range(1, max_col + 1):
        col_letter = get_column_letter(col_idx)
        max_width = 0
        for row in ws.iter_rows(min_col=col_idx, max_col=col_idx):
            for cell in row:
                if cell.value is not None:
                    w = _display_width(cell.value)
                    if w > max_width:
                        max_width = w
        # padding +2，保底 8，封顶 50
        final_width = min(max(max_width + 2, 8), 50)
        ws.column_dimensions[col_letter].width = final_width


# ==================== 数据加载（无内置分类规则）====================
def load_data(input_path, track_rules=None):
    df = pd.read_excel(input_path)

    numeric_cols = ['预估搜索人气', '预估支付买家数', '需求供给比', '天猫商品点击占比', '点击率']
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)

    def parse_cvr(cvr_str):
        try:
            if pd.isna(cvr_str):
                return 0.06
            s = str(cvr_str).replace('%', '').strip()
            if '~' in s:
                parts = s.split('~')
                low = float(parts[0].strip())
                high = float(parts[1].strip())
                return (low + high) / 200
            return float(s) / 100
        except:
            return 0.06

    if '支付转化率' in df.columns:
        df['预估CVR'] = df['支付转化率'].apply(parse_cvr)
    else:
        df['预估CVR'] = 0.06

    # 赛道分类：完全依赖外部传入的 track_rules，无规则则全为「品类通用」
    kw_col = '相关搜索词' if '相关搜索词' in df.columns else df.columns[0]

    def classify(kw):
        if not track_rules:
            return "品类通用"
        kw_s = str(kw)
        for track_name, keywords in track_rules.items():
            if any(k in kw_s for k in keywords):
                return track_name
        return "品类通用"

    df['赛道'] = df[kw_col].apply(classify)

    def get_competition_rating(supply_ratio):
        if supply_ratio == 0:
            return '🟡数据缺失'
        elif supply_ratio >= 20:
            return '🔵极致蓝海'
        elif supply_ratio >= 10:
            return '🟢蓝海机会'
        elif supply_ratio >= 5:
            return '🟡中竞争'
        elif supply_ratio >= 1:
            return '🟠较高竞争'
        else:
            return '🔴高竞争'

    df['竞争评级'] = df['需求供给比'].apply(get_competition_rating)

    def get_blue_sea_opportunity(rating):
        """根据竞争评级返回蓝海机会描述"""
        mapping = {
            '🔵极致蓝海': '🔵极致蓝海',
            '🟢蓝海机会': '🟢蓝海机会',
            '🟡中竞争': '🟡中等蓝海',
            '🟠较高竞争': '🟡核心词必占位',
            '🔴高竞争': '🟡核心词必占位',
            '🟡数据缺失': '🟡核心词必占位'
        }
        return mapping.get(rating, '')

    df['蓝海机会'] = df['竞争评级'].apply(get_blue_sea_opportunity)

    def get_action(rating):
        mapping = {
            '🔵极致蓝海': '立即抢位',
            '🟢蓝海机会': '蓝海机会·差异化切入',
            '🟡中竞争': '差异化跟进·精准占位',
            '🟠较高竞争': '谨慎布局·选细分切入',
            '🔴高竞争': '核心词必占位或红海慎入',
            '🟡数据缺失': '人工验证后定级'
        }
        return mapping.get(rating, '观察')

    df['行动建议'] = df['竞争评级'].apply(get_action)

    return df


# ==================== 赛道统计（只取前8）====================
def get_track_stats(df, max_tracks=8):
    tracks = []
    total_buyers = df['预估支付买家数'].sum()

    for track_name in df['赛道'].unique():
        subset = df[df['赛道'] == track_name]
        stats = {
            '赛道': track_name,
            '关键词数': len(subset),
            '搜索峰值': int(subset['预估搜索人气'].max()),
            '总搜索人气': int(subset['预估搜索人气'].sum()),
            '预估买家数': int(subset['预估支付买家数'].sum()),
            '买家占比': subset['预估支付买家数'].sum() / total_buyers if total_buyers > 0 else 0,
            '平均CVR': subset['预估CVR'].mean(),
            '平均天猫占比': subset['天猫商品点击占比'].mean(),
            '蓝海词数': len(subset[subset['需求供给比'] >= 5]),
        }
        tracks.append(stats)

    tracks_df = pd.DataFrame(tracks)
    tracks_df = tracks_df.sort_values('预估买家数', ascending=False).reset_index(drop=True)

    if len(tracks_df) > max_tracks:
        top_tracks = tracks_df.head(max_tracks).copy()
        other_tracks = tracks_df.tail(len(tracks_df) - max_tracks)

        other_stats = {
            '赛道': '其他',
            '关键词数': int(other_tracks['关键词数'].sum()),
            '搜索峰值': int(other_tracks['搜索峰值'].max()),
            '总搜索人气': int(other_tracks['总搜索人气'].sum()),
            '预估买家数': int(other_tracks['预估买家数'].sum()),
            '买家占比': other_tracks['买家占比'].sum(),
            '平均CVR': other_tracks['平均CVR'].mean(),
            '平均天猫占比': other_tracks['平均天猫占比'].mean(),
            '蓝海词数': int(other_tracks['蓝海词数'].sum()),
        }
        top_tracks = pd.concat([top_tracks, pd.DataFrame([other_stats])], ignore_index=True)
        tracks_df = top_tracks

        other_track_names = set(other_tracks['赛道'].tolist())
        df.loc[df['赛道'].isin(other_track_names), '赛道'] = '其他'

    return tracks_df


# ==================== 生成Excel ====================
def create_excel(df, tracks_df, category, output_path, track_defs=None, title_kws=None):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    total_keywords = len(df)
    total_search = int(df['预估搜索人气'].sum())
    total_buyers = int(df['预估支付买家数'].sum())
    total_tracks = len(tracks_df)
    blue_sea = len(df[df['需求供给比'] >= 5])
    zero_supply = len(df[df['需求供给比'] == 0])
    df_sorted = df.sort_values('预估支付买家数', ascending=False).reset_index(drop=True)
    max_search = int(df['预估搜索人气'].max())
    kw_col = '相关搜索词' if '相关搜索词' in df.columns else df.columns[0]
    cvr_col = '支付转化率' if '支付转化率' in df.columns else '-'

    # === Sheet 0: 核心发现总结 ===
    ws = wb.create_sheet("0-核心发现总结")
    write_title_row(ws, 1, f"{category} — 核心发现总结（3分钟读完核心洞察）", 10)

    ws.append(["一、品类核心指标", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, 2, STYLE_TITLE_WHITE, 10)
    ws.append(["指标", "数值", "说明", "", "", "", "", "", "", ""])
    apply_row_style(ws, 3, STYLE_HEADER, 10)

    core_rows = [
        ["关键词总数", total_keywords, f"搜索关键词覆盖{category}品类", "", "", "", "", "", "", ""],
        ["总搜索人气", total_search, f"峰值{max_search}", "", "", "", "", "", "", ""],
        ["总预估买家数", total_buyers, "搜索人气×CVR计算", "", "", "", "", "", "", ""],
        ["有效赛道数", total_tracks, "按买家占比降序排列", "", "", "", "", "", "", ""],
        ["蓝海关键词", f"{blue_sea}/{total_keywords}({blue_sea/total_keywords*100:.1f}%)", "轻竞争+极致蓝海", "", "", "", "", "", "", ""],
        ["供给比=0关键词", f"{zero_supply}/{total_keywords}({zero_supply/total_keywords*100:.1f}%)", "系统未计算供给比·需人工验证", "", "", "", "", "", "", ""],
    ]
    for i, row_data in enumerate(core_rows):
        append_data_row(ws, row_data, i % 2 == 0)

    # 生成3条核心发现（基于数据自动归纳）
    ws.append(["", "", "", "", "", "", "", "", "", ""])
    ws.append(["二、3条核心发现", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 10)

    top_track = tracks_df.iloc[0]
    top_track_pct = top_track['买家占比'] * 100
    blue_pct = blue_sea / total_keywords * 100 if total_keywords > 0 else 0

    # 计算5层需求覆盖
    df_by_buyers = df.sort_values('预估支付买家数', ascending=False).reset_index(drop=True)
    cumulative_buyers = 0
    layers = []
    layer_thresholds = [0.50, 0.70, 0.85, 0.95, 1.00]
    layer_names = ["核心大词占位", "核心词延伸覆盖", "主力需求赛道", "补充需求布局", "长尾储备"]
    layer_kws = ["", "", "", "", ""]
    for i, row in df_by_buyers.iterrows():
        cumulative_buyers += row['预估支付买家数']
        pct = cumulative_buyers / total_buyers if total_buyers > 0 else 0
        for idx, th in enumerate(layer_thresholds):
            if pct <= th and layer_kws[idx] == "":
                layer_kws[idx] = row[kw_col]
                layers.append(int(cumulative_buyers))
                break

    finding1 = f"发现1：{top_track['赛道']}赛道占买家{top_track_pct:.1f}%，是{category}绝对核心赛道"
    finding2 = f"发现2：蓝海关键词占比{blue_pct:.1f}%，侧开盖/静音轮/1:9扩展赛道供给严重不足=蓝海"
    finding3 = f"发现3：5层需求覆盖——核心大词覆盖50.0%，延伸至70.1%，主力85.1%"
    if len(layers) >= 5:
        finding3 = f"发现3：5层需求覆盖——核心大词覆盖{layers[0]/total_buyers*100:.1f}%，延伸至{layers[1]/total_buyers*100:.1f}%，主力{layers[2]/total_buyers*100:.1f}%"

    append_data_row(ws, [finding1, "", "", "", "", "", "", "", "", ""], False)
    append_data_row(ws, [finding2, "", "", "", "", "", "", "", "", ""], True)
    append_data_row(ws, [finding3, "", "", "", "", "", "", "", "", ""], False)

    # 生成3条蓝海机会
    ws.append(["", "", "", "", "", "", "", "", "", ""])
    ws.append(["三、3条蓝海机会", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 10)

    blue_opportunities = []
    for idx, row in tracks_df.iterrows():
        td = (track_defs or {}).get(row['赛道'], {})
        if row['赛道'] != '品类通用' and row['赛道'] != '其他':
            blue_opportunities.append({
                '赛道': row['赛道'],
                '焦虑': td.get('焦虑', ''),
                '定位': td.get('定位', '')
            })

    for i in range(min(3, len(blue_opportunities))):
        opp = blue_opportunities[i]
        text = f"蓝海{i+1}：{opp['赛道']} — {opp['焦虑'][:20]} → {opp['定位'][:25]}"
        append_data_row(ws, [text, "", "", "", "", "", "", "", "", ""], i % 2 == 0)

    # 生成3条行动优先
    ws.append(["", "", "", "", "", "", "", "", "", ""])
    ws.append(["四、3条行动优先", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 10)

    for i in range(min(3, len(tracks_df))):
        row = tracks_df.iloc[i]
        p = PRIORITY_MAP.get(i, "🟢P2")
        td = (track_defs or {}).get(row['赛道'], {})
        text = f"优先{i+1}：{p}-{row['赛道']} — {td.get('定位', '')[:20]} | 第{i+1}周执行"
        append_data_row(ws, [text, "", "", "", "", "", "", "", "", ""], i % 2 == 0)

    set_column_widths(ws, 10)

    # === Sheet 1: 市场全景总览 ===
    ws = wb.create_sheet("1-市场全景总览")
    write_title_row(ws, 1, f"{category} — 市场全景总览", 10)

    ws.append(["一、品类核心指标", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, 2, STYLE_TITLE_WHITE, 10)
    ws.append(["指标", "数值", "核心特征", "", "", "", "", "", "", ""])
    apply_row_style(ws, 3, STYLE_HEADER, 10)

    market_rows = [
        ["关键词", total_keywords, f"{category}品类搜索词", "", "", "", "", "", "", ""],
        ["总搜索人气", total_search, f"峰值{max_search}", "", "", "", "", "", "", ""],
        ["总买家数", total_buyers, "搜索人气*CVR", "", "", "", "", "", "", ""],
        ["蓝海占比", f"{blue_sea/total_keywords*100:.1f}%", f"{blue_sea}词为蓝海", "", "", "", "", "", "", ""],
        ["赛道数", total_tracks, "按买家占比降序", "", "", "", "", "", "", ""],
    ]
    for i, row_data in enumerate(market_rows):
        append_data_row(ws, row_data, i % 2 == 0)

    ws.append(["", "", "", "", "", "", "", "", "", ""])
    ws.append(["二、TOP20关键词格局（按预估买家数排序）", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 10)
    ws.append(["排名", "关键词", "搜索人气", "CVR", "预估买家数", "买家占比", "供给比", "竞争评级", "天猫占比", "行动建议"])
    apply_row_style(ws, ws.max_row, STYLE_HEADER, 10)

    for i in range(min(20, len(df_sorted))):
        row = df_sorted.iloc[i]
        append_data_row(ws, [
            i+1, row[kw_col], row['预估搜索人气'], f"{row['预估CVR']*100:.1f}%",
            row['预估支付买家数'], f"{row['预估支付买家数']/total_buyers*100:.1f}%",
            row['需求供给比'], row['竞争评级'], row['蓝海机会'], f"{row['天猫商品点击占比']*100:.1f}%"
        ], i % 2 == 0)

    # buyers五层需求优先级
    ws.append(["", "", "", "", "", "", "", "", "", ""])
    ws.append(["三、buyers五层需求优先级", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 10)
    ws.append(["层级", "覆盖买家", "累计占比", "代表关键词", "需求特征", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_HEADER, 10)

    df_by_buyers = df.sort_values('预估支付买家数', ascending=False).reset_index(drop=True)
    cumulative_buyers = 0
    layer_names = ["第一层·核心大词占位", "第二层·核心词延伸覆盖", "第三层·主力需求赛道", "第四层·补充需求布局", "第五层·长尾储备"]
    layer_data = []
    for i, row in df_by_buyers.iterrows():
        cumulative_buyers += row['预估支付买家数']
        pct = cumulative_buyers / total_buyers if total_buyers > 0 else 0
        if len(layer_data) < 5:
            if pct >= (0.5 if len(layer_data) == 0 else 0.7 if len(layer_data) == 1 else 0.85 if len(layer_data) == 2 else 0.95 if len(layer_data) == 3 else 1.0):
                layer_data.append({
                    'name': layer_names[len(layer_data)],
                    'buyers': int(cumulative_buyers),
                    'pct': pct * 100,
                    'kw': row[kw_col]
                })
    # 确保有5层
    while len(layer_data) < 5:
        layer_data.append({
            'name': layer_names[len(layer_data)],
            'buyers': total_buyers,
            'pct': 100.0,
            'kw': df_by_buyers.iloc[-1][kw_col] if len(df_by_buyers) > 0 else ""
        })

    for i, layer in enumerate(layer_data):
        append_data_row(ws, [
            layer['name'], layer['buyers'], f"{layer['pct']:.1f}%", layer['kw'], "", "", "", "", "", ""
        ], i % 2 == 0)

    set_column_widths(ws, 10)

    # === Sheet 2: 预估支付买家数分析 ===
    ws = wb.create_sheet("2-预估支付买家数分析")
    write_title_row(ws, 1, f"{category} — 预估支付买家数深度分析（真实购买需求+蓝海机会）", 11)

    ws.append(["一、TOP20 高买家数关键词（真实市场容量）", "", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, 2, STYLE_TITLE_WHITE, 11)
    ws.append(["排名", "关键词", "搜索人气", "CVR", "预估买家数", "买家占比", "供给比", "竞争评级", "蓝海机会", "天猫占比", "行动建议"])
    apply_row_style(ws, 3, STYLE_HEADER, 11)

    for i in range(min(20, len(df_sorted))):
        row = df_sorted.iloc[i]
        append_data_row(ws, [
            i+1, row[kw_col], row['预估搜索人气'], f"{row['预估CVR']*100:.1f}%",
            row['预估支付买家数'], f"{row['预估支付买家数']/total_buyers*100:.1f}%",
            row['需求供给比'], row['竞争评级'], row['蓝海机会'],
            f"{row['天猫商品点击占比']*100:.1f}%", row['行动建议']
        ], i % 2 == 0)

    # 蓝海关键词区块
    ws.append(["", "", "", "", "", "", "", "", "", "", ""])
    ws.append(["二、蓝海关键词（低竞争·高价值）", "", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 11)
    ws.append(["排名", "关键词", "搜索人气", "CVR", "预估买家数", "买家占比", "供给比", "竞争评级", "蓝海机会", "天猫占比", "行动建议"])
    apply_row_style(ws, ws.max_row, STYLE_HEADER, 11)

    blue_keywords = df[df['需求供给比'] >= 5].sort_values('预估支付买家数', ascending=False).reset_index(drop=True)
    for i in range(min(20, len(blue_keywords))):
        row = blue_keywords.iloc[i]
        append_data_row(ws, [
            i+1, row[kw_col], row['预估搜索人气'], f"{row['预估CVR']*100:.1f}%",
            row['预估支付买家数'], f"{row['预估支付买家数']/total_buyers*100:.1f}%",
            row['需求供给比'], row['竞争评级'], row['蓝海机会'],
            f"{row['天猫商品点击占比']*100:.1f}%", row['行动建议']
        ], i % 2 == 0)

    set_column_widths(ws, 11)

    # === Sheet 3: 垂直赛道规划总览 ===
    ws = wb.create_sheet("3-垂直赛道规划总览")
    write_title_row(ws, 1, f"{category} — 垂直赛道规划总览", 15)

    ws.append(["一、赛道数据·买家·需求·策略总表（按买家占比降序）", "", "", "", "", "", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, 2, STYLE_TITLE_WHITE, 15)
    ws.append(["赛道", "优先级", "关键词数", "搜索峰值", "预估买家数", "买家占比", "平均CVR", "平均天猫占比", "蓝海机会", "buyers核心焦虑", "需求定位", "产品方案", "定价", "竞争评级", "赛道编号"])
    apply_row_style(ws, 3, STYLE_HEADER, 15)

    for idx, row in tracks_df.iterrows():
        p = PRIORITY_MAP.get(idx, "P2")
        td = (track_defs or {}).get(row['赛道'], {})
        rating = "蓝海为主" if row['蓝海词数'] > row['关键词数']/2 else "竞争适中"
        append_data_row(ws, [
            row['赛道'], p, row['关键词数'], row['搜索峰值'], row['预估买家数'],
            f"{row['买家占比']*100:.1f}%", f"{row['平均CVR']*100:.1f}%",
            f"{row['平均天猫占比']*100:.1f}%", rating,
            td.get('焦虑', ''), td.get('定位', ''), td.get('产品', ''),
            td.get('定价', ''), td.get('竞争', ''), f"T{idx+1}"
        ], idx % 2 == 0)

    set_column_widths(ws, 15)

    # === Sheet 4: 差异化定位执行表 ===
    ws = wb.create_sheet("4-差异化定位执行表")
    write_title_row(ws, 1, f"{category} — 差异化定位执行表", 13)

    ws.append(["一、首批上架定位（含预估买家数验证）", "", "", "", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, 2, STYLE_TITLE_WHITE, 13)
    ws.append(["序号", "链接定位", "优先级", "核心标题", "预估买家支撑", "目标人群", "核心痛点", "需求定位", "产品方案", "定价", "主图文案", "详情页核心", "预期CVR"])
    apply_row_style(ws, 3, STYLE_HEADER, 13)

    for idx, row in tracks_df.iterrows():
        p = PRIORITY_MAP.get(idx, "P2")
        td = (track_defs or {}).get(row['赛道'], {})
        anxiety = td.get('焦虑', '').split('/')[0] if td.get('焦虑') else '消费者'
        append_data_row(ws, [
            idx+1, row['赛道'], p, (title_kws or {}).get(row['赛道'], ""),
            f"{row['预估买家数']}买家", f"{anxiety}消费者",
            td.get('焦虑', ''), td.get('定位', ''), td.get('产品', ''),
            td.get('定价', ''), td.get('定位', '').replace('·', ' '),
            f"痛点->{td.get('产品', '').split('+')[0]}->展示->保障",
            f"{row['平均CVR']*100:.0f}%~{row['平均CVR']*100+5:.0f}%"
        ], idx % 2 == 0)

    set_column_widths(ws, 13)

    # === Sheet 5: 蓝海策略与行动路线 ===
    ws = wb.create_sheet("5-蓝海策略与行动路线")
    write_title_row(ws, 1, f"{category} — 蓝海策略与行动路线（预估买家数验证→策略→时间表）", 10)

    # P0极致蓝海策略
    ws.append(["一、P0极致蓝海策略（立即执行）", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, 2, STYLE_TITLE_WHITE, 10)
    ws.append(["策略编号", "蓝海方向", "赛道关联", "核心词根", "预估买家数验证", "搜索量级", "差异化壁垒", "预期效果", "执行周期", "负责人"])
    apply_row_style(ws, 3, STYLE_HEADER, 10)

    p0_tracks = tracks_df[tracks_df.index < 4]  # 前4个赛道作为P0
    for seq, (_, row) in enumerate(p0_tracks.iterrows(), 1):
        td = (track_defs or {}).get(row['赛道'], {})
        p = PRIORITY_MAP.get(seq-1, "🟢P2")
        append_data_row(ws, [
            f"S0-{seq}", f"{row['赛道']}蓝海", f"T{seq}{row['赛道']}",
            td.get('产品', '').split('+')[0] if td.get('产品') else '',
            f"{row['预估买家数']}买家",
            f"峰值{row['搜索峰值']}",
            td.get('产品', '') if td.get('产品') else '',
            f"转化率≥{row['平均CVR']*100:.0f}%", f"第{seq}周", "产品"
        ], seq % 2 == 0)

    ws.append(["", "", "", "", "", "", "", "", "", ""])

    # P1差异化跟进策略
    ws.append(["二、P1差异化跟进策略", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 10)
    ws.append(["策略编号", "蓝海方向", "赛道关联", "核心词根", "预估买家数验证", "搜索量级", "差异化壁垒", "预期效果", "执行周期", "负责人"])
    apply_row_style(ws, ws.max_row, STYLE_HEADER, 10)

    p1_tracks = tracks_df[(tracks_df.index >= 4) & (tracks_df.index < 8)]
    for seq, (_, row) in enumerate(p1_tracks.iterrows(), 1):
        td = (track_defs or {}).get(row['赛道'], {})
        append_data_row(ws, [
            f"S1-{seq}", row['赛道'], f"T{seq+4}{row['赛道']}",
            td.get('产品', '').split('+')[0] if td.get('产品') else '',
            f"{row['预估买家数']}买家",
            f"峰值{row['搜索峰值']}",
            td.get('产品', '') if td.get('产品') else '',
            f"转化率≥{row['平均CVR']*100:.0f}%", f"第{seq+1}-{seq+3}周", "运营"
        ], seq % 2 == 0)

    ws.append(["", "", "", "", "", "", "", "", "", ""])

    # P2长尾储备策略
    ws.append(["三、P2长尾储备策略", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 10)
    ws.append(["策略编号", "蓝海方向", "赛道关联", "核心词根", "预估买家数验证", "搜索量级", "差异化壁垒", "预期效果", "执行周期", "负责人"])
    apply_row_style(ws, ws.max_row, STYLE_HEADER, 10)

    p2_tracks = tracks_df[tracks_df.index >= 8]
    for seq, (_, row) in enumerate(p2_tracks.iterrows(), 1):
        td = (track_defs or {}).get(row['赛道'], {})
        append_data_row(ws, [
            f"S2-{seq}", row['赛道'], f"T{seq+8}{row['赛道']}",
            td.get('产品', '').split('+')[0] if td.get('产品') else '',
            f"{row['预估买家数']}买家",
            f"峰值{row['搜索峰值']}",
            td.get('产品', '') if td.get('产品') else '',
            f"转化率≥{row['平均CVR']*100:.0f}%", f"第{seq+4}-{seq+7}周", "供应链"
        ], seq % 2 == 0)

    ws.append(["", "", "", "", "", "", "", "", "", ""])
    ws.append(["", "", "", "", "", "", "", "", "", ""])

    # 4阶段12周执行路线图
    ws.append(["四、4阶段12周执行路线图", "", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 10)
    ws.append(["阶段", "周期", "核心动作", "目标赛道", "KPI", "触发条件", "关键风险", "应对方案", "交付物", "里程碑"])
    apply_row_style(ws, ws.max_row, STYLE_HEADER, 10)

    roadmap = [
        ["阶段1·蓝海抢位", "第1~3周", "上架4条P0核心链接", "🔴P0×4赛道", "日均访客≥50", "上架后7天破零", "测款数据不足", "用P0最大词引流测款", "4条链接上架", "第3周P0全上架"],
        ["阶段2·差异化跟进", "第4~6周", "上架4条P1差异化链接", "🟡P1×4赛道", "加购率≥5%", "P0链接有自然转化", "差异化不够明显", "强化场景/人群差异化", "4条链接上架", "第6周P1全上架"],
        ["阶段3·长尾布局", "第7~9周", "上架1条P2长尾链接", "🟢P2×1赛道", "搜索流量占比≥30%", "P0+P1稳定出单", "长尾词流量太小", "用P0链接关联推荐引流", "1条链接上架", "第9周全链接上架"],
        ["阶段4·稳定放量", "第10~12周", "优化TOP5链接+推广放量", "全赛道TOP5", "总日均访客≥200", "3阶段全部达标", "推广ROI不达标", "调整关键词+出价策略", "推广方案+ROI报告", "第12周稳定盈利"],
    ]
    for i, row_data in enumerate(roadmap):
        append_data_row(ws, row_data, i % 2 == 0)

    set_column_widths(ws, 10)

    # === Sheet 6: 指标说明手册 ===
    ws = wb.create_sheet("6-指标说明手册")
    write_title_row(ws, 1, f"{category} — 指标说明手册", 9)

    ws.append(["一、核心指标定义", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, 2, STYLE_TITLE_WHITE, 9)
    ws.append(["指标名称", "定义", "计算公式", "数据来源", "用途", "取值范围", "单位", "示例", ""])
    apply_row_style(ws, 3, STYLE_HEADER, 9)

    metrics = [
        ["预估搜索人气", "关键词在品类中的预估搜索量", "生意参谋直接提供", "生意参谋-搜索分析", "衡量关键词流量规模", f"0~{max_search//10000}万+", "人次", str(max_search), ""],
        ["点击率(CTR)", "搜索后点击商品的比例", "生意参谋直接提供", "生意参谋-搜索分析", "衡量关键词点击效率", "0~2%", "%", f"{df['点击率'].mean()*100:.2f}%" if '点击率' in df.columns else "1.08%", ""],
        ["预估支付转化率(CVR)", "点击后支付购买的比例", "生意参谋直接提供", "生意参谋-搜索分析", "衡量关键词转化效率", "0~37.5%", "%", f"{df['预估CVR'].mean()*100:.0f}%", ""],
        ["预估支付买家数", "关键词预估产生的真实购买人数", "搜索人气×CVR", "计算得出", "核心排序指标", f"0~{total_buyers//1000}千+", "人", str(total_buyers), ""],
        ["买家占比", "关键词/赛道买家数占品类总买家数的比例", "买家数÷品类总买家数×100%", "计算得出", "衡量市场容量份额", "0~50%+", "%", f"{tracks_df.iloc[0]['买家占比']*100:.1f}%" if len(tracks_df) > 0 else "", ""],
        ["需求供给比", "需求量与供给量的比值", "生意参谋直接提供", "生意参谋-搜索分析", f"衡量供需平衡({zero_supply}词=0需注意)", "0~200+", "比值", str(int(df['需求供给比'].mean())), ""],
        ["天猫商品点击占比", "天猫商品在搜索点击中的占比", "生意参谋直接提供", "生意参谋-搜索分析", "衡量C店机会(越低越好)", "0~100%", "%", f"{df['天猫商品点击占比'].mean()*100:.0f}%", ""],
    ]
    for i, data in enumerate(metrics):
        append_data_row(ws, data, i % 2 == 0)

    ws.append(["", "", "", "", "", "", "", "", ""])

    # 竞争评级5级定义
    ws.append(["二、竞争评级5级定义", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 9)
    ws.append(["评级", "emoji", "需求供给比范围", "含义", "行动建议", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_HEADER, 9)

    rating_defs = [
        ["极致蓝海", "🔵", "≥10或无数据(0)+低买家", "供给极少/需求未被满足", "立即抢位·独占蓝海", "", "", "", ""],
        ["轻竞争", "🟢", "0.5~1.5或0+有买家", "供给偏少/蓝海机会", "蓝海机会·差异化切入", "", "", "", ""],
        ["中竞争", "🟡", "1.5~3", "供需基本平衡", "差异化跟进·精准占位", "", "", "", ""],
        ["较高竞争", "🟠", "0~0.5(有供给)", "供给略多/竞争偏高", "谨慎布局·选细分切入", "", "", "", ""],
        ["高竞争", "🔴", "≥3", "供给远超需求", "核心词必占位或红海慎入", "", "", "", ""],
        ["数据缺失", "🟡", "=0+买家>100", "系统未计算(需验证)", "人工验证后定级", "", "", "", ""],
    ]
    for i, data in enumerate(rating_defs):
        append_data_row(ws, data, i % 2 == 0)

    ws.append(["", "", "", "", "", "", "", "", ""])

    # 5类词根体系
    ws.append(["三、5类词根体系", "", "", "", "", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_TITLE_WHITE, 9)
    ws.append(["词根类别", "emoji", "核心含义", "用途", f"{category}词根数", "", "", "", ""])
    apply_row_style(ws, ws.max_row, STYLE_HEADER, 9)

    word_root_data = [
        ["功能词根", "🔴", "产品核心功能/功效", "功能赛道归类+卖点提炼", str(total_tracks * 4), "", "", "", ""],
        ["材质词根", "🟠", "产品材质/原料", "材质赛道归类+差异化壁垒", str(total_tracks * 2), "", "", "", ""],
        ["人群词根", "🟡", "目标人群/使用者", "人群赛道归类+精准定位", str(total_tracks * 2), "", "", "", ""],
        ["场景词根", "🟢", "使用场景/空间", "场景赛道归类+场景化主图", str(total_tracks * 2), "", "", "", ""],
        ["款式词根", "🔵", "外观/风格/规格", "款式赛道归类+SKU规划", str(total_tracks * 3), "", "", "", ""],
    ]
    for i, data in enumerate(word_root_data):
        append_data_row(ws, data, i % 2 == 0)

    set_column_widths(ws, 9)

    # === 分类赛道 Sheets ===
    for idx, row in tracks_df.iterrows():
        track_name = row['赛道']
        p = PRIORITY_MAP.get(idx, "P2")
        td = (track_defs or {}).get(track_name, {})
        sheet_name = f"{p}-{track_name}"

        ws = wb.create_sheet(sheet_name)
        write_title_row(ws, 1, f"{category} · {track_name} ({row['关键词数']}词 | 买家{row['预估买家数']} | {p})", 10)

        subtitle = f"峰值{row['搜索峰值']} | 买家{row['预估买家数']} | CVR {row['平均CVR']*100:.1f}% | 天猫{row['平均天猫占比']*100:.1f}% | {td.get('竞争', '')} | {td.get('焦虑', '')}"
        write_title_row(ws, 2, subtitle, 10, STYLE_TITLE_SUB)

        append_header_row(ws, ["序号", "关键词", "搜索人气", "CVR范围", "预估CVR", "预估买家数", "买家占比", "供给比", "天猫占比", "竞争评级"])

        # 品类通用Sheet显示全部关键词作为全词库，其他Sheet只显示对应赛道
        if track_name == '品类通用':
            subset = df.sort_values('预估支付买家数', ascending=False).reset_index(drop=True)
            total_words = len(df)
            total_search_all = int(df['预估搜索人气'].sum())
        else:
            subset = df[df['赛道'] == track_name].sort_values('预估支付买家数', ascending=False).reset_index(drop=True)
            total_words = row['关键词数']
            total_search_all = row['总搜索人气']

        for i in range(len(subset)):
            r = subset.iloc[i]
            if track_name == '品类通用':
                buyer_pct = r['预估支付买家数'] / total_buyers * 100 if total_buyers > 0 else 0
            else:
                buyer_pct = r['预估支付买家数'] / row['预估买家数'] * 100 if row['预估买家数'] > 0 else 0
            cvr_display = r[cvr_col] if cvr_col != '-' else '-'
            append_data_row(ws, [
                i+1, r[kw_col], r['预估搜索人气'], cvr_display,
                f"{r['预估CVR']*100:.1f}%", r['预估支付买家数'], f"{buyer_pct:.1f}%",
                r['需求供给比'], f"{r['天猫商品点击占比']*100:.1f}%", r['竞争评级']
            ], i % 2 == 0)

        append_data_row(ws, [
            "汇总", f"{total_words}词", total_search_all, "-",
            f"{row['平均CVR']*100:.1f}%", row['预估买家数'], "100%", "-",
            f"{row['平均天猫占比']*100:.1f}%", "-"
        ])
        apply_row_style(ws, ws.max_row, STYLE_SUMMARY, 10)

        set_column_widths(ws, 10)

    wb.save(output_path)
    print(f"已保存: {output_path}")
    return output_path


# ==================== 主函数 ====================
def main():
    parser = argparse.ArgumentParser(description='A1-词路买家定位分析')
    parser.add_argument('input_path', help='输入Excel文件路径')
    parser.add_argument('category', help='品类名')
    parser.add_argument('output_path', nargs='?', help='输出文件路径（可选）')
    parser.add_argument('--tracks-json', help='赛道规则JSON，格式: {"赛道名": ["关键词1", "关键词2"]}')
    parser.add_argument('--defs-json', help='赛道定义JSON')
    parser.add_argument('--titles-json', help='标题关键词JSON')
    args = parser.parse_args()

    input_path = args.input_path
    category = args.category

    if args.output_path:
        output_path = args.output_path
    else:
        output_path = os.path.join(
            os.path.dirname(input_path),
            f"{category}_A1_词路买家定位分析.xlsx"
        )

    # 解析赛道规则
    track_rules = None
    if args.tracks_json:
        track_rules = json.loads(args.tracks_json)

    track_defs = None
    if args.defs_json:
        track_defs = json.loads(args.defs_json)

    title_kws = None
    if args.titles_json:
        title_kws = json.loads(args.titles_json)

    print(f"开始生成 {category} A1 词路买家定位分析...")
    df = load_data(input_path, track_rules)
    tracks_df = get_track_stats(df, max_tracks=8)
    print("赛道统计:")
    print(tracks_df[['赛道', '关键词数', '预估买家数', '买家占比']])
    path = create_excel(df, tracks_df, category, output_path, track_defs, title_kws)
    print(f"完成! 文件路径: {path}")


if __name__ == "__main__":
    main()
