function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function draw(img: HTMLImageElement, maxSide: number, quality: number) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

export async function preparePhoto(file: File) {
  const img = await loadImage(file);
  return { upload: draw(img, 1024, 0.7), thumb: draw(img, 240, 0.6) };
}

export interface AiResult { items: { name: string; kcal: number }[]; total: number; confidence?: string }

/** 调用 Worker（通义千问视觉模型）识别；未配置或失败返回 null */
export async function recognize(endpoint: string | undefined, dataUrl: string): Promise<AiResult | null> {
  if (!endpoint) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    if (!Array.isArray(j.items) || typeof j.total !== 'number') return null;
    return j as AiResult;
  } catch {
    return null;
  }
}

export const DEFAULT_KCAL: Record<string, number> = {
  早餐: 350, 午餐: 600, 晚餐: 600, 加餐: 200, 夜宵: 450, 夜班餐: 450,
};
