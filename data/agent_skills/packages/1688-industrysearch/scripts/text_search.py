#!/usr/bin/env python3
"""
1688 工业品文本搜索脚本

调用 1688 工业品搜索接口，根据用户输入的关键词搜索工业品商品。

使用方法:
    python text_search.py "m6 不锈钢 螺栓" [itemCount]

参数:
    query: 搜索关键词（多个词用空格分隔）
    itemCount: 返回商品数量，默认 10
"""

import json
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def text_search(query: str, item_count: int = 10) -> dict:
    """
    执行 1688 工业品文本搜索
    
    Args:
        query: 搜索关键词，建议不超过 3 个短词，用空格分隔
        item_count: 返回商品数量，默认 10
        
    Returns:
        API 响应数据字典
    """
    url = "https://ainext.1688.com/1688claw/industrySkill/textSearch"
    
    payload = {
        "query": query,
        "itemCount": item_count
    }
    
    headers = {
        "Content-Type": "application/json"
    }
    
    try:
        req = Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
        with urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result
    except HTTPError as e:
        return {
            "success": False,
            "fail": True,
            "errorMsg": f"HTTP 错误：{e.code} - {e.reason}"
        }
    except URLError as e:
        return {
            "success": False,
            "fail": True,
            "errorMsg": f"网络错误：{e.reason}"
        }
    except Exception as e:
        return {
            "success": False,
            "fail": True,
            "errorMsg": f"请求失败：{str(e)}"
        }


def format_results(data: dict) -> str:
    """
    格式化搜索结果输出
    
    Args:
        data: API 响应数据
        
    Returns:
        格式化后的文本结果
    """
    if not data.get("success") or data.get("fail"):
        error_msg = data.get("errorMsg", "搜索失败")
        return f"❌ 搜索失败：{error_msg}"
    
    items = data.get("data", [])
    
    if not items:
        return "未找到相关商品，建议调整搜索关键词或尝试图片搜索。"
    
    output_lines = [f"✅ 为您找到 {len(items)} 个工业品商品：\n"]
    
    for idx, item in enumerate(items, 1):
        title = item.get("itemTitle", "无标题")
        detail_url = item.get("itemDetailUrl", "#")
        price = item.get("itemPrice", "暂无报价")
        sale_count = item.get("itemSaleCount", "")
        seller = item.get("sellerName", "未知卖家")
        expert_recommend = item.get("expertRecommend", "")
        service_list = item.get("serviceList", [])
        cpv_tags = item.get("cpvTagList", [])
        
        # 构建商品条目
        output_lines.append(f"{idx}. [{title}]({detail_url})")
        output_lines.append(f"   价格：¥{price}" + (f" | {sale_count}" if sale_count else ""))
        output_lines.append(f"   卖家：{seller}")
        
        if expert_recommend:
            output_lines.append(f"   🏆 行家推荐：{expert_recommend}")
        
        if service_list:
            services = " / ".join(service_list[:4])  # 最多显示 4 个服务标签
            output_lines.append(f"   服务：{services}")
        
        if cpv_tags:
            tags = " / ".join(cpv_tags[:5])  # 最多显示 5 个属性标签
            output_lines.append(f"   属性：{tags}")
        
        output_lines.append("")  # 空行分隔
    
    return "\n".join(output_lines)


def main():
    """主函数"""
    if len(sys.argv) < 2:
        print("用法：python text_search.py \"搜索关键词\" [商品数量]")
        print("示例：python text_search.py \"m6 不锈钢 螺栓\" 10")
        sys.exit(1)
    
    query = sys.argv[1]
    item_count = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    
    print(f"正在搜索：{query}")
    print(f"期望返回：{item_count} 个商品\n")
    
    result = text_search(query, item_count)
    formatted = format_results(result)
    print(formatted)


if __name__ == "__main__":
    main()
