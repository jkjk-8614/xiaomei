#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A2-市场洞察·五类词根需求拆解 — 通用数据分析脚本
技能编号: A2

用法:
    python build_A2.py --config <config.json>

config.json 示例:
    {
        "input_path": "数据源.xlsx",
        "output_path": "输出.xlsx",
        "category_name": "品类名称",
        "core_product_word": "核心品类词",
        "root_dict": {
            "功能": ["..."],
            "材质": ["..."],
            "人群": ["..."],
            "场景": ["..."],
            "款式": ["..."]
        },
        "title_rules": {
            "default_suffix": "默认后缀",
            "root_overrides": {"词根": "对应后缀"},
            "category_overrides": {"类别": {"词根": "对应后缀"}}
        }
    }
"""

import argparse
import json
import os
import sys

import pandas as pd
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

# ==================== 常量 ====================
CAT_EMOJI = {"功能": "🔴", "材质": "🟠", "人群": "🟡", "场景": "🟢", "款式": "🔵"}
CAT_FILL = {"功能": "FF6B6B", "材质": "FF9F43", "人群": "FDCB6E", "场景": "6C5CE7", "款式": "74B9FF"}

# ==================== 样式 ====================
def apply_title_style(cell, text, font_size=14, font_color="FFFFFF", fill_color="2D2006"):
    cell.value = text
    cell.font = Font(name="微软雅黑", size=font_size, bold=True, color=font_color)
    cell.fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

def apply_header_style(cell, text, fill_color="375623"):
    cell.value = text
    cell.font = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
    cell.fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

def apply_data_style(cell, value, is_alt=False, align="center"):
    cell.value = value
    cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
    bg = "F5F5F0" if is_alt else "FFFFFF"
    cell.fill = PatternFill(start_color=bg, end_color=bg, fill_type="solid")
    cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)

def apply_category_title(ws, row, col, text, fill_color):
    cell = ws.cell(row=row, column=col)
    cell.value = text
    cell.font = Font(name="微软雅黑", size=11, bold=True, color="FFFFFF")
    cell.fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
    cell.alignment = Alignment(horizontal="left", vertical="center")

# ==================== 词根提取 ====================
def extract_roots(term, core_product_word, root_dict):
    t = term.replace(" ", "").replace(core_product_word, "")
    result = {cat: [] for cat in root_dict}
    matched_positions = []

    for cat, roots in root_dict.items():
        for root in roots:
            idx = t.find(root)
            if idx != -1:
                overlap = False
                for start, end in matched_positions:
                    if idx < end and idx + len(root) > start:
                        overlap = True
                        break
                if not overlap:
                    result[cat].append(root)
                    matched_positions.append((idx, idx + len(root)))
    return result

# ==================== 数据读取 ====================
def load_data(input_path):
    df = pd.read_excel(input_path)
    df["预估搜索人气"] = pd.to_numeric(df["预估搜索人气"], errors="coerce").fillna(0)
    df["预估点击人数"] = pd.to_numeric(df["预估点击人数"], errors="coerce").fillna(0)
    df["预估支付买家数"] = pd.to_numeric(df["预估支付买家数"], errors="coerce").fillna(0)
    df["点击率"] = pd.to_numeric(df["点击率"], errors="coerce").fillna(0)
    df["需求供给比"] = pd.to_numeric(df["需求供给比"], errors="coerce").fillna(0)
    df["天猫商品点击占比"] = pd.to_numeric(df["天猫商品点击占比"], errors="coerce").fillna(0)
    df["CVR"] = pd.to_numeric(df.get("预估支付转化率", 0), errors="coerce").fillna(0)
    # 如果列名是"预估支付转化率"则使用它，否则尝试"CVR"
    if "预估支付转化率" in df.columns:
        df["CVR"] = pd.to_numeric(df["预估支付转化率"], errors="coerce").fillna(0)
    df["买家数"] = df["预估支付买家数"]
    return df

# ==================== 词根统计 ====================
def calc_root_stats(df, core_product_word, root_dict):
    root_records = []
    for _, row in df.iterrows():
        term = str(row.get("相关搜索词", ""))
        if not term or term == "nan":
            continue
        roots = extract_roots(term, core_product_word, root_dict)
        for cat, rlist in roots.items():
            for root in rlist:
                root_records.append({
                    "词根": root, "类别": cat, "搜索词": term,
                    "搜索人气": row["预估搜索人气"], "点击人数": row["预估点击人数"],
                    "CVR": row["CVR"], "买家数": row["买家数"],
                    "供给比": row["需求供给比"], "天猫占比": row["天猫商品点击占比"]
                })
    if not root_records:
        return pd.DataFrame()
    rdf = pd.DataFrame(root_records)
    agg = rdf.groupby(["类别", "词根"]).agg(
        出现词数=("搜索词", "nunique"),
        总搜索人气=("搜索人气", "sum"),
        平均搜索人气=("搜索人气", "mean"),
        平均CVR=("CVR", "mean"),
        平均供给比=("供给比", "mean"),
        平均天猫占比=("天猫占比", "mean"),
        平均买家数=("买家数", "mean"),
        总买家数=("买家数", "sum")
    ).reset_index()
    agg["平均CVR"] = agg["平均CVR"] * 100
    agg["平均天猫占比"] = agg["平均天猫占比"] * 100
    return agg

# ==================== 评分计算 ====================
def calc_scores(agg):
    if agg.empty:
        return agg

    max_avg_search = agg["平均搜索人气"].max()
    agg["需求规模"] = (agg["平均搜索人气"] / max_avg_search * 10).round(1).clip(0, 10) if max_avg_search > 0 else 0

    max_cvr = agg["平均CVR"].max()
    agg["转化效率"] = (agg["平均CVR"] / max_cvr * 10).round(1).clip(0, 10) if max_cvr > 0 else 0

    max_supply = agg["平均供给比"].max()
    agg["竞争压力"] = (agg["平均供给比"] / max_supply * 10).round(1).clip(0, 10) if max_supply > 0 else 0

    def blue_ocean(row):
        if row["平均供给比"] <= 0:
            return 10
        return min(10, (1.0 / (1 + row["平均供给比"]) * 100))
    agg["蓝海机会"] = agg.apply(blue_ocean, axis=1).round(1).clip(0, 10)

    max_avg_buyers = agg["平均买家数"].max()
    agg["商业价值"] = (agg["平均买家数"] / max_avg_buyers * 10).round(1).clip(0, 10) if max_avg_buyers > 0 else 0

    agg["综合指数"] = (
        agg["需求规模"] * 0.3 + agg["转化效率"] * 0.25 +
        (10 - agg["竞争压力"]) * 0.15 + agg["蓝海机会"] * 0.2 + agg["商业价值"] * 0.1
    ).round(2)

    agg["需求规模评分"] = agg["需求规模"]
    return agg

# ==================== Sheet 1 ====================
def build_sheet1(wb, df, agg, category_name, root_dict):
    ws = wb.create_sheet("1-词根需求总览")

    ws.merge_cells("A1:I1")
    apply_title_style(ws["A1"], f"{category_name} · 词根需求总览", 16, "FFD700", "2D2006")

    ws.merge_cells("A2:I2")
    apply_title_style(ws["A2"], f"品类概览：{len(df)}搜索词覆盖{category_name}品类，5类词根体系拆解", 11, "FFFFFF", "2D2006")

    row = 4
    headers = ["指标", "数值"]
    for i, h in enumerate(headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)

    total_search = int(df["预估搜索人气"].sum())
    avg_cvr = df["CVR"].mean() * 100
    valid_supply = df[df["需求供给比"] > 0]["需求供给比"].mean()
    zero_supply = int((df["需求供给比"] == 0).sum())
    avg_tmall = df["天猫商品点击占比"].mean() * 100

    metrics = [
        ("总搜索词数", len(df)),
        ("总搜索人气(预估)", total_search),
        ("平均CVR(%)", round(avg_cvr, 2)),
        ("有效供给比均值(排除0)", round(valid_supply, 2) if not pd.isna(valid_supply) else 0),
        ("供给比为0词数", zero_supply),
        ("天猫占比均值(%)", round(avg_tmall, 2))
    ]
    for i, (k, v) in enumerate(metrics):
        r = row + 1 + i
        apply_data_style(ws.cell(row=r, column=1), k, is_alt=(i%2==1), align="left")
        apply_data_style(ws.cell(row=r, column=2), v, is_alt=(i%2==1))

    row = row + len(metrics) + 2
    ws.merge_cells(f"A{row}:I{row}")
    apply_title_style(ws.cell(row=row, column=1), "5类词根体系概览", 12, "FFD700", "2D2006")
    row += 1

    headers2 = ["词根类别", "词根数", "有效词根数(出现>0)", "总出现频次", "平均搜索人气", "平均CVR(%)", "平均供给比", "平均天猫占比(%)"]
    for i, h in enumerate(headers2):
        apply_header_style(ws.cell(row=row, column=i+1), h)

    for ci, cat in enumerate(["功能", "材质", "人群", "场景", "款式"]):
        cat_data = agg[agg["类别"] == cat].sort_values("综合指数", ascending=False)
        total_roots = len(root_dict[cat])
        valid_roots = len(cat_data)
        total_freq = int(cat_data["出现词数"].sum()) if not cat_data.empty else 0
        avg_search = round(cat_data["平均搜索人气"].mean(), 0) if not cat_data.empty else 0
        avg_cvr_cat = round(cat_data["平均CVR"].mean(), 2) if not cat_data.empty else 0
        avg_supply = round(cat_data["平均供给比"].mean(), 2) if not cat_data.empty else 0
        avg_tmall_cat = round(cat_data["平均天猫占比"].mean(), 2) if not cat_data.empty else 0

        r = row + 1
        apply_data_style(ws.cell(row=r, column=1), f"{CAT_EMOJI[cat]}{cat}", is_alt=(ci%2==1), align="left")
        apply_data_style(ws.cell(row=r, column=2), total_roots, is_alt=(ci%2==1))
        apply_data_style(ws.cell(row=r, column=3), valid_roots, is_alt=(ci%2==1))
        apply_data_style(ws.cell(row=r, column=4), total_freq, is_alt=(ci%2==1))
        apply_data_style(ws.cell(row=r, column=5), avg_search, is_alt=(ci%2==1))
        apply_data_style(ws.cell(row=r, column=6), avg_cvr_cat, is_alt=(ci%2==1))
        apply_data_style(ws.cell(row=r, column=7), avg_supply, is_alt=(ci%2==1))
        apply_data_style(ws.cell(row=r, column=8), avg_tmall_cat, is_alt=(ci%2==1))
        row = r + 1

        for idx, rdata in cat_data.iterrows():
            apply_data_style(ws.cell(row=row, column=1), "", is_alt=(idx%2==1))
            apply_data_style(ws.cell(row=row, column=2), "", is_alt=(idx%2==1))
            apply_data_style(ws.cell(row=row, column=3), rdata["词根"], is_alt=(idx%2==1), align="left")
            apply_data_style(ws.cell(row=row, column=4), rdata["出现词数"], is_alt=(idx%2==1))
            apply_data_style(ws.cell(row=row, column=5), round(rdata["平均搜索人气"], 0), is_alt=(idx%2==1))
            apply_data_style(ws.cell(row=row, column=6), round(rdata["平均CVR"], 2), is_alt=(idx%2==1))
            apply_data_style(ws.cell(row=row, column=7), round(rdata["平均供给比"], 2), is_alt=(idx%2==1))
            apply_data_style(ws.cell(row=row, column=8), round(rdata["平均天猫占比"], 2), is_alt=(idx%2==1))
            apply_data_style(ws.cell(row=row, column=9), rdata["综合指数"], is_alt=(idx%2==1))
            row += 1

    row += 1

    ws.merge_cells(f"A{row}:I{row}")
    apply_title_style(ws.cell(row=row, column=1), "全词根排名(按综合指数)", 12, "FFD700", "2D2006")
    row += 1

    rank_headers = ["排名", "词根类别", "词根", "出现词数", "搜索人气", "CVR(%)", "供给比", "天猫占比(%)", "综合指数"]
    for i, h in enumerate(rank_headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)
    row += 1

    all_ranked = agg.sort_values("综合指数", ascending=False).reset_index(drop=True)
    for idx, rdata in all_ranked.iterrows():
        vals = [
            idx + 1, f"{CAT_EMOJI[rdata['类别']]}{rdata['类别']}", rdata["词根"],
            rdata["出现词数"], round(rdata["平均搜索人气"], 0), round(rdata["平均CVR"], 2),
            round(rdata["平均供给比"], 2), round(rdata["平均天猫占比"], 2), rdata["综合指数"]
        ]
        for ci, v in enumerate(vals):
            apply_data_style(ws.cell(row=row, column=ci+1), v, is_alt=(idx%2==1))
        row += 1

    row += 1

    ws.merge_cells(f"A{row}:I{row}")
    apply_title_style(ws.cell(row=row, column=1), "品类总洞察", 12, "FFD700", "2D2006")
    row += 1

    insight_headers = ["洞察编号", "洞察内容"]
    for i, h in enumerate(insight_headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)
    row += 1

    insights = [
        ("洞察1", "功能词根是核心驱动力，高频功能词根是品类核心属性"),
        ("洞察2", "材质词根搜索量集中，高端材质是品质信号词根"),
        ("洞察3", "场景词根组合频率高，需求与场景绑定强"),
        ("洞察4", "款式词根覆盖面广，颜色/风格/品牌细分是差异化流量入口"),
        ("洞察5", "人群词根覆盖全量，细分人群是蓝海客群方向"),
        ("洞察6", f"{zero_supply}词供给比为0，赛道数据缺失较多，蓝海词根需以有效数据验证")
    ]
    for i, (num, content) in enumerate(insights):
        apply_data_style(ws.cell(row=row, column=1), num, is_alt=(i%2==1), align="left")
        apply_data_style(ws.cell(row=row, column=2), content, is_alt=(i%2==1), align="left")
        row += 1

    ws.column_dimensions["A"].width = 16
    for c in "BCDEFGHI":
        ws.column_dimensions[c].width = 14

# ==================== Sheet 2 ====================
def build_sheet2(wb, agg, category_name):
    ws = wb.create_sheet("2-分类目词根拆解")
    ws.merge_cells("A1:I1")
    apply_title_style(ws["A1"], f"{category_name} · 分类目词根拆解", 16, "FFD700", "2D2006")

    row = 3
    for cat in ["功能", "材质", "人群", "场景", "款式"]:
        cat_data = agg[agg["类别"] == cat].sort_values("综合指数", ascending=False)
        ws.merge_cells(f"A{row}:I{row}")
        apply_category_title(ws, row, 1, f"{CAT_EMOJI[cat]}{cat}类词根拆解", CAT_FILL[cat])
        row += 1

        headers = ["词根", "出现词数", "平均搜索人气", "平均CVR(%)", "平均供给比", "平均天猫占比(%)", "平均买家数", "需求规模评分", "综合指数"]
        for i, h in enumerate(headers):
            apply_header_style(ws.cell(row=row, column=i+1), h)
        row += 1

        for idx, rdata in cat_data.iterrows():
            vals = [
                rdata["词根"], rdata["出现词数"], round(rdata["平均搜索人气"], 0),
                round(rdata["平均CVR"], 2), round(rdata["平均供给比"], 2),
                round(rdata["平均天猫占比"], 2), round(rdata["平均买家数"], 0),
                rdata["需求规模评分"], rdata["综合指数"]
            ]
            for ci, v in enumerate(vals):
                apply_data_style(ws.cell(row=row, column=ci+1), v, is_alt=(idx%2==1))
            row += 1
        row += 1

    ws.column_dimensions["A"].width = 16
    for c in "BCDEFGHI":
        ws.column_dimensions[c].width = 14

# ==================== Sheet 3 ====================
def build_sheet3(wb, agg, category_name):
    ws = wb.create_sheet("3-词根需求强度矩阵")
    ws.merge_cells("A1:J1")
    apply_title_style(ws["A1"], f"{category_name} · 词根需求强度矩阵", 16, "FFD700", "2D2006")
    ws.merge_cells("A2:J2")
    apply_title_style(ws["A2"], "5维评分体系：需求规模(0.3权重) + 转化效率(0.25) + 竞争规避(0.15) + 蓝海机会(0.2) + 商业价值(0.1)", 10, "FFFFFF", "2D2006")

    row = 4
    headers = ["排名", "词根类别", "词根", "需求规模", "转化效率", "竞争压力", "蓝海机会", "商业价值", "综合指数", "建议策略"]
    for i, h in enumerate(headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)

    sorted_agg = agg.sort_values("综合指数", ascending=False).reset_index(drop=True)

    def strategy(score):
        if score >= 6.5: return "优先投放"
        elif score >= 5.0: return "选择性投放"
        elif score >= 4.0: return "观察测试"
        else: return "谨慎观望"

    for idx, rdata in sorted_agg.iterrows():
        r = row + 1 + idx
        vals = [
            idx + 1, f"{CAT_EMOJI[rdata['类别']]}{rdata['类别']}", rdata["词根"],
            rdata["需求规模"], rdata["转化效率"], rdata["竞争压力"],
            rdata["蓝海机会"], rdata["商业价值"], rdata["综合指数"],
            strategy(rdata["综合指数"])
        ]
        for ci, v in enumerate(vals):
            apply_data_style(ws.cell(row=r, column=ci+1), v, is_alt=(idx%2==1))

    ws.column_dimensions["A"].width = 8
    ws.column_dimensions["B"].width = 14
    ws.column_dimensions["C"].width = 16
    for c in "DEFGHIJ":
        ws.column_dimensions[c].width = 12

# ==================== Sheet 4 ====================
def build_sheet4(wb, df, agg, category_name):
    ws = wb.create_sheet("4-词根交叉组合路径")
    ws.merge_cells("A1:H1")
    apply_title_style(ws["A1"], f"{category_name} · 词根交叉组合路径", 16, "FFD700", "2D2006")
    ws.merge_cells("A2:H2")
    apply_title_style(ws["A2"], "TOP20词根两两交叉，发现组合需求路径", 10, "FFFFFF", "2D2006")

    top20 = agg.sort_values("综合指数", ascending=False).head(20)
    top_roots = top20[["类别", "词根", "综合指数"]].to_dict("records")

    cross_records = []
    for i in range(len(top_roots)):
        for j in range(i+1, len(top_roots)):
            r1, r2 = top_roots[i], top_roots[j]
            matched = []
            for _, row in df.iterrows():
                term = str(row.get("相关搜索词", "")).replace(" ", "")
                if r1["词根"] in term and r2["词根"] in term:
                    matched.append(row)
            if matched:
                mdf = pd.DataFrame(matched)
                cross_records.append({
                    "词根A": f"{CAT_EMOJI[r1['类别']]}{r1['类别']}·{r1['词根']}",
                    "词根B": f"{CAT_EMOJI[r2['类别']]}{r2['类别']}·{r2['词根']}",
                    "交叉词数": len(mdf),
                    "平均搜索人气": round(mdf["预估搜索人气"].mean(), 0),
                    "平均CVR(%)": round(mdf["CVR"].mean() * 100, 2),
                    "平均买家数": round(mdf["预估支付买家数"].mean(), 0),
                    "组合潜力": round(
                        (mdf["预估搜索人气"].mean() / 1000) *
                        (mdf["CVR"].mean() * 100) * len(mdf) / 100, 2
                    )
                })

    cross_df = pd.DataFrame(cross_records).sort_values("组合潜力", ascending=False).head(25)

    row = 4
    headers = ["排名", "词根A", "词根B", "交叉词数", "平均搜索人气", "平均CVR(%)", "平均买家数", "组合潜力"]
    for i, h in enumerate(headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)

    for idx, rdata in cross_df.iterrows():
        r = row + 1 + idx
        vals = [idx + 1, rdata["词根A"], rdata["词根B"], rdata["交叉词数"],
                rdata["平均搜索人气"], rdata["平均CVR(%)"], rdata["平均买家数"], rdata["组合潜力"]]
        for ci, v in enumerate(vals):
            apply_data_style(ws.cell(row=r, column=ci+1), v, is_alt=(idx%2==1))

    insight_row = row + len(cross_df) + 2
    ws.merge_cells(f"A{insight_row}:H{insight_row}")
    apply_category_title(ws, insight_row, 1, "交叉组合核心洞察", "2D2006")
    insight_row += 1
    insights = [
        "功能×款式交叉：高频功能词+款式词为最高频组合，是品类核心路径",
        "材质×人群交叉：高端材质+核心人群为品质需求主力方向",
        "场景×功能交叉：场景词+功能词为季节性最强组合",
        "人群×款式交叉：细分人群+风格款式为风格化蓝海方向"
    ]
    for ins in insights:
        ws.merge_cells(f"A{insight_row}:H{insight_row}")
        apply_data_style(ws.cell(row=insight_row, column=1), ins, align="left")
        insight_row += 1

    ws.column_dimensions["A"].width = 8
    ws.column_dimensions["B"].width = 22
    ws.column_dimensions["C"].width = 22
    for c in "DEFGH":
        ws.column_dimensions[c].width = 14

# ==================== Sheet 5 ====================
def build_sheet5(wb, agg, category_name):
    ws = wb.create_sheet("5-蓝海词根挖掘")
    ws.merge_cells("A1:J1")
    apply_title_style(ws["A1"], f"{category_name} · 蓝海词根挖掘", 16, "FFD700", "2D2006")

    common_headers = ["排名", "词根类别", "词根", "出现词数", "搜索人气", "CVR(%)", "供给比", "天猫占比(%)", "蓝海机会评分", "策略建议"]

    row = 3
    ws.merge_cells(f"A{row}:J{row}")
    apply_category_title(ws, row, 1, "蓝海词根(供给比高+词数适中+CVR>3%)", "2D2006")
    row += 1

    for i, h in enumerate(common_headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)
    row += 1

    blue_candidates = agg[(agg["平均CVR"] > 3) & (agg["平均供给比"] > 0)].sort_values("平均供给比", ascending=False)
    blue = blue_candidates.head(3)
    blue_roots = set()

    for idx, rdata in blue.iterrows():
        blue_roots.add(rdata["词根"])
        vals = [
            len(blue_roots), f"{CAT_EMOJI[rdata['类别']]}{rdata['类别']}", rdata["词根"],
            rdata["出现词数"], round(rdata["平均搜索人气"], 0), round(rdata["平均CVR"], 2),
            round(rdata["平均供给比"], 2), round(rdata["平均天猫占比"], 2), rdata["蓝海机会"], "🔥核心抢占"
        ]
        for ci, v in enumerate(vals):
            apply_data_style(ws.cell(row=row, column=ci+1), v, is_alt=(len(blue_roots)%2==0))
        row += 1

    row += 2
    ws.merge_cells(f"A{row}:J{row}")
    apply_category_title(ws, row, 1, "轻竞争词根(出现词数≤5+供给比>0)", "2D2006")
    row += 1

    for i, h in enumerate(common_headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)
    row += 1

    light = agg[
        (agg["出现词数"] <= 5) & (agg["平均供给比"] > 0) & (~agg["词根"].isin(blue_roots))
    ].sort_values("蓝海机会", ascending=False)

    for ridx, (idx, rdata) in enumerate(light.iterrows()):
        strategy = "🔥核心抢占" if rdata["蓝海机会"] >= 8 else "💎差异化布局"
        vals = [
            ridx + 1, f"{CAT_EMOJI[rdata['类别']]}{rdata['类别']}", rdata["词根"],
            rdata["出现词数"], round(rdata["平均搜索人气"], 0), round(rdata["平均CVR"], 2),
            round(rdata["平均供给比"], 2), round(rdata["平均天猫占比"], 2), rdata["蓝海机会"], strategy
        ]
        for ci, v in enumerate(vals):
            apply_data_style(ws.cell(row=row, column=ci+1), v, is_alt=(ridx%2==1))
        row += 1

    row += 2
    ws.merge_cells(f"A{row}:J{row}")
    apply_category_title(ws, row, 1, "3级蓝海策略 + 上架方向", "2D2006")
    row += 1

    strategy_headers = ["策略级别", "策略描述", "目标词根", "上架方向", "标题建议"]
    for i, h in enumerate(strategy_headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)
    row += 1

    strategies = [
        ["🔥P0-核心抢占", "最高蓝海机会词根，立即上架抢占", "词根A+词根B", "核心链接", f"{category_name}核心词根组合标题"],
        ["💎P1-差异化布局", "中等蓝海词根，差异化上架", "词根C+词根D", "差异化链接", f"{category_name}差异化词根组合标题"],
        ["🎯P2-测试验证", "轻竞争词根，小批量测试", "词根E+词根F", "测试链接", f"{category_name}测试词根组合标题"]
    ]
    for si, srow in enumerate(strategies):
        for ci, v in enumerate(srow):
            apply_data_style(ws.cell(row=row, column=ci+1), v, is_alt=(si%2==1), align="left")
        row += 1

    ws.column_dimensions["A"].width = 14
    ws.column_dimensions["B"].width = 16
    ws.column_dimensions["C"].width = 14
    ws.column_dimensions["D"].width = 14
    ws.column_dimensions["E"].width = 40
    for c in "FGHIJ":
        ws.column_dimensions[c].width = 14

# ==================== Sheet 6 ====================
def build_sheet6(wb, agg, category_name):
    ws = wb.create_sheet("6-词根盈利诊断")
    ws.merge_cells("A1:I1")
    apply_title_style(ws["A1"], f"{category_name} · 词根盈利诊断", 16, "FFD700", "2D2006")

    row = 3
    ws.merge_cells(f"A{row}:I{row}")
    apply_category_title(ws, row, 1, "盈利TOP10词根(商业价值排序)", "2D2006")
    row += 1

    headers = ["排名", "词根类别", "词根", "出现词数", "搜索人气", "CVR(%)", "买家数", "商业价值评分", "诊断结论"]
    for i, h in enumerate(headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)
    row += 1

    top10 = agg.sort_values("商业价值", ascending=False).head(10)
    for idx, rdata in top10.iterrows():
        conclusion = "高盈利核心词根，必投" if rdata["商业价值"] >= 7 else "中等盈利，选择性投放"
        vals = [
            idx + 1, f"{CAT_EMOJI[rdata['类别']]}{rdata['类别']}", rdata["词根"],
            rdata["出现词数"], round(rdata["平均搜索人气"], 0), round(rdata["平均CVR"], 2),
            round(rdata["平均买家数"], 0), rdata["商业价值"], conclusion
        ]
        for ci, v in enumerate(vals):
            apply_data_style(ws.cell(row=row, column=ci+1), v, is_alt=(idx%2==1))
        row += 1

    row += 2
    ws.merge_cells(f"A{row}:I{row}")
    apply_category_title(ws, row, 1, "需优化TOP10词根(商业价值低排序)", "2D2006")
    row += 1

    for i, h in enumerate(headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)
    row += 1

    bottom10 = agg[agg["商业价值"] > 0].sort_values("商业价值", ascending=True).head(10)
    for idx, rdata in bottom10.iterrows():
        vals = [
            idx + 1, f"{CAT_EMOJI[rdata['类别']]}{rdata['类别']}", rdata["词根"],
            rdata["出现词数"], round(rdata["平均搜索人气"], 0), round(rdata["平均CVR"], 2),
            round(rdata["平均买家数"], 0), rdata["商业价值"], "低商业价值，需优化投放"
        ]
        for ci, v in enumerate(vals):
            apply_data_style(ws.cell(row=row, column=ci+1), v, is_alt=(idx%2==1))
        row += 1

    ws.column_dimensions["A"].width = 8
    ws.column_dimensions["B"].width = 14
    ws.column_dimensions["C"].width = 14
    for c in "DEFGHI":
        ws.column_dimensions[c].width = 14

# ==================== Sheet 7 ====================
def build_sheet7(wb, agg, category_name, core_product_word, title_rules=None):
    ws = wb.create_sheet("7-词根行动策略")
    ws.merge_cells("A1:J1")
    apply_title_style(ws["A1"], f"{category_name} · 词根行动策略", 16, "FFD700", "2D2006")
    ws.merge_cells("A2:J2")
    apply_title_style(ws["A2"], "三级行动策略(P0紧急/P1重要/P2观察)", 10, "FFFFFF", "2D2006")

    row = 4
    headers = ["优先级", "词根类别", "词根", "出现词数", "搜索人气", "CVR(%)", "供给比", "综合指数", "行动策略", "标题建议"]
    for i, h in enumerate(headers):
        apply_header_style(ws.cell(row=row, column=i+1), h)
    row += 1

    def priority(score):
        if score >= 6.5: return "🔥P0-紧急"
        elif score >= 5.0: return "💎P1-重要"
        else: return "🎯P2-观察"

    def action_strategy(score):
        if score >= 6.5: return "立即上架投放"
        elif score >= 5.0: return "选择性投放"
        else: return "小批量测试"

    def title_suggest(rdata):
        cat = rdata["类别"]
        root = rdata["词根"]
        base = category_name

        # 避免词根与base重复
        if root in base:
            title = base
        elif core_product_word in root and core_product_word in base:
            title = base.replace(core_product_word, root, 1)
        else:
            title = f"{root}{base}" if cat == "材质" else f"{base}{root}"

        # 应用 title_rules（如果提供了）
        if title_rules:
            suffix = title_rules.get("default_suffix", "")
            root_override = title_rules.get("root_overrides", {}).get(root)
            cat_override = title_rules.get("category_overrides", {}).get(cat, {}).get(root)
            if cat_override:
                suffix = cat_override
            elif root_override:
                suffix = root_override
            if suffix:
                return f"{title}{suffix}"

        return title

    sorted_agg = agg.sort_values("综合指数", ascending=False)
    for idx, rdata in sorted_agg.iterrows():
        p = priority(rdata["综合指数"])
        vals = [
            p, f"{CAT_EMOJI[rdata['类别']]}{rdata['类别']}", rdata["词根"],
            rdata["出现词数"], round(rdata["平均搜索人气"], 0), round(rdata["平均CVR"], 2),
            round(rdata["平均供给比"], 2), rdata["综合指数"],
            action_strategy(rdata["综合指数"]), title_suggest(rdata)
        ]
        for ci, v in enumerate(vals):
            apply_data_style(ws.cell(row=row, column=ci+1), v, is_alt=(idx%2==1), align="left" if ci in [0,1,9] else "center")
        row += 1

    ws.column_dimensions["A"].width = 14
    ws.column_dimensions["B"].width = 14
    ws.column_dimensions["C"].width = 14
    for c in "DEFGH":
        ws.column_dimensions[c].width = 12
    ws.column_dimensions["I"].width = 14
    ws.column_dimensions["J"].width = 40

# ==================== 主函数 ====================
def main():
    parser = argparse.ArgumentParser(description="A2 五类词根需求拆解")
    parser.add_argument("--config", required=True, help="JSON 配置文件路径")
    args = parser.parse_args()

    with open(args.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    input_path = cfg["input_path"]
    output_path = cfg["output_path"]
    category_name = cfg["category_name"]
    core_product_word = cfg["core_product_word"]
    root_dict = cfg["root_dict"]
    title_rules = cfg.get("title_rules")

    # 排序：每类内按长度降序
    for cat in root_dict:
        root_dict[cat] = sorted(root_dict[cat], key=len, reverse=True)

    print(f"开始生成 A2 五类词根需求拆解表格 [{category_name}]...")
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    df = load_data(input_path)
    print(f"数据加载完成: {len(df)} 条搜索词")

    agg = calc_root_stats(df, core_product_word, root_dict)
    print(f"词根提取完成: {len(agg)} 个词根")

    agg = calc_scores(agg)
    print("评分计算完成")

    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    build_sheet1(wb, df, agg, category_name, root_dict)
    build_sheet2(wb, agg, category_name)
    build_sheet3(wb, agg, category_name)
    build_sheet4(wb, df, agg, category_name)
    build_sheet5(wb, agg, category_name)
    build_sheet6(wb, agg, category_name)
    build_sheet7(wb, agg, category_name, core_product_word, title_rules)

    wb.save(output_path)
    print(f"已保存: {output_path}")

if __name__ == "__main__":
    main()
