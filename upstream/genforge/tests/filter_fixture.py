from PIL import Image, ImageDraw


def source():
    image = Image.new("RGBA", (64, 64))
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 12, 51, 52), fill=(125, 75, 35, 255))
    draw.rectangle((21, 24, 39, 39), fill=(0, 0, 0, 0))
    draw.rectangle((10, 12, 51, 19), fill=(55, 140, 65, 255))
    draw.line((7, 56, 55, 8), fill=(190, 185, 170, 255), width=3)
    return image
