"""轻量验证：六站点可见页快照只能以脱敏、受限字段进入聊天上下文。"""
import asyncio
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import main  # noqa: E402


def run() -> None:
    context = {
        "source": "electron-visible-dom-assistant",
        "site": "xiaohongshu",
        "pageType": "content",
        "url": "https://www.xiaohongshu.com/explore/demo?xsec_token=secret&keyword=tea",
        "title": "token: secret",
        "rawText": "无关背景文字 token: secret 13800138000",
        "structured": {
            "title": "小红书图文",
            "kind": "xhs-note",
            "facts": [
                {"label": "博主", "value": "示例作者"},
                {"label": "点赞", "value": "10"},
            ],
            "resources": [
                {"id": "xhs-content", "token": "@图文", "label": "图文", "available": True},
                # 错误页型资源不得因为 token 以 @ 开头就混入小红书上下文。
                {"id": "qianniu-chat-records", "token": "@聊天记录", "label": "聊天记录", "available": True},
            ],
            "excerpt": "正文主体摘录",
        },
        "tables": [{"title": "可见指标", "rows": [["点赞", "10"]]}],
        "comments": [{"author": "用户", "text": "很好"}],
        "images": [{"url": "https://img.example/note.jpg?token=temporary"}],
    }
    output = main._commerce_analysis_format_page_context(context)
    assert "小红书当前页面即时分析上下文" in output
    assert "小红书图文" in output
    assert "示例作者" in output
    assert "正文主体摘录" in output
    assert "@图文" in output
    assert "@聊天记录" not in output
    assert "xsec_token" not in output
    assert "secret" not in output
    assert "13800138000" not in output
    assert "无关背景文字" not in output
    assert main._commerce_analysis_format_page_context({**context, "site": "unknown"}) == ""
    assert main._commerce_analysis_format_page_context({**context, "url": "https://example.com/explore/demo"}) == ""

    # 六站点都必须只接收结构化页型字段；背景 rawText 不得在该分支出现。
    site_cases = [
        ("qianniu", "seller-admin", "https://myseller.taobao.com/app/customer-service", "千牛工作台", "客服 > 聊天记录", "qianniu-service", {"id": "qianniu-chat-records", "token": "@聊天记录", "label": "聊天记录"}, "@图文"),
        ("sycm", "report", "https://sycm.taobao.com/marketing", "生意参谋", "生意参谋 > 营销", "sycm-marketing", {"id": "sycm-current-report", "token": "@营销概况", "label": "营销概况"}, "@图文"),
        ("dmp", "report", "https://dmp.taobao.com/items/growup-path", "达摩盘", "达摩盘 > 商品打爆路径", "dmp-growup-path", {"id": "dmp-growup-path", "token": "@本品与竞品打爆路径对比", "label": "本品与竞品打爆路径对比"}, "@图文"),
        ("xiaohongshu", "content", "https://www.xiaohongshu.com/explore/demo", "小红书", "小红书图文", "xhs-note", {"id": "xhs-content", "token": "@图文", "label": "图文"}, "@聊天记录"),
        ("douyin", "content", "https://www.douyin.com/video/123", "抖音", "抖音当前视频", "douyin-work", {"id": "douyin-content", "token": "@视频", "label": "视频"}, "@评论"),
        ("1688", "product", "https://detail.1688.com/offer/123.html", "1688", "1688 商品详情", "1688-detail", {"id": "1688-product-info", "token": "@商品信息", "label": "商品信息"}, "@图文"),
    ]
    for site, page_type, url, site_label, structured_title, structured_kind, allowed_resource, rejected_token in site_cases:
        site_context = {
            "source": "electron-visible-dom-assistant",
            "site": site,
            "pageType": page_type,
            "url": url + "?xsec_token=secret",
            "rawText": "不要展示的背景内容 secret",
            "structured": {
                "title": structured_title,
                "kind": structured_kind,
                "facts": [{"label": "核心字段", "value": "当前页数据"}],
                "resources": [
                    {**allowed_resource, "available": True},
                    {"id": "qianniu-chat-records" if site == "xiaohongshu" else "xhs-content", "token": rejected_token, "label": "不应跨站点", "available": True},
                ],
            },
        }
        site_output = main._commerce_analysis_format_page_context(site_context)
        assert site_label in site_output
        assert structured_title in site_output
        assert "当前页数据" in site_output
        assert allowed_resource["token"] in site_output
        assert rejected_token not in site_output
        assert "不要展示的背景内容" not in site_output
        assert "xsec_token" not in site_output

    prepared = asyncio.run(main._prepare_link_context("分析当前笔记", page_context=context))
    assert prepared["images"] == []
    assert "正文主体摘录" in prepared["context_text"]

    legacy_record = {
        "role": "user",
        "link_context": "【小红书当前页面即时分析上下文】\n可见文字",
        "link_images": ["https://img.example/not-public.jpg"],
    }
    assert main._commerce_analysis_link_images_from_record(legacy_record) == []
    upstream = main.upstream_message_from_record(legacy_record)
    assert isinstance(upstream["content"], list)
    assert [part["type"] for part in upstream["content"]] == ["text"]


if __name__ == "__main__":
    run()
    print("assistant page context assertions passed")
