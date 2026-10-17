import unittest

import main


class MarketplacePageContextTests(unittest.TestCase):
    def test_each_marketplace_product_snapshot_is_accepted(self):
        pages = {
            "amazon": "https://www.amazon.com/dp/B012345678",
            "aliexpress": "https://www.aliexpress.com/item/1005001234567890.html",
            "shopee": "https://shopee.sg/desk-light-i.12345.67890",
            "temu": "https://www.temu.com/goods.html?goods_id=987654321",
            "ozon": "https://www.ozon.ru/product/desk-light-123456789/",
            "ebay": "https://www.ebay.com/itm/123456789012",
            "shein": "https://www.shein.com/desk-light-p-12345678.html",
            "tiktok-shop": "https://shop.tiktok.com/view/product/123456789012",
        }
        for site, url in pages.items():
            with self.subTest(site=site):
                context = {
                    "source": "electron-visible-dom-assistant",
                    "site": site,
                    "pageType": "product",
                    "url": url,
                    "structured": {
                        "kind": f"{site}-product",
                        "title": "桌面阅读灯",
                        "facts": [{"label": "价格", "value": "US $29.99"}],
                        "resources": [{"id": f"{site}-product-info", "token": "@商品信息", "label": "商品信息"}],
                    },
                }
                result = main._commerce_analysis_format_visible_page_context(context)
                self.assertIn("桌面阅读灯", result)
                self.assertIn("@商品信息", result)

    def test_foreign_resource_and_host_are_rejected(self):
        context = {
            "source": "electron-visible-dom-assistant",
            "site": "amazon",
            "pageType": "product",
            "url": "https://www.amazon.com/dp/B012345678",
            "structured": {
                "kind": "amazon-product",
                "title": "桌面阅读灯",
                "resources": [{"id": "ebay-reviews", "token": "@用户评价", "label": "用户评价"}],
            },
        }
        result = main._commerce_analysis_format_visible_page_context(context)
        self.assertNotIn("@用户评价", result)
        context["url"] = "https://example.com/dp/B012345678"
        self.assertEqual(main._commerce_analysis_format_visible_page_context(context), "")

    def test_clicked_detail_images_reach_chat_as_count_without_pixels(self):
        context = {
            "source": "electron-visible-dom-assistant",
            "site": "amazon",
            "pageType": "product",
            "url": "https://www.amazon.com/dp/B012345678",
            "images": [{"url": "https://images.example.test/detail-one.jpg"}, {"url": "https://images.example.test/detail-two.jpg"}],
            "structured": {
                "kind": "amazon-product",
                "title": "桌面阅读灯",
                "marketplace": {"mainImageCount": 1, "detailImageCount": 2},
                "resources": [{"id": "amazon-detail-images", "token": "@详情图片", "label": "详情图片"}],
            },
        }
        result = main._commerce_analysis_format_visible_page_context(context)
        self.assertIn("详情图片：已读取 2 张", result)
        self.assertIn("图片像素未返回", result)
        self.assertNotIn("images.example.test", result)

    def test_empty_samples_do_not_advertise_deferred_resources(self):
        context = {
            "source": "electron-visible-dom-assistant",
            "site": "ebay",
            "pageType": "product",
            "url": "https://www.ebay.com/itm/123456789012",
            "structured": {
                "kind": "ebay-product",
                "title": "桌面阅读灯",
                "resources": [
                    {"id": "ebay-detail-images", "token": "@详情图片", "label": "详情图片"},
                    {"id": "ebay-reviews", "token": "@用户评价", "label": "用户评价"},
                ],
            },
        }
        result = main._commerce_analysis_format_visible_page_context(context)
        self.assertNotIn("@详情图片", result)
        self.assertNotIn("@用户评价", result)


if __name__ == "__main__":
    unittest.main()
