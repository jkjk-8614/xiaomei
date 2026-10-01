#!/usr/bin/env python3
"""
1688 工业品搜索结果格式化脚本

将 API 返回的 JSON 数据格式化为 Markdown 输出。

使用方法:
    python format_results.py < response.json
    或在代码中导入 format_results 函数
"""

import json
import sys


def format_item(item: dict, index: int) -> str:
    """
    格式化单个商品信息
    
    Args:
        item: 商品数据字典
        index: 商品序号
        
    Returns:
        格式化后的 Markdown 文本
    """
    title = item.get("itemTitle", "无标题")
    detail_url = item.get("itemDetailUrl", "#")
    price = item.get("itemPrice", "暂无报价")
    sale_count = item.get("itemSaleCount", "")
    seller = item.get("sellerName", "未知卖家")
    expert_recommend = item.get("expertRecommend", "")
    service_list = item.get("serviceList", [])
    cpv_tags = item.get("cpvTagList", [])
    
    lines = []
    lines.append(f"{index}. [{title}]({detail_url})")
    lines.append(f"   价格：¥{price}" + (f" | {sale_count}" if sale_count else ""))
    lines.append(f"   卖家：{seller}")
    
    if expert_recommend:
        lines.append(f"   🏆 行家推荐：{expert_recommend}")
    
    if service_list:
        services = " / ".join(service_list[:4])
        lines.append(f"   服务：{services}")
    
    if cpv_tags:
        tags = " / ".join(cpv_tags[:5])
        lines.append(f"   属性：{tags}")
    
    return "\n".join(lines)


def format_results(data: dict, search_type: str = "text") -> str:
    """
    格式化搜索结果
    
    Args:
        data: API 响应数据
        search_type: 搜索类型 ("text" 或 "image")
        
    Returns:
        格式化后的 Markdown 文本
    """
    if not data.get("success") or data.get("fail"):
        error_msg = data.get("errorMsg", "搜索失败")
        return f"❌ 搜索失败：{error_msg}\n\n建议：换个关键词重试，或检查网络连接。"
    
    items = data.get("data", [])
    
    if not items:
        if search_type == "image":
            return "未找到相似商品。\n\n建议：更换图片或尝试文本搜索。"
        else:
            return "未找到相关商品。\n\n建议：调整搜索关键词，或使用更具体的行业术语。"
    
    # 构建输出
    output_lines = []
    
    if search_type == "image":
        output_lines.append(f"✅ 为您找到 {len(items)} 个相似工业品商品：\n")
    else:
        output_lines.append(f"✅ 为您找到 {len(items)} 个工业品商品：\n")
    
    for idx, item in enumerate(items, 1):
        output_lines.append(format_item(item, idx))
        output_lines.append("")  # 空行分隔
    
    return "\n".join(output_lines)


def main():
    """从标准输入读取 JSON 并格式化输出"""
    try:
        data = json.load(sys.stdin)
        result = format_results(data)
        print(result)
    except json.JSONDecodeError:
        print("❌ 错误：无效的 JSON 格式")
        sys.exit(1)
    except Exception as e:
        print(f"❌ 错误：{str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
