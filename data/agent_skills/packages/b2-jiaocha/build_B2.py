#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
B2-交叉矩阵·交叉赛道四级分类 — 通用数据分析脚本
技能编号: B2

用法:
    python build_B2.py --config <config.json>

config.json 示例:
    {
        "input_path": "数据源.xlsx",
        "output_path": "输出.xlsx",
        "category_name": "行李箱(侧开盖赛道)",
        "total_buyers": 716438,
        "sheet_name": "交叉赛道数据源"
    }

数据源格式（Excel sheet）:
    类别A | 词根A | 类别B | 词根B | 类别C | 词根C | 交叉类型 | 共现词数 | 总搜索人气 | 总买家数 | 平均CVR% | 平均供给比 | 竞争评级 | 3维归属 | 差异化策略
"""

import argparse
import json
import os
import sys

import pandas as pd
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# ==================== 常量配置 ====================
# 默认四级分类阈值（可通过配置覆盖）
DEFAULT_TIER_THRESHOLDS = {
    "head":   {"name": "头部", "emoji": "🔴", "count": 10, "fill": "FFFFE8E8", "font_color": "000000"},
    "waist":  {"name": "腰部", "emoji": "🟠", "count": 20, "fill": "FFFFF0D0", "font_color": "000000"},
    "active": {"name": "动销", "emoji": "🔵", "count": 20, "fill": "FFE0F0FF", "font_color": "000000"},
    "tail":   {"name": "尾部", "emoji": "⚪", "count": None, "fill": "FFE8E8E8", "font_color": "000000"},
}

TIER_CONFIG = dict(DEFAULT_TIER_THRESHOLDS)

TITLE_FILL = "FF204060"
TITLE_FONT_COLOR = "FFFFFFFF"
HEADER_FILL = "375623"
HEADER_FONT_COLOR = "FFFFFF"
ALT_ROW_FILL = "F5F5F0"

DIM3_COMBINATIONS = [
    "功能×材质×人群", "功能×材质×场景", "功能×材质×款式",
    "功能×人群×场景", "功能×人群×款式", "功能×场景×款式",
    "材质×人群×场景", "材质×人群×款式", "材质×场景×款式",
    "人群×场景×款式",
]

STRATEGY_TEMPLATES = {
    "head":   {
        "cols": ["优先投放", "建立壁垒", "竞品对标"],
        "detail": "竞品对标：参考头部链接，优化标题/主图/详情页词根布局",
        "actions": {
            "🔵蓝海": "立即抢占：加大投放预算，快速建立品类心智",
            "🟢轻竞争": "优先投放：优化词根布局，抢占搜索流量入口",
            "🟡中竞争": "选择性投放：聚焦差异化卖点，避开正面竞争",
            "🟠高竞争": "谨慎投放：需强差异化支撑，控制预算比例",
            "🔴红海": "避免投放：寻找细分差异化场景切入",
            "⚪数据缺失": "数据补充：建议补充竞争数据后再决策",
        },
    },
    "waist":  {
        "cols": ["延伸头部", "差异化区分", "测试投放"],
        "detail": "与头部区分：避开头部词根组合，选择腰部差异化词根切入",
        "actions": {
            "🔵蓝海": "快速跟进：利用蓝海优势，承接头部溢出流量",
            "🟢轻竞争": "差异化切入：选择与头部不同的词根组合错位竞争",
            "🟡中竞争": "测试验证：小预算测试，验证差异化卖点效果",
            "🟠高竞争": "观望储备：暂不建议投放，等待竞争环境变化",
            "🔴红海": "放弃切入：红海赛道腰部竞争同样激烈",
            "⚪数据缺失": "数据监测：建议先补充数据，评估竞争环境",
        },
    },
    "active": {
        "cols": ["观察测试", "关注转化", "低预算试投"],
        "detail": "测试周期2-4周，观察CVR和加购率，达标后升级腰部",
        "actions": {
            "🔵蓝海": "潜力挖掘：蓝海动销赛道值得加大测试预算",
            "🟢轻竞争": "稳步测试：控制成本，关注ROI达标情况",
            "🟡中竞争": "谨慎观察：CVR达标前保持低预算观察",
            "🟠高竞争": "暂不测试：竞争激烈，动销升级难度大",
            "🔴红海": "暂缓投入：红海赛道动销难以突破",
            "⚪数据缺失": "补充测试：建议先跑小数据验证需求真实性",
        },
    },
    "tail":   {
        "cols": ["储备观察", "关注信号", "暂不投放"],
        "detail": "储备条件：CVR>5%或供给比>1时考虑升级",
        "actions": {
            "🔵蓝海": "关注储备：蓝海尾部有潜力，持续监测需求变化",
            "🟢轻竞争": "定期复盘：每60天评估一次，关注竞争环境变化",
            "🟡中竞争": "长期观察：需求增长时考虑切入",
            "🟠高竞争": "放弃储备：竞争激烈且需求低，不建议关注",
            "🔴红海": "直接放弃：红海尾部无价值",
            "⚪数据缺失": "忽略处理：数据不足且需求低，暂不关注",
        },
    },
}

INDICATOR_MANUAL = [
    ["指标名称", "定义说明", "计算公式", "数据来源", "单位", "", "", ""],
    ["总搜索人气", "交叉赛道内所有搜索词预估搜索人气之和", "Σ预估搜索人气", "生意参谋", "万", "", "", ""],
    ["总买家数", "交叉赛道内所有搜索词预估支付买家数之和", "Σ预估支付买家数", "生意参谋", "人", "", "", ""],
    ["买家占比", "该赛道买家数占全品类买家数的百分比", "赛道买家数/全品类买家数×100%", "计算", "%", "", "", ""],
    ["平均CVR", "赛道内搜索词平均支付转化率", "ΣCVR/词数", "计算", "%", "", "", ""],
    ["平均供给比", "赛道内搜索词平均需求供给比(排除0)", "Σ有效供给比/有效词数", "计算", "倍", "", "", ""],
    ["竞争评级", "基于供给比的5级竞争评级", "蓝海≥5/轻≥1/中≥0.3/高≥0.1/红<0.1", "计算", "级", "", "", ""],
    ["共现词数", "含2/3类词根的搜索词数量", "词根A∩词根B的词数", "计算", "个", "", "", ""],
]

TIER_DEFINITIONS = [
    ["等级", "范围", "特征", "策略方向", "预算建议", "投放节奏", "观测周期", "升级条件"],
    ["🔴头部", "TOP1-10", "高买家数+高CVR", "优先投放+壁垒建设", "高预算30-50%", "立即上架", "7天冲刺", "无需升级"],
    ["🟠腰部", "TOP11-30", "中等买家数", "差异化投放+延伸路径", "中预算20-30%", "14天放量", "14天观察", "买家数超头部50%"],
    ["🔵动销", "TOP31-50", "低买家数+有转化", "测试投放+观察指标", "低预算10-15%", "30天稳量", "30天观察", "CVR>赛道均值"],
    ["⚪尾部", "TOP51+", "极低买家数", "储备观察+暂不投放", "0-5%预算", "暂缓上架", "60天观察", "买家数突破动销线"],
]

COMPETITION_RATINGS = [
    ["评级", "供给比范围", "含义", "策略建议", "", "", "", ""],
    ["🔵蓝海", "≥5", "需求远超供给，竞争极少", "立即抢占", "", "", "", ""],
    ["🟢轻竞争", "1-5", "需求>供给，竞争可控", "优先投放", "", "", "", ""],
    ["🟡中竞争", "0.3-1", "供需平衡，竞争适中", "选择性投放", "", "", "", ""],
    ["🟠高竞争", "0.1-0.3", "供给>需求，竞争激烈", "谨慎投放", "", "", "", ""],
    ["🔴红海", "<0.1", "供给远超需求，极度竞争", "避免或差异化", "", "", "", ""],
]


# ==================== 样式函数 ====================
def apply_title_style(cell, text, font_size=14, font_color=TITLE_FONT_COLOR, fill_color=TITLE_FILL):
    cell.value = text
    cell.font = Font(name="微软雅黑", size=font_size, bold=True, color=font_color)
    cell.fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def apply_header_style(cell, text, fill_color=HEADER_FILL, font_color=HEADER_FONT_COLOR):
    cell.value = text
    cell.font = Font(name="微软雅黑", size=10, bold=True, color=font_color)
    cell.fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
    cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def apply_data_style(cell, value, fill_color="FFFFFF", font_color="1A1A1A", align="center"):
    cell.value = value
    cell.font = Font(name="微软雅黑", size=9, color=font_color)
    cell.fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
    cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=True)


def apply_tier_row_style(ws, row_idx, tier_key):
    """按等级应用整行背景色"""
    cfg = TIER_CONFIG[tier_key]
    fill = PatternFill(start_color=cfg["fill"], end_color=cfg["fill"], fill_type="solid")
    for col in range(1, ws.max_column + 1):
        cell = ws.cell(row=row_idx, column=col)
        if cell.fill.start_color.rgb == "00000000" or cell.fill.start_color.rgb is None:
            cell.fill = fill


# ==================== 数据源读取 ====================
def load_data(input_path, sheet_name="交叉赛道数据源"):
    """读取数据源Excel"""
    df = pd.read_excel(input_path, sheet_name=sheet_name)
    
    # 标准化列名（兼容可能的不同命名）
    col_mapping = {
        "类别A": "类别A", "词根A": "词根A",
        "类别B": "类别B", "词根B": "词根B",
        "类别C": "类别C", "词根C": "词根C",
        "交叉类型": "交叉类型", "类型": "交叉类型",
        "共现词数": "共现词数",
        "总搜索人气": "总搜索人气",
        "总买家数": "总买家数",
        "平均CVR%": "平均CVR%", "平均CVR": "平均CVR%",
        "平均供给比": "平均供给比",
        "竞争评级": "竞争评级",
        "3维归属": "3维归属", "三维归属": "3维归属",
        "差异化策略": "差异化策略",
        "交叉组合": "交叉组合",
    }
    
    # 重命名存在的列
    rename_map = {}
    for src, dst in col_mapping.items():
        if src in df.columns:
            rename_map[src] = dst
    df = df.rename(columns=rename_map)
    
    # 确保数值列
    for col in ["共现词数", "总搜索人气", "总买家数"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    for col in ["平均CVR%", "平均供给比"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    
    # 填充缺失列
    for col in ["类别C", "词根C", "交叉组合", "3维归属", "差异化策略", "竞争评级"]:
        if col not in df.columns:
            df[col] = ""
    if "交叉类型" not in df.columns:
        df["交叉类型"] = df.apply(lambda r: "3维" if pd.notna(r.get("词根C")) and str(r.get("词根C")).strip() else "2维", axis=1)
    
    # 自动推断差异化策略（基于3维归属 + 交叉组合类别）
    DIM3_STRATEGY_TEMPLATES = {
        "功能×材质×人群": "功能痛点+材质信任+人群场景三维定位",
        "功能×材质×场景": "功能卖点+材质优势+场景需求三维定位",
        "功能×材质×款式": "功能卖点+材质质感+款式差异化三维定位",
        "功能×人群×场景": "功能需求+人群画像+场景触发三维定位",
        "功能×人群×款式": "功能卖点+人群专属+款式偏好三维定位",
        "功能×场景×款式": "功能卖点+场景痛点+款式差异三维定位",
        "材质×人群×场景": "材质优势+人群画像+场景触发三维定位",
        "材质×人群×款式": "材质质感+人群偏好+款式选择三维定位",
        "材质×场景×款式": "材质优势+场景触发+款式差异三维定位",
        "人群×场景×款式": "人群专属+场景触发+款式偏好三维定位",
    }
    
    # 基于交叉组合类别的动态策略模板
    CAT_KEYWORDS = {
        "🔴功能": {"功能卖点", "功能痛点", "功能优势", "功能升级"},
        "🟠材质": {"材质优势", "材质质感", "材质信任", "材质升级"},
        "🟡人群": {"人群专属", "人群画像", "人群偏好", "人群定制"},
        "🟢场景": {"场景触发", "场景痛点", "场景需求", "场景适配"},
        "🔵款式": {"款式差异", "款式偏好", "款式选择", "款式设计"},
    }
    
    def generate_strategy(row):
        """基于3维归属和交叉组合类别生成差异化策略"""
        dim3 = row["3维归属"]
        if dim3 and dim3 in DIM3_STRATEGY_TEMPLATES:
            base = DIM3_STRATEGY_TEMPLATES[dim3]
            
            # 增强：根据竞争评级调整策略措辞
            rating = str(row.get("竞争评级", ""))
            if "蓝海" in rating:
                base += " | 蓝海赛道：快速占位，建立先发优势"
            elif "轻竞争" in rating:
                base += " | 轻竞争赛道：优化词根布局，抢占搜索流量"
            elif "红海" in rating:
                base += " | 红海赛道：强差异化切入，避免正面竞争"
            
            return base
        return ""
    
    for idx, row in df.iterrows():
        if not row["差异化策略"] or str(row["差异化策略"]).strip() == "":
            strategy = generate_strategy(row)
            if strategy:
                df.at[idx, "差异化策略"] = strategy
    
    return df


# ==================== 核心计算 ====================
def compute_tiers(df, total_buyers, tier_thresholds=None):
    """计算四级分类
    
    Args:
        df: 数据源DataFrame
        total_buyers: 全品类总买家数
        tier_thresholds: 可选，自定义阈值配置
            格式: {"head": 10, "waist": 20, "active": 20}
            或: {"head": 0.08, "waist": 0.25, "active": 0.40} (比例模式，基于总记录数)
    """
    # 按总买家数降序，稳定排序
    df = df.sort_values(by="总买家数", ascending=False, kind="mergesort").reset_index(drop=True)
    df["排名"] = df.index + 1
    
    total_count = len(df)
    
    # 解析阈值
    if tier_thresholds:
        # 支持比例模式（值<1表示比例）
        head_raw = tier_thresholds.get("head", 10)
        head_limit = int(head_raw)
        if head_raw < 1:
            head_limit = max(1, int(total_count * head_raw))
        
        waist_raw = tier_thresholds.get("waist", 20)
        waist_limit = int(waist_raw)
        if waist_raw < 1:
            waist_limit = max(1, int(total_count * waist_raw))
        
        active_raw = tier_thresholds.get("active", 20)
        active_limit = int(active_raw)
        if active_raw < 1:
            active_limit = max(1, int(total_count * active_raw))
    else:
        head_limit = 10
        waist_limit = 20
        active_limit = 20
    
    # 更新全局配置（供其他函数使用）
    TIER_CONFIG["head"]["count"] = head_limit
    TIER_CONFIG["waist"]["count"] = waist_limit
    TIER_CONFIG["active"]["count"] = active_limit
    
    # 分配等级
    def assign_tier(rank):
        if rank <= head_limit:
            return "🔴头部"
        elif rank <= head_limit + waist_limit:
            return "🟠腰部"
        elif rank <= head_limit + waist_limit + active_limit:
            return "🔵动销"
        else:
            return "⚪尾部"
    
    df["等级"] = df["排名"].apply(assign_tier)
    
    # 自动推断竞争评级（基于平均供给比 + B1兼容映射）
    def infer_competition_rating(row):
        rating = str(row["竞争评级"]) if pd.notna(row["竞争评级"]) else ""
        rating = rating.strip()
        
        # B1非标准评级映射
        B1_RATING_MAP = {
            "低": "🔵蓝海",
            "较低": "🟢轻竞争",
            "中等": "🟡中竞争",
            "较高": "🟠高竞争",
            "高": "🔴红海",
            "待评估": "⚪数据缺失",
        }
        
        # 如果已经是标准emoji评级，直接保留
        if rating and rating not in ["", "⚪数据缺失", "nan"]:
            if any(emoji in rating for emoji in ["🔵", "🟢", "🟡", "🟠", "🔴"]):
                return rating
            # 尝试映射B1文本评级
            if rating in B1_RATING_MAP:
                return B1_RATING_MAP[rating]
        
        # 基于供给比推断
        supply = row["平均供给比"]
        if pd.notna(supply):
            if supply >= 5:
                return "🔵蓝海"
            elif supply >= 1:
                return "🟢轻竞争"
            elif supply >= 0.3:
                return "🟡中竞争"
            elif supply >= 0.1:
                return "🟠高竞争"
            else:
                return "🔴红海"
        return "⚪数据缺失"
    
    df["竞争评级"] = df.apply(infer_competition_rating, axis=1)
    
    # 计算买家占比%
    if total_buyers and total_buyers > 0:
        df["买家占比%"] = (df["总买家数"] / total_buyers * 100).round(4)
    else:
        total = df["总买家数"].sum()
        df["买家占比%"] = (df["总买家数"] / total * 100).round(4) if total > 0 else 0
    
    return df


def compute_summary(df, total_buyers):
    """计算四级汇总统计"""
    summary = []
    for key, cfg in TIER_CONFIG.items():
        tier_df = df[df["等级"] == cfg["emoji"] + cfg["name"]]
        if tier_df.empty:
            summary.append({
                "等级": cfg["name"],
                "emoji": cfg["emoji"],
                "赛道数": 0,
                "总买家数": 0,
                "买家占比%": 0,
                "平均CVR%": 0,
                "平均供给比": "蓝0/红0",
                "蓝海占比": "",
                "红海占比": "",
            })
            continue
        
        count = len(tier_df)
        buyers = int(tier_df["总买家数"].sum())
        ratio = round(buyers / total_buyers * 100, 2) if total_buyers else 0
        avg_cvr = round(tier_df["平均CVR%"].mean(), 2) if tier_df["平均CVR%"].notna().any() else 0
        
        # 供给比统计：优先使用数值，缺失时基于竞争评级推断
        supply_ratios = tier_df["平均供给比"].dropna()
        if len(supply_ratios) > 0:
            blue = sum(1 for s in supply_ratios if s >= 5)
            red = sum(1 for s in supply_ratios if pd.notna(s) and s < 0.1)
        else:
            # 基于竞争评级推断
            ratings = tier_df["竞争评级"].astype(str)
            blue = sum(1 for r in ratings if "蓝海" in r)
            red = sum(1 for r in ratings if "红海" in r)
        supply_str = f"蓝{blue}/红{red}"
        
        summary.append({
            "等级": cfg["name"],
            "emoji": cfg["emoji"],
            "赛道数": count,
            "总买家数": buyers,
            "买家占比%": ratio,
            "平均CVR%": avg_cvr,
            "平均供给比": supply_str,
            "蓝海占比": "",
            "红海占比": "",
        })
    
    return summary


def compute_type_matrix(df):
    """计算10类型×4级矩阵"""
    matrix = []
    for dim3 in DIM3_COMBINATIONS:
        dim_df = df[df["3维归属"] == dim3]
        row = {"交叉类型": dim3}
        total_2d = 0
        total_3d = 0
        for key, cfg in TIER_CONFIG.items():
            tier_df = dim_df[dim_df["等级"] == cfg["emoji"] + cfg["name"]]
            count = len(tier_df)
            row[f"{cfg['name']}数"] = count
            total_2d += len(tier_df[tier_df["交叉类型"] == "2维"])
            total_3d += len(tier_df[tier_df["交叉类型"] == "3维"])
        row["2维赛道"] = total_2d
        row["3维赛道"] = total_3d
        matrix.append(row)
    
    return matrix


# ==================== Sheet 生成 ====================
def create_sheet_overview(wb, category_name, df, summary, type_matrix, total_buyers):
    """Sheet1: 四级赛道总览"""
    ws = wb.create_sheet("1-四级赛道总览")
    
    # 大标题
    ws.merge_cells("A1:M1")
    apply_title_style(ws["A1"], f"{category_name} · 四级赛道总览", 16)
    
    # 副标题
    ws.merge_cells("A2:M2")
    total_tracks = len(df)
    apply_title_style(ws["A2"], f"交叉赛道总数{total_tracks} | 总买家数{int(total_buyers)} | 按买家数排序四级分类", 10, "5F5E5A", "E8EDF2")
    
    # ① 四级分类汇总表
    ws.merge_cells("A3:M3")
    apply_title_style(ws["A3"], "① 四级分类汇总表", 12)
    
    headers = ["等级", "emoji", "赛道数", "总买家数", "买家占比%", "平均CVR%", "平均供给比", "蓝海占比", "红海占比"]
    for i, h in enumerate(headers, 1):
        apply_header_style(ws.cell(row=4, column=i), h)
    
    tier_keys = ["head", "waist", "active", "tail"]
    for idx, s in enumerate(summary):
        row = 5 + idx
        ws.cell(row=row, column=1, value=s["等级"])
        ws.cell(row=row, column=2, value=s["emoji"])
        ws.cell(row=row, column=3, value=s["赛道数"])
        ws.cell(row=row, column=4, value=s["总买家数"])
        ws.cell(row=row, column=5, value=s["买家占比%"])
        ws.cell(row=row, column=6, value=s["平均CVR%"])
        ws.cell(row=row, column=7, value=s["平均供给比"])
        ws.cell(row=row, column=8, value=s["蓝海占比"] if s["蓝海占比"] is not None else "")
        ws.cell(row=row, column=9, value=s["红海占比"] if s["红海占比"] is not None else "")
        # 应用等级行背景色
        cfg = TIER_CONFIG[tier_keys[idx]]
        fill = PatternFill(start_color=cfg["fill"], end_color=cfg["fill"], fill_type="solid")
        for col in range(1, 10):
            ws.cell(row=row, column=col).fill = fill
            ws.cell(row=row, column=col).font = Font(name="微软雅黑", size=9, color="1A1A1A")
            ws.cell(row=row, column=col).alignment = Alignment(horizontal="center", vertical="center")
    
    # ② 10类型×4级矩阵
    start_row = 10
    ws.merge_cells(f"A{start_row}:G{start_row}")
    apply_title_style(ws.cell(row=start_row, column=1), "② 10类型×4级矩阵", 12)
    
    mat_headers = ["交叉类型", "头部数", "腰部数", "动销数", "尾部数", "2维赛道", "3维赛道"]
    for i, h in enumerate(mat_headers, 1):
        apply_header_style(ws.cell(row=start_row + 1, column=i), h)
    
    for idx, row_data in enumerate(type_matrix):
        row = start_row + 2 + idx
        ws.cell(row=row, column=1, value=row_data["交叉类型"])
        ws.cell(row=row, column=2, value=row_data["头部数"])
        ws.cell(row=row, column=3, value=row_data["腰部数"])
        ws.cell(row=row, column=4, value=row_data["动销数"])
        ws.cell(row=row, column=5, value=row_data["尾部数"])
        ws.cell(row=row, column=6, value=row_data["2维赛道"])
        ws.cell(row=row, column=7, value=row_data["3维赛道"])
        for col in range(1, 8):
            cell = ws.cell(row=row, column=col)
            cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
            cell.alignment = Alignment(horizontal="center", vertical="center")
            if idx % 2 == 1:
                cell.fill = PatternFill(start_color=ALT_ROW_FILL, end_color=ALT_ROW_FILL, fill_type="solid")
    
    # ③ 全量赛道排序×四级分类(TOP50)
    top50_row = start_row + 2 + len(type_matrix) + 1
    ws.merge_cells(f"A{top50_row}:M{top50_row}")
    apply_title_style(ws.cell(row=top50_row, column=1), "③ 全量赛道排序×四级分类(TOP50)", 12)
    
    top_headers = ["排名", "等级", "类型", "类别A", "词根A", "类别B", "词根B", "交叉组合", "共现词数", "总买家数", "买家占比%", "竞争评级", "3维归属"]
    for i, h in enumerate(top_headers, 1):
        apply_header_style(ws.cell(row=top50_row + 1, column=i), h)
    
    top50 = df.head(50)
    for idx, (_, r) in enumerate(top50.iterrows()):
        row = top50_row + 2 + idx
        ws.cell(row=row, column=1, value=r["排名"])
        ws.cell(row=row, column=2, value=r["等级"])
        ws.cell(row=row, column=3, value=r["交叉类型"])
        ws.cell(row=row, column=4, value=r["类别A"])
        ws.cell(row=row, column=5, value=r["词根A"])
        ws.cell(row=row, column=6, value=r["类别B"])
        ws.cell(row=row, column=7, value=r["词根B"])
        ws.cell(row=row, column=8, value=r["交叉组合"])
        ws.cell(row=row, column=9, value=r["共现词数"])
        ws.cell(row=row, column=10, value=r["总买家数"])
        ws.cell(row=row, column=11, value=r["买家占比%"])
        ws.cell(row=row, column=12, value=r["竞争评级"])
        ws.cell(row=row, column=13, value=r["3维归属"])
        
        # 确定等级背景色
        tier_key = None
        for k, cfg in TIER_CONFIG.items():
            if r["等级"] == cfg["emoji"] + cfg["name"]:
                tier_key = k
                break
        fill_color = TIER_CONFIG[tier_key]["fill"] if tier_key else (ALT_ROW_FILL if idx % 2 == 1 else "FFFFFF")
        fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
        for col in range(1, 14):
            cell = ws.cell(row=row, column=col)
            cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.fill = fill
    
    # 列宽
    ws.column_dimensions["A"].width = 32
    ws.column_dimensions["B"].width = 10
    ws.column_dimensions["C"].width = 8
    ws.column_dimensions["D"].width = 14
    ws.column_dimensions["E"].width = 8
    ws.column_dimensions["F"].width = 14
    ws.column_dimensions["G"].width = 22
    ws.column_dimensions["H"].width = 10
    ws.column_dimensions["I"].width = 16
    ws.column_dimensions["J"].width = 14
    ws.column_dimensions["K"].width = 12
    ws.column_dimensions["M"].width = 35
    
    return ws


def create_sheet_tier_detail(wb, category_name, df, tier_key, total_buyers):
    """生成头部/腰部/动销/尾部明细Sheet"""
    cfg = TIER_CONFIG[tier_key]
    sheet_name = f"{list(TIER_CONFIG.keys()).index(tier_key) + 2}-{cfg['name']}赛道明细"
    ws = wb.create_sheet(sheet_name)
    
    tier_df = df[df["等级"] == cfg["emoji"] + cfg["name"]].copy()
    tier_total = int(tier_df["总买家数"].sum()) if not tier_df.empty else 0
    tier_ratio = round(tier_total / total_buyers * 100, 2) if total_buyers else 0
    
    # 大标题
    ws.merge_cells("A1:O1")
    apply_title_style(ws["A1"], f"{category_name} · {cfg['emoji']}{cfg['name']}赛道明细({len(tier_df)}赛道)", 16)
    
    # 副标题
    ws.merge_cells("A2:O2")
    apply_title_style(ws["A2"], f"按总买家数排序 | 总买家数{tier_total} | 占比{tier_ratio}%", 10, "5F5E5A", "E8EDF2")
    
    # 表头
    headers = ["排名", "等级", "类型", "类别A", "词根A", "类别B", "词根B", "交叉组合", "共现词数", "总买家数", "买家占比%", "平均CVR%", "竞争评级", "3维归属", "差异化策略"]
    for i, h in enumerate(headers, 1):
        apply_header_style(ws.cell(row=3, column=i), h)
    
    # 数据
    for idx, (_, r) in enumerate(tier_df.iterrows()):
        row = 4 + idx
        ws.cell(row=row, column=1, value=r["排名"])
        ws.cell(row=row, column=2, value=r["等级"])
        ws.cell(row=row, column=3, value=r["交叉类型"])
        ws.cell(row=row, column=4, value=r["类别A"])
        ws.cell(row=row, column=5, value=r["词根A"])
        ws.cell(row=row, column=6, value=r["类别B"])
        ws.cell(row=row, column=7, value=r["词根B"])
        ws.cell(row=row, column=8, value=r["交叉组合"])
        ws.cell(row=row, column=9, value=r["共现词数"])
        ws.cell(row=row, column=10, value=r["总买家数"])
        ws.cell(row=row, column=11, value=r["买家占比%"])
        ws.cell(row=row, column=12, value=r["平均CVR%"] if pd.notna(r["平均CVR%"]) else "")
        ws.cell(row=row, column=13, value=r["竞争评级"])
        ws.cell(row=row, column=14, value=r["3维归属"])
        ws.cell(row=row, column=15, value=r["差异化策略"])
        
        fill_color = cfg["fill"] if idx % 2 == 0 else "FFFFFF"
        fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
        for col in range(1, 16):
            cell = ws.cell(row=row, column=col)
            cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.fill = fill
    
    # 底部注释
    if not tier_df.empty:
        top_row = tier_df.iloc[0]
        comment_row = 4 + len(tier_df)
        ws.merge_cells(f"A{comment_row}:O{comment_row}")
        cvr_str = top_row["平均CVR%"] if pd.notna(top_row["平均CVR%"]) else "N/A"
        st = STRATEGY_TEMPLATES[tier_key]
        advice = "，".join(st["cols"])
        comment = f"{cfg['emoji']}{cfg['name']}TOP赛道：{top_row['交叉组合']}，买家数{int(top_row['总买家数'])}，CVR {cvr_str}%，{top_row['竞争评级']} | 建议：{advice}"
        apply_title_style(ws.cell(row=comment_row, column=1), comment, 9, "5F5E5A", "E8EDF2")
    
    # 列宽
    ws.column_dimensions["A"].width = 8
    ws.column_dimensions["B"].width = 10
    ws.column_dimensions["C"].width = 8
    ws.column_dimensions["D"].width = 14
    ws.column_dimensions["G"].width = 18
    ws.column_dimensions["H"].width = 18
    ws.column_dimensions["I"].width = 14
    ws.column_dimensions["K"].width = 12
    ws.column_dimensions["N"].width = 14
    ws.column_dimensions["O"].width = 35
    
    return ws


def create_sheet_full_integration(wb, category_name, df):
    """Sheet6: 全量赛道整合"""
    ws = wb.create_sheet("6-全量赛道整合")
    
    ws.merge_cells("A1:O1")
    apply_title_style(ws["A1"], f"{category_name} · 全量交叉赛道整合(四级分类)", 16)
    
    ws.merge_cells("A2:O2")
    apply_title_style(ws["A2"], f"全部{len(df)}赛道×四级分类·按买家数排序·赛道色系着色", 10, "5F5E5A", "E8EDF2")
    
    headers = ["排名", "等级", "类型", "类别A", "词根A", "类别B", "词根B", "交叉组合", "共现词数", "总买家数", "买家占比%", "平均CVR%", "竞争评级", "3维归属", "差异化策略"]
    for i, h in enumerate(headers, 1):
        apply_header_style(ws.cell(row=3, column=i), h)
    
    for idx, (_, r) in enumerate(df.iterrows()):
        row = 4 + idx
        ws.cell(row=row, column=1, value=r["排名"])
        ws.cell(row=row, column=2, value=r["等级"])
        ws.cell(row=row, column=3, value=r["交叉类型"])
        ws.cell(row=row, column=4, value=r["类别A"])
        ws.cell(row=row, column=5, value=r["词根A"])
        ws.cell(row=row, column=6, value=r["类别B"])
        ws.cell(row=row, column=7, value=r["词根B"])
        ws.cell(row=row, column=8, value=r["交叉组合"])
        ws.cell(row=row, column=9, value=r["共现词数"])
        ws.cell(row=row, column=10, value=r["总买家数"])
        ws.cell(row=row, column=11, value=r["买家占比%"])
        ws.cell(row=row, column=12, value=r["平均CVR%"] if pd.notna(r["平均CVR%"]) else "")
        ws.cell(row=row, column=13, value=r["竞争评级"])
        ws.cell(row=row, column=14, value=r["3维归属"])
        ws.cell(row=row, column=15, value=r["差异化策略"])
        
        tier_key = None
        for k, cfg in TIER_CONFIG.items():
            if r["等级"] == cfg["emoji"] + cfg["name"]:
                tier_key = k
                break
        fill_color = TIER_CONFIG[tier_key]["fill"] if tier_key else (ALT_ROW_FILL if idx % 2 == 1 else "FFFFFF")
        fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
        for col in range(1, 16):
            cell = ws.cell(row=row, column=col)
            cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.fill = fill
    
    ws.column_dimensions["A"].width = 8
    ws.column_dimensions["B"].width = 10
    ws.column_dimensions["C"].width = 8
    ws.column_dimensions["D"].width = 14
    ws.column_dimensions["G"].width = 18
    ws.column_dimensions["H"].width = 18
    ws.column_dimensions["I"].width = 14
    ws.column_dimensions["K"].width = 12
    ws.column_dimensions["N"].width = 14
    ws.column_dimensions["O"].width = 35
    
    return ws


def create_sheet_strategy(wb, category_name, df):
    """Sheet7: 策略执行建议"""
    ws = wb.create_sheet("7-策略执行建议")
    
    ws.merge_cells("A1:O1")
    apply_title_style(ws["A1"], f"{category_name} · 策略执行建议", 16)
    
    ws.merge_cells("A2:O2")
    apply_title_style(ws["A2"], "4板块策略建议+去垄断TOP5赛道", 10, "5F5E5A", "E8EDF2")
    
    current_row = 3
    
    for tier_key in ["head", "waist", "active", "tail"]:
        cfg = TIER_CONFIG[tier_key]
        tier_df = df[df["等级"] == cfg["emoji"] + cfg["name"]]
        st = STRATEGY_TEMPLATES[tier_key]
        
        # 尾部只展示前10条
        if tier_key == "tail":
            tier_df = tier_df.head(10)
        
        # 板块标题
        head_limit = TIER_CONFIG["head"]["count"]
        waist_limit = TIER_CONFIG["waist"]["count"]
        active_limit = TIER_CONFIG["active"]["count"]
        tier_ranges = {
            "head": f"TOP1-{head_limit}",
            "waist": f"TOP{head_limit+1}-{head_limit+waist_limit}",
            "active": f"TOP{head_limit+waist_limit+1}-{head_limit+waist_limit+active_limit}",
            "tail": f"TOP{head_limit+waist_limit+active_limit+1}+"
        }
        section_nums = {"head": "①", "waist": "②", "active": "③", "tail": "④"}
        ws.merge_cells(f"A{current_row}:O{current_row}")
        apply_title_style(ws.cell(row=current_row, column=1), f"{section_nums[tier_key]} {cfg['emoji']}{cfg['name']}赛道策略({tier_ranges[tier_key]})", 12)
        current_row += 1
        
        for _, r in tier_df.iterrows():
            # 基础策略列
            ws.cell(row=current_row, column=2, value=cfg["emoji"] + cfg["name"])
            ws.cell(row=current_row, column=4, value=st["cols"][0])
            ws.cell(row=current_row, column=5, value=st["cols"][1])
            ws.cell(row=current_row, column=6, value=st["cols"][2])
            ws.cell(row=current_row, column=9, value=r["交叉组合"])
            ws.cell(row=current_row, column=10, value=r["总买家数"])
            ws.cell(row=current_row, column=11, value=r["买家占比%"])
            ws.cell(row=current_row, column=12, value=r["平均CVR%"] if pd.notna(r["平均CVR%"]) else "")
            ws.cell(row=current_row, column=13, value=r["竞争评级"])
            ws.cell(row=current_row, column=14, value=r["3维归属"])
            
            # 精细化策略：基于竞争评级的行动建议
            rating = str(r.get("竞争评级", "⚪数据缺失"))
            action = st["actions"].get(rating, st["detail"])
            ws.cell(row=current_row, column=15, value=action)
            
            fill_color = cfg["fill"]
            fill = PatternFill(start_color=fill_color, end_color=fill_color, fill_type="solid")
            for col in range(1, 16):
                cell = ws.cell(row=current_row, column=col)
                cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
                cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
                cell.fill = fill
            current_row += 1
    
    # ⑤ 去垄断纯净TOP5赛道
    current_row += 1
    ws.merge_cells(f"A{current_row}:O{current_row}")
    apply_title_style(ws.cell(row=current_row, column=1), "⑤ 去垄断纯净TOP5赛道", 12)
    current_row += 1
    
    top5_headers = ["排名", "等级", "类型", "类别A", "词根A", "类别B", "词根B", "交叉组合", "共现词数", "总买家数", "买家占比%", "平均CVR%", "竞争评级", "3维归属", "策略"]
    for i, h in enumerate(top5_headers, 1):
        apply_header_style(ws.cell(row=current_row, column=i), h)
    current_row += 1
    
    top5 = df.head(5)
    for idx, (_, r) in enumerate(top5.iterrows()):
        ws.cell(row=current_row, column=1, value=r["排名"])
        ws.cell(row=current_row, column=2, value=r["等级"].replace("🔴", "").replace("🟠", "").replace("🔵", "").replace("⚪", ""))
        ws.cell(row=current_row, column=3, value=r["交叉类型"])
        ws.cell(row=current_row, column=4, value=r["类别A"])
        ws.cell(row=current_row, column=5, value=r["词根A"])
        ws.cell(row=current_row, column=6, value=r["类别B"])
        ws.cell(row=current_row, column=7, value=r["词根B"])
        ws.cell(row=current_row, column=8, value=r["交叉组合"])
        ws.cell(row=current_row, column=9, value=r["共现词数"])
        ws.cell(row=current_row, column=10, value=r["总买家数"])
        ws.cell(row=current_row, column=11, value=r["买家占比%"])
        ws.cell(row=current_row, column=12, value=r["平均CVR%"] if pd.notna(r["平均CVR%"]) else "")
        ws.cell(row=current_row, column=13, value=r["竞争评级"])
        ws.cell(row=current_row, column=14, value=r["3维归属"])
        ws.cell(row=current_row, column=15, value=r["差异化策略"])
        
        fill = PatternFill(start_color="FFFFFF", end_color="FFFFFF", fill_type="solid")
        for col in range(1, 16):
            cell = ws.cell(row=current_row, column=col)
            cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.fill = fill
        current_row += 1
    
    ws.column_dimensions["B"].width = 10
    ws.column_dimensions["D"].width = 12
    ws.column_dimensions["E"].width = 12
    ws.column_dimensions["F"].width = 12
    ws.column_dimensions["H"].width = 18
    ws.column_dimensions["I"].width = 14
    ws.column_dimensions["K"].width = 12
    ws.column_dimensions["N"].width = 14
    ws.column_dimensions["O"].width = 35
    
    return ws


def create_sheet_manual(wb, category_name):
    """Sheet8: 指标说明手册"""
    ws = wb.create_sheet("8-指标说明手册")
    
    ws.merge_cells("A1:H1")
    apply_title_style(ws["A1"], f"{category_name} · 指标说明手册", 16)
    
    # ① 核心指标说明
    ws.merge_cells("A2:H2")
    apply_title_style(ws["A2"], "① 核心指标说明", 12)
    
    for idx, row_data in enumerate(INDICATOR_MANUAL):
        row = 3 + idx
        for col_idx, val in enumerate(row_data, 1):
            cell = ws.cell(row=row, column=col_idx, value=val)
            if idx == 0:
                apply_header_style(cell, val)
            else:
                cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
                cell.alignment = Alignment(horizontal="center" if col_idx <= 5 else "left", vertical="center", wrap_text=True)
                if idx % 2 == 0:
                    cell.fill = PatternFill(start_color=ALT_ROW_FILL, end_color=ALT_ROW_FILL, fill_type="solid")
    
    # ② 四级分类定义
    start_row = 3 + len(INDICATOR_MANUAL) + 1
    ws.merge_cells(f"A{start_row}:H{start_row}")
    apply_title_style(ws.cell(row=start_row, column=1), "② 四级分类定义", 12)
    
    for idx, row_data in enumerate(TIER_DEFINITIONS):
        row = start_row + 1 + idx
        for col_idx, val in enumerate(row_data, 1):
            cell = ws.cell(row=row, column=col_idx, value=val)
            if idx == 0:
                apply_header_style(cell, val)
            else:
                cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
                cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
                # 等级行背景色
                tier_keys = ["head", "waist", "active", "tail"]
                if idx <= 4:
                    cfg = TIER_CONFIG[tier_keys[idx - 1]]
                    cell.fill = PatternFill(start_color=cfg["fill"], end_color=cfg["fill"], fill_type="solid")
    
    # ③ 竞争评级定义
    start_row2 = start_row + 1 + len(TIER_DEFINITIONS) + 1
    ws.merge_cells(f"A{start_row2}:E{start_row2}")
    apply_title_style(ws.cell(row=start_row2, column=1), "③ 竞争评级定义", 12)
    
    for idx, row_data in enumerate(COMPETITION_RATINGS):
        row = start_row2 + 1 + idx
        for col_idx, val in enumerate(row_data, 1):
            cell = ws.cell(row=row, column=col_idx, value=val)
            if idx == 0:
                apply_header_style(cell, val)
            else:
                cell.font = Font(name="微软雅黑", size=9, color="1A1A1A")
                cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
                if idx % 2 == 0:
                    cell.fill = PatternFill(start_color=ALT_ROW_FILL, end_color=ALT_ROW_FILL, fill_type="solid")
    
    ws.column_dimensions["A"].width = 12
    ws.column_dimensions["B"].width = 35
    ws.column_dimensions["C"].width = 25
    ws.column_dimensions["D"].width = 12
    ws.column_dimensions["E"].width = 8
    
    return ws


# ==================== 主函数 ====================
def main():
    parser = argparse.ArgumentParser(description="B2-交叉赛道四级分类")
    parser.add_argument("--config", required=True, help="配置文件路径(JSON)")
    args = parser.parse_args()
    
    with open(args.config, "r", encoding="utf-8") as f:
        config = json.load(f)
    
    input_path = config["input_path"]
    output_path = config["output_path"]
    category_name = config.get("category_name", "未命名品类")
    total_buyers = config.get("total_buyers", 0)
    sheet_name = config.get("sheet_name", "交叉赛道数据源")
    
    # 读取自定义阈值配置（可选）
    tier_thresholds = config.get("tier_thresholds")
    if tier_thresholds:
        print(f"[B2] 使用自定义阈值: {tier_thresholds}")
    
    print(f"[B2] 开始处理: {category_name}")
    print(f"[B2] 读取数据源: {input_path}")
    
    # 读取数据
    df = load_data(input_path, sheet_name)
    print(f"[B2] 读取 {len(df)} 条交叉赛道记录")
    
    # 计算四级分类
    df = compute_tiers(df, total_buyers, tier_thresholds)
    print(f"[B2] 四级分类完成")
    print(f"[B2] 头部TOP{TIER_CONFIG['head']['count']}/腰部TOP{TIER_CONFIG['waist']['count']}/动销TOP{TIER_CONFIG['active']['count']}")
    
    # 计算汇总
    summary = compute_summary(df, total_buyers)
    type_matrix = compute_type_matrix(df)
    
    # 生成Excel
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    
    create_sheet_overview(wb, category_name, df, summary, type_matrix, total_buyers)
    create_sheet_tier_detail(wb, category_name, df, "head", total_buyers)
    create_sheet_tier_detail(wb, category_name, df, "waist", total_buyers)
    create_sheet_tier_detail(wb, category_name, df, "active", total_buyers)
    create_sheet_tier_detail(wb, category_name, df, "tail", total_buyers)
    create_sheet_full_integration(wb, category_name, df)
    create_sheet_strategy(wb, category_name, df)
    create_sheet_manual(wb, category_name)
    
    wb.save(output_path)
    print(f"[B2] 已保存: {output_path}")
    print(f"[B2] 完成! 共生成 {len(wb.sheetnames)} 个Sheet")


if __name__ == "__main__":
    main()
