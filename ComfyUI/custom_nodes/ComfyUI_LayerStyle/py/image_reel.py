import torch
from PIL import Image, ImageFont, ImageDraw
from .imagefunc import log, tensor2pil, pil2tensor, gaussian_blur, adjust_levels, get_resource_dir

class ImageReelPipeline:
    def __init__(self):
        self.image = None
        self.texts = {}
        self.reel_height = 0
        self.reel_border = 0
        # A Reel can contain one frame for each item in an IMAGE batch.
        self.reels = []

Reel = ImageReelPipeline()
class ImageReel:

    def __init__(self):
        self.NODE_NAME = 'ImageReel'

    @classmethod
    def INPUT_TYPES(self):
        return {
            "required": {
                "image1": ("IMAGE",),
                "image1_text": ("STRING", {"multiline": False, "default": "image1"}),
                "image2_text": ("STRING", {"multiline": False, "default": "image2"}),
                "image3_text": ("STRING", {"multiline": False, "default": "image3"}),
                "image4_text": ("STRING", {"multiline": False, "default": "image4"}),
                "reel_height": ("INT", {"default": 512, "min": 64, "max": 2048}),
                "border": ("INT", {"default": 32, "min": 8, "max": 512}),
            },
            "optional": {
                "image2": ("IMAGE",),
                "image3": ("IMAGE",),
                "image4": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("Reel",)
    RETURN_NAMES = ("reel",)
    FUNCTION = 'image_reel'
    CATEGORY = '😺dzNodes/LayerUtility'

    def image_reel(self, image1, image1_text, image2_text, image3_text, image4_text,
                            reel_height, border,
                            image2=None, image3=None, image4=None,):

        image_batches = [self._tensor_to_pil_batch(image1, reel_height)]
        image_batches.extend([
            self._tensor_to_pil_batch(image2, reel_height),
            self._tensor_to_pil_batch(image3, reel_height),
            self._tensor_to_pil_batch(image4, reel_height),
        ])
        text_labels = [image1_text, image2_text, image3_text, image4_text]

        batch_size = max(len(batch) for batch in image_batches)
        reel = ImageReelPipeline()
        reel.NODE_NAME = self.NODE_NAME
        for batch_index in range(batch_size):
            image_list = []
            texts = []
            for batch, text in zip(image_batches, text_labels):
                image = self._select_batch_item(batch, batch_index)
                if image is not None:
                    image_list.append(image)
                    texts.append([text, image.width])

            frame = ImageReelPipeline()
            frame.image = self.draw_reel_image(image_list, border, reel_height)
            frame.texts = texts
            frame.reel_height = reel_height
            frame.reel_border = border
            reel.reels.append(frame)

        # Keep the original single-Reel attributes for compatibility with
        # workflows or custom nodes that inspect them directly.
        if reel.reels:
            reel.image = reel.reels[0].image
            reel.texts = reel.reels[0].texts
        reel.reel_height = reel_height
        reel.reel_border = border
        return (reel,)

    def _tensor_to_pil_batch(self, image, reel_height):
        if image is None:
            return []
        if image.dim() == 3:
            image = image.unsqueeze(0)
        if image.dim() != 4:
            raise ValueError(f"Expected an IMAGE tensor with 3 or 4 dimensions, got {image.dim()}")
        return [
            self.resize_image_to_height(tensor2pil(img.unsqueeze(0)), reel_height)
            for img in image
        ]

    @staticmethod
    def _select_batch_item(batch, index):
        if not batch:
            return None
        if len(batch) == 1:
            return batch[0]
        return batch[index] if index < len(batch) else batch[-1]

    def resize_image_to_height(self, image, target_height) -> Image:
        w = int(target_height / image.height * image.width)
        return image.resize((w, target_height), Image.LANCZOS)

    def draw_reel_image(self, image_list, border, reel_height) -> Image:
        reel_width = 0
        for img in image_list:
            reel_width += img.width + border
        reel_img = Image.new('RGBA', (reel_width, reel_height + border), color=(0, 0, 0, 0))
        #paste images
        w = border // 2
        for img in image_list:
            reel_img.paste(img, (w, border // 2))
            w += img.width + border
        return reel_img


class ImageReelComposit:

    def __init__(self):
        self.NODE_NAME = 'ImageReelComposit'
        (_, self.FONT_DICT) = get_resource_dir()
        self.FONT_LIST = list(self.FONT_DICT.keys())

    @classmethod
    def INPUT_TYPES(self):
        (LUT_DICT, FONT_DICT) = get_resource_dir()
        FONT_LIST = list(FONT_DICT.keys())
        LUT_LIST = list(LUT_DICT.keys())

        color_theme_list = ['light', 'dark']
        return {
            "required": {
                "reel_1": ("Reel",),
                "font_file": (FONT_LIST,),
                "font_size": ("INT", {"default": 40, "min": 4, "max": 1024}),
                "border": ("INT", {"default": 32, "min": 8, "max": 512}),
                "color_theme": (color_theme_list,),
            },
            "optional": {
                "reel_2": ("Reel",),
                "reel_3": ("Reel",),
                "reel_4": ("Reel",),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image1",)
    FUNCTION = 'image_reel_composit'
    CATEGORY = '😺dzNodes/LayerUtility'

    def image_reel_composit(self, reel_1, font_file, font_size, border, color_theme, reel_2=None, reel_3=None, reel_4=None,):


        ret_images = []

        if color_theme == 'light':
            bg_color = "#E5E5E5"
            text_color = "#121212"
        else:
            bg_color = "#121212"
            text_color = "#E5E5E5"


        reel_batches = [self._reel_frames(reel) for reel in (reel_1, reel_2, reel_3, reel_4)]
        batch_size = max(len(batch) for batch in reel_batches)
        for batch_index in range(batch_size):
            frames = [self._select_batch_item(batch, batch_index) for batch in reel_batches]
            frames = [frame for frame in frames if frame is not None]
            ret_images.append(pil2tensor(self._composite_frame(
                frames, font_file, font_size, border, bg_color, text_color
            )))

        # IMAGE batches must have a common spatial shape. Different Reel
        # inputs can produce different widths, so pad only when necessary.
        if ret_images:
            max_height = max(image.shape[1] for image in ret_images)
            max_width = max(image.shape[2] for image in ret_images)
            if any(image.shape[1] != max_height or image.shape[2] != max_width for image in ret_images):
                padded_images = []
                for image in ret_images:
                    padded = torch.zeros((1, max_height, max_width, image.shape[3]), dtype=image.dtype)
                    padded[:, :, :, :] = torch.tensor(tuple(int(bg_color[i:i + 2], 16) for i in (1, 3, 5)), dtype=image.dtype) / 255.0
                    padded[:, :image.shape[1], :image.shape[2], :] = image
                    padded_images.append(padded)
                ret_images = padded_images

        log(f"{self.NODE_NAME} Processed {len(ret_images)} image(s).", message_type='finish')
        return (torch.cat(ret_images, dim=0),)

    def _composite_frame(self, reels, font_file, font_size, border, bg_color, text_color):
        font_space = int(font_size * 1.5)
        width = max(reel.image.width for reel in reels)
        height = sum(reel.image.height + font_space + border for reel in reels)
        # yuv420p encoders such as libx264 require even frame dimensions.
        width += width % 2
        height += height % 2

        ret_image = Image.new('RGB', (width, height), color=bg_color)
        paste_y = 0
        for reel in reels:
            reel_text_image = self.draw_reel_text(reel, font_file, font_size, text_color)
            shadow_size = reel.image.height // 80
            ret_image = self.paste_drop_shadow(
                ret_image,
                reel.image,
                reel_text_image,
                ((width - reel.image.width) // 2, paste_y),
                shadow_size,
                text_color,
            )
            paste_y += reel.image.height + font_space + border
        return ret_image

    @staticmethod
    def _reel_frames(reel):
        if reel is None:
            return []
        frames = getattr(reel, 'reels', None)
        if frames:
            return frames
        # Accept Reel objects produced by older versions of this node.
        if getattr(reel, 'image', None) is not None:
            return [reel]
        return []

    @staticmethod
    def _select_batch_item(batch, index):
        if not batch:
            return None
        if len(batch) == 1:
            return batch[0]
        return batch[index] if index < len(batch) else batch[-1]

    def paste_drop_shadow(self, background_image, image, text_image, box, shadow_size, text_color) -> Image:
        # drop shadow
        _mask = image.split()[3]
        _blured_mask = gaussian_blur(_mask, shadow_size//1.3)
        _blured_mask = adjust_levels(_blured_mask, 0, 255, 0.5, 0, output_white=54).convert('L')
        background_image.paste(Image.new('RGBA', image.size, color="black"), (box[0]+shadow_size, box[1]+shadow_size), mask=_blured_mask)
        background_image.paste(image, box, mask=_mask)
        background_image.paste(Image.new('RGB', text_image.size, color=text_color), (box[0], box[1] + image.height), mask=text_image.split()[3])
        return background_image

    def draw_reel_text(self, reel, font_file, font_size, text_color) -> Image:

        font_path = self.FONT_DICT.get(font_file)
        font = ImageFont.truetype(font_path, font_size)
        texts = reel.texts
        text_image = Image.new('RGBA', (reel.image.width, reel.reel_border + int(font_size * 1.5)), color=(0, 0, 0, 0))
        draw = ImageDraw.Draw(text_image)
        x = reel.reel_border
        for t in texts:
            text = t[0]
            width = t[1]
            text_width = font.getbbox(text)[2]
            draw.text(
                xy=(x + width // 2 - text_width//2, reel.reel_border//4),
                text=text,
                fill=text_color,
                font=font,
            )
            x += width + reel.reel_border
        return text_image



NODE_CLASS_MAPPINGS = {
    "LayerUtility: ImageReel": ImageReel,
    "LayerUtility: ImageReelComposit": ImageReelComposit
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LayerUtility: ImageReel": "LayerUtility: Image Reel",
    "LayerUtility: ImageReelComposit": "LayerUtility: Image Reel Composit"
}
