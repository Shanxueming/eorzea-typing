"""
一次性素材处理脚本(不是运行时代码,处理完可以删)。
用边界种子的洪水填充抠掉白色背景;兔子图额外抠掉底部的黑色底座
(限制在图片底部一小段,避免顺着黑色描边一路吃进角色本体)。
"""
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "assets"


def flood_remove(arr, ref, tol, y_min=0, y_max=None):
    h, w = arr.shape[:2]
    y_max = h if y_max is None else y_max
    visited = np.zeros((h, w), dtype=bool)

    def bgish(y, x):
        if not (y_min <= y < y_max):
            return False
        px = arr[y, x]
        return all(abs(int(px[i]) - ref[i]) <= tol for i in range(3))

    q = deque()
    for x in range(w):
        for y in (y_min, y_max - 1):
            if bgish(y, x) and not visited[y, x]:
                visited[y, x] = True
                q.append((y, x))
    for y in range(y_min, y_max):
        for x in (0, w - 1):
            if bgish(y, x) and not visited[y, x]:
                visited[y, x] = True
                q.append((y, x))

    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and bgish(ny, nx):
                visited[ny, nx] = True
                q.append((ny, nx))
    return visited


def process(
    src,
    dst,
    remove_black_bottom=False,
    black_y_frac=0.92,
    background_tolerance=48,
    internal_white_regions=(),
):
    im = Image.open(src).convert("RGBA")
    arr = np.array(im)
    h, w = arr.shape[:2]

    # 只从画布边界向内抠除接近白色的像素，人物衣物中的白色不会被误删；
    # 48 比初版 28 更能清掉 JPG 抗锯齿留下的灰白边，同时不侵蚀白色服装。
    bg = flood_remove(arr, ref=(255, 255, 255), tol=background_tolerance)
    mask = bg.copy()

    # 个别素材会在头发/手臂围出的空隙里留下与外部不连通的白底。
    # 这些区域由人工确认后按小范围处理，避免误删白色服装。
    for left, top, right, bottom in internal_white_regions:
        area = arr[top:bottom, left:right, :3]
        mask[top:bottom, left:right] |= np.all(
            np.abs(area.astype(int) - 255) <= background_tolerance,
            axis=2,
        )

    if remove_black_bottom:
        y_min = int(h * black_y_frac)
        pedestal = flood_remove(arr, ref=(0, 0, 0), tol=60, y_min=y_min, y_max=h)
        mask |= pedestal

    arr[mask, 3] = 0
    Image.fromarray(arr).save(dst)
    print(f"{src} -> {dst}  removed {mask.sum()}/{h*w} px ({mask.mean()*100:.1f}%)")


def process_black_bg(src, dst, tol=40):
    im = Image.open(src).convert("RGBA")
    arr = np.array(im)
    h, w = arr.shape[:2]
    mask = flood_remove(arr, ref=(0, 0, 0), tol=tol, y_min=0, y_max=h)
    arr[mask, 3] = 0
    Image.fromarray(arr).save(dst)
    print(f"{src} -> {dst}  removed {mask.sum()}/{h*w} px ({mask.mean()*100:.1f}%)")


def preview(src, dst, bg=(60, 200, 60)):
    """把透明图叠在纯色背景上另存一份,方便肉眼确认抠图是否干净"""
    im = Image.open(src).convert("RGBA")
    canvas = Image.new("RGBA", im.size, bg + (255,))
    canvas.alpha_composite(im)
    canvas.convert("RGB").save(dst)


if __name__ == "__main__":
    p1_source = ROOT.parent / "scripts/source-assets/p1-original.png"
    if not p1_source.exists():
        p1_source = ROOT / "avatar/p1.png"
    jobs = [
        (
            process,
            p1_source,
            ROOT / "_out_p1.png",
            {"internal_white_regions": ((206, 315, 252, 391), (288, 355, 333, 441))},
        ),
        (process, ROOT / "avatar/p2.png", ROOT / "_out_p2.png", {}),
        (process_black_bg, ROOT / "avatar/e1f43f7bdb086ddcc81030457c1d5b71.png", ROOT / "_out_rabbit_icon.png", {}),
        (process, ROOT / "avatar/5b4a8593-afe0-4573-ae22-372f4cb7948d.png", ROOT / "_out_rabbit_pedestal.png", {}),
    ]
    outputs = []
    for fn, src, dst, kwargs in jobs:
        if not src.exists():
            print(f"skip missing source: {src}")
            continue
        fn(src, dst, **kwargs)
        outputs.append(dst)

    for output in outputs:
        preview(output, ROOT / output.name.replace("_out_", "_preview_"))
