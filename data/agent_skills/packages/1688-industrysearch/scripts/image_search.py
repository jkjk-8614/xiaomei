#!/usr/bin/env python3
"""
1688 工业品图片搜索脚本

调用 1688 工业品图片搜索接口，根据用户提供的图片 URL 搜索相似工业品商品。

使用方法:
    python image_search.py "https://example.com/image.png" [itemCount]

参数:
    imageUrl: 商品图片 URL
    itemCount: 返回商品数量，默认 10
"""

import json
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def image_search(image_url: str, item_count: int = 10) -> dict:
    """
    执行 1688 工业品图片搜索
    
    Args:
        image_url: 商品图片 URL 地址
        item_count: 返回商品数量，默认 10
        
    Returns:
        API 响应数据字典
    """
    url = "https://ainext.1688.com/1688claw/industrySkill/imageSearch"
    
    payload = {
        "imageUrl": image_url,
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
    格式化图片搜索结果输出
    
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
        return "未找到相似商品，建议更换图片或尝试文本搜索。"
    
    output_lines = [f"✅ 为您找到 {len(items)} 个相似工业品商品：\n"]
    
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
    if len(sys.argv)< 2:
        print("用法：python image_search.py \"图片 URL\" [商品数量]")
        print("示例：python image_search.py \"https://img.alicdn.com/imgextra/i1/xxx.png\" 10")
        sys.exit(1)
    
    image_url = sys.argv[1]
    item_count = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    
    print(f"正在搜索相似商品...")
    print(f"图片来源：{image_url}")
    print(f"期望返回：{item_count} 个商品\n")
    
    result = image_search(image_url, item_count)
    formatted = format_results(result)
    print(formatted)


if __name__ == "__main__":
    main()
